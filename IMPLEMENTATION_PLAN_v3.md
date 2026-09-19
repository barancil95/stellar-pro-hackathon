# Proof-of-Action — Implementation Plan v3

> Claude Code'a verilecek çalışma planı. Hackathon sırasında (19–20 Eylül 2026)
> sırayla uygulanır. **Milestone sırası değiştirilmez**; her milestone'un
> acceptance kriteri geçmeden bir sonrakine geçilmez.
>
> v1 (milestone sıralaması, Wallets Kit, submission checklist) + v2 (SAC,
> güvenlik düzeltmeleri, dinamik limitler, IPFS fallback) birleşimi.

---

## 0. Bağlam

**Tagline:** "Aid should move at the speed of crisis."

Afet/kriz anlarında toplanan bağışları merkezi havuzda bekletmeden, sahadaki
doğrulanmış aktörlere ihtiyaç kanıtı + 2/3 çoklu imza onayıyla aktaran
Soroban tabanlı protokol. Amaç tam teşekküllü yardım sistemi değil; bir
yardım talebinin **kanıttan ödemeye kadar zincirde izlenebilir olduğunu**
çalışan bir MVP ile göstermek.

**Etkinlik:** Rise In × Stellar Pro Hackathon, Genesis Track. 36 saat, 4 kişi.

**Zorunlu şartlar — üçü de ayrı ayrı karşılanmalı:**

| # | Şart | Bizim cevabımız |
|---|---|---|
| 1 | **Integration** — Eligible Integration Partner listesinden protokol | **Stellar Wallets Kit** (Freighter modülü altında) |
| 2 | **Anchor / Local Payments** — gerçek TRY rail | **TR Mock Anchor** (SEP-1/10/38/6) |
| 3 | **Core Feature** — entegrasyon load-bearing | Cüzdan bağlantısı ve TRY çıkışı olmadan ürün çalışmıyor |

> ⚠️ Sadece Freighter kullanmak #1'i **karşılamaz** — Freighter curated
> listede yok. Wallets Kit zorunlu, Freighter onun altında modül olarak kalır.

