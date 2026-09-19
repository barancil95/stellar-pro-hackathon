import { NextResponse } from 'next/server';
import { saveRequestNote, getRequestNote } from '../../../lib/store.js';

export const dynamic = 'force-dynamic';

/** Talebin insan tarafı — zincire sığmayan açıklama. Yetki taşımaz. */
export async function POST(request) {
  const { requestId, need, supplierName, requestedTry } = await request.json();
  if (requestId === undefined || requestId === null) {
    return NextResponse.json({ error: 'requestId gerekli' }, { status: 400 });
  }
  return NextResponse.json(
    await saveRequestNote(requestId, {
      need: need ?? null,
      supplierName: supplierName ?? null,
      // Zincire USDC yazılıyor; talep anındaki TRY burada. Bu olmadan denetim
      // izinde "ne kadar istendi / ne kadar ödendi" karşılaştırılamaz — kur
      // talep ile ödeme arasında değişebilir (plan 5.5).
      requestedTry: requestedTry ?? null,
    }),
  );
}

export async function GET(request) {
  const id = new URL(request.url).searchParams.get('requestId');
  if (!id) return NextResponse.json({ error: 'requestId gerekli' }, { status: 400 });
  return NextResponse.json((await getRequestNote(id)) ?? {});
}
