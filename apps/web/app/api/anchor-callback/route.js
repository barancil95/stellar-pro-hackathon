import { NextResponse } from 'next/server';
import { verifyCallbackSignature } from '../../../lib/payout.js';
import { saveAnchorStatus, getAnchorStatus } from '../../../lib/store.js';

export const dynamic = 'force-dynamic';

/**
 * Anchor durum değişikliklerini buraya POST eder (plan 5.7).
 * İmza doğrulanmadan hiçbir şey yazılmaz — yoksa herkes durum uydurabilir.
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
  saveAnchorStatus(transaction.id, transaction);
  return NextResponse.json({ ok: true });
}

/** Frontend son bilinen durumu buradan okur. */
export async function GET(request) {
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id gerekli' }, { status: 400 });
  return NextResponse.json({ id, ...(getAnchorStatus(id) ?? { status: null }) });
}
