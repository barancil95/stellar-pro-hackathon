# Technical design

Proof-of-Action's components, the decisions we made, and the prices we paid.

---

## 1. The flow

```
DONOR ──[Wallets Kit]──► USDC ──► POA ESCROW (Soroban, through the SAC)
                                        │
                  FIELD ACTOR ──────────┤ create_request + proof_hash
                                        │
        COORDINATOR A/B/C ──[Kit]───────┤ approve_request (2/3)
                                        │
                                        ▼ execute_payout
                            RELAYER HOT WALLET (backend, fixed address)
                                        │ SEP-10(memo) + SEP-12(IBAN) + SEP-38 + SEP-6
                                        ▼ USDC + Memo.id → treasury
                                TR MOCK ANCHOR ──► TRY ──► SUPPLIER IBAN
```

---

## 2. Why there is a relayer

A Soroban contract has no keypair. It cannot sign a SEP-10 challenge or make an
HTTP request. The fiat leg is therefore necessarily off-chain.

**Our custody stance:** the on-chain part is trustless — approval authority sits in
a 2-of-3 multisig. Custody exists only on the last metre of the fiat rail, and that
metre already belongs to the bank.

The relayer's authority is limited too: `execute_payout` does **not take the
destination as a parameter**, it reads it from `Config`. If it did, the caller
could redirect the funds anywhere after the 2/3 approvals. Changing the relayer is
possible only with the admin's signature (`update_relayer`).

**Deliberately left open: `create_request` requires no authorization.** We did not
want to restrict access in the field, and opening a request alone moves no money —
the payout depends on 2/3 approvals. The cost: anyone can open a request, so the
request list can be spammed and coordinators risk approving the wrong one. The
defence is on screen: every request arrives with a proof hash and a supplier
reference, and the coordinator sees both before approving. In production this is
where a field-actor whitelist or a small per-request deposit would go; we left it
out of the hackathon scope.

---

## 3. The contract

### 3.1 Multisig

Approvals are written to persistent storage under a `(request_id, coordinator)`
key, not kept as a bare counter. With only a counter, one coordinator could approve
twice and clear the threshold alone — the `same_coordinator_cannot_approve_twice`
test guards exactly that.

`approve_request` requires the coordinator's **own** signature (`require_auth`), and
the coordinator must be on the `Config.coordinators` list. That list is fixed at
`initialize`; on-chain whitelist management is out of scope.

The threshold is a fixed 2/3 (`APPROVAL_THRESHOLD`). A configurable threshold was
deliberately not written.

### 3.2 Privacy

A plain IBAN is **never written** to the ledger. On-chain there is only
`supplier_ref = sha256(iban | salt)`. The salt and the IBAN live in the backend
(`lib/store.js`), along with the SEP-10 memo.

The same logic applies to proof: `proof_hash` goes on-chain, not the file.

### 3.3 Storage TTL

Persistent entries are archived unless extended. Every read and write calls
`extend_ttl` (a 30-day target, triggered at 20 days). Instance storage works the
same way.

### 3.4 The error surface

Functions return `Result<T, Error>` rather than panicking. That way `try_*` test
clients see typed errors and the frontend can tell contract errors apart.

---

## 4. The anchor integration

### 4.1 No endpoint is hardcoded

The issuer, the SEP endpoints, the treasury, the rates and the limits are all read
from `/health`. Since the sandbox can be reset before the event, this is a
resilience decision.

### 4.2 Whose IBAN the TRY goes to — the most critical detail

The off-ramp pays the TRY to the IBAN in the SEP-12 record of **whichever identity
did the SEP-10 auth**. If the relayer authenticates without a memo, the money goes
to the relayer's IBAN, not the supplier's.

**The fix:** a memo-scoped customer record per supplier.

```
GET /auth?account=<RELAYER>&memo=<supplier_id>   → JWT sub = "G…:memo"
PUT /sep12/customer { bank_account_number: <supplier IBAN> }
GET /sep6/withdraw-exchange  (with that token)   → the payout goes to that IBAN
```

One relayer account, a separate identity per supplier. **Measured:**

| Supplier | SEP-10 sub | The anchor's `to` field |
|---|---|---|
| 77001 | `GBML…:77001` | `TR3200100099999012345678 90` |
| 77002 | `GBML…:77002` | `TR9700062011110000066723 15` |

### 4.3 FX risk

