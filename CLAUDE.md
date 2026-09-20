# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Proof-of-Action: a Soroban escrow that releases disaster-relief USDC only after a field request (with a proof hash) gets 2-of-3 coordinator approvals, then off-ramps it to TRY at a supplier's IBAN through the **TR Mock Anchor** (`tr-mock-anchor.fly.dev`, SEP-1/10/12/38/6). Stellar **testnet** only. It was built for a hackathon (Rise In × Stellar Pro, Genesis Track).

Docs, code comments, commit messages and UI strings are in **English**. The repo was translated from Turkish on 2026-09-20; keep English when you edit them.

Reference docs in the repo:
- `docs/architecture.md`: design decisions and tradeoffs. Read it before you change the payout flow.
- `SKILL.md`: TR Mock Anchor integration guide, with fixes measured against `@stellar/stellar-sdk` v14.
- `IMPLEMENTATION_PLAN_v5.md`: the milestone plan. Code comments refer to its sections ("plan 5.2", "plan 10.1.a").

## Commands

```bash
# Contract (Rust workspace, soroban-sdk 27). rustup is keg-only on macOS:
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
cargo test                                   # all contract tests
cargo test same_coordinator_cannot_approve_twice   # single test by name
stellar contract build                       # → target/wasm32v1-none/release/poa_escrow.wasm

# Deploy + initialize on testnet, rewrites POA_CONTRACT_ID in .env
./scripts/deploy-contract.sh                 # (package.json's `deploy` script points at a nonexistent .js — use the .sh)

# Web app (Next.js 15, React 19, Tailwind 4)
cd apps/web && npm install && npm run dev    # also: npm run build, npm run lint

# Headless end-to-end acceptance run (needs the dev server running):
WEB=http://localhost:3000 node scripts/e2e-m2.js

# Get test USDC via the anchor's real on-ramp (SEP-10 → 12 → 6 deposit)
node scripts/anchor-tour.js

# Anchor compliance (the package is @stellar/anchor-tests; `stellar-anchor-tests` returns 404)
npx @stellar/anchor-tests --home-domain https://tr-mock-anchor.fly.dev \
  --seps 1 10 12 6 38 --asset-code USDC --sep-config anchor-tests.config.json
```

Contract tests write snapshots to `contracts/poa_escrow/test_snapshots/`. Commit regenerated snapshots with the test change that produced them.

## Layout and config

- There are two npm roots. The repo root holds the scripts (`scripts/*.js`), and `apps/web` holds the app. Each has its own lockfile, which is why `next.config.mjs` sets `outputFileTracingRoot` to the repo root.
- **There is one `.env`, at the repo root.** `apps/web/next.config.mjs` loads it explicitly and re-exports only the browser-safe values as `NEXT_PUBLIC_*`. `lib/soroban.js` reads either `NEXT_PUBLIC_X` or the bare `X`, so the same module runs in the browser and in Node scripts. The scripts import `apps/web/lib/soroban.js` directly.
- `RELAYER_SECRET` (and every other `*_SECRET`) must never reach the client bundle. Only server-side route handlers and `lib/payout.js` may read it. Never add a secret to `next.config.mjs` `env`.
- `lib/store.js` is a JSON-file store (`apps/web/data/store.json`, gitignored). It is a single process, holds the IBAN ↔ `supplier_ref` ↔ SEP-10 memo mapping, and records payouts and anchor status.

## Architecture: the money path

```
Donor ─USDC─► poa_escrow ─2/3 approve─► execute_payout ─► relayer (hot wallet)
  ─► POST /api/payout ─► lib/payout.js: SEP-10(memo) + SEP-12(IBAN) + SEP-38 firm quote + SEP-6 withdraw-exchange
  ─► USDC + Memo.id to anchor treasury ─► TRY to supplier IBAN
```

Invariants that span several files. Don't break them:

1. **`execute_payout` takes no destination.** It always pays `Config.relayer`, which only the admin can change with `update_relayer`. If a caller could pass the destination, they could redirect funds after the approvals.
2. **Approvals are keyed by `(request_id, coordinator)`,** not stored as a bare counter. That key is what stops one coordinator from approving twice (`same_coordinator_cannot_approve_twice`). The threshold is the constant `APPROVAL_THRESHOLD`, and the coordinator list is fixed when `initialize` runs.
3. **Memo-scoped anchor identity decides who gets paid.** The anchor pays the IBAN in the SEP-12 record of whichever identity did SEP-10 auth. The relayer authenticates as `G…:<supplierId>` for each supplier, so each supplier gets its own customer record. If the relayer authenticates without a memo, the TRY goes to the relayer's IBAN.
4. **No plain IBAN goes on-chain.** Only `supplier_ref = sha256(iban|salt)` does, and the salt stays in `store.js`. Evidence files work the same way: `lib/evidence.js` SHA-256s the file in the browser, sends only `proof_hash` on-chain and uploads the file nowhere. There is no IPFS.
5. **`/api/payout` does not authorize anything by itself.** It re-reads the request on-chain, requires `completed`, then resolves the supplier from `supplier_ref`.
6. **Don't hardcode anchor endpoints, the issuer, the treasury, rates or limits.** Read them at runtime from `GET /health` or `stellar.toml`, because the sandbox can be reset. Limits can come back as `null`.
7. `payout.js` throws **before** sending anything if the anchor doesn't return `memo_type: "id"`. A payment without a memo can't be attributed to anyone.
8. `/api/anchor-callback` verifies the Ed25519 signature over `"<t>.<host>.<body>"` with the anchor's `SIGNING_KEY` before it writes any status. If `PUBLIC_BASE_URL` is unset (localhost), the app requests no callback and falls back to polling.

Contract details (`contracts/poa_escrow/src/lib.rs`):
- Functions return `Result<T, Error>` rather than panicking, so tests use `try_*` clients and the frontend can tell error codes apart.
- Every read and write of persistent or instance storage calls `extend_ttl`.
- The contract was written ready for a vault: `Campaign.principal`/`.shares` are separate fields, `initialize` takes `vault: Option<Address>`, and the only place that reads the balance is `available_balance()`.

Frontend:
- `lib/soroban.js` builds its client with `contract.Client.from`, which reads the contract spec from the chain. There's no generated binding step. Amounts are strings or BigInt stroops (7 decimals) via `toStroops`/`fromStroops`. Never use floats.
- `lib/wallet.js` wraps Stellar Wallets Kit with `allowAllModules()`, which is hackathon requirement #1. Every coordinator signs with their own wallet. Scripts use a local keypair signer instead.
- `lib/anchor.js` is a hand-written SEP client, because `@stellar/typescript-wallet-sdk` can't be imported on Node 26.

## Anchor gotchas (measured, see SKILL.md)

- The exchange variants take the on-chain leg as an **asset code**: `source_asset=USDC`. Passing `stellar:USDC:…` returns 400.
- `pending_trust` exists. A deposit to an account without a trustline waits there, and the anchor pays automatically once `changeTrust` lands.
- SEP-38 firm quotes are single-use and expire after 15 minutes. The UI shows an indicative quote, and the app fetches a firm quote at payout time.
- Freighter opens on Mainnet by default. Coordinators must use distinct wallets, or the contract rejects the second approval.
