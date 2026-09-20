#![cfg(test)]

use super::*;
use soroban_sdk::testutils::{Address as _, MockAuth, MockAuthInvoke};
use soroban_sdk::token::{StellarAssetClient, TokenClient};

const DEPOSIT: i128 = 1_000_0000000; // 1000 USDC, 7 decimals

struct Ctx {
    env: Env,
    contract: Address,
    usdc: Address,
    admin: Address,
    relayer: Address,
    coords: [Address; 3],
    donor: Address,
    vault: Option<Address>,
}

fn setup() -> Ctx {
    build(false)
}

/// Escrow plus (optionally) a DeFindex-compatible mock vault. The vault's asset
/// has to match the escrow's — the trap M0 caught in real life.
fn setup_vaulted() -> Ctx {
    build(true)
}

fn build(with_vault: bool) -> Ctx {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let relayer = Address::generate(&env);
    let donor = Address::generate(&env);
    let coords = [
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
    ];

    let usdc = env.register_stellar_asset_contract_v2(admin.clone()).address();
    StellarAssetClient::new(&env, &usdc).mint(&donor, &(DEPOSIT * 10));

    let vault = if with_vault {
        Some(env.register(MockVault, (usdc.clone(),)))
    } else {
        None
    };

    let contract = env.register(PoaEscrow, ());
    PoaEscrowClient::new(&env, &contract).initialize(
        &admin,
        &usdc,
        &relayer,
        &coords[0],
        &coords[1],
        &coords[2],
        &vault,
    );

    Ctx { env, contract, usdc, admin, relayer, coords, donor, vault }
}

impl Ctx {
    fn client(&self) -> PoaEscrowClient<'_> {
        PoaEscrowClient::new(&self.env, &self.contract)
    }
    fn usdc(&self) -> TokenClient<'_> {
        TokenClient::new(&self.env, &self.usdc)
    }
    fn proof(&self, b: u8) -> BytesN<32> {
        BytesN::from_array(&self.env, &[b; 32])
    }
    fn vault(&self) -> Address {
        self.vault.clone().expect("this ctx was built without a vault")
    }
    /// Mints USDC into the vault from outside — the stand-in for strategy yield.
    /// The share count stays fixed, the value per share rises.
    fn accrue_yield(&self, amount: i128) {
        StellarAssetClient::new(&self.env, &self.usdc).mint(&self.vault(), &amount);
    }
    /// Two distinct coordinator approvals, enough to clear the threshold.
    fn approve_two(&self, id: u64) {
        let c = self.client();
        c.approve_request(&self.coords[0], &id);
        c.approve_request(&self.coords[1], &id);
    }
}

/* --------------------------------- deposit -------------------------------- */

#[test]
fn deposit_moves_usdc_into_escrow() {
    let ctx = setup();
    let c = ctx.client();

    c.deposit(&ctx.donor, &DEPOSIT);

    assert_eq!(ctx.usdc().balance(&ctx.contract), DEPOSIT, "escrow balance");
    assert_eq!(c.balance(), DEPOSIT, "available_balance reads from the SAC");
    assert_eq!(c.get_campaign().principal, DEPOSIT);
    assert_eq!(c.get_campaign().shares, 0, "vault off → shares must stay 0");
}

#[test]
fn deposits_accumulate() {
    let ctx = setup();
    let c = ctx.client();
    c.deposit(&ctx.donor, &DEPOSIT);
    c.deposit(&ctx.donor, &DEPOSIT);
    assert_eq!(c.get_campaign().principal, DEPOSIT * 2);
}

#[test]
fn deposit_rejects_non_positive() {
    let ctx = setup();
    assert_eq!(
        ctx.client().try_deposit(&ctx.donor, &0),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        ctx.client().try_deposit(&ctx.donor, &-1),
        Err(Ok(Error::InvalidAmount))
    );
}

/* ------------------------------- create_request --------------------------- */

#[test]
fn create_request_assigns_sequential_ids_and_stores_proof() {
    let ctx = setup();
    let c = ctx.client();

    let first = c.create_request(&ctx.proof(0xAA), &500_0000000, &ctx.proof(0xBB));
    let second = c.create_request(&ctx.proof(0xCC), &100_0000000, &ctx.proof(0xDD));

    assert_eq!((first, second), (0, 1));
    assert_eq!(c.request_count(), 2);

    let r = c.get_request(&first);
    assert_eq!(r.amount, 500_0000000);
    assert_eq!(r.proof_hash, ctx.proof(0xBB));
    assert_eq!(r.supplier_ref, ctx.proof(0xAA), "the hash is stored, not the IBAN");
    assert_eq!(r.approvals_count, 0);
    assert!(!r.completed);
}

