/**
 * The relayer's fiat leg — SERVER SIDE. Never imported into the client.
 *
 * The contract has no keypair: it cannot sign a SEP-10 challenge or make an HTTP
 * request. `execute_payout` leaves the funds with the relayer; everything past
 * that point is off-chain.
 *
 * ⚠️ The most critical detail of the architecture (plan 5.2): the off-ramp pays
 * the TRY to the IBAN in the SEP-12 record of **whichever identity did the SEP-10
 * auth**. If the relayer authenticates without a memo, the money goes to the
 * relayer's IBAN, not the supplier's.
 * The fix: a separate `G…:memo`-scoped customer record per supplier.
 */

import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import * as anchor from './anchor.js';
import { linkAnchorTransaction } from './store.js';

const HORIZON_URL = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE || Networks.TESTNET;

function relayerKeypair() {
  const secret = process.env.RELAYER_SECRET;
  if (!secret) throw new Error('RELAYER_SECRET missing — this module only runs on the server');
  return Keypair.fromSecret(secret);
}

/**
 * Registers the supplier as a memo-scoped customer.
 * @param supplierId uint64 — mapped to supplier_ref in the backend
 * @param iban a Turkish IBAN; without one the anchor assigns a deterministic
 *             sandbox IBAN
 */
export async function registerSupplier({ supplierId, iban, name }) {
  const session = anchor.makeSession(relayerKeypair(), { memo: supplierId });

  const fields = {};
  if (iban) fields.bank_account_number = iban;
  if (name) fields.bank_name = name;
  await session.call((t) => anchor.putCustomer(t, fields));

  const customer = await session.call((t) => anchor.getCustomer(t));
  return { session, sub: session.sub, status: customer.status, customerId: customer.id };
}

/**
 * PHASE ONE of the fiat leg: register → firm quote → withdraw → send USDC.
 *
 * We stop and return here. This function used to poll for up to 180 s until the
 * anchor said `completed`; Vercel's function ceiling (60 s on Hobby) is shorter
 * than that and the request timed out. The status arrives in phase two: the main
 * path is `on_change_callback`, the fallback is `fetchPayoutStatus`.
 *
 * @param usdcAmount  a decimal string, e.g. "5.0000000"
 */
export async function startPayout({
  requestId,
  supplierId,
  iban,
  supplierName,
  usdcAmount,
  onChangeCallback,
  onProgress = () => {},
}) {
  const relayer = relayerKeypair();
  const h = await anchor.health();
  const ids = await anchor.assetIds();

  // Catch an out-of-range amount before going to the anchor — for a readable error.
  await anchor.assertOfframpAmount(usdcAmount);
  if (h.treasury.low_balance) {
    onProgress({ step: 'warn', message: 'anchor treasury is low — the off-ramp may be delayed' });
  }

  onProgress({ step: 'register', supplierId });
  const { session, sub } = await registerSupplier({ supplierId, iban, name: supplierName });

  // A firm quote, not an indicative one — the rate is locked at payout time (plan 5.5).
  onProgress({ step: 'quote' });
  const quote = await session.call((t) =>
    anchor.firmQuote(t, {
      sellAsset: ids.usdc,
      buyAsset: ids.try,
      sellAmount: usdcAmount,
    }),
  );
  onProgress({ step: 'quote', quoteId: quote.id, tryAmount: quote.buy_amount, price: quote.price });

  onProgress({ step: 'withdraw' });
  const withdrawal = await session.call((t) =>
    anchor.withdrawExchange(t, {
      sellAmount: usdcAmount,
      quoteId: quote.id,
      onChangeCallback,
    }),
  );

  if (!withdrawal.memo || withdrawal.memo_type !== 'id') {
    throw new Error(
      `Anchor did not return memo_type="id" (${withdrawal.memo_type}) — a payment without a memo cannot be attributed`,
    );
  }

  // Build the bridge BEFORE sending the USDC: the callback can arrive seconds
  // after the payment, and without knowing its request the record is lost.
  if (requestId !== undefined && requestId !== null) {
    await linkAnchorTransaction(withdrawal.id, requestId);
  }

  onProgress({ step: 'send', to: withdrawal.account_id, memo: withdrawal.memo });
  const stellarTxHash = await sendUsdc({
    keypair: relayer,
    destination: withdrawal.account_id,
    issuer: h.asset.issuer,
    amount: usdcAmount,
    memoId: withdrawal.memo,
  });

  return {
    anchorTransactionId: withdrawal.id,
    sub,
    supplierId,
    quoteId: quote.id,
    stellarTxHash,
    memo: withdrawal.memo,
    usdcSent: usdcAmount,
    /// The TRY the firm quote promised — to be compared against what actually landed.
    tryQuoted: quote.buy_amount,
    status: 'pending_anchor',
  };
}

