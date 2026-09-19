# Proof-of-Action

> **Aid should move at the speed of crisis.**

Afet anlarında toplanan bağışları merkezi bir havuzda bekletmek yerine, sahadaki
doğrulanmış aktörlere **ihtiyaç kanıtı + 2/3 çoklu imza** onayıyla aktaran
Soroban tabanlı protokol. Para, bağışçının cüzdanından tedarikçinin IBAN'ına
kadar zincirde izlenebilir.

Rise In × Stellar Pro Hackathon — **Genesis Track**.

---

## Ne çalışıyor

Testnet'te uçtan uca, gerçek para hareketiyle doğrulandı:

```
Bağışçı ──USDC──► POA ESCROW ──2/3 onay──► RELAYER ──SEP-6──► TR MOCK ANCHOR ──TRY──► Tedarikçi IBAN
```

Tek komutla tekrarlanabilir:

```bash
node scripts/e2e-m2.js
```

Son koşu: 4.5 USDC bağış → **DeFindex vault'una** → talep #1 (1.5 USDC) →
coord A (1/2) → coord B (2/2) → `execute_payout` (vault payı bozduruldu,
4.5 → 3 pay) → firm quote → `withdraw-exchange` → **72.81 TRY**, banka
referansı `FAST-GAVX4PIA4O`, tedarikçinin IBAN'ında.