**Teslimatlar:** public repo + README, Soroban SDK ile yazılmış ve testnet'e
deploy edilmiş contract, çalışan demo, teknik tasarım dokümanı, pitch deck
(resmi template'in **kopyası**), kullanılan skill dosyalarının path'leri.

---

## 1. Mimari

```
BAĞIŞÇI ──Wallets Kit──► USDC ──► POA ESCROW (Soroban, SAC üzerinden)
                                      │
                    SAHA AKTÖRÜ ──────┤ create_request + proof_hash
                                      │
              COORDINATOR A/B/C ──────┤ approve_request (2/3)
                                      │
                                      ▼ execute_payout
                          RELAYER HOT WALLET (backend, sabit adres)
                                      │ SEP-10 auth + SEP-6 withdraw
                                      ▼ USDC + Memo.id
                              TR MOCK ANCHOR ──► TRY ──► TEDARİKÇİ IBAN
```

**Neden relayer var:** Soroban contract'ın keypair'i yok, SEP-10 challenge
imzalayamaz, HTTP isteği atamaz. Anchor ile contract doğrudan konuşamaz.

**Custody duruşu (deck'te bu cümle geçsin):** Zincir üstü kısım güven
gerektirmiyor — onay yetkisi 2/3 multisig'te, kimse tek başına parayı
oynatamıyor. Custody yalnızca fiat rail'in son metresinde, ve o metre zaten
bankanın. Tedarikçiden cüzdan açmasını beklemek afet anında gerçekçi değil.

---

## 2. Testnet gereksinimleri

| Alan | Değer |
|---|---|
| Network | Stellar Testnet |
| Passphrase | `Test SDF Network ; September 2015` |
| USDC Issuer | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` |
| Anchor home domain | `tr-mock-anchor.fly.dev` |
| Anchor Treasury (withdraw hedefi) | `GCLCZEQZ2THTEDAOFI66LACNPLY4OBKN7VKLEZFMBIHYKYQOW2W7T3Z6` |
| Anchor SIGNING_KEY | `GDXYO6FJCNXZEWGXD54GT76FGFYLOLSOGSOJLNQ6WGHCGEQPO7NTE73M` |

> 🚨 **`GDXYO6FJ...` anchor'ın SEP-10 signing key'idir — RELAYER DEĞİLDİR.**
> Secret'ı sizde değil. Relayer'ı kendiniz üretin:
>
> ```bash
> stellar keys generate relayer --network testnet
> stellar keys address relayer          # → RELAYER_PUBLIC
> stellar keys show relayer             # → .env'deki RELAYER_SECRET
> ```

**USDC SAC adresi türetme (M1'in ilk işi):**

```bash
stellar contract id asset \
  --asset USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 \
  --network testnet
```

Klasik Stellar varlığı Soroban kontratı içinde doğrudan tutulamaz. Her klasik
varlığın deterministik bir Soroban wrapper (SAC) contract ID'si vardır;
transferler `token::Client` arayüzüyle bu adres üzerinden yapılır.

---

## 3. Config

`.env.example` (repoya bu girer, `.env` **asla** commit edilmez):

```bash
ANCHOR_HOME_DOMAIN=tr-mock-anchor.fly.dev
ANCHOR_AUTH=https://tr-mock-anchor.fly.dev/auth
ANCHOR_SEP6=https://tr-mock-anchor.fly.dev/sep6
ANCHOR_SEP38=https://tr-mock-anchor.fly.dev/sep38

HORIZON_URL=https://horizon-testnet.stellar.org
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"

USDC_ISSUER=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
USDC_SAC_ID=                  # M1'de türetilip doldurulur

RELAYER_SECRET=               # backend-only, asla frontend'e sızmaz
POA_CONTRACT_ID=              # deploy sonrası
ADMIN_SECRET=
COORD_A_PUBLIC=
COORD_B_PUBLIC=
COORD_C_PUBLIC=

IPFS_API_KEY=                 # opsiyonel — yoksa mock CID fallback devreye girer
```

**Limitler hardcode edilmez.** Uygulama açılışında `/sep6/info` ve
`/sep38/info` çağrılır, form min/max değerleri ve varsayılan tutarlar oradan
okunur. Kod içinde sabit "3000 TRY" tavanı yazmayın.

---

## 4. Contract yüzeyi

```rust
pub struct DisbursementRequest {
    pub id: u64,
    pub supplier_ref: BytesN<32>,   // hash(iban + salt) — düz IBAN ledger'a yazılmaz
    pub amount: i128,               // USDC, SAC birimi (7 ondalık)
    pub proof_hash: BytesN<32>,     // IPFS CID veya mock SHA-256
    pub approvals_count: u32,
    pub completed: bool,
}

// Ayrıca: (request_id, coordinator) => bool   — mükerrer onayı engeller.
// Sadece approvals_count tutmak YETERSİZDİR.
```

```rust
fn initialize(env, admin: Address, usdc_sac: Address, relayer: Address,
              coord_a: Address, coord_b: Address, coord_c: Address);

fn deposit(env, from: Address, amount: i128);
    // from.require_auth()
    // token::Client::new(&env, &usdc_sac).transfer(&from, &contract, &amount)

fn create_request(env, supplier_ref: BytesN<32>, amount: i128,
                  proof_hash: BytesN<32>) -> u64;

fn approve_request(env, coordinator: Address, request_id: u64);
    // coordinator.require_auth()
    // coord_a/b/c içinde mi? değilse panic
    // (request_id, coordinator) kaydı varsa panic  ← mükerrer oy
    // approvals_count += 1

fn execute_payout(env, request_id: u64);
    // approvals_count >= 2 && !completed  değilse panic
    // fon → initialize'da SABİTLENEN relayer adresine
    // completed = true

fn update_relayer(env, new_relayer: Address);
    // admin.require_auth() — relayer adresini değiştirmenin TEK yolu
```

> 🔐 `execute_payout` relayer adresini **parametre olarak almaz**. Alsaydı,
> 2/3 onay tamamlandıktan sonra çağıran taraf fonu istediği adrese
> yönlendirebilirdi. Adres `initialize`'da sabitlenir.

**Event'ler:** `deposit`, `request_created`, `request_approved`,
`payout_executed` — frontend timeline bunlardan beslenir.

**Kapsam dışı — tartışma açma, yazma:**
on-chain coordinator kayıt/whitelist (3 adres `initialize`'da sabit),
konfigüre edilebilir threshold (sabit 2/3), kısmi ödeme, iade, refund,
timeout, kampanya kapatma, upgrade pattern, DAO/governance, mikroservis,
WebSocket (polling yeterli), canlı KYC (SEP-12 bypass), mobil uygulama.

---

## 5. Milestone'lar

Sıralama mantığı: **en riskli dış bağımlılık en erken kanıtlanır.** Anchor
17. saatte patlarsa dönüş yolu yok; 8. saatte patlarsa var.

### M0 — Keşif (Cmt 10:30 → 13:30, workshop'larla paralel)

İki kişi workshop'ta (özellikle #3 Anchor Integration), iki kişi kurulumda.

- `/health`, `/guide`, `/explorer` aç; `/sep6/info` + `/sep38/info` çağır,
  gerçek min/max limitleri not et
- 5 testnet hesabı üret + Friendbot ile fonla (relayer, admin, coord A/B/C)
- Relayer'da USDC trustline aç
- USDC SAC ID türet → `.env`
- Elle bir deposit turu: `simulate-bank-transfer` → status `completed`
- `pending_trust` durumunu **bilerek tetikle**, neye benzediğini gör

**Acceptance:** Anchor akışı gözle doğrulandı, SAC ID elde, limitler biliniyor.

---

### M1 — Para içeri giriyor (13:30 → 18:30)

- Contract: `initialize` + `deposit` + `create_request` + `execute_payout`
  (**multisig henüz yok**, `approve_request` M2'de)
- `cargo test`: deposit, SAC transfer, payout guard
- Testnet deploy → `POA_CONTRACT_ID`
- `lib/soroban.js`: contract invoke wrapper'ları
- Bağışçı akışı: Wallets Kit ile bağlan → `deposit` imzala

**Acceptance:** Cüzdandan USDC yatırıldı, escrow bakiyesi zincirde görünüyor,
TX hash elde.

---

### M2 — Para dışarı çıkıyor (18:30 → 01:00) ⚠️ EN KRİTİK

- Contract: `approve_request` + mükerrer oy engeli + `execute_payout`
  guard'ını 2/3'e bağla + `update_relayer`
- `cargo test`: yetkisiz onay, mükerrer onay, mükerrer ödeme, yetersiz bakiye
- `lib/anchor.js`:
  - `getAuthToken(relayerKeypair)` — SEP-10 challenge/sign/token
  - `ensureUsdcTrustline()`
  - `getSep38Quote(token, tryAmount)` — kilitli kur
  - `executeOffRampToIBAN(...)` — SEP-6 withdraw → `account_id` + `memo` al
    → USDC'yi `Memo.id(memo)` ile treasury'ye gönder → `completed` poll
- Next.js API route: `/api/payout`

**Acceptance (01:00, sert deadline):**
USDC deposit → request → 2 onay → payout → relayer → SEP-6 withdraw → TRY
`completed`. **Uçtan uca tek seferde çalışıyor.**

> 01:00'de çalışmıyorsa: **özellik ekleme, kesme yap.** Ne eksikse çıkar,
> akışı kısalt. Yarım kalan zincir, eksik özellikten çok daha kötü.

---

### M3 — Görünür hale getir (01:00 → 07:00, NÖBETLEŞE)

**İki kişi uyur, iki kişi çalışır. Sabah taze kafa lazım — pazarlık yok.**

Next.js (App Router) + Tailwind + Lucide. Ekranlar:

| Ekran | İçerik |
|---|---|
| Hero | "Aid should move at the speed of crisis." + akış özeti |
| Donor | Cüzdan bağlantısı, USDC bakiyesi, escrow bakiyesi, Donate, TX hash |
| Field Request | İhtiyaç türü, TRY tutarı, tedarikçi, IBAN, evidence upload |
| Multisig | Coordinator A/B/C durumları, 2/3 barı, evidence önizleme |
| Audit Timeline | Evidence → Request → Approvals → Released → Anchor → TRY → DONE |

**Evidence akışı:** Photo/Invoice → IPFS → CID → Soroban.
**Plan B:** IPFS/Pinata/CORS 30 dakikayı aşarsa **hemen bırak** — görseli
client-side Base64'e çevirip SHA-256 hash'ini mock CID olarak zincire yaz.
Bu fallback M3 başlamadan hazır olsun.

**Acceptance:** Demo tamamen UI üzerinden yapılabiliyor, terminal gerekmiyor.

---

### M4 — Sağlamlaştırma + teslimat (07:00 → 11:00)

- Edge case'ler: expired JWT → re-auth, `pending_trust` → uyarı + trustline
  butonu, eksik memo guard, limit dışı tutar → form validasyonu
- Audit timeline'ın gerçekten on-chain event + anchor status'ten beslendiğini
  doğrula (hardcode timeline yakalanırsa jüri önünde kötü olur)
- `README.md`: ne yapıyoruz, mimari, kurulum, demo adımları, contract ID,
  testnet linkleri
- `docs/architecture.md`: bileşenler, neden relayer var, custody duruşu,
  tradeoff'lar, aşılan zorluklar, mimari diyagram
- **Kullanılan skill dosyalarının path'lerini yaz** (submission şartı)
- Deck: resmi template'in kopyası, **tek kişi** yazar

---

### 11:00 → 12:00 — DONMUŞ

Kod yazmak yok.

- [ ] Submission portalı: takım adı, tüm üyelerin ad + iletişim
- [ ] GitHub repo linki (public mi kontrol et)
- [ ] Live demo / deployment URL
- [ ] Pitch deck linki
- [ ] **Track seçimi: Genesis** ← seçilmeyen track'e değerlendirilmezsin
- [ ] Demo'yu baştan sona 3 kez prova
- [ ] Ekran kaydı al (internet çökerse yedek)

---

## 6. Repo yapısı

```
proof-of-action/
├── contracts/poa_escrow/
│   ├── Cargo.toml
│   └── src/lib.rs
├── apps/web/
│   ├── app/
│   │   ├── api/payout/route.js      # relayer + SEP-6 tetikleyici
│   │   ├── api/quote/route.js       # SEP-38
│   │   ├── page.jsx
│   │   └── layout.jsx
│   ├── components/
│   └── lib/
│       ├── anchor.js                # SEP-10/38/6
│       ├── soroban.js               # contract invoke
│       ├── wallet.js                # Stellar Wallets Kit
│       └── evidence.js              # IPFS + mock CID fallback
├── scripts/
│   ├── setup-testnet.js             # hesap üret, fonla, trustline
│   └── deploy-contract.js
├── docs/architecture.md
├── .env.example
└── README.md
```

Ayrı Express mikroservisi yok — Next.js API Routes backend orchestration'ı
yürütür.

---

## 7. İş bölümü

| Kişi | Sorumluluk |
|---|---|
| 1 | Contract (Rust/Soroban), testler |
| 2 | Relayer + anchor adapter (SEP-10/38/6), API routes |
| 3 | Frontend + Wallets Kit + evidence |
| 4 | Demo senaryosu, entegrasyon testi, README + docs + deck |

Bölünme M1'in başında yapılır. Dördü birden contract'a dalarsa relayer geceye
kalır.

---

## 8. Yaygın hata tablosu

| Belirti | Sebep | Çözüm |
|---|---|---|
| 401 Unauthorized | JWT süresi doldu | SEP-10 auth'u tekrarla |
| Deposit `pending_trust` | USDC trustline yok | `changeTrust` çalıştır |
| Deposit gelmiyor | Banka transferi simüle edilmedi | `POST /sep6/tx/{id}/simulate-bank-transfer` |
| Withdraw tamamlanmıyor | Payment'ta memo eksik/yanlış | `Memo.id(withdraw.memo)`, `memo_type: "id"` |
| "Unsupported asset_code" | Küçük harf | `USDC` büyük harf |
| Contract USDC transfer edemiyor | Issuer adresi kullanılmış | SAC ID kullan |
| Limit hatası | Hardcode edilmiş tavan | `/info`'dan oku |

---

## 9. Definition of Done

**Blockchain:** Contract testnet'te canlı; SAC üzerinden USDC transferleri
çalışıyor; 2/3 multisig ve mükerrer oy engelleri test edildi; relayer adresi
`initialize`'da sabit, yalnızca admin `update_relayer` ile değiştirebiliyor;
IBAN düz metin olarak ledger'a yazılmıyor.

**Anchor:** Relayer SEP-10 oturumu açıyor, SEP-38 quote alıyor, SEP-6
withdraw başlatıp `completed` statüsünü alıyor. Limitler `/info`'dan dinamik.

**Integration:** Stellar Wallets Kit üzerinden cüzdan bağlantısı çalışıyor.

**Frontend:** Formdan girilen talep kontrata yazılıyor; audit timeline
on-chain event ve gerçek anchor statüsünden besleniyor.

**Demo:** Akış baştan sona, gerçek testnet TX hash'leri eşliğinde kesintisiz
tekrarlanabiliyor.

---

## 10. Demo senaryosu

1. Bağışçı Wallets Kit ile bağlanır, escrow'a USDC yatırır → TX hash
2. Saha aktörü talep açar: Yakıt, 1.500 TRY, ABC Akaryakıt, evidence yükler
   → SEP-38 quote ile USDC karşılığı hesaplanır
3. Coordinator A onaylar (1/2)
4. Coordinator B onaylar (2/2)
5. `execute_payout` → USDC relayer'a → TX hash
6. Relayer SEP-6 withdraw → memo'lu transfer → anchor `completed`
7. Audit Detail: request ID, supplier ref, TRY/USDC tutar, proof CID,
   contract ID, deposit/approval/payout TX, anchor withdrawal ID

Her adımda Stellar Expert linki gösterilir. Anlatılan tek cümle:
**"Para nereye gitti?" sorusunun cevabı zincirde.**

**Bonus, vakit kalırsa:** demo sırasında gerçek bir kullanıcıyı (yerel
dernek/gönüllü) canlı onboard et — etkinlik metrikleri arasında "kaç takım
gerçek kullanıcı onboard etti" var.
