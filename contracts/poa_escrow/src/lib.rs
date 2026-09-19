#![no_std]
//! Proof-of-Action escrow.
//!
//! Bağışlar USDC olarak burada durur. Saha aktörü ihtiyaç kanıtıyla talep açar,
//! koordinatörlerden 2/3 onay gelince fon **sabit** relayer adresine çıkar.
//! Relayer fiat rail'i (SEP-6 off-ramp) sürer; contract HTTP konuşamadığı için
//! o adım zincir dışındadır.
//!
//! Vault (DeFindex) **opsiyonel ve açık**. Plan 10.1.a hazır
//! `usdc_paltalabs_vault`'un asset'inin anchor USDC SAC'ı olmadığını doğru
//! tespit etmişti; atlanan nokta factory'den **kendi vault'umuzu** kurabildiğimiz.
//! `create_defindex_vault` anchor'ın SAC'ıyla simüle edildi ve geçti.
//!
//! `vault: None` → fon escrow'da durur (eski davranış, aynen korunur).
//! `vault: Some(v)` → fon DeFindex vault'unda durur, escrow pay (share) tutar.
//! Testnet'te o SAC için strateji olmadığı için getiri **sıfırdır**; kazanç
//! mimari. Mainnet'te aynı kod Circle USDC + Blend stratejisiyle getiri üretir.

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contracterror, contractevent, contractimpl, contracttype, token, vec, Address,
    BytesN, Env, IntoVal, Symbol, Val, Vec,
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
    /// Vault'ta pay yok — share/asset oranı hesaplanamaz.
    VaultEmpty = 10,
    /// Pay hesabı i128'i taşırdı.
    ArithmeticOverflow = 11,
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
pub struct RequestApproved {
    #[topic]
    pub request_id: u64,
    #[topic]
    pub coordinator: Address,
    /// Bu onaydan sonraki toplam.
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
        // Vault açıksa fon escrow'da beklemez: vault'a yatırılır, dönen pay
        // kampanyaya yazılır. Kapalıysa `shares` 0 kalır (plan 10.3).
        if let Some(vault) = &cfg.vault {
            campaign.shares += vault_deposit(&env, &cfg.usdc, vault, amount);
        }
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

    /// Koordinatör onayı. Üçünden ikisi yeterli.
    ///
    /// Onay **koordinatörün kendi cüzdanıyla** imzalanır. Her onay ayrı bir
    /// (request, coordinator) anahtarına yazılır — sadece sayaç tutmak aynı
    /// koordinatörün iki kez onaylayıp eşiği tek başına geçmesine izin verirdi.
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

    /// Fon **sabit** relayer adresine çıkar. 2/3 onay şart.
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

        // Vault açıksa fon orada duruyor: önce pay bozdurulur, USDC escrow'a
        // döner, sonra relayer'a çıkar (plan 10.3).
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
        // Vault açık: bakiye artık token bakiyesi değil, elimizdeki payın
        // bugünkü karşılığı. Getiri varsa burada görünür.
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
// DeFindex vault'u dört metoduyla konuşuyoruz: deposit, withdraw,
// total_supply, get_asset_amounts_per_shares. Tek asset'li vault varsayımı —
// dönen vektörlerin ilk elemanı bizim USDC'miz.

/// `shares` kadar payın bugünkü USDC karşılığı.
fn shares_to_assets(env: &Env, vault: &Address, shares: i128) -> i128 {
    let amounts: Vec<i128> = env.invoke_contract(
        vault,
        &Symbol::new(env, "get_asset_amounts_per_shares"),
        vec![env, shares.into_val(env)],
    );
    amounts.get(0).unwrap_or(0)
}

/// Fonu vault'a yatırır, basılan payı döner.
///
/// Vault USDC'yi escrow'un üzerinden kendine çekiyor. O transfer escrow adına
/// yapılıyor ama escrow'un *doğrudan* çağrısı değil — araya vault giriyor — bu
/// yüzden token transferi için açıkça yetki verilmesi gerekiyor. Bu satır
/// olmadan deposit `require_auth` ile düşer.
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

    // Tek asset, swap yok: yatırdığımızın tamamının girmesini bekliyoruz.
    let amounts = vec![env, amount];
    let (_deposited, shares, _allocations): (Vec<i128>, i128, Val) = env.invoke_contract(
        vault,
        &Symbol::new(env, "deposit"),
        vec![
            env,
            amounts.into_val(env), // amounts_desired
            amounts.into_val(env), // amounts_min — slippage koruması
            me.into_val(env),
            // invest: stratejisiz vault'ta no-op, mainnet'te fonu stratejiye
            // koyar. Aynı kodun iki ağda da doğru davranması için true.
            true.into_val(env),
        ],
    );
    shares
}

/// Vault'tan `amount` USDC çeker, yakılan payı döner.
fn vault_withdraw(env: &Env, vault: &Address, amount: i128) -> Result<i128, Error> {
    let me = env.current_contract_address();

    let total_supply: i128 =
        env.invoke_contract(vault, &Symbol::new(env, "total_supply"), vec![env]);
    let total_assets = shares_to_assets(env, vault, total_supply);
    if total_supply <= 0 || total_assets <= 0 {
        return Err(Error::VaultEmpty);
    }

    // Yukarı yuvarlanıyor: aşağı yuvarlarsak bir stroop eksik çeker ve
    // relayer'a transfer düşer. Artan toz vault payı olarak escrow'da kalır.
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