#[test]
fn create_request_rejects_non_positive() {
    let ctx = setup();
    assert_eq!(
        ctx.client()
            .try_create_request(&ctx.proof(1), &0, &ctx.proof(2)),
        Err(Ok(Error::InvalidAmount))
    );
}

#[test]
fn get_request_fails_for_unknown_id() {
    let ctx = setup();
    assert_eq!(ctx.client().try_get_request(&99), Err(Ok(Error::RequestNotFound)));
}

/* ------------------------------ execute_payout ---------------------------- */

#[test]
fn payout_sends_to_configured_relayer() {
    let ctx = setup();
    let c = ctx.client();
    c.deposit(&ctx.donor, &DEPOSIT);

    let amount = 250_0000000;
    let id = c.create_request(&ctx.proof(1), &amount, &ctx.proof(2));
    ctx.approve_two(id);
    c.execute_payout(&id);

    assert_eq!(ctx.usdc().balance(&ctx.relayer), amount, "funds went to the relayer");
    assert_eq!(ctx.usdc().balance(&ctx.contract), DEPOSIT - amount);
    assert!(c.get_request(&id).completed);
    assert_eq!(c.get_campaign().disbursed, amount);
    assert_eq!(c.get_campaign().principal, DEPOSIT, "principal is not reduced by a payout");
}

#[test]
fn payout_cannot_run_twice() {
    let ctx = setup();
    let c = ctx.client();
    c.deposit(&ctx.donor, &DEPOSIT);

    let id = c.create_request(&ctx.proof(1), &100_0000000, &ctx.proof(2));
    ctx.approve_two(id);
    c.execute_payout(&id);

    assert_eq!(
        c.try_execute_payout(&id),
        Err(Ok(Error::AlreadyCompleted)),
        "a double payout must be blocked"
    );
    assert_eq!(ctx.usdc().balance(&ctx.relayer), 100_0000000);
}

#[test]
fn payout_rejects_amount_above_balance() {
    let ctx = setup();
    let c = ctx.client();
    c.deposit(&ctx.donor, &(10_0000000));

    let id = c.create_request(&ctx.proof(1), &(20_0000000), &ctx.proof(2));
    ctx.approve_two(id);
    assert_eq!(
        c.try_execute_payout(&id),
        Err(Ok(Error::InsufficientBalance))
    );
    assert_eq!(ctx.usdc().balance(&ctx.relayer), 0);
}

#[test]
fn payout_fails_for_unknown_request() {
    let ctx = setup();
    assert_eq!(
        ctx.client().try_execute_payout(&42),
        Err(Ok(Error::RequestNotFound))
    );
}

/* ------------------------------ approve_request --------------------------- */

#[test]
fn approvals_accumulate_per_coordinator() {
    let ctx = setup();
    let c = ctx.client();
    let id = c.create_request(&ctx.proof(1), &(10_0000000), &ctx.proof(2));

    assert!(!c.has_approved(&id, &ctx.coords[0]));
    c.approve_request(&ctx.coords[0], &id);
    assert!(c.has_approved(&id, &ctx.coords[0]));
    assert_eq!(c.get_request(&id).approvals_count, 1);

    c.approve_request(&ctx.coords[1], &id);
    assert_eq!(c.get_request(&id).approvals_count, 2);
    assert!(!c.has_approved(&id, &ctx.coords[2]), "the third one did not approve");
}

/// The real danger: one coordinator approving twice and clearing the threshold
/// alone. Keeping only `approvals_count` would have allowed it (plan 4.2).
#[test]
fn same_coordinator_cannot_approve_twice() {
    let ctx = setup();
    let c = ctx.client();
    c.deposit(&ctx.donor, &DEPOSIT);
    let id = c.create_request(&ctx.proof(1), &(10_0000000), &ctx.proof(2));

    c.approve_request(&ctx.coords[0], &id);
    assert_eq!(
        c.try_approve_request(&ctx.coords[0], &id),
        Err(Ok(Error::AlreadyApproved))
    );
    assert_eq!(c.get_request(&id).approvals_count, 1, "the counter must not increase");
    assert_eq!(
        c.try_execute_payout(&id),
        Err(Ok(Error::InsufficientApprovals)),
        "one coordinator alone must not be able to release funds"
    );
}

#[test]
fn outsider_cannot_approve() {
    let ctx = setup();
    let c = ctx.client();
    let id = c.create_request(&ctx.proof(1), &(10_0000000), &ctx.proof(2));

    let stranger = Address::generate(&ctx.env);
    assert_eq!(
        c.try_approve_request(&stranger, &id),
        Err(Ok(Error::NotACoordinator))
    );
    assert_eq!(c.get_request(&id).approvals_count, 0);
}

