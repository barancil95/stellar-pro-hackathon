#![cfg(test)]

use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::token::{StellarAssetClient, TokenClient};

const DEPOSIT: i128 = 1_000_0000000; // 1000 USDC, 7 ondalık

struct Ctx {
    env: Env,
    contract: Address,
    usdc: Address,
    admin: Address,
    relayer: Address,
    coords: [Address; 3],
    donor: Address,
}

fn setup() -> Ctx {
    setup_with_vault(None)
}

fn setup_with_vault(vault: Option<Address>) -> Ctx {
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

    Ctx { env, contract, usdc, admin, relayer, coords, donor }
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
    /// Eşiği geçiren iki ayrı koordinatör onayı.
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

    assert_eq!(ctx.usdc().balance(&ctx.contract), DEPOSIT, "escrow bakiyesi");
    assert_eq!(c.balance(), DEPOSIT, "available_balance SAC'tan okur");
    assert_eq!(c.get_campaign().principal, DEPOSIT);
    assert_eq!(c.get_campaign().shares, 0, "vault kapalı → shares 0 kalmalı");
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
    assert_eq!(r.supplier_ref, ctx.proof(0xAA), "IBAN değil, hash'i saklanır");
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

    assert_eq!(ctx.usdc().balance(&ctx.relayer), amount, "fon relayer'a gitti");
    assert_eq!(ctx.usdc().balance(&ctx.contract), DEPOSIT - amount);
    assert!(c.get_request(&id).completed);
    assert_eq!(c.get_campaign().disbursed, amount);
    assert_eq!(c.get_campaign().principal, DEPOSIT, "principal ödemeyle azalmaz");
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
        "mükerrer ödeme engellenmeli"
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
    assert!(!c.has_approved(&id, &ctx.coords[2]), "üçüncü onaylamadı");
}

/// Asıl tehlike: tek koordinatörün iki kez onaylayıp eşiği tek başına geçmesi.
/// Sadece `approvals_count` tutsaydık bu mümkün olurdu (plan 4.2).
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
    assert_eq!(c.get_request(&id).approvals_count, 1, "sayaç artmamalı");
    assert_eq!(
        c.try_execute_payout(&id),
        Err(Ok(Error::InsufficientApprovals)),
        "tek koordinatör kendi başına ödeme çıkaramamalı"
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

/// Onay koordinatörün kendi imzasını gerektirir — başkası onun adına onaylayamaz.
#[test]
fn approval_requires_the_coordinator_signature() {
    let ctx = setup();
    let id = ctx
        .client()
        .create_request(&ctx.proof(1), &(10_0000000), &ctx.proof(2));

    ctx.env.set_auths(&[]); // hiçbir imza sunulmuyor
    assert!(
        ctx.client().try_approve_request(&ctx.coords[0], &id).is_err(),
        "imzasız onay kabul edilmemeli"
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
        "0 onayla ödeme olmaz"
    );

    c.approve_request(&ctx.coords[0], &id);
    assert_eq!(
        c.try_execute_payout(&id),
        Err(Ok(Error::InsufficientApprovals)),
        "1/3 yetmez"
    );

    c.approve_request(&ctx.coords[2], &id);
    c.execute_payout(&id);
    assert_eq!(ctx.usdc().balance(&ctx.relayer), 10_0000000, "2/3 yeter");
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
    assert_eq!(c.get_request(&second).approvals_count, 0, "onaylar sızmamalı");
    assert_eq!(
        c.try_execute_payout(&second),
        Err(Ok(Error::InsufficientApprovals))
    );
}

/* -------------------------------- yapılandırma ---------------------------- */

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
    assert_eq!(ctx.usdc().balance(&ctx.relayer), 0, "eski relayer para almamalı");
}

/// Vault'a hazır yazıldı ama entegrasyon kapalı: adres verilirse bakiye okuma
/// sessizce yanlış cevap vermek yerine hata döner (plan 10.1.a).
#[test]
fn vault_address_is_rejected_until_integration_lands() {
    let vault = {
        let e = Env::default();
        Address::generate(&e)
    };
    let ctx = setup_with_vault(Some(vault));
    assert_eq!(ctx.client().try_balance(), Err(Ok(Error::VaultNotSupported)));
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
