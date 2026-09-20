/**
 * Supplier ledger and payout status — SERVER SIDE.
 *
 * A plain IBAN is never written to the ledger; only
 * `supplier_ref = sha256(iban|salt)` goes on-chain. The IBAN ↔ supplier_ref ↔
 * SEP-10 memo mapping is kept here (plan 5.2).
 *
 * TWO DRIVERS
 *   redis  — Upstash REST. The ONLY option that works on Vercel: the serverless
 *            file system is read-only and every invocation is a separate lambda,
 *            so a supplier written to a file is gone on the next request.
 *   file   — for localhost. Zero setup, works with `npm run dev`.
 *
 * The driver is picked from env; without the Upstash variables it falls back to
 * the file. The whole API is async — Redis cannot be synchronous and every
 * caller is an async route anyway.
 */

import { createHash, randomBytes } from 'node:crypto';

const REDIS_URL =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || null;
const REDIS_TOKEN =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || null;

const K = {
  seq: 'poa:supplier-seq',
  supplier: (ref) => `poa:supplier:${ref.toLowerCase()}`,
  supplierByIban: (iban) => `poa:supplier-iban:${iban}`,
  supplierIndex: 'poa:supplier-index',
  note: (id) => `poa:note:${id}`,
  payout: (id) => `poa:payout:${id}`,
  payoutLock: (id) => `poa:payout-lock:${id}`,
  /// An anchor callback only knows its own tx id; this bridge maps it back to the request.
  requestOfAnchorTx: (txId) => `poa:anchor-ref:${txId}`,
};

const FIRST_SUPPLIER_ID = 77100;

/* --------------------------------- drivers -------------------------------- */

function redisDriver() {
  /** Upstash REST: the command is POSTed as a JSON array. No extra dependency. */
  async function cmd(...command) {
    const res = await fetch(REDIS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command),
      cache: 'no-store',
    });
    const body = await res.json();
    if (!res.ok || body.error) {
      throw new Error(`Redis ${command[0]} → ${body.error || res.status}`);
    }
    return body.result;
  }

  return {
    async getJson(key) {
      const raw = await cmd('GET', key);
      return raw ? JSON.parse(raw) : null;
    },
    async setJson(key, value) {
      await cmd('SET', key, JSON.stringify(value));
      return value;
    },
    async setStr(key, value) {
      await cmd('SET', key, value);
    },
    async getStr(key) {
      return cmd('GET', key);
    },
    async nextId() {
      return FIRST_SUPPLIER_ID + Number(await cmd('INCR', K.seq));
    },
    async addToIndex(ref) {
      await cmd('SADD', K.supplierIndex, ref);
    },
    async listIndex() {
      return (await cmd('SMEMBERS', K.supplierIndex)) || [];
    },
    /** Atomic lock — thanks to `NX` only one of two concurrent requests takes it. */
    async acquireLock(key, ttlSeconds) {
      return (await cmd('SET', key, '1', 'NX', 'EX', String(ttlSeconds))) === 'OK';
    },
    async releaseLock(key) {
      await cmd('DEL', key);
    },
  };
}

function fileDriver() {
  const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
  const { dirname, join } = require('node:path');

  const FILE = join(process.cwd(), 'data', 'store.json');
  const empty = () => ({ kv: {}, index: [], seq: 0 });

  /**
   * Migrates the old store.json shape ({suppliers, payouts, notes,
   * nextSupplierId}) into `kv`. Without it, requests opened back then report
   * "supplier not registered" and, worse, paid requests look unpaid and can be
   * sent to the off-ramp a second time. Existing `kv` keys are never overwritten.
   */
  const migrate = (s) => {
    if (!Array.isArray(s.suppliers)) return s;
    const put = (key, value) => {
      if (s.kv[key] === undefined) s.kv[key] = value;
    };
    for (const sup of s.suppliers) {
      put(K.supplier(sup.supplierRef), sup);
      put(K.supplierByIban(sup.iban), sup.supplierRef);
      s.index = [...new Set([...s.index, sup.supplierRef])];
    }
    for (const [id, old] of Object.entries(s.payouts || {})) {
      // The old version only wrote on `completed` and kept no `status`/`supplierId`;
      // both are needed on the new GET path.
      const payout = {
        ...old,
        status: old.status ?? (old.bankReference ? 'completed' : undefined),
        supplierId: old.supplierId ?? (Number(String(old.sub || '').split(':')[1]) || undefined),
      };
      put(K.payout(id), payout);
      if (payout.anchorTransactionId) put(K.requestOfAnchorTx(payout.anchorTransactionId), id);
    }
    for (const [id, note] of Object.entries(s.notes || {})) put(K.note(id), note);
    if (s.nextSupplierId) s.seq = Math.max(s.seq, s.nextSupplierId - FIRST_SUPPLIER_ID);

    const { suppliers, payouts, notes, anchorStatus, nextSupplierId, ...rest } = s;
    write(rest);
    return rest;
  };

  const read = () => {
    let raw;
    try {
      raw = JSON.parse(readFileSync(FILE, 'utf8'));
    } catch {
      return empty();
    }
    return migrate({ ...empty(), ...raw });
  };
  const write = (state) => {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(state, null, 2));
  };

  return {
    async getJson(key) {
      const v = read().kv[key];
      return v === undefined ? null : v;
    },
    async setJson(key, value) {
      const s = read();
      s.kv[key] = value;
      write(s);
      return value;
    },
    async setStr(key, value) {
      const s = read();
      s.kv[key] = value;
      write(s);
    },
    async getStr(key) {
      const v = read().kv[key];
      return v === undefined ? null : v;
    },
    async nextId() {
      const s = read();
      s.seq = (s.seq || 0) + 1;
      write(s);
      return FIRST_SUPPLIER_ID + s.seq;
    },
    async addToIndex(ref) {
      const s = read();
      s.index = [...new Set([...(s.index || []), ref])];
      write(s);
    },
    async listIndex() {
      return read().index || [];
    },
    // Good enough in a single process; not atomic like Redis, but the file driver
    // is only ever used on localhost.
    async acquireLock(key, ttlSeconds) {
      const s = read();
      const held = s.kv[key];
      if (held && Date.now() - held < ttlSeconds * 1000) return false;
      s.kv[key] = Date.now();
      write(s);
      return true;
    },
    async releaseLock(key) {
      const s = read();
      delete s.kv[key];
      write(s);
    },
  };
}