/// An approval requires the coordinator's own signature — nobody can approve on
/// their behalf.
#[test]
fn approval_requires_the_coordinator_signature() {
    let ctx = setup();
    let id = ctx
        .client()
        .create_request(&ctx.proof(1), &(10_0000000), &ctx.proof(2));

    ctx.env.set_auths(&[]); // no signature is presented
    assert!(
        ctx.client().try_approve_request(&ctx.coords[0], &id).is_err(),
        "an unsigned approval must be rejected"
    );
}

#[test]
fn payout_blocked_below_threshold() {
    let ctx = setup();
    let c = ctx.client();
    c.deposit(&ctx.donor, &DEPOSIT);
    let id = c.create_request(&ctx.proof(1), &(10_0000000), &ctx.proof(2));

    assert_eq!(
        c.try_execute_payout(&id),
        Err(Ok(Error::InsufficientApprovals)),
        "no payout with 0 approvals"
    );

    c.approve_request(&ctx.coords[0], &id);
    assert_eq!(
        c.try_execute_payout(&id),
        Err(Ok(Error::InsufficientApprovals)),
        "1/3 is not enough"
    );

    c.approve_request(&ctx.coords[2], &id);
    c.execute_payout(&id);
    assert_eq!(ctx.usdc().balance(&ctx.relayer), 10_0000000, "2/3 is enough");
}

#[test]
fn completed_request_cannot_be_approved_again() {
    let ctx = setup();
    let c = ctx.client();
    c.deposit(&ctx.donor, &DEPOSIT);
    let id = c.create_request(&ctx.proof(1), &(10_0000000), &ctx.proof(2));
    ctx.approve_two(id);
    c.execute_payout(&id);

    assert_eq!(
        c.try_approve_request(&ctx.coords[2], &id),
        Err(Ok(Error::AlreadyCompleted))
    );
}

#[test]
fn approvals_are_scoped_to_their_request() {
    let ctx = setup();
    let c = ctx.client();
    c.deposit(&ctx.donor, &DEPOSIT);

    let first = c.create_request(&ctx.proof(1), &(10_0000000), &ctx.proof(2));
    let second = c.create_request(&ctx.proof(3), &(10_0000000), &ctx.proof(4));

    ctx.approve_two(first);
    assert_eq!(c.get_request(&second).approvals_count, 0, "approvals must not leak across requests");
    assert_eq!(
        c.try_execute_payout(&second),
        Err(Ok(Error::InsufficientApprovals))
    );
}

/* ------------------------------- configuration ---------------------------- */

#[test]
fn initialize_is_one_shot() {
    let ctx = setup();
    assert_eq!(
        ctx.client().try_initialize(
            &ctx.admin,
            &ctx.usdc,
            &ctx.relayer,
            &ctx.coords[0],
            &ctx.coords[1],
            &ctx.coords[2],
            &None,
        ),
        Err(Ok(Error::AlreadyInitialized))
    );
}

#[test]
fn config_holds_three_coordinators_and_no_vault() {
    let ctx = setup();
    let cfg = ctx.client().get_config();
    assert_eq!(cfg.coordinators.len(), 3);
    assert_eq!(cfg.vault, None);
    assert_eq!(cfg.relayer, ctx.relayer);
    assert_eq!(ctx.client().approval_threshold(), 2);
}

#[test]
fn update_relayer_redirects_future_payouts() {
    let ctx = setup();
    let c = ctx.client();
    c.deposit(&ctx.donor, &DEPOSIT);

    let new_relayer = Address::generate(&ctx.env);
    c.update_relayer(&new_relayer);
    assert_eq!(c.get_config().relayer, new_relayer);

    let id = c.create_request(&ctx.proof(1), &(50_0000000), &ctx.proof(2));
    ctx.approve_two(id);
    c.execute_payout(&id);

    assert_eq!(ctx.usdc().balance(&new_relayer), 50_0000000);
    assert_eq!(ctx.usdc().balance(&ctx.relayer), 0, "the old relayer must not get paid");
}

#[test]
fn uninitialized_contract_reports_it() {
    let env = Env::default();
    let contract = env.register(PoaEscrow, ());
    assert_eq!(
        PoaEscrowClient::new(&env, &contract).try_get_config(),
        Err(Ok(Error::NotInitialized))
    );
}

/* ================================ vault =================================== */

