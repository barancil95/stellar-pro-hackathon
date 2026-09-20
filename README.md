# Proof-of-Action

> **Aid should move at the speed of crisis.**

A Soroban-based protocol that, instead of parking disaster donations in a central
pool, releases them to verified actors in the field on **proof of need plus a 2-of-3
multisig approval**. The money is traceable on-chain all the way from the donor's
wallet to the supplier's IBAN.

Rise In × Stellar Pro Hackathon — **Genesis Track**.

---

## What works

Verified end to end on testnet, with real money moving:

```
DONOR ──USDC──► POA ESCROW ──2/3 approvals──► RELAYER ──SEP-6──► TR MOCK ANCHOR ──TRY──► SUPPLIER IBAN
```

Reproducible with a single command:

```bash
node scripts/e2e-m2.js
```

Last run (2026-09-20, on the contract documented below): 1.5 USDC donated → into
the **DeFindex vault** → request #2 (1.5 USDC) → coord A (1/2) → coord B (2/2) →
`execute_payout` (vault shares unwound, 7.4793989 → 5.9793989) → firm quote →
`withdraw-exchange` → **72.81 TRY**, bank reference `FAST-VWDFOZ8ESQ`, in the
supplier's IBAN.

| | |
|---|---|
| **Contract** | [`CCU6OCXLJ33RG3HF2DNDRKDGRIYYVCFRTXSZ5UCGVKE22VFCUAMXIYHM`](https://stellar.expert/explorer/testnet/contract/CCU6OCXLJ33RG3HF2DNDRKDGRIYYVCFRTXSZ5UCGVKE22VFCUAMXIYHM) |
| **Network** | Stellar Testnet · `Test SDF Network ; September 2015` |
| **Anchor** | [tr-mock-anchor.fly.dev](https://tr-mock-anchor.fly.dev) (SEP-1/10/12/38/6) |
| **USDC SAC** | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |
| **DeFindex vault** | [`CDHEFQQ2UT7GFWLBGYACXFI6G5WQOIXWWGLRFMPUKXFZVOPLHUSHNBPM`](https://stellar.expert/explorer/testnet/contract/CDHEFQQ2UT7GFWLBGYACXFI6G5WQOIXWWGLRFMPUKXFZVOPLHUSHNBPM) — optional, off when `VAULT_ADDRESS` is empty |

---

## Hackathon requirements

| # | Requirement | How it is met |
|---|---|---|
| 1 | **Integration** — a protocol from the curated list | **Stellar Wallets Kit** (`allowAllModules()`) — [`lib/wallet.js`](apps/web/lib/wallet.js) · **DeFindex** vault — [`create-vault.sh`](scripts/create-vault.sh), [`lib.rs`](contracts/poa_escrow/src/lib.rs) |
| 2 | **Anchor / Local Payments** | **TR Mock Anchor**, SEP-1/10/12/38/6 — [`lib/anchor.js`](apps/web/lib/anchor.js) |
| 3 | **Core Feature** — load-bearing | Remove the anchor and the product dies. Without multi-wallet support the 2/3 approval does not work: every coordinator signs with **their own wallet**. |

**DeFindex is integrated.** The ready-made `usdc_paltalabs_vault` genuinely cannot
be used — its asset is BlendUSDC (`CAQCFVLO…`), not the anchor's USDC SAC
(`CBIELTK6…`). But the factory lets us create our own vault:
[`scripts/create-vault.sh`](scripts/create-vault.sh) deploys a vault on top of the
anchor's SAC, and the escrow keeps the funds there and counts shares.

The honest limit: because no DeFindex strategy is deployed for that SAC, **yield on
testnet is zero** — the funds sit idle in the vault. What we gain is architecture:
the escrow holds a position behind a standard vault interface, and leaving
`VAULT_ADDRESS` empty reverts to the old behaviour (funds in the escrow) in one
line. On mainnet the same code produces yield with Circle USDC and a Blend strategy.

---

## Architecture in brief

The on-chain part is trustless: approval authority sits in a 2-of-3 multisig, and
`execute_payout` does **not take a destination as a parameter** — it reads it from
`Config`. Custody exists only on the last metre of the fiat rail, and that metre
already belongs to the bank.

**Why there is a relayer:** a Soroban contract has no keypair — it cannot sign a
SEP-10 challenge or make an HTTP request. The fiat leg is necessarily off-chain.

**No IBAN is written on-chain.** The ledger holds only
`supplier_ref = sha256(iban|salt)`. The IBAN ↔ SEP-10 memo mapping lives in the
backend.

**Deliberately open:** `create_request` requires no authorization — opening a
request moves no money, and the payout depends on 2/3 approvals. The cost and the
defence are in
[docs/architecture.md](docs/architecture.md#2-why-there-is-a-relayer).

Full design and trade-offs: **[docs/architecture.md](docs/architecture.md)**

---

## Setup

```bash
# Tools (macOS)
brew install rustup node stellar-cli
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"   # rustup is keg-only
rustup default stable && rustup target add wasm32v1-none

# Accounts — relayer, admin, coord-a/b/c, donor
for k in relayer admin coord-a coord-b coord-c donor; do
  stellar keys generate $k --network testnet --fund
done
stellar tx new change-trust --source relayer \
  --line USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015"

cp .env.example .env    # fill in the secrets with `stellar keys show <name>`
npm install
node scripts/onramp.js relayer 500    # real USDC from the anchor's on-ramp
node scripts/onramp.js donor  3000
./scripts/create-vault.sh             # optional — the DeFindex vault, writes to .env
./scripts/deploy-contract.sh          # deploy + initialize, updates .env

cd apps/web && npm install && npm run dev
```

`.env` is a single file at the repo root and is **never committed**.
`RELAYER_SECRET` is only read in server-side routes; every build verifies that no
secret is present in the client bundle.

If you need USDC there is no need for a faucet — the anchor's own on-ramp provides
it (`scripts/onramp.js`, above). To watch the flow step by step:

```bash
node scripts/anchor-tour.js    # SEP-10 → SEP-12 → SEP-6 deposit → completed
```

**Deployment (Vercel).** `lib/store.js` holds the supplier ↔ IBAN ↔ memo mapping,
and that data has to persist across requests. Since the file system is read-only on
Vercel, Upstash Redis is required: Vercel Marketplace → Upstash → Redis, and
`KV_REST_API_URL` and `KV_REST_API_TOKEN` are written automatically. If those
variables are empty the code falls back to a file, which works **on localhost only**.

---

## Demo steps

1. **Donate** tab — connect a wallet, deposit USDC → TX hash
2. **Field request** — the need, the TRY amount, supplier + IBAN, upload proof
   (the indicative quote converts TRY→USDC live)
3. **Approve & audit** — coordinator A approves (1/2)
4. Switch wallets, coordinator B approves (2/2) ← *the reason for Wallets Kit*
5. **Release the funds** — the on-chain payout, then TRY through the anchor
6. **Audit trail** — proof → request → approvals → funds → anchor → TRY → bank reference

**If you cannot install a wallet extension:** the **Demo account** button in the top
right switches between donor/coord-a/coord-b/coord-c in one click, and signs
locally in the browser. It only appears while `DEMO_MODE=true` and only ever hands
out those four testnet accounts — `RELAYER_SECRET` never goes down this path. Leave
`DEMO_MODE=false` on a public deploy.

If a wallet has no USDC trustline, the donation panel shows an **"Open a USDC
trustline"** button — a deposit from the anchor would otherwise wait in
`pending_trust`. Each trustline needs a 0.5 XLM reserve.

> Freighter opens on **Mainnet** by default. Switch it to Testnet.
> Import the coordinator wallets separately — the same wallet cannot approve
> twice, the contract rejects it.

---

## Tests

**Contract — 29/29 passing** (`cargo test`):

```
deposit · accumulation · SAC transfer · invalid amount
double voting · outsider approval · unsigned approval · payout below threshold
approval leaking across requests · double payout · insufficient balance
one-shot initialize · relayer change
vault: deposit · share unwind · yield · old behaviour while the vault is off
```

The vault tests run against a mock that mimics the **auth behaviour** of the real
DeFindex vault. Delete the `authorize_as_current_contract` line and six tests fail
with `Error(Auth, InvalidAction)` — so that line's load-bearing role was measured,
not assumed.

The most critical one is `same_coordinator_cannot_approve_twice`: a single
coordinator cannot approve twice and clear the threshold alone. That would have
been possible had we kept only `approvals_count` — approvals are stored under a
`(request_id, coordinator)` key.

**Anchor compliance — SDF `anchor-tests`, 78/84:**

```bash
npx @stellar/anchor-tests --home-domain https://tr-mock-anchor.fly.dev \
  --seps 1 10 12 6 38 --asset-code USDC --sep-config anchor-tests.config.json
```

```
Tests: 2 failed, 78 passed, 4 skipped, 84 total
```

Four are **skipped** — they are for anchors that run SEP-6 without auth, while ours
has `authentication_required: true`. Two fail **on the anchor's side**, not in our
integration:

- `SEP-10 GET /auth`: *minimum timebound too late* — the challenge's `minTime` is
  after the moment it was received. A 1 s difference between the local clock and
  the anchor was measured, so it is not client-side.
- `SEP-6 GET /info`: the deposit's `non_interactive_customer_info_needed` body has
  a `type` field; the test expects it in the sep-config, but the schema does not
  allow that field to be declared.

> The `npx stellar-anchor-tests` command from the plan returns 404 — the package is
> called `@stellar/anchor-tests`.

---

## Repo layout

```
contracts/poa_escrow/src/{lib.rs, test.rs}   Soroban escrow + 29 tests
apps/web/
  lib/anchor.js        SEP-1/10/12/38/6 client (endpoints from /health)
  lib/payout.js        the relayer's fiat leg — SERVER SIDE
  lib/soroban.js       contract client (spec read from the chain)
  lib/wallet.js        Stellar Wallets Kit
  lib/evidence.js      proof → SHA-256 → on-chain
  lib/store.js         IBAN ↔ supplier_ref ↔ memo mapping
  app/api/{suppliers,requests,payout,anchor-callback}/route.js
  components/          Donate · Field request · Multisig · Audit trail
scripts/
  anchor-tour.js       the M0 discovery tour — a real on-ramp
  onramp.js            get USDC into an account through the anchor
  e2e-m2.js            end-to-end acceptance, one command
  create-vault.sh      the DeFindex vault (on the anchor's USDC SAC)
  deploy-contract.sh   build + deploy + initialize
```

---

## Skill files used

| Path | Contents |
|---|---|
| [`SKILL.md`](SKILL.md) | The TR Mock Anchor integration skill — endpoints, SEP flows, trustlines, common errors |
| [`IMPLEMENTATION_PLAN_v5.md`](IMPLEMENTATION_PLAN_v5.md) | The milestone plan. Points corrected by measurement during implementation are marked in the file (5.1, 5.3, 5.4, 10.1.a) |

---

## Deviations from the plan — all measured

| Plan | Reality |
|---|---|
| 5.1 Use the Wallet SDK | `@stellar/typescript-wallet-sdk@1.10.0` cannot be imported on Node 26 (browser bundle, pinned to stellar-sdk 13 beta). The SEPs were written by hand. |
| 5.3 There is NO `pending_trust` | **There is.** A deposit without a trustline waits in `pending_trust`; once `changeTrust` lands the anchor pays by itself, no `claimClaimableBalance` needed. |
| 5.4 `source_asset=stellar:USDC:…` | In the exchange variants the on-chain leg is given as an **asset code**: `source_asset=USDC`. Anything else returns 400. |
| 10.1.a DeFindex optional | The vault asset did not match → dropped entirely. |
| IPFS → CID | No key; plan B became the main path. The file is SHA-256'd in the browser, the hash goes on-chain, and the file is uploaded nowhere. |

---

## Out of scope

Partial payments, refunds, timeouts, closing a campaign, an on-chain coordinator
whitelist, a configurable threshold, an upgrade pattern, a DAO. These were left
unwritten on purpose — the MVP's claim is to show that an aid request is
**traceable on-chain from proof to payment**.
