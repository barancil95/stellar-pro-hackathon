# Stellar Mock Anchor Entegrasyon Skill'i

Sen bir Stellar geliştirici asistanısın. Görevin, geliştiricinin **TR Mock Anchor** (testnet TRY/USDC on/off-ramp) ile entegrasyonunu yapmaktır.

> **Sürüm notu.** Bu dosya `@stellar/stellar-sdk` **v14** ile doğrulandı.
> Aşağıdaki düzeltmeler Proof-of-Action uygulaması sırasında gerçek çağrılarla
> ölçüldü; eski hâlindeki örnekler v14'te ilk satırda patlıyordu.

## Mock Anchor Bilgileri

```
Home Domain: tr-mock-anchor.fly.dev
Network: Stellar Testnet
Network Passphrase: "Test SDF Network ; September 2015"
Asset: USDC
USDC Issuer: GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
Treasury: GCLCZEQZ2THTEDAOFI66LACNPLY4OBKN7VKLEZFMBIHYKYQOW2W7T3Z6
Signing Key: GDXYO6FJCNXZEWGXD54GT76FGFYLOLSOGSOJLNQ6WGHCGEQPO7NTE73M
```

⚠️ Bunları **hardcode etme**. Sandbox etkinlik öncesi sıfırlanabilir ve
adresler değişebilir. Hepsi `GET /health`'ten okunur — auth istemez, CORS açık:

```js
const h = await fetch('https://tr-mock-anchor.fly.dev/health').then(r => r.json());
h.asset.issuer            // USDC issuer
h.sep.web_auth_endpoint   // /auth
h.sep.transfer_server     // /sep6
h.sep.kyc_server          // /sep12
h.sep.anchor_quote_server // /sep38
h.sep.signing_key         // callback imza doğrulaması
h.treasury.address        // withdraw hedefi
h.treasury.low_balance    // true ise on-ramp bekler
h.rates.buy_rate / h.rates.sell_rate
h.limits                  // min/max — aşağıdaki nota bak
```

## Endpoint'ler

```
stellar.toml:  GET  https://tr-mock-anchor.fly.dev/.well-known/stellar.toml
SEP-10 Auth:   GET  https://tr-mock-anchor.fly.dev/auth?account={G...}[&memo={id}]
SEP-10 Token:  POST https://tr-mock-anchor.fly.dev/auth
SEP-12 KYC:         https://tr-mock-anchor.fly.dev/sep12
SEP-38 Quote:       https://tr-mock-anchor.fly.dev/sep38
SEP-6 Transfer:     https://tr-mock-anchor.fly.dev/sep6
Health:        GET  https://tr-mock-anchor.fly.dev/health
```

## Limitler ve Format

- **Limitler `/health`'ten okunur.** Ölçüldüğünde `min_onramp_try`,
  `max_onramp_try` ve `min_offramp_usdc` **`null`** dönüyordu — yani limit
  uygulanmıyor. `null` gelebileceğini varsayarak kod yaz; sabit 50/3000 TRY
  tavanı **varsayma**.
- Off-ramp alt sınırı dokümante edilen değer: 1 USDC.
- TRY: 2 ondalık basamak · USDC: 7 ondalık basamak
- Kur kaynağı: Reflector oracle + 50 bps spread (her iki yönde)
- Tutarları **string** olarak taşı. Float kullanırsan kuruş kaybedersin.

## Entegrasyon Akışı

### 1. stellar.toml keşfet (SEP-1)

```js
import { StellarToml } from '@stellar/stellar-sdk';

// ⚠️ v14'te `StellarTomlResolver` diye bir export YOK.
const toml = await StellarToml.Resolver.resolve('tr-mock-anchor.fly.dev');
// toml.WEB_AUTH_ENDPOINT / TRANSFER_SERVER / KYC_SERVER / ANCHOR_QUOTE_SERVER
// toml.SIGNING_KEY · toml.CURRENCIES[0].issuer
```

### 2. Kimlik doğrulama (SEP-10)

```js
import { TransactionBuilder, Keypair, Networks } from '@stellar/stellar-sdk';

const keypair = Keypair.fromSecret(SECRET_KEY);

const challenge = await fetch(
  `https://tr-mock-anchor.fly.dev/auth?account=${keypair.publicKey()}`
).then(r => r.json());

