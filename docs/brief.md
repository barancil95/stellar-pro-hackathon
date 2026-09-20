# Proof-of-Action — Project Brief

This file answers the **"Narrative Why"** questions on the hackathon submission
form. The presentation and the README are derived from it; the sentences here can
be used verbatim on slides and in the pitch.

Rise In × Stellar Pro Hackathon — **Genesis Track** · Stellar Testnet

---

## 0. In one sentence

> A Soroban escrow that, instead of parking disaster donations in a central pool,
> releases them the moment a **proof-backed field request clears 2-of-3 coordinator
> approval**, and delivers them to the supplier's **IBAN as TRY**.

One traceable chain, from proof to bank receipt.

---

## 1. What are we building?

**Proof-of-Action** is a working system for disaster relief, in three parts:

| Part | What it does |
|---|---|
| **`poa_escrow`** (Soroban contract) | Holds the donation. Every request from the field carries a **proof hash**. Funds only leave after **2-of-3 approvals** stored under a `(request_id, coordinator)` key, and only to a **fixed relayer address** — the destination is not a function parameter. |
| **Relayer + SEP client** (Next.js backend) | Converts the USDC leaving the chain into TRY through the **TR Mock Anchor** and sends it to the supplier's IBAN. SEP-10 (memo-scoped auth) · SEP-12 (IBAN record) · SEP-38 (firm quote) · SEP-6 (withdraw-exchange). |
| **Web interface** (Next.js 15 + Stellar Wallets Kit) | Four screens: Donate · Field request · Multisig approval · Audit trail. Every coordinator signs with **their own wallet**. |

An optional fourth part: the **DeFindex vault**. With `VAULT_ADDRESS` set, the funds
do not sit idle in the escrow but hold a position in a vault on the escrow's
behalf; the shares are unwound at payout time. (The honest testnet limit → §7)

**A measured end-to-end run** (`node scripts/e2e-m2.js`, one command, 2026-09-20):
1.5 USDC donated → vault → request #2 (1.5 USDC) → coord A (1/2) → coord B (2/2) →
`execute_payout` (vault shares 7.4793989 → 5.9793989) → firm quote →
`withdraw-exchange` → **72.81 TRY**, bank reference `FAST-VWDFOZ8ESQ`, in the
supplier's IBAN.

---

## 2. What problem does it solve?

There are three separate gaps in disaster philanthropy. Unless all three close at
once the system does not work — we close all three in a single flow.

### 2.1 The trust gap — "where did my money go?"

Once a donor sends money they cannot follow it. Institutions publish aggregated,
delayed, line-item-free reports. The result: the donor hesitates at the next
disaster, and a campaign's fundraising capacity depends not on trust but on how
long the emotional intensity lasts.

**With us:** every request opens with a **proof hash** and a **supplier
reference**, every approval is an on-chain transaction, the payout is an on-chain
transfer, and the TRY leg closes with a **bank reference** from the anchor. The
donor looks at the ledger, not at a "we raised X" report.

### 2.2 The timing gap — "decisions move slower than the crisis"

The critical window is the first 72 hours; approval chains (request → headquarters
→ accounting → payment) take days. The known price of speeding up is loosening
control: fast but unaudited single-signature spending.

**With us:** speed and control live in the same mechanism. The 2/3 approval can be
collected **concurrently** and **remotely** — three coordinators in three different
cities each sign with their own wallet. The moment the threshold is met the payout
is triggered; there is no intermediate accounting step. One signature is not
enough, but two of three can be gathered in minutes.

### 2.3 The last-metre gap — "the supplier in the field does not take crypto"

On-chain solutions usually end at a wallet. But the local supplier selling tents,
blankets, medicine and food **wants TRY, and wants it in an IBAN**. Leaving the
burden of cashing out a stablecoin to the field means the system does not work in
practice.

**With us:** the last metre is inside the product. The anchor's off-ramp converts
the USDC to TRY and deposits it into the supplier's IBAN; nobody in the field needs
a wallet, an exchange account or any crypto knowledge. **The supplier does not know
crypto was involved.**

### 2.4 The technical core of the problem

The most critical detail is smaller than it looks: the off-ramp pays the TRY to the
IBAN in the SEP-12 record of **whichever identity did the SEP-10 auth**. If the
relayer authenticates without a memo, the money goes to **the relayer's** IBAN —
the flow looks "successful" while the money reaches the wrong place. Our fix is a
**memo-scoped identity** per supplier (`G…:<supplier_id>`). One relayer account, a
separate SEP-12 record per supplier; measured with two suppliers.
(`docs/architecture.md` §4.2)

---

## 3. Target users

### Primary — the three roles that use the product directly

| Role | Who | What they need | Their screen |
|---|---|---|---|
| **Donor** | Individual donors; corporate CSR budgets; the diaspora | To see their money turn into a line item | Donate + Audit trail |
| **Field actor** | An NGO volunteer in the disaster area, a local coordination team | To report a need quickly, with its proof | Field request |
| **Coordinator** | A trio from an NGO / municipality / independent auditor | To see the proof and the supplier before approving, and to be unable to spend alone | Approve & audit |

The fourth role, the **supplier** (a local shop, pharmacy, haulier), never enters
the system at all — TRY simply arrives in their IBAN. That is not a gap, it is a
design goal.

### Secondary — whoever deploys the system

Mid-sized NGOs, municipal disaster coordination units, consortia where three
institutions manage a joint fund, and corporate giving programmes that owe a
transparency report. For this group the real value is that **the audit trail is
produced automatically**: the report is not written, it is read from the ledger.

