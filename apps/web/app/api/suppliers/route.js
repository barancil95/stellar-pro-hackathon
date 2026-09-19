import { NextResponse } from 'next/server';
import { registerSupplierRecord, listSuppliers } from '../../../lib/store.js';

export const dynamic = 'force-dynamic';

/** Türk IBAN'ı: TR + 24 hane, mod-97. Anchor da doğruluyor; burada erken yakalıyoruz. */
function validTurkishIban(raw) {
  const iban = String(raw || '').replace(/\s/g, '').toUpperCase();
  if (!/^TR\d{24}$/.test(iban)) return null;
  const rearranged = iban.slice(4) + '2927' + iban.slice(2, 4);
  let remainder = 0;
  for (const ch of rearranged) remainder = (remainder * 10 + Number(ch)) % 97;
  return remainder === 1 ? iban : null;
}

export async function GET() {
  return NextResponse.json({ suppliers: listSuppliers() });
}

export async function POST(request) {
  const { name, iban } = await request.json();

  const normalized = validTurkishIban(iban);
  if (!normalized) {
    return NextResponse.json(
      { error: 'Geçersiz IBAN — TR + 24 hane olmalı ve mod-97 tutmalı' },
      { status: 400 },
    );
  }
  if (!name?.trim()) {
    return NextResponse.json({ error: 'Tedarikçi adı gerekli' }, { status: 400 });
  }

  const { supplierId, supplierRef, name: stored } = registerSupplierRecord({
    name: name.trim(),
    iban: normalized,
  });
  // IBAN geri dönmez — zincire giden de bu değil, hash'i.
  return NextResponse.json({ supplierId, supplierRef, name: stored });
}
