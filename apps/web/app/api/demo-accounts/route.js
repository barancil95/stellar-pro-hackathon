import { NextResponse } from 'next/server';
import { Keypair } from '@stellar/stellar-sdk';

export const dynamic = 'force-dynamic';

/**
 * Demo imzalayıcı için testnet anahtarları.
 *
 * Neden var: cüzdan eklentisi kurulamadığında demo tıkanıyor. Bu yol
 * tarayıcıda yerel imza atar, eklenti gerektirmez.
 *
 * ⚠️ Sınırlar — bilinçli:
 * - Yalnızca `DEMO_MODE=true` iken çalışır, aksi halde 404.
 * - Sadece bu dört demo hesabı döner. RELAYER_SECRET ve ADMIN_SECRET
 *   buradan ASLA geçmez; relayer sıcak cüzdan, tarayıcıya inmemeli.
 * - Anahtarlar client bundle'ına gömülmez, çalışma anında çekilir.
 */
const DEMO_ACCOUNTS = [
  { id: 'donor', label: 'Bağışçı', env: 'DONOR_SECRET' },
  { id: 'coord-a', label: 'Coordinator A', env: 'COORD_A_SECRET' },
  { id: 'coord-b', label: 'Coordinator B', env: 'COORD_B_SECRET' },
  { id: 'coord-c', label: 'Coordinator C', env: 'COORD_C_SECRET' },
];

export async function GET() {
  if (process.env.DEMO_MODE !== 'true') {
    return NextResponse.json({ error: 'demo modu kapalı' }, { status: 404 });
  }

  const accounts = [];
  for (const { id, label, env } of DEMO_ACCOUNTS) {
    const secret = process.env[env];
    if (!secret) continue;
    try {
      accounts.push({ id, label, secret, address: Keypair.fromSecret(secret).publicKey() });
    } catch {
      // Bozuk anahtarı sessizce atla — listeyi tamamen düşürmesin.
    }
  }
  return NextResponse.json({ accounts });
}