/// Mimics the four DeFindex vault methods we care about.
///
/// What matters is not that the surface matches but that the **auth behaviour**
/// does: it calls `from.require_auth()` and pulls the USDC to itself through the
/// escrow. Without the escrow's `authorize_as_current_contract`, this mock rejects
/// the call just like the real vault would.
#[contract]
pub struct MockVault;

#[contracttype]
#[derive(Clone)]
enum VKey {
    Asset,
    Supply,
    Shares(Address),
}

fn v_asset(env: &Env) -> Address {
    env.storage().instance().get(&VKey::Asset).unwrap()
}

fn v_supply(env: &Env) -> i128 {
    env.storage().instance().get(&VKey::Supply).unwrap_or(0)
}

/// Total USDC the vault manages — strategy yield included.
fn v_managed(env: &Env) -> i128 {
    TokenClient::new(env, &v_asset(env)).balance(&env.current_contract_address())
}

#[contractimpl]
impl MockVault {
    pub fn __constructor(env: Env, asset: Address) {
        env.storage().instance().set(&VKey::Asset, &asset);
        env.storage().instance().set(&VKey::Supply, &0i128);
    }

    pub fn deposit(
        env: Env,
        amounts_desired: Vec<i128>,
        amounts_min: Vec<i128>,
        from: Address,
        invest: bool,
    ) -> (Vec<i128>, i128, Option<Vec<i128>>) {
        from.require_auth();
        let _ = invest; // a no-op in a strategy-less vault — same as the real one
        let amount = amounts_desired.get(0).unwrap();
        assert!(amount >= amounts_min.get(0).unwrap(), "slippage");

        let managed_before = v_managed(&env);
        let supply = v_supply(&env);

        TokenClient::new(&env, &v_asset(&env)).transfer(
            &from,
            &env.current_contract_address(),
            &amount,
        );

        // The first deposit is 1:1; later ones at the current share price.
        let shares = if supply == 0 || managed_before == 0 {
            amount
        } else {
            supply * amount / managed_before
        };

        env.storage().instance().set(&VKey::Supply, &(supply + shares));
        let mine: i128 = env
            .storage()
            .instance()
            .get(&VKey::Shares(from.clone()))
            .unwrap_or(0);
        env.storage().instance().set(&VKey::Shares(from), &(mine + shares));

        (amounts_desired, shares, None)
    }

    pub fn withdraw(
        env: Env,
        df_amount: i128,
        min_amounts_out: Vec<i128>,
        from: Address,
    ) -> Vec<i128> {
        from.require_auth();
        let supply = v_supply(&env);
        let amount = v_managed(&env) * df_amount / supply;
        assert!(amount >= min_amounts_out.get(0).unwrap(), "min_amounts_out");

        let mine: i128 = env
            .storage()
            .instance()
            .get(&VKey::Shares(from.clone()))
            .unwrap_or(0);
        assert!(mine >= df_amount, "insufficient shares");

        env.storage()
            .instance()
            .set(&VKey::Shares(from.clone()), &(mine - df_amount));
        env.storage().instance().set(&VKey::Supply, &(supply - df_amount));

        TokenClient::new(&env, &v_asset(&env)).transfer(
            &env.current_contract_address(),
            &from,
            &amount,
        );
        vec![&env, amount]
    }

    pub fn total_supply(env: Env) -> i128 {
        v_supply(&env)
    }

    pub fn get_asset_amounts_per_shares(env: Env, vault_shares: i128) -> Vec<i128> {
        let supply = v_supply(&env);
        if supply == 0 {
            return vec![&env, 0];
        }
        vec![&env, v_managed(&env) * vault_shares / supply]
    }
}

#[test]
fn vault_open_moves_deposit_into_the_vault() {
    let ctx = setup_vaulted();
    let c = ctx.client();

    c.deposit(&ctx.donor, &DEPOSIT);

    assert_eq!(ctx.usdc().balance(&ctx.contract), 0, "no funds should sit in the escrow");
    assert_eq!(ctx.usdc().balance(&ctx.vault()), DEPOSIT, "it must move into the vault");
    assert_eq!(c.get_campaign().shares, DEPOSIT, "shares must be recorded");
    assert_eq!(c.get_campaign().principal, DEPOSIT, "principal is tracked separately");
    assert_eq!(c.balance(), DEPOSIT, "the balance must be read from the value of the shares");
}

#[test]
fn vault_closed_keeps_the_old_behaviour() {
    let ctx = setup();
    let c = ctx.client();

    c.deposit(&ctx.donor, &DEPOSIT);

    assert_eq!(ctx.usdc().balance(&ctx.contract), DEPOSIT);
    assert_eq!(c.get_campaign().shares, 0, "no shares are minted while the vault is off");
    assert_eq!(c.balance(), DEPOSIT);
}

