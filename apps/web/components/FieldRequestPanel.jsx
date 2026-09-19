'use client';

// Tarayıcıda Buffer global değil — açıkça import ediliyor.
import { Buffer } from 'buffer';

import { useEffect, useState } from 'react';
import { FileUp, Loader2, ShieldCheck, ArrowUpRight } from 'lucide-react';
import { signer } from '../lib/wallet.js';
import { createRequest, explorerTx } from '../lib/soroban.js';
import { hashEvidence, shortHash, formatBytes } from '../lib/evidence.js';
import { indicativePrice, assetIds } from '../lib/anchor.js';

export default function FieldRequestPanel({ wallet, onCreated }) {
  const [need, setNeed] = useState('Jeneratör yakıtı — 3 günlük');
  const [tryAmount, setTryAmount] = useState('1500');
  const [supplierName, setSupplierName] = useState('ABC Akaryakıt');
  const [iban, setIban] = useState('TR320010009999901234567890');
  const [evidence, setEvidence] = useState(null);
  const [quote, setQuote] = useState(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);
  const [error, setError] = useState(null);

  // Gösterge quote — talep anında. Firm quote ödeme anında alınır (plan 5.5).
  useEffect(() => {
    let alive = true;
    const amount = Number(tryAmount);
    if (!(amount > 0)) return setQuote(null);

    const timer = setTimeout(async () => {
      try {
        const ids = await assetIds();
        const price = await indicativePrice({
          sellAsset: ids.usdc,
          buyAsset: ids.try,
          buyAmount: tryAmount,
        });
        if (alive) setQuote(price);
      } catch {
        if (alive) setQuote(null);
      }
    }, 400);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [tryAmount]);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      setEvidence(await hashEvidence(file));
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleSubmit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/suppliers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: supplierName, iban }),
      });
      const supplier = await res.json();
      if (!res.ok) throw new Error(supplier.error);

      const { requestId, hash } = await createRequest({
        publicKey: wallet.address,
        signTransaction: signer(wallet.address),
        supplierRef: Buffer.from(supplier.supplierRef, 'hex'),
        amount: quote.sell_amount,
        proofHash: Buffer.from(evidence.hex, 'hex'),
      });

      // İhtiyaç açıklaması zincire sığmaz; denetim izinde görünsün diye saklanıyor.
      await fetch('/api/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: Number(requestId),
          need: need.trim(),
          supplierName: supplierName.trim(),
          // Zincire USDC yazıldı; kullanıcının gördüğü TRY bu. Ödeme anında
          // kur yeniden fiyatlanacağı için ikisi denetim izinde karşılaştırılır.
          requestedTry: tryAmount,
        }),
      });

      setCreated({ requestId: String(requestId), hash });
      onCreated?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const ready = wallet && evidence && quote && need.trim() && supplierName.trim();

  return (
    <section className="rounded-2xl border border-edge bg-surface p-6">
      <h2 className="mb-5 text-lg font-semibold">Saha talebi aç</h2>

      {!wallet ? (
        <p className="text-sm text-muted">
          Talep açmak için cüzdanınızı bağlayın.
        </p>
      ) : (
        <div className="space-y-4">
          <Field label="İhtiyaç">
            <input
              value={need}
              onChange={(e) => setNeed(e.target.value)}
              className="input"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Tutar (TRY)">
              <input
                type="number"
                value={tryAmount}
                onChange={(e) => setTryAmount(e.target.value)}
                className="input font-mono"
              />
            </Field>
            <Field label="Escrow'dan çıkacak">
              <div className="input flex items-center justify-between font-mono text-verified">
                {quote ? Number(quote.sell_amount).toFixed(4) : '—'}
                <span className="text-xs text-muted">USDC</span>
              </div>
            </Field>
          </div>

          <Field label="Tedarikçi">
            <input
              value={supplierName}
              onChange={(e) => setSupplierName(e.target.value)}
              className="input"
            />
          </Field>

          <Field label="Tedarikçi IBAN'ı — zincire yazılmaz, hash'i gider">
            <input
              value={iban}
              onChange={(e) => setIban(e.target.value)}
              className="input font-mono text-xs"
            />
          </Field>

          <Field label="İhtiyaç kanıtı">
            <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-edge bg-ink px-3 py-3 text-sm transition hover:border-signal">
              <FileUp size={16} className="text-muted" />
              {evidence ? (
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{evidence.fileName}</span>
                  <span className="font-mono text-xs text-muted">
                    sha256 {shortHash(evidence.hex)} · {formatBytes(evidence.fileSize)}
                  </span>
                </span>
              ) : (
                <span className="text-muted">Fotoğraf, fatura veya belge seçin</span>
              )}
              <input type="file" onChange={handleFile} className="hidden" />
            </label>
          </Field>

          {evidence?.previewUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={evidence.previewUrl}
              alt="kanıt önizleme"
              className="max-h-40 w-full rounded-lg border border-edge object-cover"
            />
          )}

          <button
            onClick={handleSubmit}
            disabled={!ready || busy}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-signal px-5 py-2.5 text-sm font-semibold text-ink transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy && <Loader2 size={15} className="animate-spin" />}
            {busy ? 'İmzalanıyor…' : 'Talebi zincire yaz'}
          </button>
        </div>
      )}

      {created && (
        <a
          href={explorerTx(created.hash)}
          target="_blank"
          rel="noreferrer"
          className="mt-4 flex items-center gap-2 rounded-lg border border-verified/30 bg-verified/5 px-3 py-2.5 text-sm text-verified"
        >
          <ShieldCheck size={15} />
          Talep #{created.requestId} açıldı — onay bekliyor
          <ArrowUpRight size={13} className="ml-auto" />
        </a>
      )}

      {error && (
        <p className="mt-4 rounded-lg border border-signal/30 bg-signal/5 px-3 py-2.5 text-xs text-signal">
          {error}
        </p>
      )}
    </section>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs text-muted">{label}</span>
      {children}
    </label>
  );
}
