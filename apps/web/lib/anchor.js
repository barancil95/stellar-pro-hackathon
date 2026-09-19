/**
 * TR Mock Anchor istemcisi — SEP-1/10/12/38/6.
 *
 * Elle yazıldı: @stellar/typescript-wallet-sdk tarayıcı için bundle'lanmış
 * (stellar-sdk 13.0.0-beta.1'e pinli) ve Node'da import edilemiyor.
 *
 * Hiçbir endpoint hardcode edilmez — hepsi /health'ten okunur.
 */

import { TransactionBuilder } from '@stellar/stellar-sdk';

const HOME_DOMAIN =
  process.env.NEXT_PUBLIC_ANCHOR_HOME_DOMAIN ||
  process.env.ANCHOR_HOME_DOMAIN ||
  'tr-mock-anchor.fly.dev';
const BASE = `https://${HOME_DOMAIN}`;

let healthCache = null;

/** /health — issuer, endpoint'ler, treasury, kurlar, limitler. */
export async function health({ fresh = false } = {}) {
  if (healthCache && !fresh) return healthCache;
  healthCache = await request(`${BASE}/health`);
  return healthCache;
}

async function request(url, options = {}) {
  const res = await fetch(url, options);
  const body = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = { raw: body };
  }
  if (!res.ok) {
    const err = new Error(
      `${options.method || 'GET'} ${url} → ${res.status}: ${parsed.error || body.slice(0, 200)}`,
    );
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

const authHeader = (token) => ({ Authorization: `Bearer ${token}` });

/**
 * SEP-10. `memo` verilirse JWT'nin sub'ı "G…:memo" olur — aynı Stellar hesabı
 * altında ayrı müşteri kimliği. Tedarikçi başına IBAN kaydı bunun üzerine kurulu
 * (bkz. plan 5.2); memo'suz auth yaparsak TRY relayer'ın IBAN'ına gider.
 */
export async function sep10Authenticate(keypair, { memo, clientDomain } = {}) {
  const h = await health();
  const url = new URL(h.sep.web_auth_endpoint);
  url.searchParams.set('account', keypair.publicKey());
  if (memo !== undefined && memo !== null) url.searchParams.set('memo', String(memo));
  if (clientDomain) url.searchParams.set('client_domain', clientDomain);

  const challenge = await request(url.toString());
  const tx = TransactionBuilder.fromXDR(
    challenge.transaction,
    challenge.network_passphrase || h.network_passphrase,
  );
  tx.sign(keypair);

  const { token } = await request(challenge.endpoint || h.sep.web_auth_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transaction: tx.toXDR() }),
  });
  return token;
}

/**
 * JWT süresi dolmuşsa (401/403) bir kez yeniden auth edip tekrar dener.
 * Plan M2: "SEP-10 auth, 401'de otomatik yenileme".
 */
export function makeSession(keypair, { memo } = {}) {
  let token = null;
  const refresh = async () => {
    token = await sep10Authenticate(keypair, { memo });
    return token;
  };
  return {
    get sub() {
      return memo === undefined ? keypair.publicKey() : `${keypair.publicKey()}:${memo}`;
    },
    async token() {
      return token || refresh();
    },
    async call(fn) {
      try {
        return await fn(await this.token());
      } catch (e) {
        if (e.status !== 401 && e.status !== 403) throw e;
        return fn(await refresh());
      }
    },
  };
}

/* ------------------------------- SEP-12 KYC ------------------------------ */

export async function getCustomer(token) {
  const h = await health();
  return request(`${h.sep.kyc_server}/customer`, { headers: authHeader(token) });
}

/**
 * Herhangi bir PUT müşteriyi ACCEPTED yapar. `bank_account_number` Türk IBAN'ı
 * ise mod-97 doğrulanır ve payout'ta kullanılır; gönderilmezse anchor
 * deterministik bir sandbox IBAN'ı atar.
 */
