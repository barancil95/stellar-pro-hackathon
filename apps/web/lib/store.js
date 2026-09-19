/**
 * Tedarikçi kayıt defteri ve ödeme durumu — SUNUCU TARAFI.
 *
 * Düz IBAN ledger'a yazılmaz; zincirde yalnızca `supplier_ref = sha256(iban|salt)`
 * durur. IBAN ↔ supplier_ref ↔ SEP-10 memo eşleşmesi burada tutulur (plan 5.2).
 *
 * İKİ SÜRÜCÜ
 *   redis  — Upstash REST. Vercel'de TEK çalışan seçenek: serverless dosya
 *            sistemi salt okunur ve her invocation ayrı lambda, yani dosyaya
 *            yazılan tedarikçi bir sonraki istekte yok olur.
 *   file   — localhost için. Sıfır kurulum, `npm run dev` ile çalışır.
 *
 * Sürücü env'den seçilir; Upstash değişkenleri yoksa dosyaya düşer. Bütün API
 * async — Redis senkron olamaz ve çağıranların hepsi zaten async route.
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
  /// Anchor callback'i yalnızca kendi tx id'sini biliyor; talebe bu köprüyle döner.
  requestOfAnchorTx: (txId) => `poa:anchor-ref:${txId}`,
};

const FIRST_SUPPLIER_ID = 77100;

/* -------------------------------- sürücüler ------------------------------- */

function redisDriver() {
  /** Upstash REST: komut JSON dizisi olarak POST edilir. Ek bağımlılık yok. */
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
    /** Atomik kilit — `NX` sayesinde iki eşzamanlı istekten yalnızca biri alır. */
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
   * Eski sürümün store.json'ı ({suppliers, payouts, notes, nextSupplierId})
   * `kv`'ye taşınır. Taşınmazsa o dönemde açılmış talepler "tedarikçi kayıtlı
   * değil" verir, daha kötüsü ödenmiş talepler ödenmemiş görünür ve ikinci kez
   * off-ramp'e açılabilir. Mevcut `kv` anahtarlarının üzerine yazılmaz.
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
      // Eski sürüm yalnızca `completed` olunca yazıyordu ve `status`/`supplierId`
      // tutmuyordu; ikisi de yeni GET yolunda gerekli.
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
    // Tek süreçte yeterli; Redis'teki gibi atomik değil ama file sürücüsü
    // zaten yalnızca localhost'ta kullanılıyor.
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

/** Route'ların "live demo neden boş" sorusunu teşhis edebilmesi için. */
export const storeBackend = usingRedis ? 'redis' : 'file';

/* ------------------------------- tedarikçi -------------------------------- */

/** IBAN'ın kendisi değil, tuzlanmış hash'i zincire gider. */
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
  // IBAN ve salt dışarı verilmez.
  return records
    .filter(Boolean)
    .map(({ supplierId, supplierRef, name, createdAt }) => ({
      supplierId,
      supplierRef,
      name,
      createdAt,
    }));
}

/* -------------------------------- talep notu ------------------------------ */

/**
 * İhtiyaç açıklaması, tedarikçi adı ve **talep edilen TRY**. Zincirde yalnızca
 * USDC tutarı ve iki hash var; talep anındaki TRY'yi buraya yazmazsak denetim
 * izinde "ne kadar istendi / ne kadar ödendi" karşılaştırması yapılamaz.
 */
export async function saveRequestNote(requestId, note) {
  const key = K.note(requestId);
  const merged = { ...((await db.getJson(key)) || {}), ...note };
  return db.setJson(key, merged);
}

export async function getRequestNote(requestId) {
  return db.getJson(K.note(requestId));
}

/* ------------------------------ ödeme kayıtları --------------------------- */

export async function savePayout(requestId, payout) {
  const key = K.payout(requestId);
  const merged = { ...((await db.getJson(key)) || {}), ...payout };
  await db.setJson(key, merged);

  // Callback yalnızca anchor tx id'sini taşıyor; talebe dönebilmek için köprü.
  if (payout.anchorTransactionId) {
    await db.setStr(K.requestOfAnchorTx(payout.anchorTransactionId), String(requestId));
  }
  return merged;
}

export async function getPayout(requestId) {
  return db.getJson(K.payout(requestId));
}

/**
 * Aynı talep için ikinci bir off-ramp başlatılmasını engeller.
 *
 * `completed` kontrolü tek başına yetmiyordu: zincirde ödeme tamamlandıktan
 * sonra `/api/payout`'a iki eşzamanlı POST gelirse ikisi de kontrolü geçip
 * iki ayrı withdraw açardı. Kilit `SET NX` ile atomik alınıyor.
 */
export async function acquirePayoutLock(requestId, ttlSeconds = 600) {
  return db.acquireLock(K.payoutLock(requestId), ttlSeconds);
}

export async function releasePayoutLock(requestId) {
  return db.releaseLock(K.payoutLock(requestId));
}

/* ----------------------------- anchor callback ---------------------------- */

/**
 * `on_change_callback` ile gelen durum. Polling'e göre hızlı ve Vercel'de
 * asıl yol — ama yalnızca anchor tx id'si geliyor, o yüzden önce hangi talebe
 * ait olduğu bulunup ödeme kaydının üzerine yazılıyor. Eskiden ayrı bir
 * anahtara yazılıyordu ve hiçbir ekran onu okumuyordu.
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

/** Ödeme başlar başlamaz köprüyü kur — callback withdraw'dan önce gelebilir. */
export async function linkAnchorTransaction(anchorTxId, requestId) {
  await db.setStr(K.requestOfAnchorTx(anchorTxId), String(requestId));
}
