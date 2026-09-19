# Proof-of-Action — Implementation Plan v4

> Claude Code'a verilecek çalışma planı. Hackathon sırasında (19–20 Eylül 2026)
> sırayla uygulanır. **Milestone sırası değiştirilmez**; her milestone'un
> acceptance kriteri geçmeden bir sonrakine geçilmez.
>
> v3 + resmi hackathon dokümanlarından (docs sitesi + anchor `/guide` + `/health`)
> çıkan bulgular. DeFindex/vault kararı bu dosyada **yok** — ayrı dosyada.

---

## 0. Bağlam

**Tagline:** "Aid should move at the speed of crisis."

Afet/kriz anlarında toplanan bağışları merkezi havuzda bekletmeden, sahadaki
doğrulanmış aktörlere ihtiyaç kanıtı + 2/3 çoklu imza onayıyla aktaran
Soroban tabanlı protokol. Amaç tam teşekküllü yardım sistemi değil; bir yardım
talebinin **kanıttan ödemeye kadar zincirde izlenebilir olduğunu** çalışan bir
MVP ile göstermek.

**Etkinlik:** Rise In × Stellar Pro Hackathon, Genesis Track. 36 saat, 4 kişi.

| # | Şart | Cevabımız |
|---|---|---|
| 1 | **Integration** — listeden bir protokol | **Stellar Wallets Kit** (`allowAllModules()`) |
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
                                        │
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

**Her şey `/health`'ten okunur, hardcode edilmez.** `GET https://tr-mock-anchor.fly.dev/health`
auth istemez, frontend'den de çağrılabilir. Alan adları:

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

Sabit olanlar:

| Alan | Değer |
|---|---|
| Network | Stellar Testnet · `Test SDF Network ; September 2015` |
| Home domain | `tr-mock-anchor.fly.dev` |
| Horizon | `https://horizon-testnet.stellar.org` |
| Soroban RPC | `https://soroban-testnet.stellar.org` |

> 🚨 **`GDXYO6FJ…` anchor'ın SEP-10 signing key'idir — RELAYER DEĞİLDİR.**
> Relayer'ı kendiniz üretin:
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

Klasik Stellar varlığı Soroban kontratı içinde doğrudan tutulamaz; transferler
`token::Client` ile bu SAC adresi üzerinden yapılır.

> ⚠️ **Sandbox etkinlik öncesi sıfırlanabilir.** Bugün açtığınız hesaplar ve
> SEP-12 kayıtları cumartesi sabahı gitmiş olabilir. M0'ı atlamayın.

---

## 3. Config

`.env.example` (repoya bu girer, `.env` **asla** commit edilmez):

```bash
ANCHOR_HOME_DOMAIN=tr-mock-anchor.fly.dev
# endpoint'ler ve issuer /health veya stellar.toml'dan runtime'da okunur

HORIZON_URL=https://horizon-testnet.stellar.org
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"

USDC_SAC_ID=                  # M0'da türetilir
POA_CONTRACT_ID=              # deploy sonrası

RELAYER_SECRET=               # backend-only, asla frontend'e sızmaz
ADMIN_SECRET=
COORD_A_PUBLIC=
COORD_B_PUBLIC=
COORD_C_PUBLIC=

PUBLIC_BASE_URL=              # on_change_callback için (Vercel URL)
IPFS_API_KEY=                 # opsiyonel — yoksa mock CID fallback
```

---

## 4. Contract yüzeyi

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

