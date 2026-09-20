import { NextResponse } from 'next/server';
import { registerSupplierRecord, listSuppliers } from '../../../lib/store.js';

export const dynamic = 'force-dynamic';

/** A Turkish IBAN: TR + 24 digits, mod-97. The anchor validates it too; we catch it early here. */
function validTurkishIban(raw) {
  const iban = String(raw || '').replace(/\s/g, '').toUpperCase();
  if (!/^TR\d{24}$/.test(iban)) return null;
  const rearranged = iban.slice(4) + '2927' + iban.slice(2, 4);
  let remainder = 0;
  for (const ch of rearranged) remainder = (remainder * 10 + Number(ch)) % 97;
  return remainder === 1 ? iban : null;
}

export async function GET() {
  return NextResponse.json({ suppliers: await listSuppliers() });
}

export async function POST(request) {
  const { name, iban } = await request.json();

  const normalized = validTurkishIban(iban);
  if (!normalized) {
    return NextResponse.json(
      { error: 'Invalid IBAN — it must be TR + 24 digits and satisfy mod-97' },
      { status: 400 },
    );
  }
  if (!name?.trim()) {
    return NextResponse.json({ error: 'A supplier name is required' }, { status: 400 });
  }

  const { supplierId, supplierRef, name: stored } = await registerSupplierRecord({
    name: name.trim(),
    iban: normalized,
  });
  // The IBAN is never returned — and it is the hash, not the IBAN, that goes on-chain.
  return NextResponse.json({ supplierId, supplierRef, name: stored });
}
