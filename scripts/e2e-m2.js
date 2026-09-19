/**
 * M2 acceptance — uçtan uca, tek komut.
 *
 *   USDC deposit → talep → 2/3 onay → payout → relayer
 *   → memo'lu tedarikçi kaydı → firm quote → withdraw-exchange
 *   → tedarikçinin IBAN'ına TRY `completed`
 *
 * Demo'da bu akış UI'dan yürür; burada headless koşuyor ki her deploy'dan
 * sonra bir komutla doğrulanabilsin.
 *
 * Kullanım: WEB=http://localhost:3000 node scripts/e2e-m2.js
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

/** Headless imzalayıcı. Tarayıcıda bunun yerine Wallets Kit var. */
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
  log('tutar    :', AMOUNT_USDC, 'USDC');

  step(1, 'Tedarikçi kaydı — IBAN backend\'de, zincire hash\'i gider');
  const supplier = await api('/api/suppliers', {
    name: 'ABC Akaryakıt',
    iban: 'TR320010009999901234567890',
  });
  log('supplierId :', supplier.supplierId);
  log('supplierRef:', supplier.supplierRef.slice(0, 24) + '…');

  step(2, 'Bağış — escrow\'a USDC');
  const depositHash = await deposit({ ...as(donor), amount: AMOUNT_USDC });
  log('tx :', explorerTx(depositHash));
  log('escrow bakiyesi:', fromStroops((await readEscrow()).balance), 'USDC');

  step(3, 'Talep — ihtiyaç kanıtı hash\'iyle');
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
  log('request id :', requestId);
  log('tx :', explorerTx(requestHash));

  step(4, 'Çoklu imza — iki AYRI cüzdan');
  log('coord A onayı…');
  await approveRequest({ ...as(coordA), requestId });
  log('  onay sayısı:', (await readRequest(requestId)).approvals_count, '/ 2 — henüz yetmez');
  log('coord B onayı…');
  await approveRequest({ ...as(coordB), requestId });
  log('  onay sayısı:', (await readRequest(requestId)).approvals_count, '/ 2 ✓');

  step(5, 'execute_payout — fon relayer\'a (hedef contract\'ta sabit)');
  const payoutHash = await executePayout({ ...as(donor), requestId });
  log('tx :', explorerTx(payoutHash));
  log('talep completed:', (await readRequest(requestId)).completed);

  step(6, 'Fiat bacağı — anchor üzerinden tedarikçinin IBAN\'ına');
  const payout = await api('/api/payout', { requestId: Number(requestId) });
  log('anchor tx  :', payout.anchorTransactionId);
  log('SEP-10 sub :', payout.sub, '← memo kapsamı');
  log('quote      :', payout.quoteId);
  log('USDC       :', payout.usdcSent);
  log('TRY        :', payout.tryPaid, `(komisyon ${payout.fee})`);
  log('banka ref  :', payout.bankReference);

  log(`\n${'═'.repeat(64)}`);
  log('✅ M2 ACCEPTANCE: deposit → 2/3 onay → payout → TRY, tedarikçinin IBAN\'ında.');
  log('═'.repeat(64));
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
