#![no_std]
//! Proof-of-Action escrow.
//!
//! Donations sit here as USDC. A field actor opens a request with proof of need,
//! and once 2 of 3 coordinators approve, the funds leave to the **fixed** relayer
//! address. The relayer drives the fiat rail (SEP-6 off-ramp); that step is
//! off-chain because a contract cannot speak HTTP.
//!
//! The (DeFindex) vault is **optional and enabled**. Plan 10.1.a correctly found
//! that the ready-made `usdc_paltalabs_vault` does not hold the anchor's USDC SAC;
//! what it missed is that the factory lets us create **our own vault**.
//! `create_defindex_vault` was simulated with the anchor's SAC and passed.
//!
//! `vault: None` → funds stay in the escrow (the old behaviour, kept as is).
//! `vault: Some(v)` → funds sit in a DeFindex vault and the escrow holds shares.
//! On testnet there is no strategy for that SAC, so yield is **zero**; what we gain
//! is architecture. On mainnet the same code yields with Circle USDC + Blend.

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contracterror, contractevent, contractimpl, contracttype, token, vec, Address,
    BytesN, Env, IntoVal, Symbol, Val, Vec,
};

/// 2-of-3 multisig. A configurable threshold is out of scope (plan 4.3).
const APPROVAL_THRESHOLD: u32 = 2;