```rust
fn initialize(env, admin, usdc_sac, relayer, coord_a, coord_b, coord_c);
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
— frontend timeline bunlardan beslenir.

> ⚠️ **Soroban storage TTL.** `persistent` storage'ın ömrü var, uzatılmazsa veri
> kaybolabilir. `extend_ttl` çağrısını baştan koyun, sonradan eklemeyin.

**Kapsam dışı — tartışma açma, yazma:** on-chain coordinator whitelist
(3 adres `initialize`'da sabit), konfigüre edilebilir threshold (sabit 2/3),
kısmi ödeme, iade, refund, timeout, kampanya kapatma, upgrade pattern,
DAO/governance, mikroservis, WebSocket (polling + callback yeterli),
canlı KYC (SEP-12 mock'ta otomatik).

---

## 5. Anchor entegrasyonu — kritik detaylar

### 5.1 Wallet SDK kullanın, elle yazmayın

```bash
npm install @stellar/typescript-wallet-sdk
```

```js
const wallet = Wallet.TestNet();
const anchor = wallet.anchor({ homeDomain: 'tr-mock-anchor.fly.dev' });
const authToken = await anchor.sep10().authenticate({ accountKp: keypair });
const sep6 = anchor.sep6();
```

TOML fetch + parse, challenge/sign/token, endpoint keşfi — hepsi SDK'nın içinde.
M2'den ~1 saat kazandırır.

### 5.2 ⚠️ TRY kimin IBAN'ına gidiyor — mimarinin en kritik detayı

Off-ramp, **SEP-12'de kayıtlı IBAN'a** ödeme yapar; yani SEP-10 auth yapan
hesabın IBAN'ına. Relayer auth yaparsa TRY **relayer'ın** IBAN'ına gider,
tedarikçinin değil. Bu ürün hikâyesini kırar.

**Çözüm — memo ile kapsamlanmış müşteri kaydı:**

```
1. GET /auth?account=<RELAYER_PUBLIC>&memo=<tedarikçi_id>
   → JWT'nin sub'ı "G…:memo" olur, ayrı bir müşteri kimliği
2. PUT /sep12/customer  { bank_account_number: "<tedarikçi IBAN>" }
   → Türk IBAN'ı mod-97 ile doğrulanır ve ödemelerde kullanılır
   → IBAN gönderilmezse deterministik sandbox IBAN'ı devreye girer