const usingRedis = Boolean(REDIS_URL && REDIS_TOKEN);
const db = usingRedis ? redisDriver() : fileDriver();

/** So routes can diagnose the "why is the live demo empty" question. */
export const storeBackend = usingRedis ? 'redis' : 'file';

/* -------------------------------- supplier -------------------------------- */

/** The salted hash goes on-chain, never the IBAN itself. */
function supplierRefOf(iban, salt) {
  return createHash('sha256').update(`${iban}|${salt}`).digest('hex');
}

export async function registerSupplierRecord({ name, iban }) {
  const existingRef = await db.getStr(K.supplierByIban(iban));
  if (existingRef) {
    const existing = await db.getJson(K.supplier(existingRef));
    if (existing) return existing;
  }

  const salt = randomBytes(16).toString('hex');
  const supplierRef = supplierRefOf(iban, salt);
  const record = {
    supplierId: await db.nextId(),
    supplierRef,
    salt,
    iban,
    name,
    createdAt: new Date().toISOString(),
  };

  await db.setJson(K.supplier(supplierRef), record);
  await db.setStr(K.supplierByIban(iban), supplierRef);
  await db.addToIndex(supplierRef);
  return record;
}

export async function findBySupplierRef(supplierRef) {
  return db.getJson(K.supplier(String(supplierRef)));
}

export async function listSuppliers() {
  const refs = await db.listIndex();
  const records = await Promise.all(refs.map((r) => db.getJson(K.supplier(r))));
  // The IBAN and the salt are never handed out.
  return records
    .filter(Boolean)
    .map(({ supplierId, supplierRef, name, createdAt }) => ({
      supplierId,
      supplierRef,
      name,
      createdAt,
    }));
}

/* ------------------------------- request note ----------------------------- */

/**
 * The need description, the supplier name and the **TRY requested**. On-chain
 * there is only the USDC amount and two hashes; without recording the TRY at
 * request time, the audit trail cannot compare "how much was asked" against
 * "how much was paid".
 */
export async function saveRequestNote(requestId, note) {
  const key = K.note(requestId);
  const merged = { ...((await db.getJson(key)) || {}), ...note };
  return db.setJson(key, merged);
}

export async function getRequestNote(requestId) {
  return db.getJson(K.note(requestId));
}

/* ------------------------------ payout records ---------------------------- */

export async function savePayout(requestId, payout) {
  const key = K.payout(requestId);
  const merged = { ...((await db.getJson(key)) || {}), ...payout };
  await db.setJson(key, merged);

  // A callback carries only the anchor tx id; this is the bridge back to the request.
  if (payout.anchorTransactionId) {
    await db.setStr(K.requestOfAnchorTx(payout.anchorTransactionId), String(requestId));
  }
  return merged;
}

export async function getPayout(requestId) {
  return db.getJson(K.payout(requestId));
}

/**
 * Stops a second off-ramp from being started for the same request.
 *
 * The `completed` check was not enough on its own: once the on-chain payout is
 * done, two concurrent POSTs to `/api/payout` would both pass the check and open
 * two separate withdrawals. The lock is taken atomically with `SET NX`.
 */
export async function acquirePayoutLock(requestId, ttlSeconds = 600) {
  return db.acquireLock(K.payoutLock(requestId), ttlSeconds);
}

export async function releasePayoutLock(requestId) {
  return db.releaseLock(K.payoutLock(requestId));
}

/* ----------------------------- anchor callback ---------------------------- */

/**
 * Status arriving via `on_change_callback`. Faster than polling and the main path
 * on Vercel — but only the anchor tx id comes with it, so we first resolve which
 * request it belongs to and merge it into that payout record. It used to be
 * written under a separate key that no screen ever read.
 */
export async function saveAnchorStatus(anchorTxId, transaction) {
  const update = {
    status: transaction.status,
    bankReference: transaction.external_transaction_id ?? null,
    tryPaid: transaction.amount_out ?? null,
    updatedAt: new Date().toISOString(),
  };

  const requestId = await db.getStr(K.requestOfAnchorTx(anchorTxId));
  if (requestId === null) return { ...update, requestId: null };

  const key = K.payout(requestId);
  const merged = { ...((await db.getJson(key)) || {}), ...update };
  await db.setJson(key, merged);
  return { ...merged, requestId };
}

/** Build the bridge as soon as the payout starts — the callback can arrive before
 * the withdrawal returns. */
export async function linkAnchorTransaction(anchorTxId, requestId) {
  await db.setStr(K.requestOfAnchorTx(anchorTxId), String(requestId));
}