// ~5 s/ledger. Persistent entries are archived unless extended (plan 4.3 warning).
const LEDGERS_PER_DAY: u32 = 17_280;
const TTL_EXTEND_TO: u32 = LEDGERS_PER_DAY * 30;
const TTL_BUMP_AT: u32 = LEDGERS_PER_DAY * 20;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidAmount = 3,
    RequestNotFound = 4,
    AlreadyCompleted = 5,
    NotACoordinator = 6,
    AlreadyApproved = 7,
    InsufficientApprovals = 8,
    InsufficientBalance = 9,
    /// No shares in the vault — the share/asset ratio cannot be computed.
    VaultEmpty = 10,
    /// The share computation overflowed i128.
    ArithmeticOverflow = 11,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Config,
    Campaign,
    RequestCount,
    Request(u64),
    /// (request_id, coordinator) → bool. Prevents double approval; keeping only
    /// `approvals_count` would not be enough (plan 4.2).
    Approval(u64, Address),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub usdc: Address,
    /// The only address a payout can go to. `execute_payout` does NOT take this
    /// as a parameter — if it did, a caller could redirect funds after the 2/3
    /// approvals.
    pub relayer: Address,
    pub coordinators: Vec<Address>,
    pub vault: Option<Address>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Campaign {
    /// Total USDC deposited.
    pub principal: i128,
    /// Vault shares. Always 0 while the vault is off.
    pub shares: i128,
    /// Total USDC disbursed.
    pub disbursed: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisbursementRequest {
    pub id: u64,
    /// hash(iban + salt). A plain IBAN is NEVER written to the ledger.
    pub supplier_ref: BytesN<32>,
    /// USDC in SAC units (7 decimals).
    pub amount: i128,
    /// IPFS CID or mock SHA-256.
    pub proof_hash: BytesN<32>,
    pub approvals_count: u32,
    pub completed: bool,
}

/* ----------------------------------- events ------------------------------ */
// The audit timeline (M3) reads these — each step's on-chain counterpart.

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Deposit {
    #[topic]
    pub from: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RequestCreated {
    #[topic]
    pub request_id: u64,
    pub supplier_ref: BytesN<32>,
    pub amount: i128,
    pub proof_hash: BytesN<32>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RequestApproved {
    #[topic]
    pub request_id: u64,
    #[topic]
    pub coordinator: Address,
    /// The total after this approval.
    pub approvals_count: u32,
    pub threshold: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayoutExecuted {
    #[topic]
    pub request_id: u64,
    pub relayer: Address,
    pub amount: i128,
    pub supplier_ref: BytesN<32>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RelayerUpdated {
    pub relayer: Address,
}

#[contract]
pub struct PoaEscrow;

#[contractimpl]
impl PoaEscrow {
    #[allow(clippy::too_many_arguments)]
    pub fn initialize(
        env: Env,
        admin: Address,
        usdc_sac: Address,
        relayer: Address,
        coord_a: Address,
        coord_b: Address,
        coord_c: Address,
        // Taken from the start. Adding a parameter later would break the deploy
        // and every call (plan 4.1 rule 2).
        vault: Option<Address>,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();

        let cfg = Config {
            admin,
            usdc: usdc_sac,
            relayer,
            coordinators: Vec::from_array(&env, [coord_a, coord_b, coord_c]),
            vault,
        };
        env.storage().instance().set(&DataKey::Config, &cfg);
        env.storage().instance().set(
            &DataKey::Campaign,
            &Campaign { principal: 0, shares: 0, disbursed: 0 },
        );
        env.storage().instance().set(&DataKey::RequestCount, &0u64);
        bump_instance(&env);
        Ok(())
    }

    /// A donor deposits USDC. `from` signs — the contract cannot pull anyone's funds.
    pub fn deposit(env: Env, from: Address, amount: i128) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        from.require_auth();

        let cfg = config(&env)?;
        token::TokenClient::new(&env, &cfg.usdc).transfer(
            &from,
            &env.current_contract_address(),
            &amount,
        );

        let mut campaign = campaign(&env);
        campaign.principal += amount;
        // With the vault on, funds do not wait in the escrow: they are deposited
        // into the vault and the returned shares are recorded on the campaign.
        // With it off, `shares` stays 0 (plan 10.3).
        if let Some(vault) = &cfg.vault {
            campaign.shares += vault_deposit(&env, &cfg.usdc, vault, amount);
        }
        env.storage().instance().set(&DataKey::Campaign, &campaign);
        bump_instance(&env);

        Deposit { from, amount }.publish(&env);
        Ok(())
    }

    /// A field actor opens a request. Opening one needs no authorization — the
    /// payout depends on 2/3 approvals, opening a request alone is harmless, and we
    /// do not want to restrict access in the field.
    pub fn create_request(
        env: Env,
        supplier_ref: BytesN<32>,
        amount: i128,
        proof_hash: BytesN<32>,
    ) -> Result<u64, Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        config(&env)?; // is it initialized

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::RequestCount)
            .unwrap_or(0);

        put_request(
            &env,
            &DisbursementRequest {
                id,
                supplier_ref: supplier_ref.clone(),
                amount,
                proof_hash: proof_hash.clone(),
                approvals_count: 0,
                completed: false,
            },
        );
        env.storage().instance().set(&DataKey::RequestCount, &(id + 1));
        bump_instance(&env);

        RequestCreated { request_id: id, supplier_ref, amount, proof_hash }.publish(&env);
        Ok(id)
    }

    /// A coordinator approval. Two of the three are enough.
    ///
    /// The approval is signed with the **coordinator's own wallet**. Each approval
    /// is written under its own (request, coordinator) key — keeping just a counter
    /// would let one coordinator approve twice and clear the threshold alone.
    pub fn approve_request(
        env: Env,
        coordinator: Address,
        request_id: u64,
    ) -> Result<(), Error> {
        coordinator.require_auth();

        let cfg = config(&env)?;
        if !cfg.coordinators.contains(&coordinator) {
            return Err(Error::NotACoordinator);
        }

        let mut request = get_request(&env, request_id)?;
        if request.completed {
            return Err(Error::AlreadyCompleted);
        }

        let vote = DataKey::Approval(request_id, coordinator.clone());
        if env.storage().persistent().get(&vote).unwrap_or(false) {
            return Err(Error::AlreadyApproved);
        }
        env.storage().persistent().set(&vote, &true);
        env.storage()
            .persistent()
            .extend_ttl(&vote, TTL_BUMP_AT, TTL_EXTEND_TO);

        request.approvals_count += 1;
        put_request(&env, &request);

        RequestApproved {
            request_id,
            coordinator,
            approvals_count: request.approvals_count,
            threshold: APPROVAL_THRESHOLD,
        }
        .publish(&env);
        Ok(())
    }

    /// Funds leave to the **fixed** relayer address. 2/3 approvals are required.
    pub fn execute_payout(env: Env, request_id: u64) -> Result<(), Error> {
        let mut request = get_request(&env, request_id)?;
        if request.completed {
            return Err(Error::AlreadyCompleted);
        }
        if request.approvals_count < APPROVAL_THRESHOLD {
            return Err(Error::InsufficientApprovals);
        }
        if available_balance(&env)? < request.amount {
            return Err(Error::InsufficientBalance);
        }

        let cfg = config(&env)?;
        let mut campaign = campaign(&env);

        // With the vault on the funds sit there: shares are unwound first, the USDC
        // returns to the escrow, and only then goes to the relayer (plan 10.3).
        if let Some(vault) = &cfg.vault {
            campaign.shares -= vault_withdraw(&env, vault, request.amount)?;
        }

        token::TokenClient::new(&env, &cfg.usdc).transfer(
            &env.current_contract_address(),
            &cfg.relayer,
            &request.amount,
        );

        request.completed = true;
        put_request(&env, &request);

        campaign.disbursed += request.amount;
        env.storage().instance().set(&DataKey::Campaign, &campaign);
        bump_instance(&env);

        PayoutExecuted {
            request_id,
            relayer: cfg.relayer,
            amount: request.amount,
            supplier_ref: request.supplier_ref,
        }
        .publish(&env);
        Ok(())
    }

    pub fn update_relayer(env: Env, new_relayer: Address) -> Result<(), Error> {
        let mut cfg = config(&env)?;
        cfg.admin.require_auth();
        cfg.relayer = new_relayer.clone();
        env.storage().instance().set(&DataKey::Config, &cfg);
        bump_instance(&env);

        RelayerUpdated { relayer: new_relayer }.publish(&env);
        Ok(())
    }

    /* --------------------------------- views --------------------------------- */

    pub fn get_config(env: Env) -> Result<Config, Error> {
        config(&env)
    }

    pub fn get_campaign(env: Env) -> Campaign {
        campaign(&env)
    }

    pub fn get_request(env: Env, request_id: u64) -> Result<DisbursementRequest, Error> {
        get_request(&env, request_id)
    }

    pub fn request_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::RequestCount)
            .unwrap_or(0)
    }

    pub fn has_approved(env: Env, request_id: u64, coordinator: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Approval(request_id, coordinator))
            .unwrap_or(false)
    }

    pub fn approval_threshold() -> u32 {
        APPROVAL_THRESHOLD
    }

    /// The payable balance. **Adding the vault changes only this function's body**
    /// (plan 4.1 rule 3).
    pub fn balance(env: Env) -> Result<i128, Error> {
        available_balance(&env)
    }
}

