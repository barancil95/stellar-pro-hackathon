#!/usr/bin/env bash
# Deploys the contract to testnet, initializes it and writes POA_CONTRACT_ID to .env.
#
# Note: plan 7 called for `deploy-contract.js`; this is a .sh because shell has less
# friction for orchestrating the stellar CLI.
#
# Prerequisite: admin/relayer/coord-a/b/c exist via `stellar keys generate`.
set -euo pipefail
cd "$(dirname "$0")/.."

# rustup is keg-only in brew.
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"

# shellcheck disable=SC1091
set -a; source .env; set +a

# The --network testnet alias does not carry the passphrase into some subcommands,
# so both are passed explicitly.
NET=(--rpc-url "$SOROBAN_RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE")

echo "→ build"
stellar contract build

echo "→ deploy"
CONTRACT_ID=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/poa_escrow.wasm \
  --source admin "${NET[@]}" 2>/dev/null | tail -1)
echo "   $CONTRACT_ID"

# Option<Address>: None → `null`, Some → the address as a JSON string.
# Both `--vault C...` (unquoted) and the `{"Some":…}` form are rejected by the CLI
# — measured.
if [ -n "${VAULT_ADDRESS:-}" ]; then
  VAULT_ARG="\"$VAULT_ADDRESS\""
  echo "→ initialize (vault: $VAULT_ADDRESS — funds will sit in the DeFindex vault)"
else
  VAULT_ARG=null
  echo "→ initialize (vault: null — funds will sit in the escrow)"
  echo "   if you want a vault, run this first: ./scripts/create-vault.sh"
fi

stellar contract invoke --id "$CONTRACT_ID" --source admin "${NET[@]}" -- initialize \
  --admin      "$(stellar keys address admin)" \
  --usdc_sac   "$USDC_SAC_ID" \
  --relayer    "$(stellar keys address relayer)" \
  --coord_a    "$(stellar keys address coord-a)" \
  --coord_b    "$(stellar keys address coord-b)" \
  --coord_c    "$(stellar keys address coord-c)" \
  --vault      "$VAULT_ARG" >/dev/null

sed -i '' "s|^POA_CONTRACT_ID=.*|POA_CONTRACT_ID=$CONTRACT_ID|" .env
echo "✅ .env updated: POA_CONTRACT_ID=$CONTRACT_ID"

stellar contract invoke --id "$CONTRACT_ID" --source admin "${NET[@]}" -- get_config
