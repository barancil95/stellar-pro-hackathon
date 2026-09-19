import { NextResponse } from 'next/server';
import { startPayout, fetchPayoutStatus } from '../../../lib/payout.js';
import {
  findBySupplierRef,
  savePayout,
  getPayout,
  acquirePayoutLock,
  releasePayoutLock,
} from '../../../lib/store.js';
import { readRequest, fromStroops } from '../../../lib/soroban.js';

export const dynamic = 'force-dynamic';
// Serverless tavanının altında kalmak zorundayız (Vercel Hobby 60 sn). Bu
// route artık anchor'ın bitmesini beklemiyor; USDC'yi gönderip dönüyor.
export const maxDuration = 60;

const TERMINAL = new Set(['completed', 'error', 'refunded']);

/**
 * Fiat bacağını BAŞLATIR: USDC relayer'dan anchor treasury'sine gider.
 *
 * Zincir üstü 2/3 onay ve `execute_payout` bundan ÖNCE gerçekleşir. Burası
 * yalnızca fiat bacağı; yetki kararı zincirde verilmiştir. Yine de contract'ın
 * durumunu okuyup doğruluyoruz — bu route'a gelen istek tek başına yetki değil.
 *
 * Sonuç `completed` olduğunda değil, USDC gönderildiğinde döner. Nihai durum
 * `on_change_callback` ile gelir; gelmezse GET yedek yolu çalıştırır.
 */
export async function POST(request) {
  const { requestId } = await request.json();
  if (requestId === undefined || requestId === null) {
    return NextResponse.json({ error: 'requestId gerekli' }, { status: 400 });
  }

  const existing = await getPayout(requestId);
  if (existing?.anchorTransactionId) {
    return NextResponse.json({ alreadyStarted: true, ...existing });
  }

  // Zincirde ödenmemiş talebe fiat bacağı açılmaz.
  const onChain = await readRequest(requestId);
  if (!onChain.completed) {
    return NextResponse.json(
      { error: 'Talep zincirde henüz ödenmedi — önce 2/3 onay ve execute_payout' },
      { status: 409 },
    );
  }

  // İki eşzamanlı POST iki ayrı withdraw açmasın. `completed` kontrolü tek
  // başına yetmiyordu: ödeme kaydı ancak withdraw'dan SONRA yazılıyor.
  if (!(await acquirePayoutLock(requestId))) {
    return NextResponse.json(
      { error: 'Bu talep için ödeme zaten sürüyor' },
      { status: 409 },
    );
  }

  try {
    const supplierRef = Buffer.from(onChain.supplier_ref).toString('hex');
    const supplier = await findBySupplierRef(supplierRef);
    if (!supplier) {
      return NextResponse.json(
        { error: `supplier_ref ${supplierRef.slice(0, 12)}… kayıtlı değil` },
        { status: 404 },
      );
    }

    const base = process.env.PUBLIC_BASE_URL;
    const started = await startPayout({
      requestId,
      supplierId: supplier.supplierId,
      iban: supplier.iban,
      supplierName: supplier.name,
      usdcAmount: fromStroops(onChain.amount),
      // Localhost'ta anchor bize ulaşamaz; o zaman GET'teki yedek yol devrede.
      onChangeCallback: base ? `${base}/api/anchor-callback` : undefined,
    });

    return NextResponse.json(
      await savePayout(requestId, { ...started, supplierName: supplier.name }),
    );
  } catch (e) {
    await releasePayoutLock(requestId);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/**
 * Ödemenin son durumu.
 *
 * Kayıt terminal değilse anchor'a TEK bir soru sorup günceller — bu, callback
 * ulaşamadığında (localhost) devreye giren yedek yol. Her istek kısa kalır,
 * uzun polling yok.
 */
export async function GET(request) {
  const requestId = new URL(request.url).searchParams.get('requestId');
  if (!requestId) {
    return NextResponse.json({ error: 'requestId gerekli' }, { status: 400 });
  }

  const payout = await getPayout(requestId);
  if (!payout?.anchorTransactionId) {
    return NextResponse.json(payout ?? { status: null });
  }
  if (TERMINAL.has(payout.status)) {
    return NextResponse.json(payout);
  }

  try {
    const fresh = await fetchPayoutStatus({
      supplierId: payout.supplierId,
      anchorTransactionId: payout.anchorTransactionId,
    });
    const merged = await savePayout(requestId, fresh);
    if (TERMINAL.has(fresh.status)) await releasePayoutLock(requestId);
    return NextResponse.json(merged);
  } catch (e) {
    // Anchor'a ulaşılamıyorsa bilinen son durumu ver; ekran boş kalmasın.
    return NextResponse.json({ ...payout, statusError: e.message });
  }
}