/* -------------------------------- internal -------------------------------- */

fn available_balance(env: &Env) -> Result<i128, Error> {
    let cfg = config(env)?;
    match cfg.vault {
        None => {
            Ok(token::TokenClient::new(env, &cfg.usdc).balance(&env.current_contract_address()))
        }
        // Vault on: the balance is no longer the token balance but today's value of
        // the shares we hold. Any yield shows up here.
        Some(vault) => {
            let shares = campaign(env).shares;
            if shares <= 0 {
                return Ok(0);
            }
            Ok(shares_to_assets(env, &vault, shares))
        }
    }
}

/* ---------------------------------- vault -------------------------------- */
// We talk to the DeFindex vault through four methods: deposit, withdraw,
// total_supply, get_asset_amounts_per_shares. Single-asset vault assumed — the
// first element of the returned vectors is our USDC.

/// Today's USDC value of `shares` shares.
fn shares_to_assets(env: &Env, vault: &Address, shares: i128) -> i128 {
    let amounts: Vec<i128> = env.invoke_contract(
        vault,
        &Symbol::new(env, "get_asset_amounts_per_shares"),
        vec![env, shares.into_val(env)],
    );
    amounts.get(0).unwrap_or(0)
}

/// Deposits funds into the vault and returns the shares minted.
///
/// The vault pulls the USDC to itself through the escrow. That transfer is made on
/// the escrow's behalf but is not the escrow's *direct* call — the vault sits in
/// between — so the token transfer has to be authorized explicitly. Without this
/// line the deposit fails on `require_auth`.
fn vault_deposit(env: &Env, usdc: &Address, vault: &Address, amount: i128) -> i128 {
    let me = env.current_contract_address();

    env.authorize_as_current_contract(vec![
        env,
        InvokerContractAuthEntry::Contract(SubContractInvocation {
            context: ContractContext {
                contract: usdc.clone(),
                fn_name: Symbol::new(env, "transfer"),
                args: (me.clone(), vault.clone(), amount).into_val(env),
            },
            sub_invocations: vec![env],
        }),
    ]);

    // Single asset, no swap: we expect all of what we deposit to go in.
    let amounts = vec![env, amount];
    let (_deposited, shares, _allocations): (Vec<i128>, i128, Val) = env.invoke_contract(
        vault,
        &Symbol::new(env, "deposit"),
        vec![
            env,
            amounts.into_val(env), // amounts_desired
            amounts.into_val(env), // amounts_min — slippage protection
            me.into_val(env),
            // invest: a no-op in a strategy-less vault, on mainnet it puts the funds
            // into the strategy. true so the same code behaves right on both networks.
            true.into_val(env),
        ],
    );
    shares
}