const tx = TransactionBuilder.fromXDR(challenge.transaction, Networks.TESTNET);
tx.sign(keypair);

const { token } = await fetch('https://tr-mock-anchor.fly.dev/auth', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ transaction: tx.toXDR() }),
}).then(r => r.json());
// Sonraki tüm isteklerde: Authorization: Bearer ${token}
```

JWT dolduğunda 401/403 gelir. **Otomatik yenileme yaz** — tek seferlik token
tutmak uzun akışlarda ortada kopar.

### 2b. ⚠️ Memo kapsamlı kimlik — TRY kimin IBAN'ına gidiyor

Bu, off-ramp'te **en kritik ve en kolay kaçırılan** detay.

Off-ramp, TRY'yi **SEP-10 auth yapan kimliğin** SEP-12 kaydındaki IBAN'a öder.
Tek bir servis hesabıyla (ör. bir relayer) birden fazla tedarikçiye ödeme
yapıyorsan ve memo'suz auth edersen, **para hep o servis hesabının IBAN'ına
gider** — tedarikçinin değil.

Çözüm: `&memo=` ile kapsamlanmış müşteri kimliği. JWT'nin `sub`'ı `G…:memo`
olur ve anchor bunu ayrı müşteri sayar.

```js
// Tedarikçi başına ayrı kimlik — tek Stellar hesabı, çok müşteri
const url = `https://tr-mock-anchor.fly.dev/auth` +
            `?account=${servicePublicKey}&memo=${supplierId}`;   // supplierId: uint64
// → JWT sub = "GABC…XYZ:77001"

// Bu token'la yapılan SEP-12 PUT ve SEP-6 withdraw, O tedarikçiye bağlanır
```

Ölçülen sonuç — iki tedarikçi, iki ayrı IBAN, doğru yönlendirme:

| memo | JWT sub | anchor'ın `to` alanı |
|---|---|---|
| 77001 | `GBML…:77001` | `TR3200100099999012345678 90` |
| 77002 | `GBML…:77002` | `TR9700062011110000066723 15` |

### 3. KYC (SEP-12)

⚠️ **"Otomatik onaylanır, ekstra işlem gerekmez" DOĞRU DEĞİL.**

Yeni kullanıcı `NEEDS_INFO` durumundadır. **Herhangi bir** `PUT` — boş JSON
bile — onu `ACCEPTED` yapar. PUT atmazsan off-ramp payout'u anchor'ın atadığı
**deterministik sandbox IBAN'ına** gider, senin istediğin IBAN'a değil.

```js
// Türk IBAN'ı gönderilirse mod-97 doğrulanır ve payout'ta KULLANILIR
await fetch('https://tr-mock-anchor.fly.dev/sep12/customer', {
  method: 'PUT',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ bank_account_number: 'TR320010009999901234567890' }),
});

// Durum kontrolü
const customer = await fetch('https://tr-mock-anchor.fly.dev/sep12/customer', {
  headers: { Authorization: `Bearer ${token}` },
}).then(r => r.json());
// customer.status: "NEEDS_INFO" → PUT sonrası "ACCEPTED"
```

`GET /sep12/customer` kaydedilen IBAN'ı **geri yansıtmaz**. Doğrulamak
istiyorsan off-ramp işleminin `to` alanına bak.

Kimlik numarası, doğum tarihi ve belgeler alındıkları anda atılır, saklanmaz.

### 4. SEP-6 Info

```js
const info = await fetch('https://tr-mock-anchor.fly.dev/sep6/info').then(r => r.json());
// info.deposit.USDC / info.withdraw.USDC
// info['deposit-exchange'] / info['withdraw-exchange']
// info.features.claimable_balances
```

### 5. Deposit (TRY → USDC)

```js
const params = new URLSearchParams({
  asset_code: 'USDC',
  account: publicKey,
  funding_method: 'bank_account',   // `type=` deprecated, bunu kullan
  amount: '1000',                    // TRY
});
const deposit = await fetch(
  `https://tr-mock-anchor.fly.dev/sep6/deposit?${params}`,
  { headers: { Authorization: `Bearer ${token}` } }
).then(r => r.json());

