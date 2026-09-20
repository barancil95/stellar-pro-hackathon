import { NextResponse } from 'next/server';
import { saveRequestNote, getRequestNote } from '../../../lib/store.js';

export const dynamic = 'force-dynamic';

/** The human side of a request — the description that does not fit on-chain. Carries no authority. */
export async function POST(request) {
  const { requestId, need, supplierName, requestedTry } = await request.json();
  if (requestId === undefined || requestId === null) {
    return NextResponse.json({ error: 'requestId is required' }, { status: 400 });
  }
  return NextResponse.json(
    await saveRequestNote(requestId, {
      need: need ?? null,
      supplierName: supplierName ?? null,
      // USDC goes on-chain; the TRY at request time lives here. Without it the audit
      // trail cannot compare "how much was asked" against "how much was paid" — the
      // rate can move between the request and the payout (plan 5.5).
      requestedTry: requestedTry ?? null,
    }),
  );
}

export async function GET(request) {
  const id = new URL(request.url).searchParams.get('requestId');
  if (!id) return NextResponse.json({ error: 'requestId is required' }, { status: 400 });
  return NextResponse.json((await getRequestNote(id)) ?? {});
}
