import { NextResponse } from 'next/server';
import { Keypair } from '@stellar/stellar-sdk';

export const dynamic = 'force-dynamic';

/**
 * Testnet keys for the demo signer.
 *
 * Why it exists: the demo stalls when a wallet extension cannot be installed. This
 * path signs locally in the browser and needs no extension.
 *
 * ⚠️ Deliberate limits:
 * - Works only while `DEMO_MODE=true`, otherwise 404.
 * - Returns these four demo accounts only. RELAYER_SECRET and ADMIN_SECRET NEVER
 *   pass through here; the relayer is a hot wallet and must not reach the browser.
 * - The keys are not inlined into the client bundle, they are fetched at runtime.
 */
const DEMO_ACCOUNTS = [
  { id: 'donor', label: 'Donor', env: 'DONOR_SECRET' },
  { id: 'coord-a', label: 'Coordinator A', env: 'COORD_A_SECRET' },
  { id: 'coord-b', label: 'Coordinator B', env: 'COORD_B_SECRET' },
  { id: 'coord-c', label: 'Coordinator C', env: 'COORD_C_SECRET' },
];

export async function GET() {
  if (process.env.DEMO_MODE !== 'true') {
    return NextResponse.json({ error: 'demo mode is off' }, { status: 404 });
  }

  const accounts = [];
  for (const { id, label, env } of DEMO_ACCOUNTS) {
    const secret = process.env[env];
    if (!secret) continue;
    try {
      accounts.push({ id, label, secret, address: Keypair.fromSecret(secret).publicKey() });
    } catch {
      // Skip a broken key silently — it should not take down the whole list.
    }
  }
  return NextResponse.json({ accounts });
}