export async function putCustomer(token, fields = {}) {
  const h = await health();
  return request(`${h.sep.kyc_server}/customer`, {
    method: 'PUT',
    headers: { ...authHeader(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
}

/* ------------------------------ SEP-38 quote ----------------------------- */

export async function assetIds() {
  const h = await health();
  return {
    usdc: `stellar:USDC:${h.asset.issuer}`,
    try: 'iso4217:TRY',
  };
}

/** Gösterge fiyat — auth gerektirmez, UI için. */
export async function indicativePrice({ sellAsset, buyAsset, sellAmount, buyAmount }) {
  const h = await health();
  const url = new URL(`${h.sep.anchor_quote_server}/price`);
  url.searchParams.set('sell_asset', sellAsset);
  url.searchParams.set('buy_asset', buyAsset);
  if (sellAmount) url.searchParams.set('sell_amount', String(sellAmount));
  if (buyAmount) url.searchParams.set('buy_amount', String(buyAmount));
  url.searchParams.set('context', 'sep6');
  return request(url.toString());
}

/** Firm quote — tek kullanımlık, varsayılan 15 dk geçerli. */
export async function firmQuote(token, { sellAsset, buyAsset, sellAmount, buyAmount }) {
  const h = await health();
  const body = { sell_asset: sellAsset, buy_asset: buyAsset, context: 'sep6' };
  if (sellAmount) body.sell_amount = String(sellAmount);
  if (buyAmount) body.buy_amount = String(buyAmount);
  return request(`${h.sep.anchor_quote_server}/quote`, {
    method: 'POST',
    headers: { ...authHeader(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/* ------------------------- SEP-6 deposit / withdraw ---------------------- */

export async function sep6Info() {
  const h = await health();
  return request(`${h.sep.transfer_server}/info`);
}

export async function deposit(token, { account, amount, quoteId, onChangeCallback }) {
  const h = await health();
  const url = new URL(`${h.sep.transfer_server}/deposit`);
  url.searchParams.set('asset_code', 'USDC');
  url.searchParams.set('account', account);
  url.searchParams.set('funding_method', 'bank_account');
  if (amount) url.searchParams.set('amount', String(amount));
  if (quoteId) url.searchParams.set('quote_id', quoteId);
  if (onChangeCallback) url.searchParams.set('on_change_callback', onChangeCallback);
  return request(url.toString(), { headers: authHeader(token) });
}

/**
 * Off-ramp. Dönen account_id + memo'ya USDC gönderilir; TRY, SEP-12'de kayıtlı
 * IBAN'a ödenir. Memo mutlaka Memo.id olmalı.
 */
export async function withdraw(token, { amount, quoteId, onChangeCallback }) {
  const h = await health();
  const url = new URL(`${h.sep.transfer_server}/withdraw`);
  url.searchParams.set('asset_code', 'USDC');
  url.searchParams.set('funding_method', 'bank_account');
  if (amount) url.searchParams.set('amount', String(amount));
  if (quoteId) url.searchParams.set('quote_id', quoteId);
  if (onChangeCallback) url.searchParams.set('on_change_callback', onChangeCallback);
  return request(url.toString(), { headers: authHeader(token) });
}

/** Fiyatlamayı açık yapan varyant — talepler TRY cinsinden geldiği için bunu kullanıyoruz. */
export async function withdrawExchange(token, { sellAmount, quoteId, onChangeCallback }) {
  const h = await health();
  const ids = await assetIds();
  const url = new URL(`${h.sep.transfer_server}/withdraw-exchange`);
  url.searchParams.set('source_asset', ids.usdc);
  url.searchParams.set('destination_asset', ids.try);
  url.searchParams.set('amount', String(sellAmount));
  url.searchParams.set('funding_method', 'bank_account');
  if (quoteId) url.searchParams.set('quote_id', quoteId);
  if (onChangeCallback) url.searchParams.set('on_change_callback', onChangeCallback);
  return request(url.toString(), { headers: authHeader(token) });
}

/** Sandbox'a özel: gerçekte bu, bankadan gelen TRY transferidir. */
export async function simulateBankTransfer(txId, amount) {
  const h = await health();
  return request(`${h.sep.transfer_server}/tx/${txId}/simulate-bank-transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: String(amount) }),
  });
}

export async function getTransaction(token, id) {
  const h = await health();
  const url = new URL(`${h.sep.transfer_server}/transaction`);
  url.searchParams.set('id', id);
  const { transaction } = await request(url.toString(), { headers: authHeader(token) });
  return transaction;
}

const TERMINAL = new Set(['completed', 'error', 'refunded']);

/**
 * Durum takibi. on_change_callback asıl yol, bu yedek (plan 5.7).
 * On-ramp 3 sn, off-ramp tespiti 5 sn kadence'ında çalışıyor.
 */
export async function pollTransaction(session, id, { timeoutMs = 120000, intervalMs = 3000, onUpdate } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const tx = await session.call((t) => getTransaction(t, id));
    if (tx.status !== last) {
      last = tx.status;
      onUpdate?.(tx);
    }
    if (TERMINAL.has(tx.status)) return tx;
    if (Date.now() > deadline) {
      const err = new Error(`Transaction ${id} ${timeoutMs}ms içinde bitmedi (son durum: ${tx.status})`);
      err.transaction = tx;
      throw err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
