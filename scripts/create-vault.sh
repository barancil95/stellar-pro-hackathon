#!/usr/bin/env bash
# DeFindex vault'unu anchor'ın USDC SAC'ı üzerine kurar ve .env'e yazar.
#
# NEDEN HAZIR VAULT DEĞİL
#   Testnet'teki `usdc_paltalabs_vault` BlendUSDC tutuyor (CAQCFVLO…),
#   anchor'ın USDC'sini (CBIELTK6…) değil. Plan 10.1.a bunu doğru tespit etmiş
#   ama yanlış sonuca varmış: factory kendi vault'umuzu kurmamıza izin veriyor.
#
# STRATEJİ LİSTESİ NEDEN BOŞ
#   Anchor'ın USDC SAC'ı için deploy edilmiş bir DeFindex stratejisi yok
#   (stratejiler Blend'in test USDC'sine bağlı). Boş liste vault contract'ında
#   geçerli — `validate_strategies` yalnızca tekrarı reddediyor.
#   Sonuç: testnet'te GETİRİ SIFIR, fon vault'ta atıl durur. Kazanç mimari —
#   escrow standart vault arayüzünde pay tutuyor. Mainnet'te aynı script
#   getiri üretir; tek değişen adresler:
#     USDC     CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75
#     strateji CDB2WMKQQNVZMEBY7Q7GZ5C7E7IAFSNMZ7GGVD6WKTCEWK7XOIAVZSAP
#
# Ön koşul: `stellar keys generate` ile admin mevcut; SEED hesabında USDC var.
set -euo pipefail
cd "$(dirname "$0")/.."

# rustup brew'da keg-only (deploy-contract.sh ile aynı sebep).
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"

# shellcheck disable=SC1091
set -a; source .env; set +a

NET=(--rpc-url "$SOROBAN_RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE")

# Adresler hardcode edilmez — DeFindex testnet'i sık yeniden deploy ediyor,
# kaynak kendi yayınladıkları JSON (plan 10.2).
CONTRACTS_JSON=${DEFINDEX_CONTRACTS_JSON:-https://raw.githubusercontent.com/defindex-io/stellar-contracts/main/public/testnet.contracts.json}
FACTORY=${DEFINDEX_FACTORY:-$(curl -fsSL "$CONTRACTS_JSON" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).ids.defindex_factory))")}

# Soroswap router o JSON'da yok; DeFindex dokümanındaki testnet adresi.
ROUTER=${SOROSWAP_ROUTER:-CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD}

# İlk yatırımda vault 1000 payı enflasyon saldırısına karşı KİLİTLER. O kaybı
# escrow'a yıkmamak için vault'u önce bu hesapla tohumluyoruz; escrow'un
# sonraki yatırımları temiz 1:1 oluyor.
SEED_SOURCE=${VAULT_SEED_SOURCE:-relayer}
SEED_STROOPS=${VAULT_SEED_STROOPS:-1000000} # 0.1 USDC
# Not: stellar CLI i128'i STRING bekliyor — [1000000] reddedilir, ["1000000"] geçer.

ADMIN=$(stellar keys address admin)
SEED_ADDR=$(stellar keys address "$SEED_SOURCE")

: "${USDC_SAC_ID:?USDC_SAC_ID .env'de tanımlı değil — deploy-contract.sh'ı okuyun}"

echo "→ factory  : $FACTORY"
echo "→ asset    : $USDC_SAC_ID  (anchor'ın USDC SAC'ı)"
echo "→ admin    : $ADMIN"
echo "→ tohum    : $SEED_STROOPS stroop, $SEED_SOURCE ($SEED_ADDR)"

echo "→ vault kuruluyor"
VAULT=$(stellar contract invoke --id "$FACTORY" --source admin "${NET[@]}" -- \
  create_defindex_vault \
  --roles "{\"0\":\"$ADMIN\",\"1\":\"$ADMIN\",\"2\":\"$ADMIN\",\"3\":\"$ADMIN\"}" \
  --vault_fee 0 \
  --assets "[{\"address\":\"$USDC_SAC_ID\",\"strategies\":[]}]" \
  --soroswap_router "$ROUTER" \
  --name_symbol '{"name":"PoA Aid Reserve","symbol":"PAID"}' \
  --upgradable true 2>/dev/null | tail -1 | tr -d '"')

echo "   $VAULT"

echo "→ tohum yatırımı (kilitlenen 1000 payı bu hesap üstleniyor)"
stellar contract invoke --id "$VAULT" --source "$SEED_SOURCE" "${NET[@]}" -- deposit \
  --amounts_desired "[\"$SEED_STROOPS\"]" \
  --amounts_min "[\"$SEED_STROOPS\"]" \
  --from "$SEED_ADDR" \
  --invest true >/dev/null

echo "→ doğrulama"
ASSETS=$(stellar contract invoke --id "$VAULT" --source admin "${NET[@]}" --send=no -- get_assets 2>/dev/null)
echo "   get_assets   : $ASSETS"
case "$ASSETS" in
  *"$USDC_SAC_ID"*) echo "   ✅ vault asset'i anchor USDC SAC'ı ile EŞLEŞİYOR" ;;
  *) echo "   ❌ asset eşleşmiyor — durduruldu"; exit 1 ;;
esac

if grep -q '^VAULT_ADDRESS=' .env; then
  sed -i '' "s|^VAULT_ADDRESS=.*|VAULT_ADDRESS=$VAULT|" .env
else
  printf '\nVAULT_ADDRESS=%s\n' "$VAULT" >> .env
fi
echo "✅ .env güncellendi: VAULT_ADDRESS=$VAULT"
echo
echo "Sıradaki: ./scripts/deploy-contract.sh  (escrow'u bu vault'la initialize eder)"
