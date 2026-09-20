# Stellar Mock Anchor Integration Skill

You are a Stellar developer assistant. Your job is to integrate the developer's
application with the **TR Mock Anchor** (a testnet TRY/USDC on/off-ramp).

> **Version note.** This file was verified against `@stellar/stellar-sdk` **v14**.
> The corrections below were measured with real calls while building
> Proof-of-Action; the examples in the earlier version blew up on the first line
> under v14.

## Mock Anchor details

```
Home Domain: tr-mock-anchor.fly.dev
Network: Stellar Testnet
Network Passphrase: "Test SDF Network ; September 2015"
Asset: USDC
USDC Issuer: GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
Treasury: GCLCZEQZ2THTEDAOFI66LACNPLY4OBKN7VKLEZFMBIHYKYQOW2W7T3Z6
Signing Key: GDXYO6FJCNXZEWGXD54GT76FGFYLOLSOGSOJLNQ6WGHCGEQPO7NTE73M
```

⚠️ Do **not hardcode** these. The sandbox can be reset before the event and the
addresses can change. They are all read from `GET /health` — no auth, CORS open:

```js
const h = await fetch('https://tr-mock-anchor.fly.dev/health').then(r => r.json());
h.asset.issuer            // the USDC issuer
h.sep.web_auth_endpoint   // /auth
h.sep.transfer_server     // /sep6
h.sep.kyc_server          // /sep12
h.sep.anchor_quote_server // /sep38
h.sep.signing_key         // for callback signature verification
h.treasury.address        // the withdrawal destination
h.treasury.low_balance    // when true, the on-ramp will wait
h.rates.buy_rate / h.rates.sell_rate
h.limits                  // min/max — see the note below
```

## Endpoints

```
stellar.toml:  GET  https://tr-mock-anchor.fly.dev/.well-known/stellar.toml
SEP-10 Auth:   GET  https://tr-mock-anchor.fly.dev/auth?account={G...}[&memo={id}]
SEP-10 Token:  POST https://tr-mock-anchor.fly.dev/auth
SEP-12 KYC:         https://tr-mock-anchor.fly.dev/sep12
SEP-38 Quote:       https://tr-mock-anchor.fly.dev/sep38
SEP-6 Transfer:     https://tr-mock-anchor.fly.dev/sep6
Health:        GET  https://tr-mock-anchor.fly.dev/health
```

## Limits and formats

- **Limits are read from `/health`.** When measured, `min_onramp_try`,
  `max_onramp_try` and `min_offramp_usdc` all came back **`null`** — meaning no
  limit is enforced. Write code that assumes `null` is possible; do **not assume** a
  fixed 50/3000 TRY ceiling.
- The documented off-ramp minimum is 1 USDC.
- TRY: 2 decimal places · USDC: 7 decimal places
- Rate source: Reflector oracle plus a 50 bps spread (in both directions)
- Carry amounts as **strings**. Use floats and you lose cents.

## Integration flow

### 1. Discover stellar.toml (SEP-1)

```js
import { StellarToml } from '@stellar/stellar-sdk';

// ⚠️ There is NO `StellarTomlResolver` export in v14.
const toml = await StellarToml.Resolver.resolve('tr-mock-anchor.fly.dev');
// toml.WEB_AUTH_ENDPOINT / TRANSFER_SERVER / KYC_SERVER / ANCHOR_QUOTE_SERVER
// toml.SIGNING_KEY · toml.CURRENCIES[0].issuer
```

### 2. Authentication (SEP-10)

```js
import { TransactionBuilder, Keypair, Networks } from '@stellar/stellar-sdk';

const keypair = Keypair.fromSecret(SECRET_KEY);

const challenge = await fetch(
  `https://tr-mock-anchor.fly.dev/auth?account=${keypair.publicKey()}`
).then(r => r.json());

const tx = TransactionBuilder.fromXDR(challenge.transaction, Networks.TESTNET);
tx.sign(keypair);

const { token } = await fetch('https://tr-mock-anchor.fly.dev/auth', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ transaction: tx.toXDR() }),
}).then(r => r.json());
// On every subsequent request: Authorization: Bearer ${token}
```

When the JWT expires you get a 401/403. **Write automatic renewal** — holding a
single token breaks in the middle of long flows.

### 2b. ⚠️ Memo-scoped identity — whose IBAN the TRY goes to

This is the **most critical and most easily missed** detail of the off-ramp.

The off-ramp pays the TRY to the IBAN in the SEP-12 record of **whichever identity
did the SEP-10 auth**. If you pay multiple suppliers from a single service account
(a relayer, say) and authenticate without a memo, **the money always goes to that
service account's IBAN** — not the supplier's.

The fix: a customer identity scoped with `&memo=`. The JWT's `sub` becomes
`G…:memo` and the anchor counts it as a separate customer.

```js
// A separate identity per supplier — one Stellar account, many customers
const url = `https://tr-mock-anchor.fly.dev/auth` +
            `?account=${servicePublicKey}&memo=${supplierId}`;   // supplierId: uint64
