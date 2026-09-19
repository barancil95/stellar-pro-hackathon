'use client';

// Tarayıcıda Buffer global değil — açıkça import ediliyor.
import { Buffer } from 'buffer';

import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, Landmark, ArrowUpRight, CircleDashed } from 'lucide-react';
import { shorten } from '../lib/wallet.js';
import {
  readAllRequests,
  readEscrow,
  readApprovals,
  readConfig,
  approveRequest,
  executePayout,
  fromStroops,
  explorerTx,
} from '../lib/soroban.js';
import { shortHash, isEmptyProof } from '../lib/evidence.js';
import AuditTimeline from './AuditTimeline.jsx';

const TERMINAL = new Set(['completed', 'error', 'refunded']);

export default function MultisigPanel({ wallet, refreshKey }) {
  const [config, setConfig] = useState(null);
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [balance, setBalance] = useState(null);

  const load = useCallback(async () => {
    try {
      const cfg = config ?? (await readConfig());
      if (!config) setConfig(cfg);

      setBalance((await readEscrow()).balance);
      const requests = await readAllRequests();
      const withApprovals = await Promise.all(
        requests.map(async (r) => ({
          ...r,
          approvals: await readApprovals(r.id, cfg.coordinators),
          payout: await fetch(`/api/payout?requestId=${r.id}`)
            .then((res) => res.json())
            .catch(() => null),
          note: await fetch(`/api/requests?requestId=${r.id}`)
            .then((res) => res.json())
            .catch(() => null),
        })),
      );
      setRows(withApprovals);
    } catch (e) {
      setError(e.message);
    }
  }, [config]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  /**
   * Anchor'da devam eden bir ödeme varken durumu yokla.
   *
   * Asıl yol `on_change_callback` (Vercel'de anchor bize ulaşır ve kaydı
   * kendisi günceller); bu, localhost için yedek — orada anchor'ın erişebileceği
   * bir URL yok. Terminal duruma gelince kendiliğinden duruyor.
   */
  useEffect(() => {
    const pending = rows?.some(
      (r) => r.payout?.anchorTransactionId && !TERMINAL.has(r.payout.status),
    );
    if (!pending) return;
    const timer = setTimeout(load, 5000); // off-ramp tespiti 5 sn kadence'ında
    return () => clearTimeout(timer);
  }, [rows, load]);

  async function handleApprove(requestId) {
    setBusy(`approve-${requestId}`);
    setError(null);
    try {
      await approveRequest({
        publicKey: wallet.address,
        signTransaction: wallet.sign,
        requestId,
      });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function handleRelease(requestId) {
    setBusy(`release-${requestId}`);
    setError(null);
    try {
      await executePayout({
        publicKey: wallet.address,
        signTransaction: wallet.sign,
        requestId,
      });
      await load();

      // Fiat bacağı: relayer anchor üzerinden tedarikçinin IBAN'ına öder.
      // POST artık `completed` beklemiyor — USDC'yi gönderip dönüyor, çünkü
      // serverless fonksiyonun süre tavanı off-ramp'in bitmesine yetmiyor.
      const res = await fetch('/api/payout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: Number(requestId) }),
      });
      const payout = await res.json();
      if (!res.ok) throw new Error(payout.error);
      await load(); // nihai durumu aşağıdaki yoklama getirecek
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  if (!rows) {
    return (
      <section className="rounded-2xl border border-edge bg-surface p-6 text-sm text-muted">
        Talepler okunuyor…
      </section>
    );
  }

  if (rows.length === 0) {
    return (
      <section className="rounded-2xl border border-edge bg-surface p-6 text-sm text-muted">
        Henüz talep yok. "Saha talebi" sekmesinden bir tane açın.
      </section>
    );
  }

  const myIndex = config?.coordinators.findIndex((c) => c === wallet?.address) ?? -1;

  return (
    <div className="space-y-4">
      {error && (
        <p className="rounded-lg border border-signal/30 bg-signal/5 px-3 py-2.5 text-xs text-signal">
          {error}
        </p>
      )}

      {rows.map((r) => {
        const id = String(r.id);
        const count = r.approvals.filter((a) => a.approved).length;
        const alreadyVoted = myIndex >= 0 && r.approvals[myIndex]?.approved;
        const canApprove = wallet && myIndex >= 0 && !alreadyVoted && !r.completed;
        // Contract bakiyeden büyük ödemeyi reddeder (Error #9). Kullanıcıyı
        // imzalatıp hataya sürmek yerine önden söylüyoruz.
        const shortBy =
          balance !== null && r.amount > balance ? r.amount - balance : null;
        const canRelease = wallet && count >= 2 && !r.completed && !shortBy;

        return (
          <section key={id} className="rounded-2xl border border-edge bg-surface p-6">
            <header className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-semibold">
                {r.note?.need || `Talep #${id}`}
                <span className="ml-3 font-mono text-sm text-verified">
                  {fromStroops(r.amount)} USDC
                </span>
              </h3>
              <span className="font-mono text-xs text-muted">
                #{id} ·{' '}
                {isEmptyProof(Buffer.from(r.proof_hash).toString('hex'))
                  ? 'kanıt eklenmedi'
                  : `kanıt ${shortHash(Buffer.from(r.proof_hash).toString('hex'), 6)}`}
              </span>
            </header>

            <div className="mb-4">
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="text-muted">Koordinatör onayı</span>
                <span className={count >= 2 ? 'text-verified' : 'text-muted'}>
                  {count}/2 gerekli · {r.approvals.length} koordinatör
                </span>
              </div>
              <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-ink">
                <div
                  className="h-full rounded-full bg-verified transition-all"
                  style={{ width: `${Math.min(count / 2, 1) * 100}%` }}
                />
              </div>
              <div className="grid grid-cols-3 gap-2">
                {r.approvals.map((a, i) => (
                  <div
                    key={a.address}
                    className={`rounded-lg border px-2.5 py-2 text-xs ${
                      a.approved
                        ? 'border-verified/40 bg-verified/5 text-verified'
                        : 'border-edge text-muted'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      {a.approved ? <Check size={12} /> : <CircleDashed size={12} />}
                      {String.fromCharCode(65 + i)}
                      {a.address === wallet?.address && (
                        <span className="ml-auto text-[10px]">siz</span>
                      )}
                    </div>
                    <div className="mt-0.5 font-mono text-[10px] opacity-60">
                      {shorten(a.address, 3)}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {canApprove && (
                <button
                  onClick={() => handleApprove(id)}
                  disabled={busy === `approve-${id}`}
                  className="inline-flex items-center gap-2 rounded-lg border border-verified/40 px-4 py-2 text-sm font-semibold text-verified transition hover:bg-verified/10 disabled:opacity-40"
                >
                  {busy === `approve-${id}` && <Loader2 size={14} className="animate-spin" />}
                  Onayla
                </button>
              )}
              {alreadyVoted && !r.completed && (
                <span className="rounded-lg border border-edge px-4 py-2 text-sm text-muted">
                  Onayınız kayıtlı
                </span>
              )}
              {canRelease && (
                <button
                  onClick={() => handleRelease(id)}
                  disabled={busy === `release-${id}`}
                  className="inline-flex items-center gap-2 rounded-lg bg-signal px-4 py-2 text-sm font-semibold text-ink transition hover:brightness-110 disabled:opacity-40"
                >
                  {busy === `release-${id}` ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Landmark size={14} />
                  )}
                  {busy === `release-${id}` ? 'Ödeniyor…' : 'Fonu serbest bırak'}
                </button>
              )}
              {shortBy && count >= 2 && !r.completed && (
                <span className="text-xs text-signal">
                  Escrow'da {fromStroops(shortBy)} USDC eksik — ödeme için önce
                  bağış gerekiyor.
                </span>
              )}
              {wallet && myIndex < 0 && !r.completed && (
                <span className="text-xs text-muted">
                  Bu cüzdan koordinatör listesinde değil — onaylayamaz.
                </span>
              )}
            </div>

            <AuditTimeline
              request={r}
              approvalCount={count}
              payout={r.payout}
              note={r.note}
            />
          </section>
        );
      })}
    </div>
  );
}
