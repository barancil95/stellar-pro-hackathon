'use client';

import { useEffect, useState } from 'react';
import { Activity } from 'lucide-react';
import WalletButton from '../components/WalletButton.jsx';
import DonorPanel from '../components/DonorPanel.jsx';
import { health } from '../lib/anchor.js';

export default function Home() {
  const [wallet, setWallet] = useState(null);
  const [anchor, setAnchor] = useState(null);

  // Issuer ve kurlar hardcode edilmez — /health'ten okunur.
  useEffect(() => {
    health().then(setAnchor).catch(() => {});
  }, []);

  return (
    <main className="mx-auto min-h-screen max-w-5xl px-4 py-8 sm:px-6">
      <nav className="mb-16 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <Activity size={20} className="text-signal" />
          <span className="font-semibold tracking-tight">Proof-of-Action</span>
        </div>
        <WalletButton wallet={wallet} onChange={(w) => setWallet(w)} />
      </nav>

      <header className="mb-14 max-w-2xl">
        <h1 className="text-4xl font-bold leading-[1.1] tracking-tight sm:text-5xl">
          Aid should move at the
          <span className="text-signal"> speed of crisis.</span>
        </h1>
        <p className="mt-5 text-base leading-relaxed text-muted">
          Bağışlar merkezi bir havuzda beklemez. Sahadaki doğrulanmış aktör ihtiyaç
          kanıtıyla talep açar, koordinatörlerden <b className="text-white">2/3 onay</b> gelince
          fon zincirden çıkar ve tedarikçinin IBAN'ına TRY olarak ulaşır.
          Her adım zincirde izlenebilir.
        </p>
      </header>

      <div className="grid gap-5 lg:grid-cols-2">
        <DonorPanel wallet={wallet} issuer={anchor?.asset?.issuer} />

        <section className="rounded-2xl border border-edge bg-surface p-6">
          <h2 className="mb-5 text-lg font-semibold">Fiat rail</h2>
          {anchor ? (
            <dl className="space-y-3 text-sm">
              <Row label="Anchor" value={anchor.service} />
              <Row label="Kur (USDC/TRY)" value={anchor.rates.sell_rate} />
              <Row label="Spread" value={`${anchor.rates.spread_bps} bps`} />
              <Row
                label="Treasury"
                value={anchor.treasury.low_balance ? 'düşük — on-ramp bekler' : 'hazır'}
                ok={!anchor.treasury.low_balance}
              />
            </dl>
          ) : (
            <p className="text-sm text-muted">Anchor okunuyor…</p>
          )}
          <p className="mt-5 border-t border-edge pt-5 text-xs leading-relaxed text-muted">
            Zincir üstü kısım güven gerektirmiyor — onay yetkisi 2/3 multisig'te.
            Custody yalnızca fiat rail'in son metresinde, ve o metre zaten bankanın.
          </p>
        </section>
      </div>

      <p className="mt-10 text-xs text-muted">
        Stellar Testnet · Soroban · TR Mock Anchor (SEP-1/10/12/38/6)
      </p>
    </main>
  );
}

function Row({ label, value, ok }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className={`font-mono text-right ${ok ? 'text-verified' : ''}`}>{value}</dd>
    </div>
  );
}
