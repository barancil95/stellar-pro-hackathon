# Teknik tasarım

Proof-of-Action'ın bileşenleri, verdiğimiz kararlar ve ödediğimiz bedeller.

---

## 1. Akış

```
BAĞIŞÇI ──[Wallets Kit]──► USDC ──► POA ESCROW (Soroban, SAC üzerinden)
                                        │
                  SAHA AKTÖRÜ ──────────┤ create_request + proof_hash
                                        │
        COORDINATOR A/B/C ──[Kit]───────┤ approve_request (2/3)
                                        │
                                        ▼ execute_payout
                            RELAYER HOT WALLET (backend, sabit adres)
                                        │ SEP-10(memo) + SEP-12(IBAN) + SEP-38 + SEP-6
                                        ▼ USDC + Memo.id → treasury
                                TR MOCK ANCHOR ──► TRY ──► TEDARİKÇİ IBAN
```

---

## 2. Neden relayer var

Soroban contract'ın keypair'i yoktur. SEP-10 challenge'ını imzalayamaz, HTTP
isteği atamaz. Fiat bacağı bu yüzden zorunlu olarak zincir dışındadır.

**Custody duruşu:** Zincir üstü kısım güven gerektirmiyor — onay yetkisi 2/3
multisig'te. Custody yalnızca fiat rail'in son metresinde, ve o metre zaten
bankanın.

Relayer'ın yetkisi de sınırlı: `execute_payout` hedef adresi **parametre olarak
almaz**, `Config`'ten okur. Alsaydı 2/3 onaydan sonra çağıran taraf fonu
istediği adrese yönlendirebilirdi. Relayer'ı değiştirmek yalnızca admin'in
imzasıyla mümkün (`update_relayer`).

**Bilerek açık bırakılan yer: `create_request` yetki istemez.** Sahadaki
erişimi kısıtlamak istemedik ve talep açmak tek başına para hareket ettirmiyor
— çıkış 2/3 onaya bağlı. Bedeli şu: herkes talep açabilir, yani talep listesi
spam'lenebilir ve koordinatörlerin yanlış talebi onaylama riski doğar. Savunma
ekranda: her talep kanıt hash'i ve tedarikçi referansıyla geliyor, koordinatör
onaylamadan önce bunları görüyor. Üretimde buraya bir saha-aktörü whitelist'i
veya talep başına küçük bir depozito gelir; hackathon kapsamında dışarıda
bıraktık.

---

## 3. Contract

### 3.1 Çoklu imza

Onaylar `(request_id, coordinator)` anahtarıyla persistent storage'a yazılır,
yalnızca sayaç tutulmaz. Sayaç tek başına tutulsaydı bir koordinatör iki kez
onaylayıp eşiği kendi başına geçebilirdi — `same_coordinator_cannot_approve_twice`
testi tam olarak bunu koruyor.

`approve_request` koordinatörün **kendi** imzasını ister (`require_auth`), ve
koordinatör `Config.coordinators` listesinde olmak zorundadır. Liste
`initialize`'da sabitlenir; on-chain whitelist yönetimi kapsam dışı.

Eşik sabit 2/3 (`APPROVAL_THRESHOLD`). Konfigüre edilebilir threshold bilinçli
olarak yazılmadı.

### 3.2 Gizlilik

Düz IBAN ledger'a **yazılmaz**. Zincirde yalnızca
`supplier_ref = sha256(iban | salt)` durur. Salt ve IBAN backend'de
(`lib/store.js`), SEP-10 memo'suyla birlikte.

Aynı mantık kanıt için de geçerli: dosya değil, `proof_hash` zincire gider.

### 3.3 Storage TTL

Persistent entry'ler uzatılmazsa arşivlenir. Her okuma ve yazmada `extend_ttl`
çağrılıyor (30 gün hedef, 20 günde tetiklenir). Instance storage da aynı şekilde.

### 3.4 Hata yüzeyi

Fonksiyonlar panic yerine `Result<T, Error>` döner. Bu sayede `try_*` test
istemcileri tipli hata görür ve frontend contract hatasını ayırt edebilir.

---

## 4. Anchor entegrasyonu

### 4.1 Hiçbir endpoint hardcode değil

Issuer, SEP endpoint'leri, treasury, kurlar ve limitler `/health`'ten okunur.
Sandbox etkinlik öncesi sıfırlanabildiği için bu bir dayanıklılık kararı.

### 4.2 TRY kimin IBAN'ına gidiyor — en kritik detay

Off-ramp, TRY'yi **SEP-10 auth yapan kimliğin** SEP-12 kaydındaki IBAN'a öder.
Relayer memo'suz auth yaparsa para relayer'ın IBAN'ına gider, tedarikçinin değil.

**Çözüm:** tedarikçi başına memo kapsamlı müşteri kaydı.

```
GET /auth?account=<RELAYER>&memo=<tedarikçi_id>   → JWT sub = "G…:memo"
PUT /sep12/customer { bank_account_number: <tedarikçi IBAN> }
GET /sep6/withdraw-exchange  (bu token'la)        → payout o IBAN'a
```

Tek relayer hesabı, tedarikçi başına ayrı kimlik. **Ölçüldü:**

| Tedarikçi | SEP-10 sub | Anchor'ın `to` alanı |
|---|---|---|
| 77001 | `GBML…:77001` | `TR3200100099999012345678 90` |
| 77002 | `GBML…:77002` | `TR9700062011110000066723 15` |

### 4.3 Kur riski

Talep açılışında **gösterge** quote gösterilir (UI), ödeme anında **firm** quote
alınır (işlem). SEP-38 quote 15 dakika geçerli ve tek kullanımlık. Slippage
toleransı roadmap'te.

