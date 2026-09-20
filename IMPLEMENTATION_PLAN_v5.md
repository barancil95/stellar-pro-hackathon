# Proof-of-Action — Implementation Plan v5

> The working plan handed to Claude Code. Applied in order during the hackathon
> (19–20 September 2026). **The milestone order is not negotiable**; we do not move
> on until a milestone's acceptance criteria pass.
>
> v4 plus the DeFindex decision, now closed: **start without the vault, write it
> vault-ready.**

---

## 0. Context

**Tagline:** "Aid should move at the speed of crisis."

A Soroban-based protocol that, rather than parking donations collected during a
disaster in a central pool, moves them to verified actors in the field on proof of
need plus a 2-of-3 multisig approval. The goal is not a full-fledged aid system; it
is to show with a working MVP that an aid request is **traceable on-chain from
proof to payment**.

**Event:** Rise In × Stellar Pro Hackathon, Genesis Track. 36 hours, 4 people.

| # | Requirement | Our answer |
|---|---|---|
| 1 | **Integration** — a protocol from the list | **Stellar Wallets Kit** (`allowAllModules()`) · **DeFindex** if the vault lands |
| 2 | **Anchor / Local Payments** | **TR Mock Anchor** (SEP-1/10/12/38/6) |
| 3 | **Core Feature** — load-bearing | Remove the anchor and the product dies; without multi-wallet support the 2/3 approval does not work |

> Using Freighter alone does not satisfy #1 — Freighter is not on the curated list.
> Wallets Kit is mandatory; Freighter is a module underneath it.

**Deliverables:** a public repo plus README, a contract written with the Soroban SDK
and deployed to testnet, a working demo, a technical design document, a pitch deck
(a **copy** of the official template), and the paths of the skill files used.

---

## 1. Architecture

```
DONOR ──[Wallets Kit]──► USDC ──► POA ESCROW (Soroban, through the SAC)
                                        │        └─ (opt.) DeFindex vault
                  FIELD ACTOR ──────────┤ create_request + proof_hash
                                        │
        COORDINATOR A/B/C ──[Kit]───────┤ approve_request (2/3)
                                        │
                                        ▼ execute_payout
                            RELAYER HOT WALLET (backend, fixed address)
                                        │ SEP-10(memo) + SEP-12(IBAN) + SEP-6
                                        ▼ USDC + Memo.id → treasury
                                TR MOCK ANCHOR ──► TRY ──► SUPPLIER IBAN
```

**Why there is a relayer:** a Soroban contract has no keypair, cannot sign a SEP-10
challenge and cannot make an HTTP request.

**Our custody stance (this sentence belongs in the deck):** the on-chain part is
trustless — approval authority sits in a 2-of-3 multisig. Custody exists only on
the last metre of the fiat rail, and that metre already belongs to the bank.

---

## 2. Testnet requirements

**Everything is read from `/health`, nothing is hardcoded.**
`GET https://tr-mock-anchor.fly.dev/health` needs no auth and can be called from
the frontend:

```js
health.asset.issuer                  // the USDC issuer
health.sep.transfer_server           // /sep6
health.sep.web_auth_endpoint         // /auth
health.sep.kyc_server                // /sep12
health.sep.anchor_quote_server       // /sep38
health.sep.signing_key               // for callback signature verification
health.treasury.address              // the withdrawal destination
health.treasury.low_balance          // bool → when true, the on-ramp waits
health.rates.buy_rate / sell_rate    // for the TRY display (50 bps spread)
health.limits.min_onramp_try         // "50.00"
health.limits.max_onramp_try         // "3000"
health.limits.min_offramp_usdc       // "1.0000000"
```

| Field | Value |
|---|---|
| Network | Stellar Testnet · `Test SDF Network ; September 2015` |
| Home domain | `tr-mock-anchor.fly.dev` |
| Horizon | `https://horizon-testnet.stellar.org` |
| Soroban RPC | `https://soroban-testnet.stellar.org` |

> 🚨 **`GDXYO6FJ…` is the anchor's SEP-10 signing key — it is NOT THE RELAYER.**
> ```bash
> stellar keys generate relayer --network testnet
> stellar keys address relayer
> ```

