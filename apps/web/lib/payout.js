/**
 * Relayer'ın fiat bacağı — SUNUCU TARAFI. Asla client'a import edilmez.
 *
 * Contract'ın keypair'i yok: SEP-10 challenge imzalayamaz, HTTP isteği atamaz.
 * `execute_payout` fonu relayer'a bırakır, buradan sonrası zincir dışıdır.
 *
 * ⚠️ Mimarinin en kritik detayı (plan 5.2): off-ramp, TRY'yi **SEP-10 auth
 * yapan kimliğin** SEP-12 kaydındaki IBAN'a öder. Relayer memo'suz auth
 * yaparsa para relayer'ın IBAN'ına gider, tedarikçinin değil.
 * Çözüm: her tedarikçi için `G…:memo` kapsamlı ayrı müşteri kaydı.
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

const HORIZON_URL = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE || Networks.TESTNET;

function relayerKeypair() {
  const secret = process.env.RELAYER_SECRET;
  if (!secret) throw new Error('RELAYER_SECRET yok — bu modül sadece sunucuda çalışır');
  return Keypair.fromSecret(secret);
}

/**
 * Tedarikçiyi memo kapsamlı müşteri olarak kaydeder.
 * @param supplierId uint64 — backend'de supplier_ref ile eşlenir
 * @param iban Türk IBAN'ı; verilmezse anchor deterministik sandbox IBAN'ı atar
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
 * Tedarikçiye TRY öder. Dönüş: anchor transaction'ı (`completed` beklenmiş).
 *
 * @param usdcAmount  ondalık string, ör. "5.0000000"
 * @param onProgress  ara durumları UI'a/loga vermek için
 */
export async function payoutToSupplier({
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

  onProgress({ step: 'register', supplierId });
  const { session, sub } = await registerSupplier({ supplierId, iban, name: supplierName });

  // Gösterge değil firm quote — ödeme anında kur kilitlenir (plan 5.5).
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
      `Anchor memo_type="id" vermedi (${withdrawal.memo_type}) — memo olmadan ödeme atfedilemez`,
    );
  }

  onProgress({ step: 'send', to: withdrawal.account_id, memo: withdrawal.memo });
  const stellarTxHash = await sendUsdc({
    keypair: relayer,
    destination: withdrawal.account_id,
    issuer: h.asset.issuer,
    amount: usdcAmount,
    memoId: withdrawal.memo,
  });

  onProgress({ step: 'settle', stellarTxHash });
  const settled = await anchor.pollTransaction(session, withdrawal.id, {
    intervalMs: 5000, // off-ramp tespiti 5 sn kadence'ında
    timeoutMs: 180000,
    onUpdate: (tx) => onProgress({ step: 'status', status: tx.status }),
  });

  if (settled.status !== 'completed') {
    throw new Error(`Off-ramp ${settled.status} ile bitti: ${settled.message || ''}`);
  }

  return {
    anchorTransactionId: settled.id,
    sub,
    quoteId: quote.id,
    stellarTxHash,
    memo: withdrawal.memo,
    usdcSent: settled.amount_in,
    tryPaid: settled.amount_out,
    fee: settled.amount_fee,
    /// Bankanın ödeme referansı — "para nereye gitti" sorusunun fiat tarafı.
    bankReference: settled.external_transaction_id,
  };
}

/** Memo.id ŞART — anchor ödemeyi memo ile eşliyor (plan 5.6). */
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
 * `on_change_callback` imza doğrulaması (plan 5.7).
 * İmza: Ed25519 over "<t>.<host>.<rawBody>", anchor'ın SIGNING_KEY'i ile.
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
