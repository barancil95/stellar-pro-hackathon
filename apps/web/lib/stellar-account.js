/** Account reads and trustlines over Horizon (everything outside the contract). */

import {
  Asset,
  BASE_FEE,
  Horizon,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

const HORIZON =
  process.env.NEXT_PUBLIC_HORIZON_URL ||
  process.env.HORIZON_URL ||
  'https://horizon-testnet.stellar.org';

const PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ||
  process.env.NETWORK_PASSPHRASE ||
  Networks.TESTNET;

/**
 * @returns {Promise<{exists: boolean, trustline: boolean, balance: string}>}
 * `trustline: false` → it cannot hold USDC. An anchor deposit waits in
 * `pending_trust` (plan 5.3); the fix is changeTrust, not a claim.
 */
export async function usdcPosition(publicKey, issuer) {
  const res = await fetch(`${HORIZON}/accounts/${publicKey}`);
  if (res.status === 404) return { exists: false, trustline: false, balance: '0', xlm: '0' };
  if (!res.ok) throw new Error(`Horizon ${res.status}`);

  const account = await res.json();
  const line = account.balances.find(
    (b) => b.asset_code === 'USDC' && b.asset_issuer === issuer,
  );
  return {
    exists: true,
    trustline: Boolean(line),
    balance: line ? line.balance : '0',
    xlm: account.balances.find((b) => b.asset_type === 'native')?.balance ?? '0',
  };
}

/**
 * Opens a USDC trustline. The wallet signs.
 *
 * Each trustline needs a 0.5 XLM reserve; without it Horizon returns
 * `tx_insufficient_balance`.
 */
export async function openUsdcTrustline({ publicKey, signTransaction, issuer }) {
  const horizon = new Horizon.Server(HORIZON);
  const account = await horizon.loadAccount(publicKey);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(Operation.changeTrust({ asset: new Asset('USDC', issuer) }))
    .setTimeout(120)
    .build();

  const { signedTxXdr } = await signTransaction(tx.toXDR(), {
    networkPassphrase: PASSPHRASE,
  });

  const signed = TransactionBuilder.fromXDR(signedTxXdr, PASSPHRASE);
  const res = await horizon.submitTransaction(signed);
  return res.hash;
}
