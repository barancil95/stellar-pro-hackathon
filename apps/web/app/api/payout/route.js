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
// We have to stay under the serverless ceiling (60 s on Vercel Hobby). This route
// no longer waits for the anchor to finish; it sends the USDC and returns.
export const maxDuration = 60;

const TERMINAL = new Set(['completed', 'error', 'refunded']);

/**
 * STARTS the fiat leg: USDC goes from the relayer to the anchor's treasury.
 *
 * The on-chain 2/3 approval and `execute_payout` happen BEFORE this. This is only
 * the fiat leg; the authorization decision was made on-chain. We still read and
 * verify the contract's state — a request hitting this route is not authorization
 * by itself.
 *
 * It returns when the USDC has been sent, not when the transfer is `completed`.
 * The final status arrives via `on_change_callback`; if it does not, the GET runs
 * the fallback path.
 */
export async function POST(request) {
  const { requestId } = await request.json();
  if (requestId === undefined || requestId === null) {
    return NextResponse.json({ error: 'requestId is required' }, { status: 400 });
  }

  const existing = await getPayout(requestId);
  if (existing?.anchorTransactionId) {
    return NextResponse.json({ alreadyStarted: true, ...existing });
  }

  // No fiat leg is opened for a request that has not been paid on-chain.
  const onChain = await readRequest(requestId);
  if (!onChain.completed) {
    return NextResponse.json(
      { error: 'The request has not been paid on-chain yet — 2/3 approvals and execute_payout come first' },
      { status: 409 },
    );
  }

  // Two concurrent POSTs must not open two separate withdrawals. The `completed`
  // check was not enough on its own: the payout record is written only AFTER the
  // withdrawal.
  if (!(await acquirePayoutLock(requestId))) {
    return NextResponse.json(
      { error: 'A payout for this request is already in progress' },
      { status: 409 },
    );
  }

  try {
    const supplierRef = Buffer.from(onChain.supplier_ref).toString('hex');
    const supplier = await findBySupplierRef(supplierRef);
    if (!supplier) {
      // A `return` does not hit the catch; without releasing the lock here the
      // request stays locked for 10 minutes.
      await releasePayoutLock(requestId);
      return NextResponse.json(
        { error: `supplier_ref ${supplierRef.slice(0, 12)}… is not registered` },
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
      // On localhost the anchor cannot reach us; the fallback path in GET takes over.
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
 * The payout's latest status.
 *
 * If the record is not terminal it asks the anchor ONCE and updates — the fallback
 * for when the callback cannot reach us (localhost). Every request stays short, no
 * long polling.
 */
export async function GET(request) {
  const requestId = new URL(request.url).searchParams.get('requestId');
  if (!requestId) {
    return NextResponse.json({ error: 'requestId is required' }, { status: 400 });
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
    // If the anchor is unreachable, return the last known status so the screen is not empty.
    return NextResponse.json({ ...payout, statusError: e.message });
  }
}
