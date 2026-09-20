/**
 * M2 acceptance — end to end, one command.
 *
 *   USDC deposit → request → 2/3 approvals → payout → relayer
 *   → memo-scoped supplier record → firm quote → withdraw-exchange
 *   → TRY `completed` in the supplier's IBAN
 *
 * In the demo this flow runs from the UI; here it runs headless so it can be
 * verified with a single command after every deploy.
 *
 * Usage: WEB=http://localhost:3000 node scripts/e2e-m2.js
 */

import 'dotenv/config';
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import {
  deposit,
  createRequest,
  approveRequest,
  executePayout,
  readEscrow,
  readRequest,
  fromStroops,
  explorerTx,
  CONTRACT_ID,
} from '../apps/web/lib/soroban.js';

const WEB = process.env.WEB || 'http://localhost:3000';
const PASSPHRASE = process.env.NETWORK_PASSPHRASE;

const log = (...a) => console.log(...a);
const step = (n, t) => log(`\n${'─'.repeat(64)}\n${n}. ${t}\n${'─'.repeat(64)}`);

/** The headless signer. In the browser, Wallets Kit takes its place. */
function localSigner(keypair) {
  return async (xdr) => {
    const tx = TransactionBuilder.fromXDR(xdr, PASSPHRASE);
    tx.sign(keypair);
    return { signedTxXdr: tx.toXDR(), signerAddress: keypair.publicKey() };
  };
}

const as = (keypair) => ({
  publicKey: keypair.publicKey(),
  signTransaction: localSigner(keypair),
});

async function api(path, body) {
  const res = await fetch(`${WEB}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${json.error}`);
  return json;
}

async function main() {
  const donor = Keypair.fromSecret(process.env.DONOR_SECRET);
  const coordA = Keypair.fromSecret(process.env.COORD_A_SECRET);
  const coordB = Keypair.fromSecret(process.env.COORD_B_SECRET);

  const AMOUNT_USDC = process.env.E2E_AMOUNT || '1.5';
  log('contract :', CONTRACT_ID);
  log('amount   :', AMOUNT_USDC, 'USDC');

  const before = await readEscrow();
  log('vault    :', before.vault ?? 'off — funds stay in the escrow');

  step(1, 'Supplier registration — the IBAN stays in the backend, its hash goes on-chain');
  const supplier = await api('/api/suppliers', {
    name: 'ABC Fuel Co.',
    iban: 'TR320010009999901234567890',
  });
  log('supplierId :', supplier.supplierId);
  log('supplierRef:', supplier.supplierRef.slice(0, 24) + '…');

  step(2, before.vault ? 'Donation — through the escrow into the DeFindex vault' : 'Donation — USDC into the escrow');
  const depositHash = await deposit({ ...as(donor), amount: AMOUNT_USDC });
  log('tx :', explorerTx(depositHash));
  const afterDeposit = await readEscrow();
  log('payable balance  :', fromStroops(afterDeposit.balance), 'USDC');
  if (before.vault) {
    log('vault shares     :', fromStroops(afterDeposit.campaign.shares), 'shares');
  }

  step(3, 'Request — with the proof-of-need hash');
  const proofHash = Buffer.from(
    '9f2c4e1a7b3d5f8e0c6a2b4d8e1f3a5c7b9d0e2f4a6c8b1d3e5f7a9c0b2d4e6f',
    'hex',
  );
  const { requestId, hash: requestHash } = await createRequest({
    ...as(donor),
    supplierRef: Buffer.from(supplier.supplierRef, 'hex'),
    amount: AMOUNT_USDC,
    proofHash,
  });
  // The need description does not fit on-chain; we do here what the UI does.
  await api('/api/requests', {
    requestId: Number(requestId),
    need: 'Generator fuel — 3 days',
    supplierName: 'ABC Fuel Co.',
  });

  log('request id :', requestId);
  log('tx :', explorerTx(requestHash));

  step(4, 'Multisig — two SEPARATE wallets');
  log('coord A approving…');
  await approveRequest({ ...as(coordA), requestId });
  log('  approvals:', (await readRequest(requestId)).approvals_count, '/ 2 — not enough yet');
  log('coord B approving…');
  await approveRequest({ ...as(coordB), requestId });
  log('  approvals:', (await readRequest(requestId)).approvals_count, '/ 2 ✓');

  step(
    5,
    before.vault
      ? 'execute_payout — vault shares are unwound, funds go to the relayer'
      : 'execute_payout — funds to the relayer (the destination is fixed in the contract)',
  );
  const payoutHash = await executePayout({ ...as(donor), requestId });
  log('tx :', explorerTx(payoutHash));
  log('request completed:', (await readRequest(requestId)).completed);
  if (before.vault) {
    const afterPayout = await readEscrow();
    log('vault shares left:', fromStroops(afterPayout.campaign.shares), 'shares');
  }

  step(6, 'The fiat leg — through the anchor to the supplier\'s IBAN');
  const started = await api('/api/payout', { requestId: Number(requestId) });
  log('anchor tx  :', started.anchorTransactionId);
  log('USDC sent  :', explorerTx(started.stellarTxHash), `memo ${started.memo}`);

  // The POST no longer waits for `completed` (serverless time ceiling). The GET
  // polls the status — on Vercel on_change_callback will already have done it.
  const TERMINAL = new Set(['completed', 'error', 'refunded']);
  let payout = started;
  for (let i = 0; i < 40 && !TERMINAL.has(payout.status); i += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    payout = await api(`/api/payout?requestId=${requestId}`);
    log('status     :', payout.status);
  }
  if (payout.status !== 'completed') {
    throw new Error(`The off-ramp did not complete: ${payout.status}`);
  }

  log('SEP-10 sub :', started.sub, '← memo scope');
  log('quote      :', started.quoteId, `(promised ${started.tryQuoted} TRY)`);
  log('USDC       :', payout.usdcSent);
  log('TRY        :', payout.tryPaid, `(fee ${payout.fee})`);
  log('bank ref   :', payout.bankReference);

  log(`\n${'═'.repeat(64)}`);
  log('✅ M2 ACCEPTANCE: deposit → 2/3 approvals → payout → TRY, in the supplier\'s IBAN.');
  log('═'.repeat(64));
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
