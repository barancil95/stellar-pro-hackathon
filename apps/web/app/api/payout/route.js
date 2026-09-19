import { NextResponse } from 'next/server';
import { payoutToSupplier } from '../../../lib/payout.js';
import { findBySupplierRef, savePayout, getPayout } from '../../../lib/store.js';
import { readRequest, fromStroops } from '../../../lib/soroban.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Zincirden çıkan fonu tedarikçinin IBAN'ına ulaştırır.
 *
 * Zincir üstü 2/3 onay ve `execute_payout` bundan ÖNCE gerçekleşir. Burası
 * yalnızca fiat bacağı; yetki kararı zincirde verilmiştir. Yine de contract'ın
 * durumunu okuyup doğruluyoruz — bu route'a gelen istek tek başına yetki değil.
 */
export async function POST(request) {
  try {
    const { requestId } = await request.json();
    if (requestId === undefined || requestId === null) {
      return NextResponse.json({ error: 'requestId gerekli' }, { status: 400 });
    }

    const existing = getPayout(requestId);
    if (existing?.bankReference) {
      return NextResponse.json({ alreadyPaid: true, ...existing });
    }

    const onChain = await readRequest(requestId);
    if (!onChain.completed) {
      return NextResponse.json(
        { error: 'Talep zincirde henüz ödenmedi — önce 2/3 onay ve execute_payout' },
        { status: 409 },
      );
    }

    const supplierRef = Buffer.from(onChain.supplier_ref).toString('hex');
    const supplier = findBySupplierRef(supplierRef);
    if (!supplier) {
      return NextResponse.json(
        { error: `supplier_ref ${supplierRef.slice(0, 12)}… kayıtlı değil` },
        { status: 404 },
      );
    }

    const base = process.env.PUBLIC_BASE_URL;
    const result = await payoutToSupplier({
      supplierId: supplier.supplierId,
      iban: supplier.iban,
      supplierName: supplier.name,
      usdcAmount: fromStroops(onChain.amount),
      // Localhost'ta anchor bize ulaşamaz; o zaman polling yedeği devrede.
      onChangeCallback: base ? `${base}/api/anchor-callback` : undefined,
    });

    return NextResponse.json(
      savePayout(requestId, { ...result, supplierName: supplier.name }),
    );
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function GET(request) {
  const id = new URL(request.url).searchParams.get('requestId');
  if (!id) return NextResponse.json({ error: 'requestId gerekli' }, { status: 400 });
  return NextResponse.json(getPayout(id) ?? { status: null });
}