/// Yield grows the **value** of the shares, not their **count**. The payable
/// balance exceeds the principal — the vault's one visible benefit.
#[test]
fn vault_yield_raises_available_balance_above_principal() {
    let ctx = setup_vaulted();
    let c = ctx.client();
    c.deposit(&ctx.donor, &DEPOSIT);

    ctx.accrue_yield(DEPOSIT / 10); // 10%

    assert_eq!(c.get_campaign().shares, DEPOSIT, "the share count is fixed");
    assert_eq!(c.get_campaign().principal, DEPOSIT, "principal is fixed");
    assert_eq!(c.balance(), DEPOSIT + DEPOSIT / 10, "the value rose");
}

#[test]
fn vault_payout_unwinds_shares_and_pays_the_relayer() {
    let ctx = setup_vaulted();
    let c = ctx.client();
    c.deposit(&ctx.donor, &DEPOSIT);

    let amount = 50_0000000;
    let id = c.create_request(&ctx.proof(1), &amount, &ctx.proof(2));
    ctx.approve_two(id);
    c.execute_payout(&id);

    assert_eq!(ctx.usdc().balance(&ctx.relayer), amount, "the relayer was paid");
    assert_eq!(c.get_campaign().shares, DEPOSIT - amount, "shares were unwound");
    assert_eq!(c.get_campaign().disbursed, amount);
    assert_eq!(c.balance(), DEPOSIT - amount, "the remainder is in the vault");
    assert_eq!(ctx.usdc().balance(&ctx.contract), 0, "no dust should be left in the escrow");
}

/// A payout with yield accrued: **fewer** shares are burned for the same USDC.
#[test]
fn vault_payout_burns_fewer_shares_after_yield() {
    let ctx = setup_vaulted();
    let c = ctx.client();
    c.deposit(&ctx.donor, &DEPOSIT);
    ctx.accrue_yield(DEPOSIT); // the share price doubled

    let amount = 50_0000000;
    let id = c.create_request(&ctx.proof(1), &amount, &ctx.proof(2));
    ctx.approve_two(id);
    c.execute_payout(&id);

    assert_eq!(ctx.usdc().balance(&ctx.relayer), amount);
    // 1 share = 2 USDC → 25 shares for 50 USDC.
    assert_eq!(c.get_campaign().shares, DEPOSIT - amount / 2, "half as many shares");
    assert_eq!(c.balance(), 2 * DEPOSIT - amount, "the remaining value");
}

/// The threshold check looks at the balance with the vault too: no payout while
/// the vault is empty.
#[test]
fn vault_payout_blocked_when_balance_is_short() {
    let ctx = setup_vaulted();
    let c = ctx.client();
    c.deposit(&ctx.donor, &(10_0000000));

    let id = c.create_request(&ctx.proof(1), &(50_0000000), &ctx.proof(2));
    ctx.approve_two(id);

    assert_eq!(c.try_execute_payout(&id), Err(Ok(Error::InsufficientBalance)));
    assert_eq!(ctx.usdc().balance(&ctx.relayer), 0);
}

#[test]
fn vault_balance_is_zero_before_any_deposit() {
    let ctx = setup_vaulted();
    assert_eq!(ctx.client().balance(), 0, "with no shares the balance is 0, not an error");
}

/// Does `authorize_as_current_contract` actually carry weight?
///
/// The other tests run under `mock_all_auths()`, where every authorization is
/// granted, so they would pass even with that line deleted. Here **only the
/// donor's** signature is mocked. The only thing authorizing the vault's USDC pull
/// through the escrow is the contract's own authorization — remove the line and
/// this test fails.
#[test]
fn vault_deposit_authorizes_its_own_token_pull() {
    let ctx = setup_vaulted();
    let c = ctx.client();

    ctx.env.mock_auths(&[MockAuth {
        address: &ctx.donor,
        invoke: &MockAuthInvoke {
            contract: &ctx.contract,
            fn_name: "deposit",
            args: (ctx.donor.clone(), DEPOSIT).into_val(&ctx.env),
            sub_invokes: &[MockAuthInvoke {
                contract: &ctx.usdc,
                fn_name: "transfer",
                args: (ctx.donor.clone(), ctx.contract.clone(), DEPOSIT).into_val(&ctx.env),
                sub_invokes: &[],
            }],
        },
    }]);

    c.deposit(&ctx.donor, &DEPOSIT);

    assert_eq!(c.get_campaign().shares, DEPOSIT);
    assert_eq!(ctx.usdc().balance(&ctx.vault()), DEPOSIT);
}