### 4.4 Memo zorunluluğu

Off-ramp gelen miktarı çevirir — kısmi/fazla ödemeler de tamamlanır. Sadece
memo doğru olmak zorundadır: `Memo.id`, `memo_type: "id"`. `payout.js` anchor
`memo_type: "id"` vermezse **ödemeyi göndermeden** hata atar; memo'suz gönderilen
para atfedilemez.

### 4.5 Durum takibi

`on_change_callback` asıl yol, polling yedek. Callback imzası Ed25519 olarak
anchor'ın `SIGNING_KEY`'i ile `"<t>.<host>.<body>"` üzerinden doğrulanır;
doğrulanmadan hiçbir durum yazılmaz — yoksa herkes durum uydurabilirdi.

Localhost'ta anchor bize ulaşamadığı için `PUBLIC_BASE_URL` boşsa callback
istenmiyor ve doğrudan polling'e düşülüyor.

---

## 5. DeFindex vault

Fon, `VAULT_ADDRESS` doluysa escrow'da beklemez: escrow'un adına bir DeFindex
vault'unda durur ve escrow pay (share) tutar.

### Neden hazır vault değil

Testnet'teki `usdc_paltalabs_vault` BlendUSDC tutuyor
(`CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU`), anchor'ın USDC
SAC'ını (`CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`) değil.
Bu doğru bir tespitti ama yanlış sonuca götürmüştü ("DeFindex elenir"). Eksik
olan nokta: factory kendi vault'umuzu kurmamıza izin veriyor.
[`scripts/create-vault.sh`](../scripts/create-vault.sh) `create_defindex_vault`
çağrısını anchor'ın SAC'ıyla yapıyor.

### Strateji listesi neden boş

O SAC için deploy edilmiş bir DeFindex stratejisi yok — stratejiler Blend'in
test USDC'sine bağlı. Vault contract'ının `validate_strategies` fonksiyonu boş
listeyi kabul ediyor (yalnızca tekrarı reddediyor), dolayısıyla stratejisiz
vault geçerli.

**Sonucu saklamıyoruz: testnet'te getiri sıfırdır.** Fon vault'ta atıl durur ve
UI'daki getiri satırı `0.0000000` gösterir. Kazanç mimari:

- Custody escrow'da kalır; vault pozisyonu da contract'ın adınadır.
- Bakiye tek bir yerden okunur, fon nerede olursa olsun.
- Mainnet'te tek değişen adreslerdir — Circle USDC + Blend stratejisi — ve aynı
  kod getiri üretir.

Getiri argümanını abartmamanın somut karşılığı: 1000 $ iki günde ~22 sent.
Afet-öncesi fonlama (para aylarca bekler, oracle tetikler) roadmap'te kalıyor.

### Contract tarafı

`initialize` baştan `vault: Option<Address>` alıyordu, o yüzden entegrasyon
deploy yüzeyini bozmadı:

1. `Campaign.principal` ve `.shares` ayrı — vault kapalıyken `shares` 0 kalır.
2. `deposit` fonu vault'a yatırır, dönen payı `shares`'e ekler.
3. `execute_payout` önce payı bozdurur, sonra relayer'a öder.
4. `available_balance()` vault açıkken payın **bugünkü karşılığını** okur —
   getiri varsa bakiye anaparayı aşar.

**Kritik ayrıntı — `authorize_as_current_contract`.** Vault, USDC'yi escrow'un
üzerinden kendine çekiyor. Bu transfer escrow adına ama escrow'un doğrudan
çağrısı değil (araya vault giriyor), dolayısıyla contract'ın o alt-çağrıya
açıkça yetki vermesi gerekiyor. Satır olmadan deposit `Error(Auth,
InvalidAction)` ile düşüyor. Test mock'u gerçek vault'un auth davranışını
taklit ediyor ve satır kaldırıldığında altı test düşüyor — ölçüldü.

### Geri dönüş

`VAULT_ADDRESS` boşsa `initialize --vault null` ile eski davranış aynen
geçerli: fon escrow'da durur, `shares` 0 kalır. Vault tarafı arızalanırsa
kaçış yolu tek satır.

---

## 6. Tradeoff'lar

| Karar | Bedeli |
|---|---|
| Wallet SDK yerine elle SEP istemcisi | ~230 satır bakım. Karşılığında Node 26'da çalışıyor ve bağımlılık yüzeyi küçük. |
| Contract spec'i zincirden okunuyor | Her istemci oluşturmada bir ağ çağrısı. Karşılığında binding üretme adımı yok, contract değişince frontend güncel kalıyor. |
| IPFS yerine SHA-256 | Dosyanın bulunabilirliği kullanıcıda. Zincirdeki taahhüt zaten hash olduğu için ispat gücü aynı. |
| Tedarikçi defteri dosyada | Tek süreç. Üretimde veritabanı olurdu. |
| Sabit 2/3 eşik | Esneklik yok. Karşılığında saldırı yüzeyi ve test matrisi küçük. |
| Relayer sıcak cüzdan | Fiat rail'in son metresinde custody. Zincir üstü kısım bundan etkilenmiyor. |

---

## 7. Roadmap

- Slippage toleransı ve quote yenileme
- Kısmi ödeme, iade, timeout ile talep iptali
- On-chain coordinator yönetimi ve konfigüre edilebilir threshold
- Kanıt dosyaları için kalıcı depolama (IPFS/Arweave)
- Afet-öncesi fonlama: para aylarca bekler, oracle tetikler — asset'i eşleşen
  bir vault bu senaryoda anlam kazanır
