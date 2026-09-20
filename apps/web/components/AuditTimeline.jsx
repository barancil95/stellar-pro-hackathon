'use client';

// Buffer is not a global in the browser — imported explicitly.
import { Buffer } from 'buffer';

import { Check, ArrowUpRight } from 'lucide-react';
import { fromStroops, explorerTx } from '../lib/soroban.js';
import { shortHash, isEmptyProof } from '../lib/evidence.js';

/**
 * An indicative quote is taken at request time and a firm quote at payout time
 * (plan 5.5). If the rate moves in between, the TRY reaching the supplier differs
 * from what was requested — the audit trail has to show that, otherwise the answer
 * to "where did the money go" is incomplete.
 */
function driftOf(requestedTry, tryPaid) {
  const requested = Number(requestedTry);
  const paid = Number(tryPaid);
  if (!(requested > 0) || !(paid > 0)) return null;

  const delta = paid - requested;
  if (Math.abs(delta) < 0.005) return null; // sub-cent — noise
  return {
    requested: requested.toFixed(2),
    delta: `${delta > 0 ? '+' : ''}${delta.toFixed(2)}`,
    pct: `${delta > 0 ? '+' : ''}${((delta / requested) * 100).toFixed(2)}%`,
    negative: delta < 0,
  };
}

/**
 * "Where did the money go?" — it reads the real state on-chain and at the anchor,
 * with no invented steps. An unfinished step is dimmed.
 */
export default function AuditTimeline({ request, approvalCount, payout, note }) {
  const proofHex = Buffer.from(request.proof_hash).toString('hex');
  const supplierHex = Buffer.from(request.supplier_ref).toString('hex');

  const steps = [
    {
      label: 'Proof',
      // Proof is optional; rendering the zero hash as if it were a sha256 would mislead.
      detail: isEmptyProof(proofHex) ? 'not attached' : `sha256 ${shortHash(proofHex, 6)}`,
      done: !isEmptyProof(proofHex),
    },
    {
      label: 'Request',
      detail: `#${request.id} · ${fromStroops(request.amount)} USDC · supplier ${
        note?.supplierName || payout?.supplierName || shortHash(supplierHex, 4)
      }`,
      done: true,
    },
    {
      label: 'Approvals',
      detail: `${approvalCount}/2 coordinators`,
      done: approvalCount >= 2,
    },
    {
      label: 'Funds released',
      detail: request.completed ? 'escrow → relayer' : 'pending',
      done: request.completed,
    },
    {
      label: 'Anchor',
      detail: payout?.anchorTransactionId
        ? `${payout.anchorTransactionId} · memo ${payout.memo}`
        : 'pending',
      done: Boolean(payout?.anchorTransactionId),
      href: payout?.stellarTxHash ? explorerTx(payout.stellarTxHash) : null,
    },
    {
      label: 'TRY paid',
      detail: payout?.bankReference
        ? `${payout.tryPaid} TRY · bank ref ${payout.bankReference}`
        : payout?.status && payout.status !== 'completed'
          ? `anchor: ${payout.status}`
          : 'pending',
      done: Boolean(payout?.bankReference),
      // The rate at request time need not equal the rate at payout time. Rather than
      // hiding the drift, we show it.
      drift: driftOf(note?.requestedTry, payout?.tryPaid),
    },
  ];

  return (
    <div className="mt-6 border-t border-edge pt-5">
      <h4 className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted">
        Audit trail
      </h4>
      <ol className="space-y-0">
        {steps.map((s, i) => (
          <li key={s.label} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span
                className={`flex size-5 items-center justify-center rounded-full border text-[10px] ${
                  s.done
                    ? 'border-verified bg-verified/15 text-verified'
                    : 'border-edge text-muted'
                }`}
              >
                {s.done ? <Check size={11} /> : i + 1}
              </span>
              {i < steps.length - 1 && (
                <span
                  className={`w-px flex-1 ${s.done ? 'bg-verified/40' : 'bg-edge'}`}
                />
              )}
            </div>
            <div className={`pb-4 text-sm ${s.done ? '' : 'opacity-40'}`}>
              <div className="font-medium">{s.label}</div>
              <div className="flex items-center gap-1 font-mono text-xs text-muted">
                {s.detail}
                {s.href && (
                  <a href={s.href} target="_blank" rel="noreferrer" className="hover:text-white">
                    <ArrowUpRight size={12} />
                  </a>
                )}
              </div>
              {s.drift && (
                <div className="font-mono text-xs text-muted">
                  requested {s.drift.requested} TRY → drift{' '}
                  <span className={s.drift.negative ? 'text-signal' : 'text-verified'}>
                    {s.drift.delta} TRY ({s.drift.pct})
                  </span>
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
