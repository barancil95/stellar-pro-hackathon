#!/usr/bin/env bash
# Contract'ı testnet'e deploy edip initialize eder, POA_CONTRACT_ID'yi .env'e yazar.
#
# Not: plan 7'de `deploy-contract.js` diyordu; stellar CLI orkestrasyonu için
# shell daha az sürtünmeli olduğu için .sh yazıldı.
#
# Ön koşul: `stellar keys generate` ile admin/relayer/coord-a/b/c mevcut.
set -euo pipefail
cd "$(dirname "$0")/.."

# rustup brew'da keg-only.
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"

# shellcheck disable=SC1091
set -a; source .env; set +a

# --network testnet alias'ı bazı alt komutlarda passphrase'i taşımıyor,
# bu yüzden ikisi de açıkça geçiliyor.
NET=(--rpc-url "$SOROBAN_RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE")

echo "→ build"
stellar contract build

echo "→ deploy"
CONTRACT_ID=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/poa_escrow.wasm \
  --source admin "${NET[@]}" 2>/dev/null | tail -1)
echo "   $CONTRACT_ID"

echo "→ initialize (vault: null — DeFindex elendi, bkz. plan 10.1.a)"
stellar contract invoke --id "$CONTRACT_ID" --source admin "${NET[@]}" -- initialize \
  --admin      "$(stellar keys address admin)" \
  --usdc_sac   "$USDC_SAC_ID" \
  --relayer    "$(stellar keys address relayer)" \
  --coord_a    "$(stellar keys address coord-a)" \
  --coord_b    "$(stellar keys address coord-b)" \
  --coord_c    "$(stellar keys address coord-c)" \
  --vault      null >/dev/null

sed -i '' "s|^POA_CONTRACT_ID=.*|POA_CONTRACT_ID=$CONTRACT_ID|" .env
echo "✅ .env güncellendi: POA_CONTRACT_ID=$CONTRACT_ID"

stellar contract invoke --id "$CONTRACT_ID" --source admin "${NET[@]}" -- get_config
