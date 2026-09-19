/**
 * M0 — Anchor keşif turu.
 *
 * 1. /health oku
 * 2. SEP-10 auth (relayer)
 * 3. SEP-12 müşteri kaydı
 * 4. SEP-38 gösterge fiyat
 * 5. SEP-6 deposit → simulate-bank-transfer → completed
 *    → relayer'da trustline var, düz payment gelmeli
 * 6. Trustline'sız hesaba deposit → `pending_trust` bilerek tetiklenir,
 *    trustline açılınca anchor kendiliğinden öder (claimable balance DEĞİL)
 *
 * Amaç hem anchor akışını gözle doğrulamak hem de M1/M2 testleri için
 * relayer'a gerçek testnet USDC almak (Circle faucet'e gerek yok).
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
    return line ? line.balance : null; // null = trustline yok
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
  log('kur             :', `mid ${h.rates.mid_rate} · buy ${h.rates.buy_rate} · sell ${h.rates.sell_rate}`);
  log('spread          :', `${h.rates.spread_bps} bps · kaynak: ${h.rates.source}`);
  log('limitler        :', JSON.stringify(h.limits), '← null = uygulanmıyor');

  const info = await anchor.sep6Info();
  log('features        :', JSON.stringify(info.features));

  const relayer = Keypair.fromSecret(process.env.RELAYER_SECRET);

  step(2, `SEP-10 auth — relayer ${relayer.publicKey().slice(0, 8)}…`);
  const session = anchor.makeSession(relayer);
  const token = await session.token();
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  log('sub             :', claims.sub);
  log('exp             :', new Date(claims.exp * 1000).toISOString());

  step(3, 'SEP-12 müşteri kaydı');
  log('öncesi          :', (await session.call((t) => anchor.getCustomer(t))).status);
  await session.call((t) => anchor.putCustomer(t, {}));
  const after = await session.call((t) => anchor.getCustomer(t));
  log('sonrası         :', after.status);

  step(4, 'SEP-38 gösterge fiyat — 1500 TRY → USDC');
  const ids = await anchor.assetIds();
  const price = await anchor.indicativePrice({
    sellAsset: ids.try,
    buyAsset: ids.usdc,
    sellAmount: '1500.00',
  });
  log('total_price     :', price.total_price);
  log('buy_amount      :', price.buy_amount, 'USDC');
  log('fee             :', price.fee?.total, price.fee?.asset);

  step(5, 'SEP-6 deposit — relayer (trustline VAR → payment beklenir)');
  const before = await usdcBalance(relayer.publicKey(), h.asset.issuer);
  log('önce            :', before, 'USDC');

  const dep = await session.call((t) =>
    anchor.deposit(t, { account: relayer.publicKey(), amount: '1500.00' }),
  );
  log('tx id           :', dep.id);
  log('banka           :', dep.instructions?.bank_name?.value);
  log('IBAN            :', dep.instructions?.bank_account_number?.value);
  log('açıklama/referans:', dep.instructions?.external_transfer_memo?.value);

  log('\n→ TRY transferi simüle ediliyor…');
  await anchor.simulateBankTransfer(dep.id, '1500.00');

  const done = await anchor.pollTransaction(session, dep.id, {
    onUpdate: (tx) => log('   status:', tx.status, tx.pending_reason ? `(${tx.pending_reason})` : ''),
  });
  log('amount_in       :', done.amount_in, done.amount_in_asset);
  log('amount_out      :', done.amount_out, done.amount_out_asset);
  log('amount_fee      :', done.amount_fee);
  log('stellar tx      :', done.stellar_transaction_id);
  log('claimable       :', done.claimable_balance_id || '— (düz payment, beklendiği gibi)');
  log('sonra           :', await usdcBalance(relayer.publicKey(), h.asset.issuer), 'USDC');

  step(6, 'SEP-6 deposit — trustline YOK → `pending_trust` beklenir');
  const noTrust = Keypair.fromSecret(process.env.COORD_C_SECRET);
  log('hesap           :', noTrust.publicKey());
  const trustline = await usdcBalance(noTrust.publicKey(), h.asset.issuer);
  if (trustline !== null) {
    log('⏭  bu hesapta trustline zaten açık, adım atlanıyor');
    log('   (temiz tekrar için yeni bir hesap üret: stellar keys generate … --fund)');
  } else {
    const s2 = anchor.makeSession(noTrust);
    await s2.call((t) => anchor.putCustomer(t, {}));
    const dep2 = await s2.call((t) =>
      anchor.deposit(t, { account: noTrust.publicKey(), amount: '100.00' }),
    );
    await anchor.simulateBankTransfer(dep2.id, '100.00');

    // pending_trust terminal değil — poll timeout'a düşer, beklenen bu.
    const held = await anchor
      .pollTransaction(s2, dep2.id, {
        timeoutMs: 20000,
        onUpdate: (tx) => log('   status:', tx.status),
      })
      .catch((e) => e.transaction);

    log('durum           :', held.status, held.status === 'pending_trust' ? '✓ beklendiği gibi' : '← BEKLENMEDİK');
    log('anchor mesajı   :', held.message);
    log('claimable id    :', held.claimable_balance_id || '— (claimable balance YOK)');
    log('\n→ Kurtarma: changeTrust. Anchor kalanı kendi yapar, claim gerekmez.');
  }

  log('\n✅ M0 anchor turu tamam.');
}

main().catch((e) => {
  console.error('\n❌', e.message);
  if (e.body) console.error(JSON.stringify(e.body, null, 2));
  if (e.transaction) console.error('son transaction:', JSON.stringify(e.transaction, null, 2));
  process.exit(1);
});