// Banka talimatları SEP-9 formatında `instructions` altında:
deposit.instructions.bank_name.value              // "TR Mock Bank A.Ş."
deposit.instructions.bank_account_number.value    // anchor'ın IBAN'ı
deposit.instructions.external_transfer_memo.value // açıklamaya yazılacak referans
deposit.more_info_url                             // insan sayfası + simülasyon düğmesi

// Banka transferini simüle et — SADECE mock'ta. Auth gerekmez.
await fetch(
  `https://tr-mock-anchor.fly.dev/sep6/tx/${deposit.id}/simulate-bank-transfer`,
  { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: '1000' }) }
);

// Durum
const { transaction } = await fetch(
  `https://tr-mock-anchor.fly.dev/sep6/transaction?id=${deposit.id}`,
  { headers: { Authorization: `Bearer ${token}` } }
).then(r => r.json());
```

**Deposit durumları:**

| Durum | Anlamı |
|---|---|
| `pending_user_transfer_start` | Banka transferi bekleniyor (simüle et) |
| `pending_anchor` | TRY alındı, USDC ödeniyor |
| `pending_trust` | **Hedefte USDC trustline yok** — açılınca otomatik ödenir |
| `pending_stellar` | Gönderim yeniden deneniyor |
| `completed` | USDC gönderildi, `stellar_transaction_id` dolu |
| `error` | Kalıcı hata, TRY iade |

`pending_reason: "treasury_low"` görürsen bekle, kendiliğinden çözülür.

### 6. Withdraw (USDC → TRY)

```js
import { Horizon, TransactionBuilder, Networks, Operation, Asset, Memo, BASE_FEE }
  from '@stellar/stellar-sdk';

const withdraw = await fetch(
  `https://tr-mock-anchor.fly.dev/sep6/withdraw?` + new URLSearchParams({
    asset_code: 'USDC',
    funding_method: 'bank_account',
    amount: '50',
  }),
  { headers: { Authorization: `Bearer ${token}` } }
).then(r => r.json());
// withdraw.account_id (treasury) · withdraw.memo · withdraw.memo_type === "id"

// ⚠️ v14'te `Server` diye bir export YOK — `Horizon.Server` kullan.
const server = new Horizon.Server('https://horizon-testnet.stellar.org');
const USDC = new Asset('USDC', issuerFromHealth);

const account = await server.loadAccount(publicKey);
const paymentTx = new TransactionBuilder(account, {
  fee: BASE_FEE,
  networkPassphrase: Networks.TESTNET,
})
  .addOperation(Operation.payment({
    destination: withdraw.account_id,
    asset: USDC,
    amount: '50',
  }))
  .addMemo(Memo.id(String(withdraw.memo)))   // memo_type "id" ŞART
  .setTimeout(60)
  .build();

paymentTx.sign(keypair);
await server.submitTransaction(paymentTx);
```

Göndermeden önce `withdraw.memo_type === 'id'` olduğunu **doğrula**. Memo'suz
veya yanlış tipte gönderilen para atfedilemez ve işlem asla tamamlanmaz.

Off-ramp gelen miktarı çevirir — kısmi/fazla ödemeler de tamamlanır. Sadece
memo doğru olmak zorundadır.

### 6b. Exchange varyantları — tutar fiat cinsindense

`deposit-exchange` / `withdraw-exchange` fiyatlamayı açık yapar ve `quote_id`
bağlamanı sağlar.

⚠️ **Asset formatı burada farklı.** Zincir üstü bacak **asset koduyla**,
zincir dışı bacak SEP-38 formatıyla verilir:

```
# DOĞRU
/sep6/withdraw-exchange?source_asset=USDC&destination_asset=iso4217:TRY&amount=5&quote_id=…

