# Proof-of-Action — Implementation Plan v5

> Claude Code'a verilecek çalışma planı. Hackathon sırasında (19–20 Eylül 2026)
> sırayla uygulanır. **Milestone sırası değiştirilmez**; her milestone'un
> acceptance kriteri geçmeden bir sonrakine geçilmez.
>
> v4 + DeFindex kararı kapatıldı: **vault'suz başla, vault'a hazır yaz.**

---

## 0. Bağlam

**Tagline:** "Aid should move at the speed of crisis."

Afet/kriz anlarında toplanan bağışları merkezi havuzda bekletmeden, sahadaki
doğrulanmış aktörlere ihtiyaç kanıtı + 2/3 çoklu imza onayıyla aktaran Soroban
tabanlı protokol. Amaç tam teşekküllü yardım sistemi değil; bir yardım talebinin
**kanıttan ödemeye kadar zincirde izlenebilir olduğunu** çalışan bir MVP ile
göstermek.

**Etkinlik:** Rise In × Stellar Pro Hackathon, Genesis Track. 36 saat, 4 kişi.

| # | Şart | Cevabımız |
|---|---|---|
| 1 | **Integration** — listeden bir protokol | **Stellar Wallets Kit** (`allowAllModules()`) · vault eklenirse **DeFindex** |
| 2 | **Anchor / Local Payments** | **TR Mock Anchor** (SEP-1/10/12/38/6) |
| 3 | **Core Feature** — load-bearing | Anchor çıkarsa ürün ölür; çok-cüzdan olmadan 2/3 onay çalışmaz |

> Sadece Freighter kullanmak #1'i karşılamaz — Freighter curated listede yok.
> Wallets Kit zorunlu, Freighter onun altında bir modül.