// → JWT sub = "GABC…XYZ:77001"

// The SEP-12 PUT and SEP-6 withdrawal made with this token bind to THAT supplier
```

The measured result — two suppliers, two separate IBANs, correctly routed:

| memo | JWT sub | The anchor's `to` field |
|---|---|---|
| 77001 | `GBML…:77001` | `TR3200100099999012345678 90` |
| 77002 | `GBML…:77002` | `TR9700062011110000066723 15` |

### 3. KYC (SEP-12)

⚠️ **"It is approved automatically, no extra work needed" is NOT TRUE.**

A new user is in the `NEEDS_INFO` state. **Any** `PUT` — even an empty JSON body —
moves them to `ACCEPTED`. Without a PUT, the off-ramp payout goes to the
**deterministic sandbox IBAN** the anchor assigns, not the IBAN you wanted.

```js
// A Turkish IBAN, if sent, is mod-97 validated and IS USED at payout time
await fetch('https://tr-mock-anchor.fly.dev/sep12/customer', {
  method: 'PUT',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ bank_account_number: 'TR320010009999901234567890' }),
});

// Check the status
const customer = await fetch('https://tr-mock-anchor.fly.dev/sep12/customer', {
  headers: { Authorization: `Bearer ${token}` },
}).then(r => r.json());
// customer.status: "NEEDS_INFO" → "ACCEPTED" after the PUT
```

`GET /sep12/customer` does **not reflect back** the saved IBAN. To verify it, look
at the `to` field of the off-ramp transaction.

ID numbers, dates of birth and documents are discarded the moment they arrive; they
are not stored.

### 4. SEP-6 Info

```js
const info = await fetch('https://tr-mock-anchor.fly.dev/sep6/info').then(r => r.json());
// info.deposit.USDC / info.withdraw.USDC
// info['deposit-exchange'] / info['withdraw-exchange']
// info.features.claimable_balances
```

### 5. Deposit (TRY → USDC)

```js
const params = new URLSearchParams({
  asset_code: 'USDC',
  account: publicKey,
  funding_method: 'bank_account',   // `type=` is deprecated, use this
  amount: '1000',                    // TRY
});
const deposit = await fetch(
  `https://tr-mock-anchor.fly.dev/sep6/deposit?${params}`,
  { headers: { Authorization: `Bearer ${token}` } }
).then(r => r.json());

// The bank instructions are under `instructions`, in SEP-9 format:
deposit.instructions.bank_name.value              // "TR Mock Bank A.Ş."
deposit.instructions.bank_account_number.value    // the anchor's IBAN
deposit.instructions.external_transfer_memo.value // the reference for the transfer
deposit.more_info_url                             // a human page with a simulate button

// Simulate the bank transfer — MOCK ONLY. No auth required.
await fetch(
  `https://tr-mock-anchor.fly.dev/sep6/tx/${deposit.id}/simulate-bank-transfer`,
  { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: '1000' }) }
);

// Status
const { transaction } = await fetch(
  `https://tr-mock-anchor.fly.dev/sep6/transaction?id=${deposit.id}`,
  { headers: { Authorization: `Bearer ${token}` } }
).then(r => r.json());
```

**Deposit statuses:**

| Status | Meaning |
|---|---|
| `pending_user_transfer_start` | Waiting for the bank transfer (simulate it) |
| `pending_anchor` | TRY received, USDC being paid out |
| `pending_trust` | **The destination has no USDC trustline** — paid automatically once it is opened |
| `pending_stellar` | The send is being retried |
| `completed` | USDC sent, `stellar_transaction_id` is populated |
| `error` | Permanent failure, the TRY is refunded |

If you see `pending_reason: "treasury_low"`, wait — it resolves on its own.

### 6. Withdraw (USDC → TRY)

```js
import { Horizon, TransactionBuilder, Networks, Operation, Asset, Memo, BASE_FEE }
  from '@stellar/stellar-sdk';

const withdraw = await fetch(
  `https://tr-mock-anchor.fly.dev/sep6/withdraw?` + new URLSearchParams({
    asset_code: 'USDC',
    funding_method: 'bank_account',
    amount: '50',
  }),
  { headers: { Authorization: `Bearer ${token}` } }
).then(r => r.json());
// withdraw.account_id (treasury) · withdraw.memo · withdraw.memo_type === "id"