/// Withdraws `amount` USDC from the vault and returns the shares burned.
fn vault_withdraw(env: &Env, vault: &Address, amount: i128) -> Result<i128, Error> {
    let me = env.current_contract_address();

    let total_supply: i128 =
        env.invoke_contract(vault, &Symbol::new(env, "total_supply"), vec![env]);
    let total_assets = shares_to_assets(env, vault, total_supply);
    if total_supply <= 0 || total_assets <= 0 {
        return Err(Error::VaultEmpty);
    }

    // Rounded up: rounding down would withdraw one stroop short and the transfer to
    // the relayer would fail. The leftover dust stays in the escrow as vault shares.
    let shares_to_burn = total_supply
        .checked_mul(amount)
        .and_then(|v| v.checked_add(total_assets - 1))
        .ok_or(Error::ArithmeticOverflow)?
        / total_assets;

    let _withdrawn: Vec<i128> = env.invoke_contract(
        vault,
        &Symbol::new(env, "withdraw"),
        vec![
            env,
            shares_to_burn.into_val(env),
            vec![env, amount].into_val(env), // min_amounts_out
            me.into_val(env),
        ],
    );
    Ok(shares_to_burn)
}

fn config(env: &Env) -> Result<Config, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(Error::NotInitialized)
}

fn campaign(env: &Env) -> Campaign {
    env.storage()
        .instance()
        .get(&DataKey::Campaign)
        .unwrap_or(Campaign { principal: 0, shares: 0, disbursed: 0 })
}

fn get_request(env: &Env, id: u64) -> Result<DisbursementRequest, Error> {
    let key = DataKey::Request(id);
    let request = env
        .storage()
        .persistent()
        .get::<DataKey, DisbursementRequest>(&key)
        .ok_or(Error::RequestNotFound)?;
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_BUMP_AT, TTL_EXTEND_TO);
    Ok(request)
}

fn put_request(env: &Env, request: &DisbursementRequest) {
    let key = DataKey::Request(request.id);
    env.storage().persistent().set(&key, request);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_BUMP_AT, TTL_EXTEND_TO);
}

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_BUMP_AT, TTL_EXTEND_TO);
}

mod test;
