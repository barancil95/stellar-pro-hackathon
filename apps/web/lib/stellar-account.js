/** Horizon üzerinden hesap okumaları (contract dışı kalanlar). */

const HORIZON =
  process.env.NEXT_PUBLIC_HORIZON_URL || 'https://horizon-testnet.stellar.org';

/**
 * @returns {Promise<{exists: boolean, trustline: boolean, balance: string}>}
 * `trustline: false` → USDC tutamaz. Anchor deposit'i `pending_trust`'ta bekler
 * (plan 5.3); çözüm claim değil, changeTrust.
 */
export async function usdcPosition(publicKey, issuer) {
  const res = await fetch(`${HORIZON}/accounts/${publicKey}`);
  if (res.status === 404) return { exists: false, trustline: false, balance: '0' };
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