An **indicative** quote is shown when the request is opened (UI), and a **firm**
quote is taken at payout time (the transaction). A SEP-38 quote is valid for 15
minutes and single-use. Slippage tolerance is on the roadmap.

### 4.4 The memo requirement

The off-ramp converts whatever amount arrives — partial and excess payments also
complete. Only the memo has to be right: `Memo.id`, `memo_type: "id"`. If the
anchor does not return `memo_type: "id"`, `payout.js` throws **before sending
anything**; money sent without a memo cannot be attributed.

### 4.5 Status tracking

`on_change_callback` is the main path, polling the fallback. The callback signature
is verified as Ed25519 over `"<t>.<host>.<body>"` with the anchor's `SIGNING_KEY`;
no status is written before it verifies — otherwise anyone could make one up.

On localhost the anchor cannot reach us, so when `PUBLIC_BASE_URL` is empty no
callback is requested and we fall straight back to polling.

---

## 5. The DeFindex vault

When `VAULT_ADDRESS` is set, the funds do not wait in the escrow: they sit in a
DeFindex vault on the escrow's behalf and the escrow holds shares.

### Why not a ready-made vault

The testnet `usdc_paltalabs_vault` holds BlendUSDC
(`CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU`), not the anchor's USDC
SAC (`CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`). That was a correct
finding but it led to the wrong conclusion ("DeFindex is out"). The missing point:
the factory lets us create our own vault.
[`scripts/create-vault.sh`](../scripts/create-vault.sh) makes the
`create_defindex_vault` call with the anchor's SAC.

### Why the strategy list is empty

There is no DeFindex strategy deployed for that SAC — the strategies are tied to
Blend's test USDC. The vault contract's `validate_strategies` accepts an empty list
(it only rejects duplicates), so a strategy-less vault is valid.

**We are not hiding the outcome: yield on testnet is zero.** The funds sit idle in
the vault and the yield line in the UI reads `0.0000000`. What we gain is
architecture:

- Custody stays with the escrow; the vault position is in the contract's name too.
- The balance is read from one place, wherever the funds are.
- On mainnet the only things that change are addresses — Circle USDC and a Blend
  strategy — and the same code produces yield.

The concrete reason not to oversell the yield argument: $1000 earns about 22 cents
in two days. Pre-disaster funding (money waits for months, an oracle triggers it)
stays on the roadmap.

### The contract side

`initialize` took `vault: Option<Address>` from the start, so the integration did
not break the deploy surface:

1. `Campaign.principal` and `.shares` are separate — `shares` stays 0 while the
   vault is off.
2. `deposit` puts the funds into the vault and adds the returned shares to `shares`.
3. `execute_payout` unwinds the shares first, then pays the relayer.
4. With the vault on, `available_balance()` reads **today's value** of the shares —
   with yield, the balance exceeds the principal.

**The critical detail — `authorize_as_current_contract`.** The vault pulls the USDC
to itself through the escrow. That transfer is on the escrow's behalf but is not
the escrow's direct call (the vault sits in between), so the contract has to
authorize that sub-invocation explicitly. Without the line, the deposit fails with
`Error(Auth, InvalidAction)`. The test mock mimics the real vault's auth behaviour
and six tests fail when the line is removed — measured.

### The way back

With `VAULT_ADDRESS` empty, `initialize --vault null` keeps the old behaviour
exactly: the funds stay in the escrow and `shares` stays 0. If the vault side
breaks, the escape hatch is one line.

---

## 6. Trade-offs

| Decision | The price |
|---|---|
| A hand-written SEP client instead of the Wallet SDK | ~230 lines to maintain. In return it runs on Node 26 and the dependency surface is small. |
| The contract spec is read from the chain | One network call per client construction. In return there is no binding generation step and the frontend stays current when the contract changes. |
| SHA-256 instead of IPFS | The file's availability is the user's problem. Since the on-chain commitment is a hash either way, the proof is just as strong. |
| The supplier ledger in a file | Single process. In production it would be a database. |
| A fixed 2/3 threshold | No flexibility. In return the attack surface and the test matrix stay small. |
| A hot relayer wallet | Custody on the last metre of the fiat rail. The on-chain part is unaffected by it. |

---

## 7. Roadmap

- Slippage tolerance and quote refresh
- Partial payments, refunds, cancelling a request on timeout
- On-chain coordinator management and a configurable threshold
- Persistent storage for proof files (IPFS/Arweave)
- Pre-disaster funding: money waits for months, an oracle triggers it — a vault
  with a matching asset earns its place in that scenario
