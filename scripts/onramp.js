/**
 * Bir testnet hesabına anchor'ın kendi on-ramp'i üzerinden gerçek USDC alır.
 *
 * Circle faucet'e gerek yok (20 USDC / adres / 2 saat sınırı var); anchor
 * SEP-6 deposit'i sandbox'ta `simulate-bank-transfer` ile anında tamamlıyor.
 *
 * Kullanım:
 *   node scripts/onramp.js relayer 500      # 500 TRY karşılığı USDC
 *   node scripts/onramp.js donor   2000
 *
 * İlk argüman .env'deki <AD>_SECRET anahtarını seçer (relayer|donor|admin…).
 * Hesapta USDC trustline yoksa deposit `pending_trust`'ta bekler — script
 * bunu söyler ve durur, sessizce asılı kalmaz.
 */

import 'dotenv/config';
import { Keypair } from '@stellar/stellar-sdk';
import * as anchor from '../apps/web/lib/anchor.js';

const log = (...a) => console.log(...a);

const NAME = (process.argv[2] || 'relayer').toLowerCase();
const TRY_AMOUNT = process.argv[3] || '1000';

function keypairFor(name) {
  const secret = process.env[`${name.toUpperCase().replace(/-/g, '_')}_SECRET`];
  if (!secret) throw new Error(`.env'de ${name.toUpperCase()}_SECRET yok`);
  return Keypair.fromSecret(secret);
}

async function main() {
  const keypair = keypairFor(NAME);
  const h = await anchor.health();

  log(`hesap    : ${NAME} ${keypair.publicKey()}`);
  log(`tutar    : ${TRY_AMOUNT} TRY  (kur ${h.rates.buy_rate})`);
  if (h.treasury.low_balance) {
    log('uyarı    : treasury düşük — deposit "treasury_low" ile bekleyebilir');
  }

  await anchor.assertOnrampAmount(TRY_AMOUNT);

  const session = anchor.makeSession(keypair);

  // KYC kendiliğinden ACCEPTED olmuyor; en az bir PUT gerekiyor.
  await session.call((t) => anchor.putCustomer(t, {}));
  const customer = await session.call((t) => anchor.getCustomer(t));
  log(`sep12    : ${customer.status}`);

  const deposit = await session.call((t) =>
    anchor.deposit(t, {
      account: keypair.publicKey(),
      amount: TRY_AMOUNT,
    }),
  );
  log(`deposit  : ${deposit.id}`);

  // Sandbox'a özel: gerçekte bu, bankadan gelen TRY transferidir.
  await anchor.simulateBankTransfer(deposit.id, TRY_AMOUNT);
  log('banka    : transfer simüle edildi');

  const settled = await anchor.pollTransaction(session, deposit.id, {
    intervalMs: 3000,
    timeoutMs: 120000,
    onUpdate: (tx) => {
      log(`durum    : ${tx.status}${tx.pending_reason ? ` (${tx.pending_reason})` : ''}`);
      if (tx.status === 'pending_trust') {
        log('           ↳ hedefte USDC trustline yok. Açın; anchor kendiliğinden öder.');
      }
    },
  });

  if (settled.status !== 'completed') {
    throw new Error(`on-ramp ${settled.status} ile bitti: ${settled.message || ''}`);
  }

  log(`✅ ${settled.amount_out} USDC geldi`);
  log(`   tx: https://stellar.expert/explorer/testnet/tx/${settled.stellar_transaction_id}`);
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