# YANLIŞ → 400 "unsupported source_asset 'stellar:USDC:…'; this anchor ramps USDC"
/sep6/withdraw-exchange?source_asset=stellar:USDC:GBBD…&…
```

SEP-38 formatı (`stellar:USDC:<issuer>`) **yalnızca `/sep38/*` çağrılarında**
geçerlidir.

### 7. SEP-38 Quote

```js
// /prices ve /price PUBLIC — auth gerekmez
const price = await fetch(
  'https://tr-mock-anchor.fly.dev/sep38/price?' + new URLSearchParams({
    sell_asset: `stellar:USDC:${issuer}`,
    buy_asset: 'iso4217:TRY',
    buy_amount: '1500',       // sell_amount veya buy_amount
    context: 'sep6',
  })
).then(r => r.json());
// price.sell_amount → bu kadar USDC gerekiyor

// Firm quote — JWT gerekir, tek kullanımlık, varsayılan 15 dk (expire_after ile 1 saate kadar)
const quote = await fetch('https://tr-mock-anchor.fly.dev/sep38/quote', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    sell_asset: `stellar:USDC:${issuer}`,
    buy_asset: 'iso4217:TRY',
    sell_amount: '5',
    context: 'sep6',
  }),
}).then(r => r.json());
// quote.id → deposit/withdraw'da quote_id olarak geçir
```

**Kurgu önerisi:** kullanıcıya talep anında **gösterge** fiyat göster
(`/price`, auth'suz), işlem anında **firm** quote al (`POST /quote`).
Off-ramp kuru 30 dakika kilitli, sonra yeniden fiyatlanır.

### 8. İşlem geçmişi

```js
// Tüm işlemler — kind=deposit|withdrawal, limit, no_older_than, paging_id
fetch('https://tr-mock-anchor.fly.dev/sep6/transactions?asset_code=USDC',
  { headers: { Authorization: `Bearer ${token}` } });

// Tek işlem — id, stellar_transaction_id veya external_transaction_id ile
fetch(`https://tr-mock-anchor.fly.dev/sep6/transaction?id=${txId}`,
  { headers: { Authorization: `Bearer ${token}` } });
```

### 9. on_change_callback — polling yerine push

`deposit`/`withdraw` çağrısına `on_change_callback=https://…` ekle; anchor her
durum değişiminde `{"transaction": …}` POST eder.

**İmzayı doğrulamadan hiçbir şey yazma** — yoksa herkes durum uydurabilir:

```js
import { Keypair } from '@stellar/stellar-sdk';

const [, t, s] = /t=(\d+),\s*s=(.+)/.exec(req.headers['signature']);
const ok = Keypair.fromPublicKey(SIGNING_KEY).verify(
  Buffer.from(`${t}.${req.headers.host}.${rawBody}`),
  Buffer.from(s, 'base64'),
);
```

Localhost'ta anchor sana ulaşamaz. **Polling'i yedek tut** (on-ramp 3 sn,
off-ramp tespiti 5 sn kadence'ında çalışıyor).

## USDC Trustline

Kullanıcı USDC alabilmek için trustline açmalı; yoksa deposit `pending_trust`
durumunda bekler. Trustline açılır açılmaz anchor **kendiliğinden** öder,
ayrıca bir şey çağırmana gerek yoktur.

```js
import { Horizon, TransactionBuilder, Networks, Operation, Asset, Keypair, BASE_FEE }
  from '@stellar/stellar-sdk';

const server = new Horizon.Server('https://horizon-testnet.stellar.org');
const account = await server.loadAccount(publicKey);

const tx = new TransactionBuilder(account, {
  fee: BASE_FEE,
  networkPassphrase: Networks.TESTNET,
})
  .addOperation(Operation.changeTrust({ asset: new Asset('USDC', issuerFromHealth) }))
  .setTimeout(60)
  .build();

tx.sign(Keypair.fromSecret(SECRET_KEY));
await server.submitTransaction(tx);
```

Trustline başına **0.5 XLM** rezerv gerekir; yetmezse Horizon
`tx_insufficient_balance` döner.

## Testnet Hesap Fonlama

```js
await fetch(`https://friendbot.stellar.org?addr=${publicKey}`);   // XLM
```

**USDC için Circle faucet'e gerek yok.** Anchor'ın kendi on-ramp'i gerçek
testnet USDC veriyor: SEP-10 → SEP-12 PUT → SEP-6 deposit →
`simulate-bank-transfer` → `completed`. Faucet (20 USDC / adres / 2 saat)
yalnızca yedek.

## Yaygın Hatalar

| Hata | Sebep | Çözüm |
|---|---|---|
| `Server is not a constructor` | v14'te `Server` export'u yok | `Horizon.Server` kullan |
| `StellarTomlResolver is undefined` | v14'te adı değişti | `StellarToml.Resolver.resolve()` |
| 401 / 403 | JWT dolmuş veya yok | SEP-10'u tekrarla, otomatik yenileme yaz |
| `pending_trust` takıldı | Hedefte USDC trustline yok | `changeTrust` — gerisini anchor halleder |
| Deposit gelmiyor | Banka transferi simüle edilmedi | `POST /sep6/tx/{id}/simulate-bank-transfer` |
| `pending_reason: treasury_low` | Treasury düşük | Kendiliğinden çözülür, bekle |
| Withdraw tamamlanmıyor | Memo eksik veya yanlış tip | `Memo.id(String(memo))`, `memo_type: "id"` |
| **TRY yanlış IBAN'a gitti** | memo kapsamı yok veya SEP-12 PUT atılmadı | Bölüm 2b + 3 |
| `unsupported source_asset` | Exchange'te SEP-38 formatı kullanıldı | `source_asset=USDC` (kod) |
| "Unsupported asset_code" | Yanlış asset kodu | `USDC` (büyük harf) |
| Limit hatası | Hardcode edilmiş tavan | `/health`'ten oku, `null` olabilir |

## Önemli Notlar

- Mock Anchor **sadece testnet**'te çalışır.
- KYC simüledir ama **kendiliğinden olmaz** — en az bir `PUT /sep12/customer`
  gerekir. IBAN'ı oraya göndermezsen payout sandbox IBAN'ına gider.
- `simulate-bank-transfer` **mock'a özeldir**; gerçek anchor'da gerçek banka
  transferi bu işi yapar, sen tetiklemezsin, gözlemlersin.
- Trustline'sız hesaba deposit **claimable balance oluşturmaz**, `pending_trust`'ta
  bekler. (`/sep6/info` `features.claimable_balances: true` ilan eder; o yol
  muhtemelen hiç açılmamış hesaplar için — fonlanmış-ama-trustline'sız senaryoda
  ölçülen davranış `pending_trust`'tır.)
- Secret key'i **asla** frontend'e koyma. `.env`, git'e commit etme.
- Tüm hata response'ları `{"error": "..."}` formatındadır.
- Bir Soroban contract'ı SEP akışını **kendi başına yürütemez**: keypair'i
  yoktur, SEP-10 challenge imzalayamaz, HTTP isteği atamaz. Fiat bacağı için
  zincir dışı bir imzalayıcı (relayer) gerekir.

## Asset Format (SEP-38)

```
Fiat:    iso4217:TRY
Stellar: stellar:USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
```

Bu format `/sep38/*` içindir. SEP-6 exchange varyantlarında zincir üstü bacak
**asset koduyla** verilir (bölüm 6b).

## Uyumluluk testi

```bash
# ⚠️ Paket adı `@stellar/anchor-tests` — `stellar-anchor-tests` 404 verir.
npx @stellar/anchor-tests --home-domain https://tr-mock-anchor.fly.dev \
  --seps 1 10 12 6 38 --asset-code USDC --sep-config anchor-tests.config.json
```

`sep-config` şeması paketin kendi `lib/schemas/config.js` dosyasında.
Dikkat: SEP-10 bölümü **yoktur**, `12.customers` en az 4 kayıt ister,
`createCustomer`/`deleteCustomer` **string**'dir (müşteri adı),
`sameAccountDifferentMemos` iki müşteri adından oluşan bir dizidir,
`38` yalnızca `contexts` alır.

## Faydalı Linkler

- Mock Anchor: https://tr-mock-anchor.fly.dev
- SEP Demo (interaktif): https://tr-mock-anchor.fly.dev/explorer
- Guide: https://tr-mock-anchor.fly.dev/guide
- Health: https://tr-mock-anchor.fly.dev/health
- Stellar Lab: https://lab.stellar.org
- Circle USDC Faucet: https://faucet.circle.com
- Stellar Developer Docs: https://developers.stellar.org
