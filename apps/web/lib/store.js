/**
 * Tedarikçi kayıt defteri — SUNUCU TARAFI, dosya destekli.
 *
 * Düz IBAN ledger'a yazılmaz; zincirde yalnızca `supplier_ref = sha256(iban|salt)`
 * durur. IBAN ↔ supplier_ref ↔ SEP-10 memo eşleşmesi burada tutulur (plan 5.2).
 *
 * Hackathon kapsamı: tek süreç, dosya. Üretimde bu bir veritabanı olurdu.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DATA_DIR = join(process.cwd(), 'data');
const FILE = join(DATA_DIR, 'store.json');

const EMPTY = { suppliers: [], payouts: {}, notes: {}, anchorStatus: {}, nextSupplierId: 77100 };

function read() {
  try {
    return { ...EMPTY, ...JSON.parse(readFileSync(FILE, 'utf8')) };
  } catch {
    return { ...EMPTY };
  }
}

function write(state) {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(state, null, 2));
  return state;
}

/** IBAN'ın kendisi değil, tuzlanmış hash'i zincire gider. */
function supplierRefOf(iban, salt) {
  return createHash('sha256').update(`${iban}|${salt}`).digest('hex');
}

export function registerSupplierRecord({ name, iban }) {
  const state = read();

  const existing = state.suppliers.find((s) => s.iban === iban);
  if (existing) return existing;

  const salt = randomBytes(16).toString('hex');
  const record = {
    supplierId: state.nextSupplierId,
    supplierRef: supplierRefOf(iban, salt),
    salt,
    iban,
    name,
    createdAt: new Date().toISOString(),
  };
  state.nextSupplierId += 1;
  state.suppliers.push(record);
  write(state);
  return record;
}

export function findBySupplierRef(supplierRef) {
  return read().suppliers.find(
    (s) => s.supplierRef.toLowerCase() === String(supplierRef).toLowerCase(),
  );
}

export function listSuppliers() {
  // IBAN ve salt dışarı verilmez.
  return read().suppliers.map(({ supplierId, supplierRef, name, createdAt }) => ({
    supplierId,
    supplierRef,
    name,
    createdAt,
  }));
}

/* -------------------------------- talep notu ------------------------------ */

/**
 * İhtiyaç açıklaması ve tedarikçi adı. Zincirde yalnızca tutar ve iki hash var;
 * insan tarafı burada — denetim izinde "ne için" sorusunu yanıtlıyor.
 */
export function saveRequestNote(requestId, note) {
  const state = read();
  state.notes[requestId] = { ...(state.notes[requestId] || {}), ...note };
  write(state);
  return state.notes[requestId];
}

export function getRequestNote(requestId) {
  return read().notes[requestId] ?? null;
}

/* ------------------------------ ödeme kayıtları --------------------------- */

export function savePayout(requestId, payout) {
  const state = read();
  state.payouts[requestId] = { ...(state.payouts[requestId] || {}), ...payout };
  write(state);
  return state.payouts[requestId];
}

export function getPayout(requestId) {
  return read().payouts[requestId] ?? null;
}

/** `on_change_callback` ile gelen son durum — polling'e göre daha hızlı. */
export function saveAnchorStatus(anchorTxId, transaction) {
  const state = read();
  state.anchorStatus[anchorTxId] = {
    status: transaction.status,
    externalTransactionId: transaction.external_transaction_id ?? null,
    amountOut: transaction.amount_out ?? null,
    updatedAt: new Date().toISOString(),
  };
  write(state);
}

export function getAnchorStatus(anchorTxId) {
  return read().anchorStatus[anchorTxId] ?? null;
}
