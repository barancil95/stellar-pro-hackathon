import { NextResponse } from 'next/server';
import { verifyCallbackSignature } from '../../../lib/payout.js';
import { saveAnchorStatus, getPayout } from '../../../lib/store.js';

export const dynamic = 'force-dynamic';

/**
 * Anchor durum değişikliklerini buraya POST eder (plan 5.7).
 * İmza doğrulanmadan hiçbir şey yazılmaz — yoksa herkes durum uydurabilir.
 *
 * Gelen gövdede yalnızca anchor'ın kendi tx id'si var; hangi talebe ait
 * olduğu `store` içindeki köprüden bulunur ve ödeme kaydının üzerine yazılır.
 * Böylece denetim izi callback'ten besleniyor — eskiden ayrı bir anahtara
 * yazılıyordu ve hiçbir ekran okumuyordu.
 */
export async function POST(request) {
  const rawBody = await request.text();

  const ok = await verifyCallbackSignature({
    signatureHeader: request.headers.get('signature'),
    host: request.headers.get('host'),
    rawBody,
  });
  if (!ok) {
    return NextResponse.json({ error: 'imza doğrulanamadı' }, { status: 401 });
  }

  const { transaction } = JSON.parse(rawBody);
  const saved = await saveAnchorStatus(transaction.id, transaction);

  if (saved.requestId === null) {
    // Bizim başlatmadığımız bir işlem — imza geçerli, ama eşleştiremiyoruz.
    return NextResponse.json({ ok: true, matched: false });
  }
  return NextResponse.json({ ok: true, matched: true, requestId: saved.requestId });
}

/** Frontend ödeme durumunu /api/payout üzerinden okur; bu uç teşhis içindir. */
export async function GET(request) {
  const requestId = new URL(request.url).searchParams.get('requestId');
  if (!requestId) return NextResponse.json({ error: 'requestId gerekli' }, { status: 400 });
  return NextResponse.json((await getPayout(requestId)) ?? { status: null });
}
