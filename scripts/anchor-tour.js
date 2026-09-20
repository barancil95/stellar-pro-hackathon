/**
 * M0 — the anchor discovery tour.
 *
 * 1. read /health
 * 2. SEP-10 auth (relayer)
 * 3. SEP-12 customer registration
 * 4. SEP-38 indicative price
 * 5. SEP-6 deposit → simulate-bank-transfer → completed
 *    → the relayer has a trustline, so a plain payment is expected
 * 6. A deposit to an account with no trustline → `pending_trust` is triggered on
 *    purpose; once the trustline is opened the anchor pays by itself (NOT a
 *    claimable balance)
 *
 * The point is both to verify the anchor flow by eye and to get real testnet USDC
 * into the relayer for the M1/M2 tests (no Circle faucet needed).
 */

import 'dotenv/config';
import { Keypair, Horizon } from '@stellar/stellar-sdk';
import * as anchor from '../apps/web/lib/anchor.js';

const horizon = new Horizon.Server(process.env.HORIZON_URL);

const log = (...a) => console.log(...a);
const step = (n, t) => log(`\n${'─'.repeat(60)}\n${n}. ${t}\n${'─'.repeat(60)}`);

async function usdcBalance(publicKey, issuer) {
  try {
    const acc = await horizon.loadAccount(publicKey);
    const line = acc.balances.find((b) => b.asset_code === 'USDC' && b.asset_issuer === issuer);
    return line ? line.balance : null; // null = no trustline
  } catch {
    return null;
  }
}

async function main() {
  step(1, '/health');
  const h = await anchor.health();
  log('issuer          :', h.asset.issuer);
  log('treasury        :', h.treasury.address, `(${h.treasury.usdc_balance} USDC)`);
  log('low_balance     :', h.treasury.low_balance);
  log('rates           :', `mid ${h.rates.mid_rate} · buy ${h.rates.buy_rate} · sell ${h.rates.sell_rate}`);
  log('spread          :', `${h.rates.spread_bps} bps · source: ${h.rates.source}`);
  log('limits          :', JSON.stringify(h.limits), '← null = not enforced');

  const info = await anchor.sep6Info();
  log('features        :', JSON.stringify(info.features));

  const relayer = Keypair.fromSecret(process.env.RELAYER_SECRET);

  step(2, `SEP-10 auth — relayer ${relayer.publicKey().slice(0, 8)}…`);
  const session = anchor.makeSession(relayer);
  const token = await session.token();
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  log('sub             :', claims.sub);
  log('exp             :', new Date(claims.exp * 1000).toISOString());

  step(3, 'SEP-12 customer registration');
  log('before          :', (await session.call((t) => anchor.getCustomer(t))).status);
  await session.call((t) => anchor.putCustomer(t, {}));
  const after = await session.call((t) => anchor.getCustomer(t));
  log('after           :', after.status);

  step(4, 'SEP-38 indicative price — 1500 TRY → USDC');
  const ids = await anchor.assetIds();
  const price = await anchor.indicativePrice({
    sellAsset: ids.try,
    buyAsset: ids.usdc,
    sellAmount: '1500.00',
  });
  log('total_price     :', price.total_price);
  log('buy_amount      :', price.buy_amount, 'USDC');
  log('fee             :', price.fee?.total, price.fee?.asset);

  step(5, 'SEP-6 deposit — relayer (trustline PRESENT → a payment is expected)');
  const before = await usdcBalance(relayer.publicKey(), h.asset.issuer);
  log('before          :', before, 'USDC');

  const dep = await session.call((t) =>
    anchor.deposit(t, { account: relayer.publicKey(), amount: '1500.00' }),
  );
  log('tx id           :', dep.id);
  log('bank            :', dep.instructions?.bank_name?.value);
  log('IBAN            :', dep.instructions?.bank_account_number?.value);
  log('reference       :', dep.instructions?.external_transfer_memo?.value);

  log('\n→ simulating the TRY transfer…');
  await anchor.simulateBankTransfer(dep.id, '1500.00');

  const done = await anchor.pollTransaction(session, dep.id, {
    onUpdate: (tx) => log('   status:', tx.status, tx.pending_reason ? `(${tx.pending_reason})` : ''),
  });
  log('amount_in       :', done.amount_in, done.amount_in_asset);
  log('amount_out      :', done.amount_out, done.amount_out_asset);
  log('amount_fee      :', done.amount_fee);
  log('stellar tx      :', done.stellar_transaction_id);
  log('claimable       :', done.claimable_balance_id || '— (plain payment, as expected)');
  log('after           :', await usdcBalance(relayer.publicKey(), h.asset.issuer), 'USDC');

  step(6, 'SEP-6 deposit — NO trustline → `pending_trust` expected');
  const noTrust = Keypair.fromSecret(process.env.COORD_C_SECRET);
  log('account         :', noTrust.publicKey());
  const trustline = await usdcBalance(noTrust.publicKey(), h.asset.issuer);
  if (trustline !== null) {
    log('⏭  this account already has a trustline, skipping the step');
    log('   (for a clean rerun, generate a new account: stellar keys generate … --fund)');
  } else {
    const s2 = anchor.makeSession(noTrust);
    await s2.call((t) => anchor.putCustomer(t, {}));
    const dep2 = await s2.call((t) =>
      anchor.deposit(t, { account: noTrust.publicKey(), amount: '100.00' }),
    );
    await anchor.simulateBankTransfer(dep2.id, '100.00');

    // pending_trust is not terminal — the poll times out, which is expected.
    const held = await anchor
      .pollTransaction(s2, dep2.id, {
        timeoutMs: 20000,
        onUpdate: (tx) => log('   status:', tx.status),
      })
      .catch((e) => e.transaction);

    log('status          :', held.status, held.status === 'pending_trust' ? '✓ as expected' : '← UNEXPECTED');
    log('anchor message  :', held.message);
    log('claimable id    :', held.claimable_balance_id || '— (NO claimable balance)');
    log('\n→ Recovery: changeTrust. The anchor does the rest by itself, no claim needed.');
  }

  log('\n✅ M0 anchor tour complete.');
}

main().catch((e) => {
  console.error('\n❌', e.message);
  if (e.body) console.error(JSON.stringify(e.body, null, 2));
  if (e.transaction) console.error('last transaction:', JSON.stringify(e.transaction, null, 2));
  process.exit(1);
});