3. GET /sep6/withdraw   (bu token'la)
   → payout o tedarikçinin IBAN'ına gider
```

Tek relayer hesabı, tedarikçi başına ayrı müşteri kaydı. `supplier_ref` hash'i
ile `tedarikçi_id` eşleşmesi backend'de tutulur.

### 5.3 `pending_trust` YOK — claimable balance var

Hedef hesap varsa ve USDC trustline'ı varsa normal `payment`; yoksa **claimable
balance** oluşur (`claimable_balance_id` transaction'da). Deposit takılmaz.
Cüzdan trustline açıp `claimClaimableBalance({ balanceId })` çağırır — ikisi tek
transaction'da olabilir.

Gerçek status listesi:

| Status | Deposit | Withdraw |
|---|---|---|
| `pending_user_transfer_start` | TRY transferi bekleniyor (simüle et) | Memo'lu USDC bekleniyor |
| `pending_anchor` | TRY alındı, USDC ödeniyor (treasury düşükse de) | — |
| `pending_stellar` | Gönderim yeniden deneniyor | — |
| `completed` | `stellar_transaction_id`, belki `claimable_balance_id` | `external_transaction_id` = banka referansı |
| `error` | Kalıcı hata, TRY iade | İptal |

Takılırsa `pending_reason`'a bakın: `treasury_low` kendiliğinden çözülür.

### 5.4 Exchange varyantlarını kullanın

Talepleriniz TRY cinsinden. `/sep6/withdraw-exchange` ve `/sep6/deposit-exchange`
fiyatlamayı açık hale getirir ve `quote_id` bağlamanıza izin verir:

```
source_asset=stellar:USDC:<issuer>&destination_asset=iso4217:TRY&amount=…&quote_id=…
```

Ayrıca `funding_method=bank_account` kullanın — `type=bank_account` deprecated
(kabul ediliyor ama).

### 5.5 Quote gerçeği

SEP-38 quote **15 dakika** geçerli (`expire_after` ile 1 saate kadar), tek
kullanımlık ve kullanıcıya bağlı. Off-ramp kuru 30 dakika kilitli, sonra yeniden
fiyatlanıyor. Yani onay süreci uzarsa quote expire olur.

**Doğru kurgu:** talep açılışında gösterge quote (UI için), ödeme anında yeni
quote (işlem için). Kur riski kalkmıyor, görünür oluyor.

Jüri cümlesi: *"Kur riskini biliyoruz; talep anında gösterge, ödeme anında firm
quote alıyoruz. Slippage toleransı roadmap'te."*

### 5.6 Off-ramp gelen miktarı çevirir

Kısmi veya fazla ödemeler de tamamlanır. **Sadece memo doğru olmak zorunda** —
`Memo.id(withdraw.memo)`, `memo_type: "id"`. Memo eksik/yanlışsa anchor işlemi
eşleştiremez ve iade süreci yok.

### 5.7 `on_change_callback` — polling yerine push

Deposit/withdraw çağrısına `on_change_callback=<PUBLIC_BASE_URL>/api/anchor-callback`
ekleyin. Anchor her status değişiminde POST atar, `Signature: t=…, s=…` header'ı
ile Ed25519 imzalı:

```js
const [, t, s] = /t=(\d+), s=(.+)/.exec(req.headers['signature']);
const ok = Keypair.fromPublicKey(SIGNING_KEY)
  .verify(Buffer.from(`${t}.${req.headers.host}.${rawBody}`), Buffer.from(s, 'base64'));
```

Vercel deploy'unuz public URL verdiği için çalışır. Timeline canlı beslenir,
imza doğrulaması teknik dokümanda iyi durur. **Polling'i yedek tutun**
(settlement: on-ramp 3 sn, off-ramp tespiti 5 sn).

---

## 6. Milestone'lar

Sıralama mantığı: **en riskli dış bağımlılık en erken kanıtlanır.**

### M0 — Keşif (Cmt 10:30 → 13:30, workshop'larla paralel)

İki kişi workshop'ta (özellikle #3 Anchor Integration), iki kişi kurulumda.

- `GET /health` → limitler, treasury, issuer, kurlar
- `/explorer` ve `/guide` aç, elle bir deposit turu at
- **Claimable balance'ı bilerek tetikle** (trustline'sız hesaba deposit), neye
  benzediğini gör
- 5 testnet hesabı üret + Friendbot ile fonla (relayer, admin, coord A/B/C)
- Relayer'da USDC trustline aç
- USDC SAC ID türet
- Freighter'ı **Testnet'e çevir** (varsayılan Mainnet!)
- Yedek: Circle faucet'tan testnet USDC (20 USDC / adres / 2 saat)

**Acceptance:** Anchor akışı gözle doğrulandı, SAC ID elde, limitler biliniyor.

> Her hesapta min 1 XLM, her trustline +0.5 XLM gerekir. Friendbot bol verir
> ama fonlamayı unutmayın.

---

### M1 — Para içeri giriyor (13:30 → 18:30)

- Contract: `initialize` + `deposit` + `create_request` + `execute_payout`
  (**multisig henüz yok**)
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
  - SEP-38 quote
  - `withdraw-exchange` → `account_id` + `memo` → `Memo.id` ile USDC gönder
  - status poll + `on_change_callback` handler
- API route: `/api/payout`, `/api/anchor-callback`

**Acceptance (01:00, sert deadline):** USDC deposit → request → 2 onay → payout
→ relayer → withdraw → **tedarikçinin IBAN'ına** TRY `completed`.

> 01:00'de çalışmıyorsa: **özellik ekleme, kesme yap.** Yarım kalan zincir,
> eksik özellikten çok daha kötü.

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

### M4 — Sağlamlaştırma + teslimat (07:00 → 11:00)

- Edge case'ler: expired JWT, claimable balance (trustline + claim butonu),
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
| Deposit claimable balance'a düştü | Trustline yok | `changeTrust` + `claimClaimableBalance` |
| Deposit gelmiyor | Banka transferi simüle edilmedi | `POST /sep6/tx/{id}/simulate-bank-transfer` |
| `pending_reason: treasury_low` | Treasury düşük | Kendiliğinden çözülür, bekle |
| Withdraw tamamlanmıyor | Memo eksik/yanlış tip | `Memo.id(memo)`, `memo_type: "id"` |
| TRY yanlış IBAN'a gitti | SEP-12 memo kapsamı yok | 5.2'deki akış |
| Contract USDC transfer edemiyor | Issuer adresi kullanılmış | SAC ID kullan |
| Limit hatası | Hardcode tavan | `/health`'ten oku |
| Contract verisi kayboldu | TTL uzatılmadı | `extend_ttl` |

---

## 10. Demo senaryosu

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

---

## 11. Açık karar

**DeFindex / vault katmanı** bu planda yok. Ürünü afet-öncesi fonlamaya
kaydırma ve vault'u merkeze alma seçeneği ayrı dosyada değerlendirilecek.
Kararı vermeden M1'e başlamayın — `deposit` fonksiyonu etkilenir.
