/**
 * TR Mock Anchor client — SEP-1/10/12/38/6.
 *
 * Hand-written: @stellar/typescript-wallet-sdk is bundled for the browser (pinned
 * to stellar-sdk 13.0.0-beta.1) and cannot be imported on Node.
 *
 * No endpoint is hardcoded — they are all read from /health.
 */

import { TransactionBuilder } from '@stellar/stellar-sdk';

const HOME_DOMAIN =
  process.env.NEXT_PUBLIC_ANCHOR_HOME_DOMAIN ||
  process.env.ANCHOR_HOME_DOMAIN ||
  'tr-mock-anchor.fly.dev';
const BASE = `https://${HOME_DOMAIN}`;

let healthCache = null;

/** /health — issuer, endpoints, treasury, rates, limits. */
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
 * The signer arrives in one of two shapes: a `Keypair` on the server or in a
 * script, and a wallet in the browser — `{ publicKey, signTransaction }` (Wallets
 * Kit or the demo signer). This lets the SEP-10 challenge be signed by either.
 */
const addressOf = (signer) =>
  typeof signer.publicKey === 'function' ? signer.publicKey() : signer.publicKey;

async function signChallenge(signer, xdr, networkPassphrase) {
  if (typeof signer.signTransaction === 'function') {
    const { signedTxXdr } = await signer.signTransaction(xdr, { networkPassphrase });
    return signedTxXdr;
  }
  const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
  tx.sign(signer);
  return tx.toXDR();
}

/**
 * SEP-10. With a `memo`, the JWT's sub becomes "G…:memo" — a separate customer
 * identity under the same Stellar account. The per-supplier IBAN record is built
 * on this (see plan 5.2); authenticating without a memo sends the TRY to the
 * relayer's IBAN.
 */
export async function sep10Authenticate(signer, { memo, clientDomain } = {}) {
  const h = await health();
  const url = new URL(h.sep.web_auth_endpoint);
  url.searchParams.set('account', addressOf(signer));
  if (memo !== undefined && memo !== null) url.searchParams.set('memo', String(memo));
  if (clientDomain) url.searchParams.set('client_domain', clientDomain);

  const challenge = await request(url.toString());
  const signed = await signChallenge(
    signer,
    challenge.transaction,
    challenge.network_passphrase || h.network_passphrase,
  );

  const { token } = await request(challenge.endpoint || h.sep.web_auth_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transaction: signed }),
  });
  return token;
}

/**
 * If the JWT has expired (401/403), re-authenticates once and retries.
 * Plan M2: "SEP-10 auth, automatic renewal on 401".
 */
export function makeSession(signer, { memo } = {}) {
  let token = null;
  const refresh = async () => {
    token = await sep10Authenticate(signer, { memo });
    return token;
  };
  return {
    get sub() {
      return memo === undefined ? addressOf(signer) : `${addressOf(signer)}:${memo}`;
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

/* --------------------------------- limits -------------------------------- */

/**
 * The limits in `/health` can come back `null` — that means no limit is enforced.
 * Do NOT assume a fixed 50/3000 TRY ceiling (SKILL.md); enforce what you read.
 * All three were null when measured, but that can change when the sandbox resets.
 */
export async function assertOfframpAmount(usdcAmount) {
  const { limits } = await health();
  const min = limits?.min_offramp_usdc;
  if (min != null && Number(usdcAmount) < Number(min)) {
    throw new Error(
      `The off-ramp minimum is ${min} USDC — a withdrawal cannot be opened with ${usdcAmount} USDC`,
    );
  }
}

export async function assertOnrampAmount(tryAmount) {
  const { limits } = await health();
  const amount = Number(tryAmount);
  const min = limits?.min_onramp_try;
  const max = limits?.max_onramp_try;
  if (min != null && amount < Number(min)) {
    throw new Error(`The on-ramp minimum is ${min} TRY — ${tryAmount} TRY is not accepted`);
  }
  if (max != null && amount > Number(max)) {
    throw new Error(`The on-ramp maximum is ${max} TRY — ${tryAmount} TRY is not accepted`);
  }
}

/* ------------------------------- SEP-12 KYC ------------------------------ */

export async function getCustomer(token) {
  const h = await health();
  return request(`${h.sep.kyc_server}/customer`, { headers: authHeader(token) });
}

/**
 * Any PUT moves the customer to ACCEPTED. If `bank_account_number` is a Turkish
 * IBAN it is mod-97 validated and used at payout time; if it is omitted, the
 * anchor assigns a deterministic sandbox IBAN.
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

/** Indicative price — needs no auth, for the UI. */
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

/** Firm quote — single-use, valid for 15 minutes by default. */
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
 * Off-ramp. USDC is sent to the returned account_id + memo; the TRY is paid to the
 * IBAN registered in SEP-12. The memo must be a Memo.id.
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

/**
 * The variant that makes the pricing explicit — we use it because requests come
 * in denominated in TRY.
 *
 * ⚠️ `source_asset` is an **asset code** ("USDC"), NOT the SEP-38 format. In the
 * SEP-6 spec's exchange variants the on-chain leg is given as a code and the
 * off-chain leg in SEP-38 format. Plan 5.4 had it as `stellar:USDC:<issuer>`; the
 * anchor returned 400 "unsupported source_asset".
 */
export async function withdrawExchange(token, { sellAmount, quoteId, onChangeCallback }) {
  const h = await health();
  const ids = await assetIds();
  const url = new URL(`${h.sep.transfer_server}/withdraw-exchange`);
  url.searchParams.set('source_asset', 'USDC');
  url.searchParams.set('destination_asset', ids.try);
  url.searchParams.set('amount', String(sellAmount));
  url.searchParams.set('funding_method', 'bank_account');
  if (quoteId) url.searchParams.set('quote_id', quoteId);
  if (onChangeCallback) url.searchParams.set('on_change_callback', onChangeCallback);
  return request(url.toString(), { headers: authHeader(token) });
}

/** Sandbox-only: in reality this is the incoming TRY transfer from the bank. */
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
 * Status tracking. on_change_callback is the main path, this is the fallback
 * (plan 5.7). The on-ramp runs on a 3 s cadence, off-ramp detection on 5 s.
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
      const err = new Error(`Transaction ${id} did not settle within ${timeoutMs}ms (last status: ${tx.status})`);
      err.transaction = tx;
      throw err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
