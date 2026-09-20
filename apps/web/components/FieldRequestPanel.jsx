'use client';

// Buffer is not a global in the browser — imported explicitly.
import { Buffer } from 'buffer';

import { useEffect, useState } from 'react';
import { FileUp, Loader2, ShieldCheck, ArrowUpRight } from 'lucide-react';
import { createRequest, explorerTx, readEscrow, fromStroops } from '../lib/soroban.js';
import { hashEvidence, shortHash, formatBytes, EMPTY_PROOF_HEX } from '../lib/evidence.js';
import { indicativePrice, assetIds } from '../lib/anchor.js';

export default function FieldRequestPanel({ wallet, onCreated }) {
  const [need, setNeed] = useState('Generator fuel — 3 days');
  const [tryAmount, setTryAmount] = useState('1500');
  const [supplierName, setSupplierName] = useState('ABC Fuel Co.');
  const [iban, setIban] = useState('TR320010009999901234567890');
  const [evidence, setEvidence] = useState(null);
  const [quote, setQuote] = useState(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);
  const [error, setError] = useState(null);
  const [escrowBalance, setEscrowBalance] = useState(null);

  // If the request exceeds the escrow, the contract rejects it at payout time
  // (Error #9). We tell the user here instead of making them wait until then.
  useEffect(() => {
    readEscrow().then((e) => setEscrowBalance(fromStroops(e.balance))).catch(() => {});
  }, []);

  // An indicative quote at request time. The firm quote is fetched at payout time
  // (plan 5.5).
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
        signTransaction: wallet.sign,
        supplierRef: Buffer.from(supplier.supplierRef, 'hex'),
        amount: quote.sell_amount,
        // Proof is optional; without it the zero hash goes on-chain and the audit
        // trail reads "no proof attached".
        proofHash: Buffer.from(evidence?.hex ?? EMPTY_PROOF_HEX, 'hex'),
      });

      // The need description does not fit on-chain; stored so it shows in the audit trail.
      await fetch('/api/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: Number(requestId),
          need: need.trim(),
          supplierName: supplierName.trim(),
          // USDC went on-chain; this is the TRY the user saw. Since the rate is
          // repriced at payout time, the two are compared in the audit trail.
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

  const neededUsdc = quote ? Number(quote.sell_amount) : 0;
  const exceedsEscrow =
    escrowBalance !== null && quote && neededUsdc > Number(escrowBalance);
  const ready = wallet && quote && need.trim() && supplierName.trim();

  return (
    <section className="rounded-2xl border border-edge bg-surface p-6">
      <h2 className="mb-5 text-lg font-semibold">Open a field request</h2>

      {!wallet ? (
        <p className="text-sm text-muted">
          Connect your wallet to open a request.
        </p>
      ) : (
        <div className="space-y-4">
          <Field label="Need">
            <input
              value={need}
              onChange={(e) => setNeed(e.target.value)}
              className="input"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Amount (TRY)">
              <input
                type="number"
                value={tryAmount}
                onChange={(e) => setTryAmount(e.target.value)}
                className="input font-mono"
              />
            </Field>
            <Field label="Leaving the escrow">
              <div className="input flex items-center justify-between font-mono">
                <span className={exceedsEscrow ? 'text-signal' : 'text-verified'}>
                  {quote ? neededUsdc.toFixed(4) : '—'}
                </span>
                <span className="text-xs text-muted">USDC</span>
              </div>
            </Field>
          </div>

          <Field label="Supplier">
            <input
              value={supplierName}
              onChange={(e) => setSupplierName(e.target.value)}
              className="input"
            />
          </Field>

          <Field label="Supplier IBAN — never written on-chain, only its hash">
            <input
              value={iban}
              onChange={(e) => setIban(e.target.value)}
              className="input font-mono text-xs"
            />
          </Field>

          <Field label="Proof of need — optional">
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
                <span className="text-muted">Pick a photo, invoice or document</span>
              )}
              <input type="file" onChange={handleFile} className="hidden" />
            </label>
            {!evidence && (
              <p className="mt-1.5 text-xs text-muted">
                A request can be opened without proof — an actor who cannot produce a
                document in the field should not be blocked. The audit trail shows such
                a request as &quot;no proof attached&quot;.
              </p>
            )}
          </Field>

          {evidence?.previewUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={evidence.previewUrl}
              alt="proof preview"
              className="max-h-40 w-full rounded-lg border border-edge object-cover"
            />
          )}

          {escrowBalance !== null && (
            <p className={`text-xs ${exceedsEscrow ? 'text-signal' : 'text-muted'}`}>
              Escrow balance: <span className="font-mono">{escrowBalance} USDC</span>
              {exceedsEscrow && ' — the request exceeds it and will be rejected at the payout step. Donate first.'}
            </p>
          )}

          <button
            onClick={handleSubmit}
            disabled={!ready || busy}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-signal px-5 py-2.5 text-sm font-semibold text-ink transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy && <Loader2 size={15} className="animate-spin" />}
            {busy ? 'Signing…' : 'Write the request on-chain'}
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
          Request #{created.requestId} opened — awaiting approval
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