// ⚠️ There is NO `Server` export in v14 — use `Horizon.Server`.
const server = new Horizon.Server('https://horizon-testnet.stellar.org');
const USDC = new Asset('USDC', issuerFromHealth);

const account = await server.loadAccount(publicKey);
const paymentTx = new TransactionBuilder(account, {
  fee: BASE_FEE,
  networkPassphrase: Networks.TESTNET,
})
  .addOperation(Operation.payment({
    destination: withdraw.account_id,
    asset: USDC,
    amount: '50',
  }))
  .addMemo(Memo.id(String(withdraw.memo)))   // memo_type "id" is MANDATORY
  .setTimeout(60)
  .build();

paymentTx.sign(keypair);
await server.submitTransaction(paymentTx);
```

**Verify** that `withdraw.memo_type === 'id'` before sending. Money sent with no
memo or the wrong memo type cannot be attributed and the transaction never
completes.

The off-ramp converts whatever amount arrives — partial and excess payments also
complete. Only the memo has to be right.

### 6b. The exchange variants — when the amount is denominated in fiat

`deposit-exchange` / `withdraw-exchange` make the pricing explicit and let you bind
a `quote_id`.

⚠️ **The asset format differs here.** The on-chain leg is given as an **asset
code**, the off-chain leg in SEP-38 format:

```
# CORRECT
/sep6/withdraw-exchange?source_asset=USDC&destination_asset=iso4217:TRY&amount=5&quote_id=…

