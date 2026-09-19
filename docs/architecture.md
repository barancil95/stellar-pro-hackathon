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

## 5. Vault kapısı

DeFindex **elendi**: testnet vault'unun asset'i (`CAQCFVLO…`) anchor'ın USDC
SAC'ı (`CBIELTK6…`) değil. Escrow fonu o vault'a yatırılamaz.

Contract yine de vault'a hazır yazıldı, çünkü maliyeti sıfırdı:

1. `Campaign.principal` ve `.shares` ayrı alanlar — vault kapalıyken `shares` 0.
2. `initialize` baştan `vault: Option<Address>` alıyor. Sonradan parametre
   eklemek deploy'u ve tüm çağrıları bozardı.
3. Bakiye okuma tek `available_balance()` fonksiyonunda.

Asset'i eşleşen bir vault çıkarsa değişecek yer: `available_balance`'ın `Some`
dalı, `deposit`'te share kaydı, `execute_payout`'ta share bozdurma. Tahmini
40-50 satır.

Şu an `Some(vault)` verilirse contract sessizce yanlış bakiye dönmek yerine
`VaultNotSupported` hatası veriyor.

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