### Not targets right now

Government-scale emergency budgets, small single-signature donation campaigns, and
regions that require cash-in-hand distribution.

---

## 4. Why is this problem worth solving?

1. **Donation volume is limited by trust, not by attention.** Willingness to give
   peaks during a disaster; what clogs is the process that makes the money
   *spendable*. Making trust measurable is cheaper than raising new money.
2. **Transparency is now a legal and institutional obligation.** Corporate giving
   programmes and international funds demand proof of spending. Today that runs on
   manually collected receipts; this system produces it as a by-product.
3. **Turkey has a concrete geographic reality.** In a country on a seismic belt,
   disaster relief is not exceptional but a recurring operation. A solution where
   the TRY/IBAN rail is the default is directly usable here.
4. **Technically it is possible exactly now.** Soroban gives cheap, fast multisig
   and Stellar anchors give local fiat exit. Without both, this product would
   either end at a wallet or be a chainless accounting tool.
5. **The pattern travels.** The "proof-backed request → multi-party approval →
   exit to local fiat" template maps directly onto refugee cash assistance, supply
   chain advances and conditional grants.

---

## 5. Value proposition

**To the donor:** "You can verify yourself which request your donation became, with
what proof, under whose approval, and with which bank reference." A ledger, not a
report.

**To the institution (NGO/municipality):** "You do no extra work to produce a
transparency report; the audit trail is a by-product of the flow. And no single
person — including the system administrator — can move the funds alone."

**To the field:** "Open the request with its proof, get two approvals, and TRY
lands in the supplier's IBAN. Nobody needs to set up a wallet."

### The clear difference against the alternatives

| Alternative | What it lacks | Our difference |
|---|---|---|
| A classic donation platform (bank/credit card) | Everything past the pool is a black box; spending cannot be traced per item | Every item is on-chain, tied to a proof hash |
| A crypto donation address (single wallet) | Single signature; no spending control; no last metre | 2/3 approval plus a TRY exit to an IBAN |
| A general-purpose multisig wallet (Safe et al.) | It approves a transaction but carries no **why**; no fiat leg | The approval is bound to a *request* and its *proof*; the fiat rail is integrated |
| Corporate ERP plus manual receipts | The audit trail is produced by hand and cannot be verified afterwards | The trail is automatic and externally verifiable |

### The one-sentence position

> Donation platforms collect money, multisig wallets collect signatures, and
> anchors move money into fiat. **Proof-of-Action unites all three in a single
> audit trail.**

---

## 6. Why Stellar?

- **The anchor network** — the last metre is this product's lifeline. Stellar's SEP
  standards define local fiat exit (TRY → IBAN) at the protocol level; on another
  chain that leg would need a bilateral agreement. Remove the anchor and the
  product dies.
- **Soroban** — the multisig logic, the proof hash and TTL management all live in
  one contract, at a transaction cost low enough not to make an aid request absurd.
- **Stellar Wallets Kit** — each coordinator signing with their own wallet is the
  precondition for the 2/3 approval being real; `allowAllModules()` means no wallet
  lock-in.
- **DeFindex** — a standard vault interface that turns the funds' waiting time into
  yield.

---

## 7. Honest limits

We state these in the presentation too; this is where credibility with the judges
comes from.

- **Yield on testnet is zero.** There is no DeFindex strategy deployed for the
  anchor's USDC SAC, so the funds sit idle in the vault. What we gain is
  architecture: the escrow holds a position behind a standard vault interface, and
  on mainnet the only things that change are addresses.
- **`create_request` requires no authorization.** Opening a request moves no money,
  so it was left open deliberately; the exit depends on 2/3 approvals. The cost is
  spam risk, the defence is the proof and supplier information on the approval
  screen. In production, a field-actor whitelist.
- **Custody sits on the last metre of the fiat rail.** A Soroban contract has no
  keypair and cannot sign a SEP-10 challenge. The relayer is mandatory — but its
  destination is fixed in the contract, not a parameter.
- **The supplier ledger is kept in a file.** A single-process JSON store; in
  production it would be a database.
- **Out of scope (deliberately):** partial payments, refunds, timeouts, on-chain
  coordinator management, a configurable threshold, a DAO.

---

## 8. Evidence — where each claim is backed

| Claim | Where it is verified |
|---|---|
| The 2/3 approval is genuinely enforced | `cargo test same_coordinator_cannot_approve_twice` · 29/29 contract tests |
| Funds cannot be redirected | `execute_payout` takes no destination parameter — `contracts/poa_escrow/src/lib.rs` |
| No IBAN is written on-chain | Only `supplier_ref = sha256(iban\|salt)` goes on-chain |
| The anchor integration follows the standards | SDF `@stellar/anchor-tests`: 78/84 passing (2 anchor-side, 4 skipped) |
| It genuinely works end to end | `node scripts/e2e-m2.js` — one command, real money moving, produces a bank reference |

---

## 9. Ready-made lines for the pitch

- "Aid should move at the speed of crisis."
- "The donor looks at the ledger, not at a report."
- "The supplier never knows crypto was involved — TRY lands in their IBAN."
- "Approval authority sits in a 2-of-3 multisig; custody exists only on the last
  metre of the fiat rail, and that metre already belongs to the bank."
- "Remove the anchor and the product dies — the integration is load-bearing, not
  decorative."
- "72.81 TRY, bank reference `FAST-VWDFOZ8ESQ`. Not a slide, a receipt."
