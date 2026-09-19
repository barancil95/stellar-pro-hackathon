'use client';

// Tarayıcıda Buffer global değil — açıkça import ediliyor.
import { Buffer } from 'buffer';

import { Check, ArrowUpRight } from 'lucide-react';
import { fromStroops, explorerTx } from '../lib/soroban.js';
import { shortHash } from '../lib/evidence.js';

/**
 * "Para nereye gitti?" — zincirdeki ve anchor'daki gerçek duruma bakar,
 * uydurma adım yok. Tamamlanmamış adım soluk gösterilir.
 */
export default function AuditTimeline({ request, approvalCount, payout }) {
  const proofHex = Buffer.from(request.proof_hash).toString('hex');
  const supplierHex = Buffer.from(request.supplier_ref).toString('hex');

  const steps = [
    {
      label: 'Kanıt',
      detail: `sha256 ${shortHash(proofHex, 6)}`,
      done: true,
    },
    {
      label: 'Talep',
      detail: `#${request.id} · ${fromStroops(request.amount)} USDC · tedarikçi ${shortHash(supplierHex, 4)}`,
      done: true,
    },
    {
      label: 'Onaylar',
      detail: `${approvalCount}/2 koordinatör`,
      done: approvalCount >= 2,
    },
    {
      label: 'Fon serbest',
      detail: request.completed ? 'escrow → relayer' : 'bekliyor',
      done: request.completed,
    },
    {
      label: 'Anchor',
      detail: payout?.anchorTransactionId
        ? `${payout.anchorTransactionId} · memo ${payout.memo}`
        : 'bekliyor',
      done: Boolean(payout?.anchorTransactionId),
      href: payout?.stellarTxHash ? explorerTx(payout.stellarTxHash) : null,
    },
    {
      label: 'TRY ödendi',
      detail: payout?.bankReference
        ? `${payout.tryPaid} TRY · banka ref ${payout.bankReference}`
        : 'bekliyor',
      done: Boolean(payout?.bankReference),
    },
  ];

  return (
    <div className="mt-6 border-t border-edge pt-5">
      <h4 className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted">
        Denetim izi
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
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
