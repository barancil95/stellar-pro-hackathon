#![no_std]
//! Proof-of-Action escrow.
//!
//! Bağışlar USDC olarak burada durur. Saha aktörü ihtiyaç kanıtıyla talep açar,
//! koordinatörlerden 2/3 onay gelince fon **sabit** relayer adresine çıkar.
//! Relayer fiat rail'i (SEP-6 off-ramp) sürer; contract HTTP konuşamadığı için
//! o adım zincir dışındadır.
//!
//! Vault (DeFindex) **kapalı** — testnet vault'unun asset'i anchor'ın USDC
//! SAC'ı değil (plan 10.1.a). Yine de plan 4.1'deki üç kurala göre yazıldı:
//! `principal`/`shares` ayrı, `vault` baştan `Option<Address>`, bakiye okuma
//! tek fonksiyonda. Vault açılırsa sadece `available_balance` değişir.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, BytesN,
    Env, Vec,
};

/// 2/3 çoklu imza. Konfigüre edilebilir threshold kapsam dışı (plan 4.3).
const APPROVAL_THRESHOLD: u32 = 2;

// ~5 sn/ledger. Persistent entry'ler uzatılmazsa arşivlenir (plan 4.3 uyarısı).
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
    /// Vault adresi verildi ama vault entegrasyonu bu sürümde kapalı.
    VaultNotSupported = 10,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Config,
    Campaign,
    RequestCount,
    Request(u64),
    /// (request_id, coordinator) → bool. Mükerrer onayı engeller;
    /// sadece `approvals_count` tutmak yetersizdir (plan 4.2).
    Approval(u64, Address),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub usdc: Address,
    /// Payout'un tek gidebileceği adres. `execute_payout` bunu parametre
    /// olarak ALMAZ — alsaydı 2/3 onay sonrası çağıran fonu yönlendirebilirdi.
    pub relayer: Address,
    pub coordinators: Vec<Address>,
    pub vault: Option<Address>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Campaign {
    /// Yatırılan USDC toplamı.
    pub principal: i128,
    /// Vault share. Vault kapalıyken her zaman 0.
    pub shares: i128,
    /// Ödenen USDC toplamı.
    pub disbursed: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisbursementRequest {
    pub id: u64,
    /// hash(iban + salt). Düz IBAN ledger'a YAZILMAZ.
    pub supplier_ref: BytesN<32>,
    /// USDC, SAC birimi (7 ondalık).
    pub amount: i128,
    /// IPFS CID veya mock SHA-256.
    pub proof_hash: BytesN<32>,
    pub approvals_count: u32,
    pub completed: bool,
}

/* ---------------------------------- event'ler ---------------------------- */
// Audit timeline (M3) bunları okur — her adımın zincirdeki karşılığı.

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
        // Baştan alınır. Sonradan parametre eklemek deploy'u ve tüm
        // çağrıları bozardı (plan 4.1 kural 2).
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

    /// Bağışçı USDC yatırır. `from` imzalar — contract kimsenin fonunu çekemez.
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
        // Vault açılınca: fon vault'a yatırılır, dönen share buraya eklenir
        // ve `shares` sıfır olmaktan çıkar (plan 10.3).
        env.storage().instance().set(&DataKey::Campaign, &campaign);
        bump_instance(&env);

        Deposit { from, amount }.publish(&env);
        Ok(())
    }

    /// Saha aktörü talep açar. Açmak yetki istemez — para çıkışı 2/3 onaya bağlı,
    /// talep açmak tek başına zararsız ve sahadaki erişimi kısıtlamak istemiyoruz.
    pub fn create_request(
        env: Env,
        supplier_ref: BytesN<32>,
        amount: i128,
        proof_hash: BytesN<32>,
    ) -> Result<u64, Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        config(&env)?; // initialize edilmiş mi

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

    /// Fon **sabit** relayer adresine çıkar.
    ///
    /// M1: onay sayısı kontrolü henüz yok — `approve_request` M2'de gelir.
    pub fn execute_payout(env: Env, request_id: u64) -> Result<(), Error> {
        let mut request = get_request(&env, request_id)?;
        if request.completed {
            return Err(Error::AlreadyCompleted);
        }
        if available_balance(&env)? < request.amount {
            return Err(Error::InsufficientBalance);
        }

        let cfg = config(&env)?;
        // Vault açılınca burada önce share bozdurulur (plan 10.3).
        token::TokenClient::new(&env, &cfg.usdc).transfer(
            &env.current_contract_address(),
            &cfg.relayer,
            &request.amount,
        );

        request.completed = true;
        put_request(&env, &request);

        let mut campaign = campaign(&env);
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

    /* ------------------------------- görünümler ------------------------------ */

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

    /// Ödenebilir bakiye. **Vault gelince sadece bu fonksiyonun içi değişir**
    /// (plan 4.1 kural 3).
    pub fn balance(env: Env) -> Result<i128, Error> {
        available_balance(&env)
    }
}

/* --------------------------------- içsel --------------------------------- */

fn available_balance(env: &Env) -> Result<i128, Error> {
    let cfg = config(env)?;
    match cfg.vault {
        None => {
            Ok(token::TokenClient::new(env, &cfg.usdc).balance(&env.current_contract_address()))
        }
        // DeFindex bırakıldı (plan 10.1.a). Açılırsa buraya
        // shares_to_assets(total_supply, fetch_total_managed_funds) gelir.
        Some(_) => Err(Error::VaultNotSupported),
    }
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