**The USDC SAC address (M0's first job):**

```bash
stellar contract id asset \
  --asset USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 \
  --network testnet
```

> ⚠️ **The sandbox can be reset before the event.** The accounts and SEP-12 records
> you create today may be gone on Saturday morning. Do not skip M0.

---

## 3. Config

```bash
# .env.example — this is what goes into the repo, .env is NEVER committed
ANCHOR_HOME_DOMAIN=tr-mock-anchor.fly.dev
# endpoints and the issuer are read at runtime from /health or stellar.toml

HORIZON_URL=https://horizon-testnet.stellar.org
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"

USDC_SAC_ID=                  # derived in M0
POA_CONTRACT_ID=              # after the deploy
VAULT_ADDRESS=                # optional — empty means the vault is off

RELAYER_SECRET=               # backend-only, never leaks to the frontend
ADMIN_SECRET=
COORD_A_PUBLIC=
COORD_B_PUBLIC=
COORD_C_PUBLIC=

PUBLIC_BASE_URL=              # for on_change_callback (the Vercel URL)
IPFS_API_KEY=                 # optional — without it, the mock CID fallback
```

---

## 4. The contract surface — written vault-ready

### 4.1 Three design rules (they make adding the vault later cheap)

**1. The balance is kept in two separate fields.** Without a vault, `shares` stays
zero.

```rust
pub struct Campaign {
    pub principal: i128,   // total USDC deposited
    pub shares: i128,      // vault shares — 0 while the vault is off
}
```

**2. `initialize` takes the `vault_address` parameter FROM THE START.** Without a
vault it is passed as `None` on an `Option<Address>`. Adding a parameter later
breaks the deploy and every call.

**3. Balance reads are collected into a single function.**

```rust
fn available_balance(e: &Env) -> i128 {
    match vault_address(e) {
        None => usdc_client(e).balance(&e.current_contract_address()),
        Some(v) => shares_to_assets(e, &v, campaign(e).shares),
    }
}
```

When the vault arrives, only this function's body changes.

### 4.2 Data

```rust
pub struct DisbursementRequest {
    pub id: u64,
    pub supplier_ref: BytesN<32>,   // hash(iban + salt) — a plain IBAN is NEVER written to the ledger
    pub amount: i128,               // USDC, in SAC units (7 decimals)
    pub proof_hash: BytesN<32>,     // an IPFS CID or a mock SHA-256
    pub approvals_count: u32,
    pub completed: bool,
}
// Also: (request_id, coordinator) => bool — prevents double approval.
// Keeping only approvals_count is NOT ENOUGH.
```

### 4.3 Functions

```rust
fn initialize(env, admin, usdc_sac, relayer, coord_a, coord_b, coord_c,
              vault: Option<Address>);
fn deposit(env, from: Address, amount: i128);          // from.require_auth()
fn create_request(env, supplier_ref, amount, proof_hash) -> u64;
fn approve_request(env, coordinator: Address, request_id: u64);
    // coordinator.require_auth(); on the coord list?; already approved?
fn execute_payout(env, request_id: u64);
    // approvals_count >= 2 && !completed; funds → the FIXED relayer address
fn update_relayer(env, new_relayer: Address);          // admin.require_auth()
```

> 🔐 `execute_payout` does **not take the relayer address as a parameter**. If it
> did, the caller could redirect the funds anywhere after the 2/3 approvals.

**Events:** `deposit`, `request_created`, `request_approved`, `payout_executed`

> ⚠️ **Soroban storage TTL.** `persistent` storage has a lifetime and data can be
> lost unless it is extended. Put the `extend_ttl` call in from the start.

**Out of scope — do not debate it, do not write it:** an on-chain coordinator
whitelist, a configurable threshold (fixed at 2/3), partial payments, returns,
refunds, timeouts, closing a campaign, an upgrade pattern, DAO/governance,
microservices, WebSockets, live KYC.

---

## 5. The anchor integration — critical details

### 5.1 ⚠️ The Wallet SDK DOES NOT WORK — written by hand

`@stellar/typescript-wallet-sdk@1.10.0` **cannot be imported** on Node 26:

```
TypeError: Cannot read properties of undefined (reading 'prototype')
  at ./src/walletSdk/Types/auth.ts (lib/bundle.js)
```

The package's `main` is a single file bundled for the browser with webpack
(`https-browserify`, `stream-http`, `vm-browserify`) with
`@stellar/stellar-sdk@13.0.0-beta.1` embedded inside it. It clashes with the v14 we
use. Detected in 10 minutes during M0; the package was removed.

**Decided:** SEP-1/10/12/38/6 written directly against `@stellar/stellar-sdk` v14
plus `fetch` → [`apps/web/lib/anchor.js`](apps/web/lib/anchor.js) (~230 lines). Not
one endpoint is hardcoded, they are all read from `/health`. Verified against the
real testnet on-ramp.

### 5.2 ⚠️ Whose IBAN the TRY goes to — the architecture's most critical detail

The off-ramp pays **the IBAN registered in SEP-12** — that is, the IBAN of the
account that did the SEP-10 auth. If the relayer authenticates, the TRY goes to
**the relayer's** IBAN, not the supplier's.

**The fix — a memo-scoped customer record:**

```
1. GET /auth?account=<RELAYER_PUBLIC>&memo=<supplier_id>
   → the JWT's sub becomes "G…:memo", a separate customer identity
2. PUT /sep12/customer  { bank_account_number: "<supplier IBAN>" }
   → a Turkish IBAN is mod-97 validated and used for payouts
   → without it, the deterministic sandbox IBAN takes over
3. GET /sep6/withdraw-exchange  (with that token)
   → the payout goes to that supplier's IBAN
```

One relayer account, a separate customer record per supplier. The `supplier_ref` ↔
`supplier_id` mapping is kept in the backend.

### 5.3 `pending_trust` EXISTS — measured in M0 ⚠️ v5 had this wrong

**Observed behaviour (19 Sep 2026, `scripts/anchor-tour.js` step 6):** when the
destination account exists but has no USDC trustline, the deposit does **not** fall
into a claimable balance — it waits in `pending_trust`:

> `Add a USDC trustline to G…; the anchor pays the USDC once the trustline exists.`

As soon as the trustline is opened the anchor sends a plain `payment` **by itself**
and the transaction goes `completed`. No `claimClaimableBalance` call is **needed**.

`/sep6/info` still advertises `features.claimable_balances: true` (alongside
`account_creation: false`) — the claimable balance path is probably for accounts
that were never created. Tested in the funded-but-trustline-less scenario, with the
result above.

**The UI counterpart:** not a claim button but an **"Open a USDC trustline"**
button. Keep polling after the trustline; it goes `completed` on its own.

| Status | Deposit | Withdraw |
|---|---|---|
| `pending_user_transfer_start` | Waiting for TRY (simulate it) | Waiting for USDC with a memo |
| `pending_anchor` | TRY received, USDC being paid out | — |
| `pending_trust` | **No trustline at the destination — paid automatically once opened** | — |
| `pending_stellar` | The send is being retried | — |
| `completed` | `stellar_transaction_id` | `external_transaction_id` = the bank ref |
| `error` | Permanent failure, TRY refunded | Cancelled |

If it stalls with `pending_reason: treasury_low`, that resolves on its own.

### 5.4 The exchange variants

Requests are denominated in TRY → `/sep6/withdraw-exchange` and
`/sep6/deposit-exchange` make the pricing explicit and bind a `quote_id`.

⚠️ **v5 had this wrong.** In the exchange variants the **on-chain leg is given as
an asset code** and the off-chain leg in SEP-38 format. The SEP-38 format is valid
only in `/sep38/*` calls:

```
# CORRECT (measured in M2)
source_asset=USDC&destination_asset=iso4217:TRY&amount=…&quote_id=…

# WRONG → 400 "unsupported source_asset 'stellar:USDC:…'; this anchor ramps USDC"
source_asset=stellar:USDC:<issuer>&…
```

Use `funding_method=bank_account` — `type=bank_account` is deprecated.

### 5.5 The truth about quotes

A SEP-38 quote is valid for **15 minutes** (up to an hour with `expire_after`) and
is single-use. The off-ramp rate is locked for 30 minutes, then repriced.

**The design:** an indicative quote when the request is opened (UI), a firm quote at
payout time (the transaction).

The line for the judges: *"We know about FX risk; we show an indicative quote at
request time and take a firm quote at payout time. Slippage tolerance is on the
roadmap."*

### 5.6 The off-ramp converts whatever arrives

Partial and excess payments also complete. **Only the memo has to be right** —
`Memo.id(withdraw.memo)`, `memo_type: "id"`.

### 5.7 `on_change_callback` — push instead of polling

```js
// on_change_callback=<PUBLIC_BASE_URL>/api/anchor-callback
const [, t, s] = /t=(\d+), s=(.+)/.exec(req.headers['signature']);
const ok = Keypair.fromPublicKey(SIGNING_KEY)
  .verify(Buffer.from(`${t}.${req.headers.host}.${rawBody}`), Buffer.from(s, 'base64'));
```

It works because Vercel gives us a public URL. **Keep polling as a fallback** (the
on-ramp runs on a 3 s cadence, off-ramp detection on 5 s).

---

## 6. Milestones

The ordering logic: **the riskiest external dependency is proven earliest.**

### M0 — Discovery (Sat 10:30 → 13:30, in parallel with the workshops)

Two people in the workshops (especially #3, Anchor Integration), two on setup.

- `GET /health` → limits, treasury, issuer, rates
- Open `/explorer` and `/guide`, run a deposit tour by hand
- **Trigger `pending_trust` on purpose** (a deposit to an account with no trustline)
- Generate 5 testnet accounts and fund them with Friendbot (relayer, admin, coord A/B/C)
- Open a USDC trustline on the relayer
- Derive the USDC SAC ID
- Switch Freighter **to Testnet** (it defaults to Mainnet!)
- Fallback: the Circle faucet (20 USDC per address per 2 hours)
- **The vault check (30 min, see section 10):** call `get_assets` and see whether
  the asset address matches the USDC SAC

**Acceptance:** the anchor flow verified by eye, the SAC ID in hand, the limits
known, the vault decision made.

> At least 1 XLM in every account, plus 0.5 XLM per trustline.

---

### M1 — Money goes in (13:30 → 18:30)

- Contract: `initialize` (vault `None`) + `deposit` + `create_request` +
  `execute_payout` (**no multisig yet**)
- Follow the three design rules in 4.1: `principal`/`shares` separate,
  `vault: Option<Address>`, `available_balance()` as a single function
- `cargo test`: deposit, SAC transfer, the payout guard
- Deploy to testnet → `POA_CONTRACT_ID`
- `lib/wallet.js`: Wallets Kit, `allowAllModules()`
- The donor flow: connect a wallet → sign a `deposit`

**Acceptance:** USDC deposited from a wallet, the escrow balance on-chain, a TX hash
in hand.

> If the anchor stalls, carry on with Circle faucet USDC — M1 must not depend on
> the anchor.

---

### M2 — Money goes out (18:30 → 01:00) ⚠️ THE MOST CRITICAL

- Contract: `approve_request` + the double-vote guard + the 2/3 guard +
  `update_relayer`
- `cargo test`: unauthorized approval, double approval, double payout, insufficient
  balance
- `lib/anchor.js` (over the Wallet SDK):
  - SEP-10 auth, **automatic renewal on 401**
  - the **memo-scoped supplier record** (5.2)
  - a SEP-38 firm quote
  - `withdraw-exchange` → `account_id` + `memo` → send USDC with `Memo.id`
  - status polling plus the `on_change_callback` handler
- API routes: `/api/payout`, `/api/anchor-callback`

**Acceptance (01:00, a hard deadline):** USDC deposit → request → 2 approvals →
payout → relayer → withdrawal → TRY `completed` **in the supplier's IBAN**.

> If it does not work by 01:00: **cut scope, do not add features.**

---

### M3 — Make it visible (01:00 → 07:00, IN SHIFTS)

**Two people sleep, two people work. Not negotiable.**

Next.js (App Router) + Tailwind + Lucide:

| Screen | Contents |
|---|---|
| Hero | "Aid should move at the speed of crisis." |
| Donor | Wallet connection, USDC + escrow balance, Donate, TX hash |
| Field Request | The need, the TRY amount, the supplier, the IBAN, evidence upload |
| Multisig | Coordinator A/B/C states, the 2/3 bar, an evidence preview |
| Audit Timeline | Evidence → Request → Approvals → Released → Anchor → TRY → DONE |

**Evidence:** IPFS → CID → Soroban. **Plan B:** if IPFS/CORS costs more than 30
minutes, **drop it immediately** — client-side Base64 → SHA-256 → a mock CID. The
fallback code should be ready before M3 starts.

**Acceptance:** the demo can be performed entirely through the UI, with no terminal.

---

### M3.5 — The DeFindex vault ✅ DONE (after M4)

The M0 check was red for the ready-made vault, but we read the result wrong (see
10.1.a). We created our own vault:

- [`scripts/create-vault.sh`](scripts/create-vault.sh) — a vault from the factory,
  on top of the anchor's USDC SAC, with a seed deposit
- `deposit` → puts funds into the vault and records shares · `execute_payout` →
  unwinds shares
- `available_balance()` reads today's value of the shares
- `authorize_as_current_contract` — for the token pull the vault makes through the
  escrow; without it, `Error(Auth, InvalidAction)`
- 7 new contract tests (a mock vault with the real auth behaviour)

---

### M4 — Hardening plus delivery (07:00 → 11:00)

- Edge cases: an expired JWT, `pending_trust` (the open-trustline button), the
  missing-memo guard, out-of-range amounts, the `treasury_low` warning
- Verify that the timeline really is fed from on-chain events plus anchor status
- **Run anchor-tests** and put the output in the README:
  ```bash
  npx stellar-anchor-tests --home-domain https://tr-mock-anchor.fly.dev \
    --seps 1 10 12 6 38 --asset-code USDC --sep-config anchor-tests.config.json
  ```
- `README.md`: what we are doing, the architecture, setup, demo steps, the contract
  ID, links
- `docs/architecture.md`: components, why a relayer, the custody stance, trade-offs
- **Write down the paths of the skill files used** (a submission requirement)
- The deck: a copy of the official template, written by **one person**

---

### 11:00 → 12:00 — FROZEN

- [ ] Team name, every member's name and contact details
- [ ] The GitHub repo (check that it is public)
- [ ] The live demo / deployment URL
- [ ] The pitch deck link
- [ ] **Track: Genesis** ← you are not judged in a track you did not pick
- [ ] Rehearse the demo 3 times
- [ ] A screen recording (a fallback if the internet dies)

---

## 7. Repo layout

```
proof-of-action/
├── contracts/poa_escrow/{Cargo.toml, src/lib.rs, src/test.rs}
├── apps/web/
│   ├── app/api/{payout,quote,anchor-callback}/route.js
│   ├── app/{page.jsx,layout.jsx}
│   ├── components/
│   └── lib/{anchor.js, soroban.js, wallet.js, evidence.js}
├── scripts/{setup-testnet.js, deploy-contract.js}
├── docs/architecture.md
├── anchor-tests.config.json
├── .env.example
└── README.md
```

---

## 8. Division of work

| Person | Responsibility |
|---|---|
| 1 | The contract (Rust/Soroban), tests |
| 2 | The relayer plus the anchor adapter, API routes |
| 3 | The frontend plus Wallets Kit plus evidence |
| 4 | The demo scenario, integration testing, README + docs + deck |

The split happens at the start of M1. If all four dive into the contract, the
relayer slips to the night.

---

## 9. Common error table

| Symptom | Cause | Fix |
|---|---|---|
| 401 / 403 | The JWT expired or is missing | Redo SEP-10 |
| A deposit stuck in `pending_trust` | No USDC trustline at the destination | `changeTrust` — the anchor does the rest |
| The deposit never arrives | The bank transfer was not simulated | `POST /sep6/tx/{id}/simulate-bank-transfer` |
| `pending_reason: treasury_low` | The treasury is low | It resolves on its own |
| The withdrawal never completes | The memo is missing or the wrong type | `Memo.id(memo)`, `memo_type: "id"` |
| The TRY went to the wrong IBAN | No SEP-12 memo scope | The flow in 5.2 |
| The contract cannot transfer USDC | The issuer address was used | Use the SAC ID |
| A limit error | A hardcoded ceiling | Read it from `/health` |
| Contract data disappeared | The TTL was not extended | `extend_ttl` |

---

## 10. The DeFindex vault — the M3.5 block

### 10.1 The decision

**Start without the vault, write it vault-ready.** With the three rules in section
4.1 applied, adding it later is ~40–50 lines and 2–3 hours.

### 10.1.a ⚠️ THE M0 CONCLUSION WAS CORRECTED — DeFindex is integrated

> **This section was corrected afterwards.** M0 recorded it as "ruled out"; the
> measurement was right but the conclusion was wrong. The ready-made vault cannot be
> used — but we can create **our own vault** from the factory.
> `create_defindex_vault` was called with the anchor's SAC and passed. See
> [`scripts/create-vault.sh`](scripts/create-vault.sh).

The check in 10.2 was run and came back **red** — correctly so, for the ready-made
vault:

```
vault get_assets  → CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU
anchor USDC SAC   → CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA
```

`usdc_paltalabs_vault` holds **a different USDC** (Blend's own testnet USDC), not
the anchor's Circle testnet USDC. We cannot put the escrow's funds into **that**
vault.

**The question we skipped:** do we have to use the ready-made vault? No. The factory
(`CDSCWE4GLNBYYTES2OCYDFQA2LLY4RBIAX6ZI32VSUXD7GO6HRPO4A32`) creates a vault on any
asset we like and accepts an empty strategy list (in the vault contract,
`validate_strategies` only rejects duplicates).

**The corrected decision: DeFindex is integrated, optionally.** With `VAULT_ADDRESS`
set the funds are in the vault, otherwise in the escrow. The integration requirement
(section 0, #1) is now met by two protocols.

**The honest limit:** with no strategy for that SAC, **yield on testnet is zero**.
The rationale is architectural, as in section 10.5 — which is how it was planned
anyway.

### 10.2 The check in M0 (30 min)

```bash
# Pull the addresses fresh — testnet is redeployed often
curl -s https://raw.githubusercontent.com/defindex-io/stellar-contracts/main/public/testnet.contracts.json

# Verify the vault's asset
stellar contract invoke --id <usdc_paltalabs_vault> --network testnet \
  --source <account> -- get_assets

# Compare it with the USDC SAC
stellar contract id asset \
  --asset USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 \
  --network testnet
```

The known testnet address (as of 19 September 2026):
`usdc_paltalabs_vault = CBMVK2JK6NTOT2O4HNQAIQFJY232BHKGLIMXDVQVHIIZKDACXDFZDWHN`
— live, with a balance of ~949 USDC, a Blend autocompound strategy, the `sep41`
trait.

**If it does not match, drop DeFindex entirely.** The Wallets Kit defence is enough.

### 10.3 NOT the API — cross-contract

The DeFindex API returns unsigned XDR and needs an **account** to sign it. A Soroban
contract cannot sign → the escrow cannot use the API. The fix: call the vault
directly.

```rust
// deposit
let deposit_args = vec![
    &e,
    &amounts_desired,                 // Vec<i128>, single element
    &amounts_min,                     // slippage protection
    &e.current_contract_address(),    // from = THE ESCROW
    &true,                            // invest
];
let (_deposited, shares_minted, _alloc) = e.try_invoke_contract::<...>(
    &vault, &Symbol::new(&e, "deposit"), deposit_args.into_val(&e)
).unwrap().unwrap();
campaign.shares += shares_minted;
```

```rust
// withdraw — denominated in shares, so convert first
let total_supply = invoke(vault, "total_supply");
let managed      = invoke(vault, "fetch_total_managed_funds"); // single asset → [0]
let shares_to_burn = total_supply * amount_to_withdraw / managed.total_amount;

let withdraw_args = vec![
    &e, &shares_to_burn, &min_amounts_out, &e.current_contract_address()
];
```

### 10.4 Scope

**To write:** `deposit` puts funds into the vault and records shares;
`execute_payout` unwinds shares; the vault address in `initialize`; a single balance
line in the UI.

**Not to write:** an APY display or chart, rebalancing, strategy selection,
migration, `rescue`, a slippage settings screen, multiple vaults.

### 10.5 How to talk about it

Do not oversell the yield argument — $1000 earns about 22 cents in two days. The
rationale is **architectural**:

> "The donated funds are not sitting idle — they hold a position behind a standard
> vault interface. Custody stays with the escrow contract; the vault position is in
> the contract's name too."

Pre-disaster funding (money waits for months, an oracle triggers it) stays **on the
roadmap slide**, not in the code.

---

## 11. The demo scenario

1. The donor connects with Wallets Kit and deposits USDC into the escrow → TX hash
2. The field actor opens a request: fuel, 1,500 TRY, ABC Fuel Co., uploads evidence
   → a SEP-38 indicative quote
3. Coordinator A approves (1/2) — **with their own wallet**
4. Coordinator B approves (2/2) — **with a different wallet** ← the reason for
   Wallets Kit
5. `execute_payout` → USDC to the relayer → TX hash
6. The relayer: the memo-scoped supplier record → a firm quote → withdraw-exchange
   → USDC with `Memo.id` → the anchor goes `completed`
7. Audit Detail: request ID, supplier ref, TRY/USDC, the proof CID, the contract ID,
   the deposit/approval/payout TXs, the anchor withdrawal ID,
   `external_transaction_id`

A Stellar Expert link at every step. The one sentence we say:
**the answer to "where did the money go?" is on-chain.**

**Bonus:** onboard a real user (a local association or volunteer) live during the
demo — "onboarded real users" is one of the metrics.