# WRONG → 400 "unsupported source_asset 'stellar:USDC:…'; this anchor ramps USDC"
/sep6/withdraw-exchange?source_asset=stellar:USDC:GBBD…&…
```

The SEP-38 format (`stellar:USDC:<issuer>`) is valid **only in `/sep38/*` calls**.

### 7. SEP-38 Quote

```js
// /prices and /price are PUBLIC — no auth needed
const price = await fetch(
  'https://tr-mock-anchor.fly.dev/sep38/price?' + new URLSearchParams({
    sell_asset: `stellar:USDC:${issuer}`,
    buy_asset: 'iso4217:TRY',
    buy_amount: '1500',       // either sell_amount or buy_amount
    context: 'sep6',
  })
).then(r => r.json());
// price.sell_amount → this much USDC is required

// A firm quote — needs a JWT, single-use, 15 minutes by default (up to an hour with expire_after)
const quote = await fetch('https://tr-mock-anchor.fly.dev/sep38/quote', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    sell_asset: `stellar:USDC:${issuer}`,
    buy_asset: 'iso4217:TRY',
    sell_amount: '5',
    context: 'sep6',
  }),
}).then(r => r.json());
// quote.id → pass it as quote_id on the deposit/withdrawal
```

**Suggested design:** show the user an **indicative** price when they make the
request (`/price`, no auth), and take a **firm** quote at transaction time
(`POST /quote`). The off-ramp rate is locked for 30 minutes, then repriced.

### 8. Transaction history

```js
// All transactions — kind=deposit|withdrawal, limit, no_older_than, paging_id
fetch('https://tr-mock-anchor.fly.dev/sep6/transactions?asset_code=USDC',
  { headers: { Authorization: `Bearer ${token}` } });

// A single transaction — by id, stellar_transaction_id or external_transaction_id
fetch(`https://tr-mock-anchor.fly.dev/sep6/transaction?id=${txId}`,
  { headers: { Authorization: `Bearer ${token}` } });
```

### 9. on_change_callback — push instead of polling

Add `on_change_callback=https://…` to the `deposit`/`withdraw` call and the anchor
POSTs `{"transaction": …}` on every status change.

**Write nothing before verifying the signature** — otherwise anyone can make up a
status:

```js
import { Keypair } from '@stellar/stellar-sdk';

const [, t, s] = /t=(\d+),\s*s=(.+)/.exec(req.headers['signature']);
const ok = Keypair.fromPublicKey(SIGNING_KEY).verify(
  Buffer.from(`${t}.${req.headers.host}.${rawBody}`),
  Buffer.from(s, 'base64'),
);
```

On localhost the anchor cannot reach you. **Keep polling as a fallback** (the
on-ramp runs on a 3 s cadence, off-ramp detection on 5 s).

## The USDC trustline

A user must open a trustline to receive USDC; without one the deposit waits in
`pending_trust`. As soon as the trustline is opened the anchor pays **by itself** —
you do not have to call anything else.

```js
import { Horizon, TransactionBuilder, Networks, Operation, Asset, Keypair, BASE_FEE }
  from '@stellar/stellar-sdk';

const server = new Horizon.Server('https://horizon-testnet.stellar.org');
const account = await server.loadAccount(publicKey);

const tx = new TransactionBuilder(account, {
  fee: BASE_FEE,
  networkPassphrase: Networks.TESTNET,
})
  .addOperation(Operation.changeTrust({ asset: new Asset('USDC', issuerFromHealth) }))
  .setTimeout(60)
  .build();

tx.sign(Keypair.fromSecret(SECRET_KEY));
await server.submitTransaction(tx);
```

Each trustline needs a **0.5 XLM** reserve; without it Horizon returns
`tx_insufficient_balance`.

## Funding testnet accounts

```js
await fetch(`https://friendbot.stellar.org?addr=${publicKey}`);   // XLM
```

**No Circle faucet is needed for USDC.** The anchor's own on-ramp hands out real
testnet USDC: SEP-10 → SEP-12 PUT → SEP-6 deposit → `simulate-bank-transfer` →
`completed`. The faucet (20 USDC per address per 2 hours) is only a fallback.

## Common errors

| Error | Cause | Fix |
|---|---|---|
| `Server is not a constructor` | There is no `Server` export in v14 | Use `Horizon.Server` |
| `StellarTomlResolver is undefined` | It was renamed in v14 | `StellarToml.Resolver.resolve()` |
| 401 / 403 | The JWT expired or is missing | Redo SEP-10, write automatic renewal |
| Stuck in `pending_trust` | The destination has no USDC trustline | `changeTrust` — the anchor handles the rest |
| The deposit never arrives | The bank transfer was not simulated | `POST /sep6/tx/{id}/simulate-bank-transfer` |
| `pending_reason: treasury_low` | The treasury is low | It resolves on its own, wait |
| The withdrawal never completes | The memo is missing or the wrong type | `Memo.id(String(memo))`, `memo_type: "id"` |
| **The TRY went to the wrong IBAN** | No memo scope, or no SEP-12 PUT was made | Sections 2b and 3 |
| `unsupported source_asset` | The SEP-38 format was used on an exchange call | `source_asset=USDC` (the code) |
| "Unsupported asset_code" | Wrong asset code | `USDC` (uppercase) |
| A limit error | A hardcoded ceiling | Read it from `/health`, it can be `null` |

## Important notes

- The Mock Anchor works on **testnet only**.
- KYC is simulated but **does not happen by itself** — at least one
  `PUT /sep12/customer` is required. Without sending the IBAN there, the payout goes
  to the sandbox IBAN.
- `simulate-bank-transfer` is **mock-specific**; with a real anchor an actual bank
  transfer does that job, which you observe rather than trigger.
- A deposit to an account without a trustline **does not create a claimable
  balance**, it waits in `pending_trust`. (`/sep6/info` advertises
  `features.claimable_balances: true`; that path is probably for accounts that were
  never created — in the funded-but-trustline-less scenario the measured behaviour
  is `pending_trust`.)
- **Never** put a secret key in the frontend. Do not commit `.env` to git.
- Every error response is in the `{"error": "..."}` format.
- A Soroban contract **cannot run the SEP flow by itself**: it has no keypair, it
  cannot sign a SEP-10 challenge, and it cannot make an HTTP request. The fiat leg
  needs an off-chain signer (a relayer).

## Asset format (SEP-38)

```
Fiat:    iso4217:TRY
Stellar: stellar:USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
```

This format is for `/sep38/*`. In the SEP-6 exchange variants the on-chain leg is
given as an **asset code** (section 6b).

## Compliance testing

```bash
# ⚠️ The package is `@stellar/anchor-tests` — `stellar-anchor-tests` returns 404.
npx @stellar/anchor-tests --home-domain https://tr-mock-anchor.fly.dev \
  --seps 1 10 12 6 38 --asset-code USDC --sep-config anchor-tests.config.json
```

The `sep-config` schema lives in the package's own `lib/schemas/config.js`. Note
that there is **no** SEP-10 section, `12.customers` wants at least 4 records,
`createCustomer`/`deleteCustomer` are **strings** (customer names),
`sameAccountDifferentMemos` is an array of two customer names, and `38` takes only
`contexts`.

## Useful links

- Mock Anchor: https://tr-mock-anchor.fly.dev
- SEP Demo (interactive): https://tr-mock-anchor.fly.dev/explorer
- Guide: https://tr-mock-anchor.fly.dev/guide
- Health: https://tr-mock-anchor.fly.dev/health
- Stellar Lab: https://lab.stellar.org
- Circle USDC Faucet: https://faucet.circle.com
- Stellar Developer Docs: https://developers.stellar.org