**Teslimatlar:** public repo + README, Soroban SDK ile yazılmış ve testnet'e
deploy edilmiş contract, çalışan demo, teknik tasarım dokümanı, pitch deck
(resmi template'in **kopyası**), kullanılan skill dosyalarının path'leri.

---

## 1. Mimari

```
BAĞIŞÇI ──[Wallets Kit]──► USDC ──► POA ESCROW (Soroban, SAC üzerinden)
                                        │        └─ (ops.) DeFindex vault
                  SAHA AKTÖRÜ ──────────┤ create_request + proof_hash
                                        │
        COORDINATOR A/B/C ──[Kit]───────┤ approve_request (2/3)
                                        │
                                        ▼ execute_payout
                            RELAYER HOT WALLET (backend, sabit adres)
                                        │ SEP-10(memo) + SEP-12(IBAN) + SEP-6
                                        ▼ USDC + Memo.id → treasury
                                TR MOCK ANCHOR ──► TRY ──► TEDARİKÇİ IBAN
```

**Neden relayer var:** Soroban contract'ın keypair'i yok, SEP-10 challenge
imzalayamaz, HTTP isteği atamaz.

**Custody duruşu (deck'te bu cümle geçsin):** Zincir üstü kısım güven
gerektirmiyor — onay yetkisi 2/3 multisig'te. Custody yalnızca fiat rail'in son
metresinde, ve o metre zaten bankanın.

---

## 2. Testnet gereksinimleri

**Her şey `/health`'ten okunur, hardcode edilmez.**
`GET https://tr-mock-anchor.fly.dev/health` auth istemez, frontend'den de
çağrılabilir:

```js
health.asset.issuer                  // USDC issuer
health.sep.transfer_server           // /sep6
health.sep.web_auth_endpoint         // /auth
health.sep.kyc_server                // /sep12
health.sep.anchor_quote_server       // /sep38
health.sep.signing_key               // callback imza doğrulaması
health.treasury.address              // withdraw hedefi
health.treasury.low_balance          // bool → true ise on-ramp bekler
health.rates.buy_rate / sell_rate    // TRY gösterimi (spread 50 bps)
health.limits.min_onramp_try         // "50.00"
health.limits.max_onramp_try         // "3000"
health.limits.min_offramp_usdc       // "1.0000000"
```

| Alan | Değer |
|---|---|
| Network | Stellar Testnet · `Test SDF Network ; September 2015` |
| Home domain | `tr-mock-anchor.fly.dev` |
| Horizon | `https://horizon-testnet.stellar.org` |
| Soroban RPC | `https://soroban-testnet.stellar.org` |

> 🚨 **`GDXYO6FJ…` anchor'ın SEP-10 signing key'idir — RELAYER DEĞİLDİR.**
> ```bash
> stellar keys generate relayer --network testnet
> stellar keys address relayer
> ```

**USDC SAC adresi (M0'ın ilk işi):**

```bash
stellar contract id asset \
  --asset USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 \
  --network testnet
```

> ⚠️ **Sandbox etkinlik öncesi sıfırlanabilir.** Bugün açtığınız hesaplar ve
> SEP-12 kayıtları cumartesi sabahı gitmiş olabilir. M0'ı atlamayın.

---

## 3. Config

```bash
# .env.example — repoya bu girer, .env ASLA commit edilmez
ANCHOR_HOME_DOMAIN=tr-mock-anchor.fly.dev
# endpoint'ler ve issuer /health veya stellar.toml'dan runtime'da okunur

HORIZON_URL=https://horizon-testnet.stellar.org
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"

USDC_SAC_ID=                  # M0'da türetilir
POA_CONTRACT_ID=              # deploy sonrası
VAULT_ADDRESS=                # opsiyonel — boşsa vault kapalı

RELAYER_SECRET=               # backend-only, asla frontend'e sızmaz
ADMIN_SECRET=
COORD_A_PUBLIC=
COORD_B_PUBLIC=
COORD_C_PUBLIC=

PUBLIC_BASE_URL=              # on_change_callback için (Vercel URL)
IPFS_API_KEY=                 # opsiyonel — yoksa mock CID fallback
```

---

## 4. Contract yüzeyi — vault'a hazır yazılır

### 4.1 Üç tasarım kuralı (vault'u sonradan eklemeyi ucuzlatır)

**1. Bakiye iki ayrı alanda tutulur.** Vault yokken `shares` sıfır kalır.

```rust
pub struct Campaign {
    pub principal: i128,   // yatırılan USDC toplamı
    pub shares: i128,      // vault share — vault kapalıyken 0
}
```

**2. `initialize` `vault_address` parametresini BAŞTAN alır.** Vault yoksa
`Option<Address>` olarak `None` geçilir. Sonradan parametre eklemek deploy'u ve
tüm çağrıları bozar.

**3. Bakiye okuma tek fonksiyonda toplanır.**

```rust
fn available_balance(e: &Env) -> i128 {
    match vault_address(e) {
        None => usdc_client(e).balance(&e.current_contract_address()),
        Some(v) => shares_to_assets(e, &v, campaign(e).shares),
    }
}
```

Vault gelince sadece bu fonksiyonun içi değişir.

### 4.2 Veri

```rust
pub struct DisbursementRequest {
    pub id: u64,
    pub supplier_ref: BytesN<32>,   // hash(iban + salt) — düz IBAN ledger'a YAZILMAZ
    pub amount: i128,               // USDC, SAC birimi (7 ondalık)
    pub proof_hash: BytesN<32>,     // IPFS CID veya mock SHA-256
    pub approvals_count: u32,
    pub completed: bool,
}
// Ayrıca: (request_id, coordinator) => bool — mükerrer onayı engeller.
// Sadece approvals_count tutmak YETERSİZDİR.
```

### 4.3 Fonksiyonlar

```rust
fn initialize(env, admin, usdc_sac, relayer, coord_a, coord_b, coord_c,
              vault: Option<Address>);
fn deposit(env, from: Address, amount: i128);          // from.require_auth()
fn create_request(env, supplier_ref, amount, proof_hash) -> u64;
fn approve_request(env, coordinator: Address, request_id: u64);
    // coordinator.require_auth(); coord listesinde mi; mükerrer mi
fn execute_payout(env, request_id: u64);
    // approvals_count >= 2 && !completed; fon → SABİT relayer adresine
fn update_relayer(env, new_relayer: Address);          // admin.require_auth()
```

> 🔐 `execute_payout` relayer adresini **parametre olarak almaz**. Alsaydı, 2/3
> onaydan sonra çağıran taraf fonu istediği adrese yönlendirebilirdi.

**Event'ler:** `deposit`, `request_created`, `request_approved`, `payout_executed`

> ⚠️ **Soroban storage TTL.** `persistent` storage'ın ömrü var, uzatılmazsa veri
> kaybolabilir. `extend_ttl` çağrısını baştan koyun.

**Kapsam dışı — tartışma açma, yazma:** on-chain coordinator whitelist,
konfigüre edilebilir threshold (sabit 2/3), kısmi ödeme, iade, refund, timeout,
kampanya kapatma, upgrade pattern, DAO/governance, mikroservis, WebSocket,
canlı KYC.

---

## 5. Anchor entegrasyonu — kritik detaylar

### 5.1 ⚠️ Wallet SDK ÇALIŞMIYOR — elle yazıldı

`@stellar/typescript-wallet-sdk@1.10.0` Node 26'da **import edilemiyor**:

```
TypeError: Cannot read properties of undefined (reading 'prototype')
  at ./src/walletSdk/Types/auth.ts (lib/bundle.js)
```

Paketin `main`'i webpack ile tarayıcı için bundle'lanmış tek bir dosya
(`https-browserify`, `stream-http`, `vm-browserify`) ve içine
`@stellar/stellar-sdk@13.0.0-beta.1` gömülü. Bizim kullandığımız v14 ile
çakışıyor. M0'da 10 dakikada tespit edildi, paket kaldırıldı.

**Kararlaştırılan:** SEP-1/10/12/38/6 doğrudan `@stellar/stellar-sdk` v14 +
`fetch` ile yazıldı → [`apps/web/lib/anchor.js`](apps/web/lib/anchor.js) (~230
satır). Endpoint'lerin hiçbiri hardcode değil, hepsi `/health`'ten okunuyor.
Gerçek testnet on-ramp'i ile doğrulandı.

### 5.2 ⚠️ TRY kimin IBAN'ına gidiyor — mimarinin en kritik detayı

Off-ramp, **SEP-12'de kayıtlı IBAN'a** ödeme yapar; yani SEP-10 auth yapan
hesabın IBAN'ına. Relayer auth yaparsa TRY **relayer'ın** IBAN'ına gider,
tedarikçinin değil.

**Çözüm — memo ile kapsamlanmış müşteri kaydı:**

```
1. GET /auth?account=<RELAYER_PUBLIC>&memo=<tedarikçi_id>
   → JWT'nin sub'ı "G…:memo" olur, ayrı müşteri kimliği
2. PUT /sep12/customer  { bank_account_number: "<tedarikçi IBAN>" }
   → Türk IBAN'ı mod-97 doğrulanır, ödemelerde kullanılır
   → gönderilmezse deterministik sandbox IBAN'ı devreye girer
3. GET /sep6/withdraw-exchange  (bu token'la)
   → payout o tedarikçinin IBAN'ına gider
```

Tek relayer hesabı, tedarikçi başına ayrı müşteri kaydı. `supplier_ref` ↔
`tedarikçi_id` eşleşmesi backend'de tutulur.

### 5.3 `pending_trust` VAR — M0'da ölçüldü ⚠️ v5'te yanlış yazılmıştı

**Gözlenen davranış (19 Eyl 2026, `scripts/anchor-tour.js` adım 6):** hedef hesap
var ama USDC trustline'ı yoksa deposit **claimable balance'a düşmez** —
`pending_trust` durumunda bekler:

> `Add a USDC trustline to G…; the anchor pays the USDC once the trustline exists.`

Trustline açılır açılmaz anchor **kendiliğinden** düz `payment` gönderir ve
`completed` olur. `claimClaimableBalance` çağrısı **gerekmez**.

`/sep6/info` yine `features.claimable_balances: true` ilan ediyor
(`account_creation: false` ile birlikte) — claimable balance yolu muhtemelen
hiç açılmamış hesaplar için. Fonlanmış-ama-trustline'sız senaryoda test edildi,
çıkan sonuç yukarıdaki.

**UI karşılığı:** claim butonu değil, **"USDC trustline aç"** butonu. Trustline
sonrası poll'a devam et, kendiliğinden `completed` olur.

| Status | Deposit | Withdraw |
|---|---|---|
| `pending_user_transfer_start` | TRY bekleniyor (simüle et) | Memo'lu USDC bekleniyor |
| `pending_anchor` | TRY alındı, USDC ödeniyor | — |
| `pending_trust` | **Hedefte trustline yok — açılınca otomatik ödenir** | — |
| `pending_stellar` | Gönderim yeniden deneniyor | — |
| `completed` | `stellar_transaction_id` | `external_transaction_id` = banka ref |
| `error` | Kalıcı hata, TRY iade | İptal |

Takılırsa `pending_reason`: `treasury_low` kendiliğinden çözülür.

### 5.4 Exchange varyantları

Talepler TRY cinsinden → `/sep6/withdraw-exchange` ve `/sep6/deposit-exchange`
fiyatlamayı açık yapar, `quote_id` bağlanır.

⚠️ **v5'te yanlış yazılmıştı.** Exchange varyantlarında **zincir üstü bacak
asset koduyla**, zincir dışı bacak SEP-38 formatıyla verilir. SEP-38 formatı
yalnızca `/sep38/*` çağrılarında geçerli:

```
# DOĞRU (M2'de ölçüldü)
source_asset=USDC&destination_asset=iso4217:TRY&amount=…&quote_id=…

# YANLIŞ → 400 "unsupported source_asset 'stellar:USDC:…'; this anchor ramps USDC"
source_asset=stellar:USDC:<issuer>&…
```

`funding_method=bank_account` kullanın — `type=bank_account` deprecated.

### 5.5 Quote gerçeği

SEP-38 quote **15 dakika** geçerli (`expire_after` ile 1 saate kadar), tek
kullanımlık. Off-ramp kuru 30 dakika kilitli, sonra yeniden fiyatlanır.

**Kurgu:** talep açılışında gösterge quote (UI), ödeme anında firm quote (işlem).

Jüri cümlesi: *"Kur riskini biliyoruz; talep anında gösterge, ödeme anında firm
quote alıyoruz. Slippage toleransı roadmap'te."*

### 5.6 Off-ramp gelen miktarı çevirir

Kısmi/fazla ödemeler de tamamlanır. **Sadece memo doğru olmak zorunda** —
`Memo.id(withdraw.memo)`, `memo_type: "id"`.

### 5.7 `on_change_callback` — polling yerine push

```js
// on_change_callback=<PUBLIC_BASE_URL>/api/anchor-callback
const [, t, s] = /t=(\d+), s=(.+)/.exec(req.headers['signature']);
const ok = Keypair.fromPublicKey(SIGNING_KEY)
  .verify(Buffer.from(`${t}.${req.headers.host}.${rawBody}`), Buffer.from(s, 'base64'));
```

Vercel public URL verdiği için çalışır. **Polling'i yedek tutun** (on-ramp 3 sn,
off-ramp tespiti 5 sn).

---

## 6. Milestone'lar

Sıralama mantığı: **en riskli dış bağımlılık en erken kanıtlanır.**

### M0 — Keşif (Cmt 10:30 → 13:30, workshop'larla paralel)

İki kişi workshop'ta (özellikle #3 Anchor Integration), iki kişi kurulumda.

- `GET /health` → limitler, treasury, issuer, kurlar
- `/explorer` ve `/guide` aç, elle bir deposit turu at
- **`pending_trust`'ı bilerek tetikle** (trustline'sız hesaba deposit)
- 5 testnet hesabı üret + Friendbot ile fonla (relayer, admin, coord A/B/C)
- Relayer'da USDC trustline aç
- USDC SAC ID türet
- Freighter'ı **Testnet'e çevir** (varsayılan Mainnet!)
- Yedek: Circle faucet (20 USDC / adres / 2 saat)
- **Vault kontrolü (30 dk, bkz. bölüm 10):** `get_assets` çağır, asset adresi
  USDC SAC ile eşleşiyor mu

**Acceptance:** Anchor akışı gözle doğrulandı, SAC ID elde, limitler biliniyor,
vault kararı verildi.

> Her hesapta min 1 XLM, her trustline +0.5 XLM.

---

### M1 — Para içeri giriyor (13:30 → 18:30)

- Contract: `initialize` (vault `None`) + `deposit` + `create_request` +
  `execute_payout` (**multisig henüz yok**)
- Bölüm 4.1'deki üç tasarım kuralına uy: `principal`/`shares` ayrı,
  `vault: Option<Address>`, `available_balance()` tek fonksiyon
- `cargo test`: deposit, SAC transfer, payout guard
- Testnet deploy → `POA_CONTRACT_ID`
- `lib/wallet.js`: Wallets Kit, `allowAllModules()`
- Bağışçı akışı: cüzdan bağla → `deposit` imzala

**Acceptance:** Cüzdandan USDC yatırıldı, escrow bakiyesi zincirde, TX hash elde.

> Anchor tıkanırsa Circle faucet USDC'siyle devam edin — M1 anchor'a bağımlı
> olmasın.

---

### M2 — Para dışarı çıkıyor (18:30 → 01:00) ⚠️ EN KRİTİK

- Contract: `approve_request` + mükerrer oy engeli + 2/3 guard + `update_relayer`
- `cargo test`: yetkisiz onay, mükerrer onay, mükerrer ödeme, yetersiz bakiye
- `lib/anchor.js` (Wallet SDK üzerinden):
  - SEP-10 auth, **401'de otomatik yenileme**
  - **memo'lu tedarikçi kaydı** (5.2)
  - SEP-38 firm quote
  - `withdraw-exchange` → `account_id` + `memo` → `Memo.id` ile USDC gönder
  - status poll + `on_change_callback` handler
- API route: `/api/payout`, `/api/anchor-callback`

**Acceptance (01:00, sert deadline):** USDC deposit → request → 2 onay → payout
→ relayer → withdraw → **tedarikçinin IBAN'ına** TRY `completed`.

> 01:00'de çalışmıyorsa: **özellik ekleme, kesme yap.**

---

### M3 — Görünür hale getir (01:00 → 07:00, NÖBETLEŞE)

**İki kişi uyur, iki kişi çalışır. Pazarlık yok.**

Next.js (App Router) + Tailwind + Lucide:

| Ekran | İçerik |
|---|---|
| Hero | "Aid should move at the speed of crisis." |
| Donor | Cüzdan bağlantısı, USDC + escrow bakiyesi, Donate, TX hash |
| Field Request | İhtiyaç, TRY tutar, tedarikçi, IBAN, evidence upload |
| Multisig | Coordinator A/B/C durumları, 2/3 barı, evidence önizleme |
| Audit Timeline | Evidence → Request → Approvals → Released → Anchor → TRY → DONE |

**Evidence:** IPFS → CID → Soroban. **Plan B:** IPFS/CORS 30 dakikayı aşarsa
**hemen bırak** — client-side Base64 → SHA-256 → mock CID. Fallback kodu M3
başlamadan hazır olsun.

**Acceptance:** Demo tamamen UI üzerinden yapılabiliyor, terminal gerekmiyor.

---

### M3.5 — DeFindex vault ✅ YAPILDI (M4 sonrası)

M0'daki kontrol hazır vault için kırmızıydı ama sonucu yanlış okumuştuk
(bkz. 10.1.a). Kendi vault'umuzu kurduk:

- [`scripts/create-vault.sh`](scripts/create-vault.sh) — factory'den vault,
  anchor USDC SAC'ı üzerine, tohum yatırımıyla
- `deposit` → vault'a yatırır, pay kaydeder · `execute_payout` → pay bozdurur
- `available_balance()` payın bugünkü karşılığını okur
- `authorize_as_current_contract` — vault'un escrow üzerinden yaptığı token
  çekişi için; olmadan `Error(Auth, InvalidAction)`
- 7 yeni contract testi (mock vault, gerçek auth davranışıyla)

---

### M4 — Sağlamlaştırma + teslimat (07:00 → 11:00)

- Edge case'ler: expired JWT, `pending_trust` (trustline aç butonu),
  eksik memo guard, limit dışı tutar, `treasury_low` uyarısı
- Timeline'ın gerçekten on-chain event + anchor status'ten beslendiğini doğrula
- **anchor-tests çalıştır**, çıktıyı README'ye koy:
  ```bash
  npx stellar-anchor-tests --home-domain https://tr-mock-anchor.fly.dev \
    --seps 1 10 12 6 38 --asset-code USDC --sep-config anchor-tests.config.json
  ```
- `README.md`: ne yapıyoruz, mimari, kurulum, demo adımları, contract ID, linkler
- `docs/architecture.md`: bileşenler, neden relayer, custody duruşu, tradeoff'lar
- **Kullanılan skill dosyalarının path'lerini yaz** (submission şartı)
- Deck: resmi template'in kopyası, **tek kişi** yazar

---

### 11:00 → 12:00 — DONMUŞ

- [ ] Takım adı, tüm üyelerin ad + iletişim
- [ ] GitHub repo (public mi kontrol et)
- [ ] Live demo / deployment URL
- [ ] Pitch deck linki
- [ ] **Track: Genesis** ← seçilmeyen track'e değerlendirilmezsin
- [ ] Demo 3 kez prova
- [ ] Ekran kaydı (internet çökerse yedek)

---

## 7. Repo yapısı

```
proof-of-action/
├── contracts/poa_escrow/{Cargo.toml, src/lib.rs, src/test.rs}
├── apps/web/
│   ├── app/api/{payout,quote,anchor-callback}/route.js
│   ├── app/{page.jsx,layout.jsx}
│   ├── components/
│   └── lib/{anchor.js, soroban.js, wallet.js, evidence.js}
├── scripts/{setup-testnet.js, deploy-contract.js}
├── docs/architecture.md
├── anchor-tests.config.json
├── .env.example
└── README.md
```

---

## 8. İş bölümü

| Kişi | Sorumluluk |
|---|---|
| 1 | Contract (Rust/Soroban), testler |
| 2 | Relayer + anchor adapter, API routes |
| 3 | Frontend + Wallets Kit + evidence |
| 4 | Demo senaryosu, entegrasyon testi, README + docs + deck |

Bölünme M1'in başında. Dördü birden contract'a dalarsa relayer geceye kalır.

---

## 9. Yaygın hata tablosu

| Belirti | Sebep | Çözüm |
|---|---|---|
| 401 / 403 | JWT dolmuş veya yok | SEP-10 tekrar |
| Deposit `pending_trust`'ta takıldı | Hedefte USDC trustline yok | `changeTrust` — anchor kalanı kendi yapar |
| Deposit gelmiyor | Banka transferi simüle edilmedi | `POST /sep6/tx/{id}/simulate-bank-transfer` |
| `pending_reason: treasury_low` | Treasury düşük | Kendiliğinden çözülür |
| Withdraw tamamlanmıyor | Memo eksik/yanlış tip | `Memo.id(memo)`, `memo_type: "id"` |
| TRY yanlış IBAN'a gitti | SEP-12 memo kapsamı yok | 5.2'deki akış |
| Contract USDC transfer edemiyor | Issuer adresi kullanılmış | SAC ID kullan |
| Limit hatası | Hardcode tavan | `/health`'ten oku |
| Contract verisi kayboldu | TTL uzatılmadı | `extend_ttl` |

---

## 10. DeFindex vault — M3.5 bloğu

### 10.1 Karar

**Vault'suz başla, vault'a hazır yaz.** Bölüm 4.1'deki üç kural uygulanırsa
sonradan eklemek ~40-50 satır ve 2-3 saat.

### 10.1.a ⚠️ M0 SONUCU DÜZELTİLDİ — DeFindex entegre edildi

> **Bu bölüm sonradan düzeltildi.** M0'da "elendi" yazılmıştı; ölçüm doğruydu
> ama sonuç yanlıştı. Hazır vault kullanılamıyor — ama factory'den **kendi
> vault'umuzu** kurabiliyoruz. `create_defindex_vault` anchor'ın SAC'ıyla
> çağrıldı ve geçti. Bkz. [`scripts/create-vault.sh`](scripts/create-vault.sh).

10.2'deki kontrol çalıştırıldı, **kırmızı** — hazır vault için doğru:

```
vault get_assets  → CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU
anchor USDC SAC   → CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA
```

`usdc_paltalabs_vault` **başka bir USDC** tutuyor (Blend'in kendi testnet
USDC'si), anchor'ın Circle testnet USDC'sini değil. Escrow'daki fonu **bu**
vault'a yatıramayız.

**Atlanan soru:** hazır vault'a girmek zorunda mıyız? Hayır. Factory
(`CDSCWE4GLNBYYTES2OCYDFQA2LLY4RBIAX6ZI32VSUXD7GO6HRPO4A32`) istediğimiz asset
üzerine vault kuruyor ve boş strateji listesini kabul ediyor (vault
contract'ında `validate_strategies` yalnızca tekrarı reddediyor).

**Düzeltilmiş karar: DeFindex entegre, opsiyonel.** `VAULT_ADDRESS` doluysa fon
vault'ta, boşsa escrow'da. Integration şartı (bölüm 0, #1) artık iki protokolle
karşılanıyor.

**Dürüst sınır:** o SAC için strateji olmadığından **testnet'te getiri sıfır**.
Gerekçe bölüm 10.5'teki gibi mimari — zaten öyle planlanmıştı.

### 10.2 M0'daki kontrol (30 dk)

```bash
# Adresleri taze çek — testnet sık yeniden deploy edilir
curl -s https://raw.githubusercontent.com/defindex-io/stellar-contracts/main/public/testnet.contracts.json

# Vault'un asset'ini doğrula
stellar contract invoke --id <usdc_paltalabs_vault> --network testnet \
  --source <hesap> -- get_assets

# USDC SAC ile karşılaştır
stellar contract id asset \
  --asset USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 \
  --network testnet
```

Bilinen testnet adresi (19 Eylül 2026 itibarıyla):
`usdc_paltalabs_vault = CBMVK2JK6NTOT2O4HNQAIQFJY232BHKGLIMXDVQVHIIZKDACXDFZDWHN`
— canlı, ~949 USDC bakiyeli, Blend autocompound stratejisi, `sep41` trait.

**Eşleşmiyorsa DeFindex'i tamamen bırak.** Wallets Kit savunması yeterli.

### 10.3 API DEĞİL, cross-contract

DeFindex API'si imzasız XDR döndürüyor; imzalayan bir **hesap** gerekiyor.
Soroban contract imza atamaz → escrow API'yi kullanamaz. Çözüm: vault'u
doğrudan çağır.

```rust
// deposit
let deposit_args = vec![
    &e,
    &amounts_desired,                 // Vec<i128>, tek elemanlı
    &amounts_min,                     // slippage koruması
    &e.current_contract_address(),    // from = ESCROW
    &true,                            // invest
];
let (_deposited, shares_minted, _alloc) = e.try_invoke_contract::<...>(
    &vault, &Symbol::new(&e, "deposit"), deposit_args.into_val(&e)
).unwrap().unwrap();
campaign.shares += shares_minted;
```

```rust
// withdraw — share cinsinden, önce dönüştür
let total_supply = invoke(vault, "total_supply");
let managed      = invoke(vault, "fetch_total_managed_funds"); // tek asset → [0]
let shares_to_burn = total_supply * amount_to_withdraw / managed.total_amount;

let withdraw_args = vec![
    &e, &shares_to_burn, &min_amounts_out, &e.current_contract_address()
];
```

### 10.4 Kapsam

**Yazılacak:** `deposit` vault'a yatırır + share kaydeder; `execute_payout`
share bozdurur; `initialize`'da vault adresi; UI'da tek satır bakiye.

**Yazılmayacak:** APY gösterimi/grafik, rebalancing, strateji seçimi, migration,
`rescue`, slippage ayar ekranı, çoklu vault.

### 10.5 Anlatım

Getiri argümanını abartmayın — 1000$ iki günde ~22 sent. Gerekçe **mimari**:

> "Bağış fonu atıl beklemiyor — standart bir vault arayüzünde duruyor.
> Custody escrow contract'ında; vault pozisyonu da contract'ın adına."

Afet-öncesi fonlama (para aylarca bekler, oracle tetikler) **roadmap slaytında**
kalır, kodda değil.

---

## 11. Demo senaryosu

1. Bağışçı Wallets Kit ile bağlanır, escrow'a USDC yatırır → TX hash
2. Saha aktörü talep açar: Yakıt, 1.500 TRY, ABC Akaryakıt, evidence yükler
   → SEP-38 gösterge quote
3. Coordinator A onaylar (1/2) — **kendi cüzdanıyla**
4. Coordinator B onaylar (2/2) — **farklı cüzdanla** ← Wallets Kit'in gerekçesi
5. `execute_payout` → USDC relayer'a → TX hash
6. Relayer: memo'lu tedarikçi kaydı → firm quote → withdraw-exchange →
   `Memo.id` ile USDC → anchor `completed`
7. Audit Detail: request ID, supplier ref, TRY/USDC, proof CID, contract ID,
   deposit/approval/payout TX, anchor withdrawal ID, `external_transaction_id`

Her adımda Stellar Expert linki. Anlatılan tek cümle:
**"Para nereye gitti?" sorusunun cevabı zincirde.**

**Bonus:** demo sırasında gerçek bir kullanıcıyı (yerel dernek/gönüllü) canlı
onboard et — metriklerde "onboarded real users" var.
