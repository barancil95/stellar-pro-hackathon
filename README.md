# Proof-of-Action

**Disaster-relief funds that move on proof, not on trust.**

Donations sit in a Soroban escrow instead of a central pool. A field actor opens a
request with a hash of the supporting evidence; two of three coordinators approve it
with their own wallets; the contract then releases the USDC, and an anchor off-ramps
it to Turkish Lira in the supplier's bank account. Every hop — donation, proof,
approvals, release, fiat settlement — is a verifiable record.

Rise In × Stellar Pro Hackathon · Genesis Track · Stellar Testnet.

| | |
|---|---|
| Contract | [`CCU6OCXLJ33RG3HF2DNDRKDGRIYYVCFRTXSZ5UCGVKE22VFCUAMXIYHM`](https://stellar.expert/explorer/testnet/contract/CCU6OCXLJ33RG3HF2DNDRKDGRIYYVCFRTXSZ5UCGVKE22VFCUAMXIYHM) |
| Network | Stellar Testnet · `Test SDF Network ; September 2015` |
| Anchor | [tr-mock-anchor.fly.dev](https://tr-mock-anchor.fly.dev) — SEP-1 / 10 / 12 / 38 / 6 |
| USDC (SAC) | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |
| DeFindex vault | [`CDHEFQQ2UT7GFWLBGYACXFI6G5WQOIXWWGLRFMPUKXFZVOPLHUSHNBPM`](https://stellar.expert/explorer/testnet/contract/CDHEFQQ2UT7GFWLBGYACXFI6G5WQOIXWWGLRFMPUKXFZVOPLHUSHNBPM) — optional |

A full run on testnet: 1.5 USDC donated → held in the vault → request #2 → coordinator
A (1/2) → coordinator B (2/2) → `execute_payout` → firm FX quote → SEP-6
withdraw-exchange → **72.81 TRY** delivered to the supplier's IBAN, bank reference
`FAST-VWDFOZ8ESQ`. One command reproduces it end to end: `node scripts/e2e-m2.js`.

---

## 1. Overall architecture

```
  DONOR                                                         SUPPLIER
    │ USDC (Wallets Kit)                                            ▲
    ▼                                                          TRY  │
┌────────────────────┐                                   ┌──────────┴────────┐
│   poa_escrow       │   deposit / shares                │   TR MOCK ANCHOR  │
│   (Soroban)        │◄────────────► DeFindex vault      │  SEP-10/12/38/6   │
│                    │                (optional)         └──────────▲────────┘
│  create_request    │◄── FIELD ACTOR: need + proof_hash             │
│  approve_request   │◄── COORDINATOR A / B / C (2 of 3, own wallet) │
│  execute_payout    │                                               │
└─────────┬──────────┘                                    USDC + Memo.id
          │ USDC to the fixed relayer address                        │
          ▼                                                          │
   RELAYER HOT WALLET ──► Next.js server: /api/payout ───────────────┘
                          SEP-10(memo) → SEP-12(IBAN) → SEP-38 firm quote
                          → SEP-6 withdraw-exchange → signed Stellar payment
```

Two halves with a clean seam between them.

**On-chain (trustless).** The escrow holds the funds and owns the authorization
logic. Approvals are signatures, the threshold is enforced in the contract, and the
payout destination is not a parameter — it is read from contract config. Nothing the
backend does can move money that the contract has not already released.

**Off-chain (the fiat leg).** A Soroban contract has no keypair, so it cannot sign a
SEP-10 challenge or make an HTTP request. Everything from `execute_payout` onward
runs in a server-side route: it authenticates to the anchor as the supplier's
identity, locks an FX rate, and sends the USDC with the memo that tells the anchor
which bank account to pay.

---

## 2. Main components

### `contracts/poa_escrow` — the escrow (Rust, soroban-sdk 27)

| Function | Responsibility |
|---|---|
| `initialize(admin, usdc_sac, relayer, coord_a, coord_b, coord_c, vault)` | One-shot setup. The coordinator set and the payout destination are fixed here. |
| `deposit(from, amount)` | Pulls USDC through the SAC; routes it into the vault when one is configured. |
| `create_request(supplier_ref, amount, proof_hash)` | Opens a disbursement request. Permissionless by design (see §4). |
| `approve_request(request_id, coordinator)` | `require_auth` on the coordinator; records the vote under a `(request_id, coordinator)` key. |
| `execute_payout(request_id)` | Requires `approvals ≥ APPROVAL_THRESHOLD`; unwinds vault shares if needed; transfers to `Config.relayer`. Takes **no destination**. |
| `update_relayer(new_relayer)` | Admin-only. The single way the destination can ever change. |
| `balance()`, `get_request()`, `has_approved()`, … | Read surface used by the UI and the acceptance script. |

Every function returns `Result<T, Error>` rather than panicking, so tests use `try_*`
clients and the frontend distinguishes error codes. Every storage read and write
extends TTL (30-day target, bumped at 20 days). Emitted events — `RequestCreated`,
`RequestApproved`, `PayoutExecuted`, `RelayerUpdated` — are what the audit timeline
renders.

### `apps/web` — the application (Next.js 15, React 19, Tailwind 4)

| Module | Responsibility |
|---|---|
| [`lib/soroban.js`](apps/web/lib/soroban.js) | Contract client built with `contract.Client.from`, reading the spec from the chain — no generated bindings. Amounts are strings or BigInt stroops, never floats. |
| [`lib/wallet.js`](apps/web/lib/wallet.js) | Stellar Wallets Kit with `allowAllModules()`; each coordinator signs with their own wallet. |
| [`lib/anchor.js`](apps/web/lib/anchor.js) | Hand-written SEP-1/10/12/38/6 client. Sessions, challenge signing, quotes, withdraw-exchange, status polling. |
| [`lib/payout.js`](apps/web/lib/payout.js) | **Server-only.** The relayer's fiat leg: memo-scoped auth, customer registration, firm quote, withdraw, signed payment. |
| [`lib/evidence.js`](apps/web/lib/evidence.js) | SHA-256s the evidence file in the browser; only the hash leaves it. |
| [`lib/store.js`](apps/web/lib/store.js) | The off-chain ledger: IBAN ↔ `supplier_ref` ↔ SEP-10 memo, payout records, anchor status. Redis in production, JSON file on localhost. |
| `app/api/{suppliers,requests,payout,anchor-callback}` | Route handlers. `/api/payout` re-reads the request on-chain and refuses anything not `completed`. |
| `components/` | Donate · Field request · Multisig approval · Audit trail. |

### `scripts/` — operations

`deploy-contract.sh` (build + deploy + initialize), `create-vault.sh` (DeFindex vault
on the anchor's SAC), `onramp.js` (real USDC via the anchor's on-ramp),
`anchor-tour.js` (step-by-step SEP walkthrough), `e2e-m2.js` (headless acceptance run
of the whole money path).

---

## 3. Stellar integrations and protocols

**Soroban** — the escrow itself: custody, the 2-of-3 approval state machine, and the
payout. It moves USDC through the **Stellar Asset Contract**, so the same asset is
native to both the contract and the classic payment that feeds the anchor.

**Stellar Wallets Kit** — wallet connectivity with `allowAllModules()`. This is
load-bearing rather than decorative: three distinct coordinators must sign three
distinct approvals, so the product needs multi-wallet support to work at all.

**SEP-1** — `stellar.toml` discovery: issuer, signing key, and SEP endpoints.

**SEP-10** — challenge/response auth for the relayer. Used **with a memo**, which is
what makes per-supplier identity possible (§5).

**SEP-12** — KYC/customer records. One memo-scoped record per supplier holds that
supplier's `bank_account_number`.

**SEP-38** — quotes. An *indicative* price converts TRY→USDC live while a field
request is being written; a *firm* quote is taken at payout time and consumed by the
withdrawal.

**SEP-6** — programmatic deposit and `withdraw-exchange`. Deposit is how test USDC
enters the system; withdraw-exchange is the USDC→TRY off-ramp that ends at an IBAN.

**DeFindex** — an optional yield vault. When `VAULT_ADDRESS` is set, deposits go into
a vault created on the anchor's USDC SAC via the DeFindex factory, and the escrow
holds shares instead of a raw balance; `execute_payout` unwinds them first.

---

## 4. Key design decisions and trade-offs

**`execute_payout` takes no destination.** It always pays `Config.relayer`. If the
destination were a parameter, anyone could redirect funds *after* the approvals had
been collected — the approvals would authorize an amount but not a recipient. The
cost is flexibility: changing the destination requires an admin transaction.

**Approvals are keyed by `(request_id, coordinator)`, not counted.** A bare counter
would let a single coordinator approve twice and clear a 2-of-3 threshold alone. The
key makes that structurally impossible, and `same_coordinator_cannot_approve_twice`
pins it down. The trade-off is one storage entry per vote instead of one per request.

**No IBAN and no evidence file ever touch the ledger.** On-chain there is only
`supplier_ref = sha256(iban | salt)` and `proof_hash = sha256(file)`. The salt, the
IBAN and the memo mapping live in the backend. The commitment is just as strong as
storing the data itself, and nothing private is published forever. The price: file
availability is the uploader's problem — there is no IPFS pin.

**`create_request` is permissionless.** Restricting who may raise a request would
slow the field down, and opening one moves no money; the payout still depends on 2 of
3 approvals. The cost is spam, and the defence is at the point of decision: a
coordinator sees the proof hash and supplier reference before approving. A field-actor
whitelist or a small deposit is where production would go.

**A hot relayer wallet.** Custody exists on exactly one hop — the last metre of the
fiat rail — and that metre already belongs to a bank. The on-chain half is unaffected
by it. `RELAYER_SECRET` is read only in server-side code and never enters the client
bundle.

**The contract spec is read from the chain.** One extra network call per client
construction buys away the entire binding-generation step and keeps the frontend in
sync whenever the contract changes.

**A hand-written SEP client.** Around 300 lines to maintain, in exchange for running
on current Node and a very small dependency surface.

**Nothing about the anchor is hardcoded** — endpoints, issuer, treasury, rates and
limits are all read at runtime from `/health` and `stellar.toml`, because a sandbox
can be reset at any time and limits may come back `null`.

**A fixed 2-of-3 threshold.** No flexibility; a much smaller attack surface and test
matrix. Configurable thresholds, partial payments, refunds and timeouts are
deliberately out of scope for the MVP.

---

## 5. Technical challenges and how we solved them

**Whose IBAN does the anchor pay?** This is the detail the whole product hinges on.
An off-ramp pays the bank account in the SEP-12 record of *whichever identity
completed SEP-10*. With a single relayer account authenticating plainly, every
supplier's TRY would land in the relayer's own IBAN. The fix is memo-scoped identity:
the relayer authenticates as `GBML…:<supplierId>`, giving each supplier its own
customer record and its own bank account under one Stellar account. Verified with two
suppliers side by side — `…:77001` settles to `TR32…5678`, `…:77002` to `TR97…2315`.

**A payment without a memo is unattributable.** The withdrawal's memo is the only
thing linking the incoming USDC to a supplier. So `payout.js` validates that the
anchor returned `memo_type: "id"` and throws **before** any funds leave the relayer if
it did not — a wrong memo is a lost payment, and the check is cheap.

**A vault deposit fails auth in a way that looks like a contract bug.** The DeFindex
vault pulls USDC through the escrow, so the transfer happens on the escrow's behalf
but is not the escrow's own direct call. Soroban requires the contract to authorize
that sub-invocation explicitly with `authorize_as_current_contract`; without it the
deposit dies with `Error(Auth, InvalidAction)`. The test mock reproduces the real
vault's auth behaviour, so removing that line fails six tests rather than silently
passing.

**The ready-made testnet vault holds the wrong asset.** `usdc_paltalabs_vault` is
denominated in BlendUSDC, not the anchor's USDC SAC, which initially looked like
"DeFindex is not usable here". The factory is the way through:
`create-vault.sh` calls `create_defindex_vault` with the anchor's SAC. No DeFindex
strategy exists for that SAC on testnet, so the vault runs strategy-less and testnet
yield is zero — what the integration buys is the architecture. The escrow keeps a
position behind a standard vault interface, balance is read from one place whether
funds are in the vault or not, and clearing `VAULT_ADDRESS` reverts to plain escrow
custody in one line.

**FX moves between writing a request and paying it.** SEP-38 firm quotes are
single-use and expire in 15 minutes, which is shorter than an approval round. So the
UI shows an indicative quote while the request is drafted, and the firm quote is
fetched at payout time, immediately before the withdrawal it is attached to.

**Deposits to an account without a trustline do not fail — they wait.** The anchor
parks them in `pending_trust` and settles automatically once `changeTrust` lands.
Rather than treating that as an error, the donation panel detects the missing
trustline and offers a one-click "Open a USDC trustline" button.

**The exchange endpoints want an asset code, not a qualified asset.** SEP-38/SEP-6
exchange variants take the on-chain leg as `source_asset=USDC`; passing the canonical
`stellar:USDC:GBBD…` form returns 400. Measured against a live anchor and documented
in [`SKILL.md`](SKILL.md).

**The payout is longer than a serverless function.** Polling the anchor to
`completed` can exceed Vercel's 60-second ceiling, so the payout is split: phase one
registers, quotes, withdraws and sends, then returns. Status arrives afterwards over
the signed `on_change_callback`, with polling as the fallback — and on localhost,
where the anchor cannot reach the app, no callback is requested at all.

**A status callback is an unauthenticated write unless it is verified.** Anyone who
knows the URL could post a fake "completed". `/api/anchor-callback` verifies an
Ed25519 signature over `"<t>.<host>.<body>"` against the anchor's `SIGNING_KEY`
before writing any status.

**The Wallet SDK could not be used.** `@stellar/typescript-wallet-sdk` is a browser
bundle pinned to a stellar-sdk 13 beta and does not import on current Node. The SEP
flows were written by hand against `@stellar/stellar-sdk` v14 instead.

---

## 6. Running it

```bash
# Tooling (macOS; rustup is keg-only)
brew install rustup node stellar-cli
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
rustup default stable && rustup target add wasm32v1-none

# Accounts
for k in relayer admin coord-a coord-b coord-c donor; do
  stellar keys generate $k --network testnet --fund
done
stellar tx new change-trust --source relayer \
  --line USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015"

cp .env.example .env          # fill in secrets with `stellar keys show <name>`
npm install
node scripts/onramp.js relayer 500     # real USDC from the anchor's on-ramp
node scripts/onramp.js donor  3000
./scripts/create-vault.sh              # optional DeFindex vault; writes to .env
./scripts/deploy-contract.sh           # build + deploy + initialize; updates .env

cd apps/web && npm install && npm run dev
```

There is a single `.env` at the repo root and it is never committed. Contract tests
run with `cargo test`; the full money path runs headless with
`WEB=http://localhost:3000 node scripts/e2e-m2.js`.

For deployment, `lib/store.js` needs storage that survives across requests — provision
Upstash Redis and the `KV_REST_API_URL` / `KV_REST_API_TOKEN` variables are picked up
automatically. Without them the store falls back to a JSON file, which only works on
localhost.

**Demo tips.** Freighter opens on Mainnet by default — switch it to Testnet, and
import each coordinator as a separate wallet, since the contract rejects a second
approval from the same address. With `DEMO_MODE=true` a "Demo account" button switches
between the donor and the three coordinators and signs locally in the browser; it only
ever exposes those four testnet accounts and never the relayer.

---

## 7. Repo layout

```
contracts/poa_escrow/src/{lib.rs, test.rs}   Soroban escrow + test suite
apps/web/
  lib/           anchor · payout · soroban · wallet · evidence · store
  app/api/       suppliers · requests · payout · anchor-callback
  components/    Donate · Field request · Multisig · Audit trail
scripts/         deploy-contract.sh · create-vault.sh · onramp.js
                 anchor-tour.js · e2e-m2.js
docs/architecture.md   design rationale in depth
SKILL.md               TR Mock Anchor integration notes, measured against SDK v14
```