| | |
|---|---|
| **Contract** | [`CBFOPW6C3PDRXUV5DG3VI5WPGFPMNZKOVZSJWLHTQ3R6CJWVRHRSZ4XC`](https://stellar.expert/explorer/testnet/contract/CBFOPW6C3PDRXUV5DG3VI5WPGFPMNZKOVZSJWLHTQ3R6CJWVRHRSZ4XC) |
| **Network** | Stellar Testnet · `Test SDF Network ; September 2015` |
| **Anchor** | [tr-mock-anchor.fly.dev](https://tr-mock-anchor.fly.dev) (SEP-1/10/12/38/6) |
| **USDC SAC** | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |
| **DeFindex vault** | [`CBJM2TT573QLVT6G6LHSNMI5HDMLRMPYIMBCCDQT2KZVK7CM5NJNPHFM`](https://stellar.expert/explorer/testnet/contract/CBJM2TT573QLVT6G6LHSNMI5HDMLRMPYIMBCCDQT2KZVK7CM5NJNPHFM) — opsiyonel, `VAULT_ADDRESS` boşsa kapalı |

---

## Hackathon şartları

| # | Şart | Karşılığı |
|---|---|---|
| 1 | **Integration** — curated listeden bir protokol | **Stellar Wallets Kit** (`allowAllModules()`) — [`lib/wallet.js`](apps/web/lib/wallet.js) · **DeFindex** vault — [`create-vault.sh`](scripts/create-vault.sh), [`lib.rs`](contracts/poa_escrow/src/lib.rs) |
| 2 | **Anchor / Local Payments** | **TR Mock Anchor**, SEP-1/10/12/38/6 — [`lib/anchor.js`](apps/web/lib/anchor.js) |
| 3 | **Core Feature** — load-bearing | Anchor çıkarsa ürün ölür. Çok-cüzdan olmadan 2/3 onay çalışmaz: her koordinatör **kendi cüzdanıyla** imzalar. |

**DeFindex** entegre. Hazır `usdc_paltalabs_vault` gerçekten kullanılamıyor —
asset'i BlendUSDC (`CAQCFVLO…`), anchor'ın USDC SAC'ı (`CBIELTK6…`) değil. Ama
factory kendi vault'umuzu kurmamıza izin veriyor:
[`scripts/create-vault.sh`](scripts/create-vault.sh) anchor'ın SAC'ı üzerine
bir vault deploy ediyor, escrow fonu orada tutup pay (share) sayıyor.

Dürüst sınır: o SAC için deploy edilmiş bir DeFindex stratejisi olmadığı için
**testnet'te getiri sıfır** — fon vault'ta atıl durur. Kazanç mimari: escrow
standart bir vault arayüzünde pozisyon tutuyor ve `VAULT_ADDRESS` boş
bırakılırsa eski davranışa (fon escrow'da) tek satırla dönülüyor. Mainnet'te
aynı kod Circle USDC + Blend stratejisiyle getiri üretir.

---

## Mimari özet

Zincir üstü kısım güven gerektirmiyor: onay yetkisi 2/3 multisig'te ve
`execute_payout` hedef adresi **parametre olarak almıyor**, `Config`'ten
okuyor. Custody yalnızca fiat rail'in son metresinde, ve o metre zaten bankanın.

**Neden relayer var:** Soroban contract'ın keypair'i yok — SEP-10 challenge
imzalayamaz, HTTP isteği atamaz. Fiat bacağı zorunlu olarak zincir dışıdır.

**IBAN zincire yazılmaz.** Ledger'da yalnızca `supplier_ref = sha256(iban|salt)`
durur. IBAN ↔ SEP-10 memo eşleşmesi backend'de.

**Bilerek açık:** `create_request` yetki istemiyor — talep açmak para
hareket ettirmiyor, çıkış 2/3 onaya bağlı. Bedeli ve savunması
[docs/architecture.md](docs/architecture.md#2-neden-relayer-var) içinde.

Ayrıntılı tasarım ve tradeoff'lar: **[docs/architecture.md](docs/architecture.md)**

---

## Kurulum

```bash
# Araçlar (macOS)
brew install rustup node stellar-cli
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"   # rustup keg-only
rustup default stable && rustup target add wasm32v1-none

# Hesaplar — relayer, admin, coord-a/b/c, donor
for k in relayer admin coord-a coord-b coord-c donor; do
  stellar keys generate $k --network testnet --fund
done
stellar tx new change-trust --source relayer \
  --line USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015"

cp .env.example .env    # secret'ları `stellar keys show <ad>` ile doldurun
npm install
node scripts/onramp.js relayer 500    # anchor'ın on-ramp'inden gerçek USDC
node scripts/onramp.js donor  3000
./scripts/create-vault.sh             # opsiyonel — DeFindex vault'u, .env'e yazar
./scripts/deploy-contract.sh          # deploy + initialize, .env'i günceller

cd apps/web && npm install && npm run dev
```

`.env` repo kökünde tek dosyadır ve **asla commit edilmez**. `RELAYER_SECRET`
yalnızca sunucu tarafı route'larda okunur; client bundle'ında secret bulunmadığı
her build'de doğrulanır.

USDC gerekiyorsa faucet'e gerek yok — anchor'ın kendi on-ramp'i veriyor
(`scripts/onramp.js`, yukarıda). Akışı adım adım görmek için:

```bash
node scripts/anchor-tour.js    # SEP-10 → SEP-12 → SEP-6 deposit → completed
```

**Deployment (Vercel).** `lib/store.js` tedarikçi ↔ IBAN ↔ memo eşleşmesini
tutuyor ve bu veri isteklere göre kalıcı olmak zorunda. Vercel'de dosya sistemi
salt okunur olduğundan Upstash Redis gerekiyor: Vercel Marketplace → Upstash →
Redis, `KV_REST_API_URL` ve `KV_REST_API_TOKEN` otomatik yazılır. Değişkenler
boşsa kod dosyaya düşer ve **yalnızca localhost'ta** çalışır.

---

## Demo adımları

1. **Bağış** sekmesi — cüzdan bağla, USDC yatır → TX hash
2. **Saha talebi** — ihtiyaç, TRY tutar, tedarikçi + IBAN, kanıt yükle
   (gösterge quote TRY→USDC'yi canlı çevirir)
3. **Onay & denetim** — coordinator A onaylar (1/2)
4. Cüzdanı değiştir, coordinator B onaylar (2/2) ← *Wallets Kit'in gerekçesi*
5. **Fonu serbest bırak** — zincir üstü payout, ardından anchor üzerinden TRY
6. **Denetim izi** — kanıt → talep → onaylar → fon → anchor → TRY → banka referansı

**Cüzdan eklentisi kurulamıyorsa:** sağ üstteki **Demo hesap** düğmesi
donor/coord-a/coord-b/coord-c arasında tek tıkla geçiş yapar, imza tarayıcıda
yerel atılır. Yalnızca `DEMO_MODE=true` iken görünür ve sadece bu dört testnet
hesabını verir — `RELAYER_SECRET` bu yoldan asla geçmez. Herkese açık deploy'da
`DEMO_MODE=false` bırakın.

Cüzdanda USDC trustline'ı yoksa bağış panelinde **"USDC trustline aç"** düğmesi
çıkar — anchor'dan gelen bir deposit de trustline olmadan `pending_trust`'ta
beklerdi. Trustline başına 0.5 XLM rezerv gerekir.

> Freighter varsayılan olarak **Mainnet** açılır. Testnet'e alın.
> Koordinatör cüzdanlarını ayrı ayrı import edin — aynı cüzdan iki kez
> onaylayamaz, contract reddeder.

---

## Testler

**Contract — 29/29 geçiyor** (`cargo test`):

```
deposit · birikim · SAC transfer · geçersiz tutar
mükerrer oy · yabancı onay · imzasız onay · eşik altı ödeme
talepler arası onay sızıntısı · mükerrer ödeme · yetersiz bakiye
tek seferlik initialize · relayer değişimi
vault: yatırım · pay bozdurma · getiri · vault kapalıyken eski davranış
```

Vault testleri gerçek DeFindex vault'unun **auth davranışını** taklit eden bir
mock'a karşı koşuyor. `authorize_as_current_contract` satırı silindiğinde altı
test `Error(Auth, InvalidAction)` ile düşüyor — yani o satırın yük taşıdığı
ölçülerek doğrulandı, varsayılmadı.

En kritik olanı `same_coordinator_cannot_approve_twice`: tek koordinatör iki kez
onaylayıp eşiği kendi başına geçemiyor. Sadece `approvals_count` tutsaydık bu
mümkün olurdu — onaylar `(request_id, coordinator)` anahtarıyla saklanıyor.

**Anchor uyumluluğu — SDF `anchor-tests`, 78/84:**

```bash
npx @stellar/anchor-tests --home-domain https://tr-mock-anchor.fly.dev \
  --seps 1 10 12 6 38 --asset-code USDC --sep-config anchor-tests.config.json
```

```
Tests: 2 failed, 78 passed, 4 skipped, 84 total
```

Dördü **atlandı** — SEP-6'yı auth'suz çalıştıran anchor'lar için, bizde
`authentication_required: true`. İkisi **anchor tarafında**, entegrasyonumuzda
değil:

- `SEP-10 GET /auth`: *minimum timebound too late* — challenge'ın `minTime`'ı
  alındığı andan sonra. Yerel saat ile anchor arasında 1 sn fark ölçüldü, yani
  istemci kaynaklı değil.
- `SEP-6 GET /info`: deposit'in `non_interactive_customer_info_needed` gövdesinde
  `type` alanı var; test bunu sep-config'de bekliyor ama şema o alanı
  tanımlamaya izin vermiyor.

> Plandaki `npx stellar-anchor-tests` komutu 404 verir — paketin adı
> `@stellar/anchor-tests`.

---

## Repo yapısı

```
contracts/poa_escrow/src/{lib.rs, test.rs}   Soroban escrow + 22 test
apps/web/
  lib/anchor.js        SEP-1/10/12/38/6 istemcisi (endpoint'ler /health'ten)
  lib/payout.js        relayer'ın fiat bacağı — SUNUCU TARAFI
  lib/soroban.js       contract istemcisi (spec zincirden okunur)
  lib/wallet.js        Stellar Wallets Kit
  lib/evidence.js      kanıt → SHA-256 → zincir
  lib/store.js         IBAN ↔ supplier_ref ↔ memo eşleşmesi
  app/api/{suppliers,requests,payout,anchor-callback}/route.js
  components/          Bağış · Saha talebi · Çoklu imza · Denetim izi
scripts/
  anchor-tour.js       M0 keşif turu — gerçek on-ramp
  onramp.js            hesaba anchor üzerinden USDC al
  e2e-m2.js            uçtan uca acceptance, tek komut
  create-vault.sh      DeFindex vault'u (anchor USDC SAC'ı üzerine)
  deploy-contract.sh   build + deploy + initialize
```

---

## Kullanılan skill dosyaları

| Path | İçerik |
|---|---|
| [`SKILL.md`](SKILL.md) | TR Mock Anchor entegrasyon skill'i — endpoint'ler, SEP akışları, trustline, yaygın hatalar |
| [`IMPLEMENTATION_PLAN_v5.md`](IMPLEMENTATION_PLAN_v5.md) | Milestone planı. Uygulama sırasında ölçümle düzeltilen noktalar dosyada işaretli (5.1, 5.3, 5.4, 10.1.a) |

---

## Plandan sapmalar — hepsi ölçümle

| Plan | Gerçek |
|---|---|
| 5.1 Wallet SDK kullan | `@stellar/typescript-wallet-sdk@1.10.0` Node 26'da import edilemiyor (tarayıcı bundle'ı, stellar-sdk 13 beta'ya pinli). SEP'ler elle yazıldı. |
| 5.3 `pending_trust` YOK | **Var.** Trustline'sız deposit `pending_trust`'ta bekliyor; `changeTrust` atılınca anchor kendiliğinden ödüyor, `claimClaimableBalance` gerekmiyor. |
| 5.4 `source_asset=stellar:USDC:…` | Exchange varyantlarında zincir üstü bacak **asset koduyla** verilir: `source_asset=USDC`. Aksi halde 400. |
| 10.1.a DeFindex opsiyonel | Vault asset'i eşleşmedi → tamamen bırakıldı. |
| IPFS → CID | Anahtar yok; plan B asıl yol. Dosya tarayıcıda SHA-256'lanır, hash zincire gider, dosya hiçbir yere yüklenmez. |

---

## Kapsam dışı

Kısmi ödeme, iade/refund, timeout, kampanya kapatma, on-chain coordinator
whitelist, konfigüre edilebilir threshold, upgrade pattern, DAO. Bunlar bilinçli
olarak yazılmadı — MVP'nin iddiası bir yardım talebinin **kanıttan ödemeye kadar
zincirde izlenebilir** olduğunu göstermek.