/**
 * PHASE TWO, the fallback path: asks the anchor for the status once.
 *
 * Not needed when `on_change_callback` works (it does on Vercel). On localhost the
 * anchor cannot reach us, so the UI calls this instead.
 */
export async function fetchPayoutStatus({ supplierId, anchorTransactionId }) {
  const session = anchor.makeSession(relayerKeypair(), { memo: supplierId });
  const tx = await session.call((t) => anchor.getTransaction(t, anchorTransactionId));
  return {
    status: tx.status,
    usdcSent: tx.amount_in ?? null,
    tryPaid: tx.amount_out ?? null,
    fee: tx.amount_fee ?? null,
    /// The bank's payment reference — the fiat side of "where did the money go".
    bankReference: tx.external_transaction_id ?? null,
    message: tx.message ?? null,
  };
}

/**
 * Start and wait until it settles. For the headless e2e; the HTTP route does NOT
 * use this (time ceiling).
 */
export async function payoutToSupplier(args) {
  const started = await startPayout(args);
  const session = anchor.makeSession(relayerKeypair(), { memo: args.supplierId });

  const settled = await anchor.pollTransaction(session, started.anchorTransactionId, {
    intervalMs: 5000, // off-ramp detection runs on a 5 s cadence
    timeoutMs: 180000,
    onUpdate: (tx) => args.onProgress?.({ step: 'status', status: tx.status }),
  });

  if (settled.status !== 'completed') {
    throw new Error(`Off-ramp ended as ${settled.status}: ${settled.message || ''}`);
  }

  return {
    ...started,
    status: settled.status,
    usdcSent: settled.amount_in,
    tryPaid: settled.amount_out,
    fee: settled.amount_fee,
    bankReference: settled.external_transaction_id,
  };
}

/** Memo.id is MANDATORY — the anchor matches the payment by memo (plan 5.6). */
async function sendUsdc({ keypair, destination, issuer, amount, memoId }) {
  const horizon = new Horizon.Server(HORIZON_URL);
  const account = await horizon.loadAccount(keypair.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination,
        asset: new Asset('USDC', issuer),
        amount: String(amount),
      }),
    )
    .addMemo(Memo.id(String(memoId)))
    .setTimeout(60)
    .build();

  tx.sign(keypair);
  const res = await horizon.submitTransaction(tx);
  return res.hash;
}

/**
 * `on_change_callback` signature verification (plan 5.7).
 * The signature is Ed25519 over "<t>.<host>.<rawBody>", with the anchor's
 * SIGNING_KEY.
 */
export async function verifyCallbackSignature({ signatureHeader, host, rawBody }) {
  if (!signatureHeader) return false;
  const match = /t=(\d+),\s*s=(.+)/.exec(signatureHeader);
  if (!match) return false;

  const [, t, s] = match;
  const h = await anchor.health();
  try {
    return Keypair.fromPublicKey(h.sep.signing_key).verify(
      Buffer.from(`${t}.${host}.${rawBody}`),
      Buffer.from(s, 'base64'),
    );
  } catch {
    return false;
  }
}
