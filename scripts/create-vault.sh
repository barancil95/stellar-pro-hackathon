#!/usr/bin/env bash
# Creates the DeFindex vault on top of the anchor's USDC SAC and writes it to .env.
#
# WHY NOT A READY-MADE VAULT
#   The testnet `usdc_paltalabs_vault` holds BlendUSDC (CAQCFVLO…), not the
#   anchor's USDC (CBIELTK6…). Plan 10.1.a spotted that correctly but drew the
#   wrong conclusion: the factory lets us create our own vault.
#
# WHY THE STRATEGY LIST IS EMPTY
#   There is no DeFindex strategy deployed for the anchor's USDC SAC (the
#   strategies are tied to Blend's test USDC). An empty list is valid in the vault
#   contract — `validate_strategies` only rejects duplicates.
#   The result: on testnet YIELD IS ZERO and the funds sit idle in the vault. What
#   we gain is architecture — the escrow holds shares behind a standard vault
#   interface. On mainnet the same script produces yield; only the addresses change:
#     USDC      CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75
#     strategy  CDB2WMKQQNVZMEBY7Q7GZ5C7E7IAFSNMZ7GGVD6WKTCEWK7XOIAVZSAP
#
# Prerequisite: admin exists via `stellar keys generate`; the SEED account holds USDC.
set -euo pipefail
cd "$(dirname "$0")/.."

# rustup is keg-only in brew (same reason as deploy-contract.sh).
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"

# shellcheck disable=SC1091
set -a; source .env; set +a

NET=(--rpc-url "$SOROBAN_RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE")

# Addresses are not hardcoded — DeFindex redeploys testnet often, so the source of
# truth is the JSON they publish themselves (plan 10.2).
CONTRACTS_JSON=${DEFINDEX_CONTRACTS_JSON:-https://raw.githubusercontent.com/defindex-io/stellar-contracts/main/public/testnet.contracts.json}
FACTORY=${DEFINDEX_FACTORY:-$(curl -fsSL "$CONTRACTS_JSON" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).ids.defindex_factory))")}

# The Soroswap router is not in that JSON; this is the testnet address from the
# DeFindex docs.
ROUTER=${SOROSWAP_ROUTER:-CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD}

# On the first deposit the vault LOCKS 1000 shares against an inflation attack. So
# that the escrow does not eat that loss, we seed the vault with this account first;
# the escrow's later deposits are then a clean 1:1.
SEED_SOURCE=${VAULT_SEED_SOURCE:-relayer}
SEED_STROOPS=${VAULT_SEED_STROOPS:-1000000} # 0.1 USDC
# Note: the stellar CLI expects i128 as a STRING — [1000000] is rejected,
# ["1000000"] is accepted.

ADMIN=$(stellar keys address admin)
SEED_ADDR=$(stellar keys address "$SEED_SOURCE")

: "${USDC_SAC_ID:?USDC_SAC_ID is not set in .env — read deploy-contract.sh}"

echo "→ factory  : $FACTORY"
echo "→ asset    : $USDC_SAC_ID  (the anchor's USDC SAC)"
echo "→ admin    : $ADMIN"
echo "→ seed     : $SEED_STROOPS stroops, $SEED_SOURCE ($SEED_ADDR)"

echo "→ creating the vault"
VAULT=$(stellar contract invoke --id "$FACTORY" --source admin "${NET[@]}" -- \
  create_defindex_vault \
  --roles "{\"0\":\"$ADMIN\",\"1\":\"$ADMIN\",\"2\":\"$ADMIN\",\"3\":\"$ADMIN\"}" \
  --vault_fee 0 \
  --assets "[{\"address\":\"$USDC_SAC_ID\",\"strategies\":[]}]" \
  --soroswap_router "$ROUTER" \
  --name_symbol '{"name":"PoA Aid Reserve","symbol":"PAID"}' \
  --upgradable true 2>/dev/null | tail -1 | tr -d '"')

echo "   $VAULT"

echo "→ seed deposit (this account absorbs the 1000 locked shares)"
stellar contract invoke --id "$VAULT" --source "$SEED_SOURCE" "${NET[@]}" -- deposit \
  --amounts_desired "[\"$SEED_STROOPS\"]" \
  --amounts_min "[\"$SEED_STROOPS\"]" \
  --from "$SEED_ADDR" \
  --invest true >/dev/null

echo "→ verification"
ASSETS=$(stellar contract invoke --id "$VAULT" --source admin "${NET[@]}" --send=no -- get_assets 2>/dev/null)
echo "   get_assets   : $ASSETS"
case "$ASSETS" in
  *"$USDC_SAC_ID"*) echo "   ✅ the vault asset MATCHES the anchor USDC SAC" ;;
  *) echo "   ❌ asset mismatch — stopped"; exit 1 ;;
esac

if grep -q '^VAULT_ADDRESS=' .env; then
  sed -i '' "s|^VAULT_ADDRESS=.*|VAULT_ADDRESS=$VAULT|" .env
else
  printf '\nVAULT_ADDRESS=%s\n' "$VAULT" >> .env
fi
echo "✅ .env updated: VAULT_ADDRESS=$VAULT"
echo
echo "Next: ./scripts/deploy-contract.sh  (initializes the escrow with this vault)"
