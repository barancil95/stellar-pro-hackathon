import { NextResponse } from 'next/server';
import { verifyCallbackSignature } from '../../../lib/payout.js';
import { saveAnchorStatus, getPayout } from '../../../lib/store.js';

export const dynamic = 'force-dynamic';

/**
 * The anchor POSTs status changes here (plan 5.7).
 * Nothing is written before the signature is verified — otherwise anyone could
 * make up a status.
 *
 * The incoming body carries only the anchor's own tx id; which request it belongs
 * to is resolved through the bridge in `store` and merged into the payout record.
 * That way the audit trail is fed from the callback — it used to be written under
 * a separate key that no screen read.
 */
export async function POST(request) {
  const rawBody = await request.text();

  const ok = await verifyCallbackSignature({
    signatureHeader: request.headers.get('signature'),
    host: request.headers.get('host'),
    rawBody,
  });
  if (!ok) {
    return NextResponse.json({ error: 'signature could not be verified' }, { status: 401 });
  }

  const { transaction } = JSON.parse(rawBody);
  const saved = await saveAnchorStatus(transaction.id, transaction);

  if (saved.requestId === null) {
    // A transaction we did not start — the signature is valid, but we cannot match it.
    return NextResponse.json({ ok: true, matched: false });
  }
  return NextResponse.json({ ok: true, matched: true, requestId: saved.requestId });
}

/** The frontend reads payout status through /api/payout; this endpoint is for diagnostics. */
export async function GET(request) {
  const requestId = new URL(request.url).searchParams.get('requestId');
  if (!requestId) return NextResponse.json({ error: 'requestId is required' }, { status: 400 });
  return NextResponse.json((await getPayout(requestId)) ?? { status: null });
}
