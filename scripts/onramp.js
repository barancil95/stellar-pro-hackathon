/**
 * Gets real USDC into a testnet account through the anchor's own on-ramp.
 *
 * No Circle faucet needed (it caps at 20 USDC per address per 2 hours); in the
 * sandbox the anchor's SEP-6 deposit completes instantly via
 * `simulate-bank-transfer`.
 *
 * Usage:
 *   node scripts/onramp.js relayer 500      # USDC for 500 TRY
 *   node scripts/onramp.js donor   2000
 *
 * The first argument picks the <NAME>_SECRET key from .env (relayer|donor|admin…).
 * If the account has no USDC trustline the deposit waits in `pending_trust` — the
 * script says so and stops rather than hanging silently.
 */

import 'dotenv/config';
import { Keypair } from '@stellar/stellar-sdk';
import * as anchor from '../apps/web/lib/anchor.js';

const log = (...a) => console.log(...a);

const NAME = (process.argv[2] || 'relayer').toLowerCase();
const TRY_AMOUNT = process.argv[3] || '1000';

function keypairFor(name) {
  const secret = process.env[`${name.toUpperCase().replace(/-/g, '_')}_SECRET`];
  if (!secret) throw new Error(`${name.toUpperCase()}_SECRET is missing from .env`);
  return Keypair.fromSecret(secret);
}

async function main() {
  const keypair = keypairFor(NAME);
  const h = await anchor.health();

  log(`account  : ${NAME} ${keypair.publicKey()}`);
  log(`amount   : ${TRY_AMOUNT} TRY  (rate ${h.rates.buy_rate})`);
  if (h.treasury.low_balance) {
    log('warning  : treasury is low — the deposit may wait with "treasury_low"');
  }

  await anchor.assertOnrampAmount(TRY_AMOUNT);

  const session = anchor.makeSession(keypair);

  // KYC does not become ACCEPTED on its own; at least one PUT is required.
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

  // Sandbox-only: in reality this is the incoming TRY transfer from the bank.
  await anchor.simulateBankTransfer(deposit.id, TRY_AMOUNT);
  log('bank     : transfer simulated');

  const settled = await anchor.pollTransaction(session, deposit.id, {
    intervalMs: 3000,
    timeoutMs: 120000,
    onUpdate: (tx) => {
      log(`status   : ${tx.status}${tx.pending_reason ? ` (${tx.pending_reason})` : ''}`);
      if (tx.status === 'pending_trust') {
        log('           ↳ the destination has no USDC trustline. Open one; the anchor pays by itself.');
      }
    },
  });

  if (settled.status !== 'completed') {
    throw new Error(`the on-ramp ended as ${settled.status}: ${settled.message || ''}`);
  }

  log(`✅ ${settled.amount_out} USDC received`);
  log(`   tx: https://stellar.expert/explorer/testnet/tx/${settled.stellar_transaction_id}`);
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
