'use client';

import { useEffect, useState, useCallback } from 'react';
import { ArrowUpRight, Loader2, ShieldCheck } from 'lucide-react';
import { signer } from '../lib/wallet.js';
import {
  deposit,
  readEscrow,
  fromStroops,
  explorerTx,
  CONTRACT_ID,
  explorerContract,
} from '../lib/soroban.js';
import { usdcPosition, openUsdcTrustline } from '../lib/stellar-account.js';
import { TestnetHint } from './WalletButton.jsx';

export default function DonorPanel({ wallet, issuer }) {
  const [escrow, setEscrow] = useState(null);
  const [position, setPosition] = useState(null);
  const [amount, setAmount] = useState('5');
  const [busy, setBusy] = useState(false);
  const [lastTx, setLastTx] = useState(null); // { hash, label }
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      setEscrow(await readEscrow());
      if (wallet && issuer) setPosition(await usdcPosition(wallet.address, issuer));
    } catch (e) {
      setError(e.message);
    }
  }, [wallet, issuer]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleTrustline() {
    setBusy(true);
    setError(null);
    try {
      const hash = await openUsdcTrustline({
        publicKey: wallet.address,
        signTransaction: signer(wallet.address),
        issuer,
      });
      setLastTx({ hash, label: 'USDC trustline açıldı' });
      await refresh();
    } catch (e) {
      setError(trustlineHint(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleDonate() {
    setBusy(true);
    setError(null);
    try {
      const hash = await deposit({
        publicKey: wallet.address,
        signTransaction: signer(wallet.address),
        amount,
      });
      setLastTx({ hash, label: 'Bağış zincire yazıldı' });
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const noTrustline = position && !position.trustline;
  const insufficient =
    position && Number(position.balance) < Number(amount || 0);

  return (
    <section className="rounded-2xl border border-edge bg-surface p-6">
      <header className="mb-5 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Bağış yap</h2>
        <a
          href={explorerContract(CONTRACT_ID)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-mono text-xs text-muted hover:text-white"
        >
          escrow <ArrowUpRight size={12} />
        </a>
      </header>

      <div className="mb-4 grid grid-cols-2 gap-3">
        <Stat label="Escrow bakiyesi" value={escrow ? fromStroops(escrow.balance) : '—'} unit="USDC" accent />
        <Stat label="Ödenen" value={escrow ? fromStroops(escrow.campaign.disbursed) : '—'} unit="USDC" />
      </div>

      {escrow?.vault && <VaultLine escrow={escrow} />}

      {!wallet ? (
        <>
          <p className="text-sm text-muted">
            Bağış yapmak için cüzdanınızı bağlayın. Fon merkezi bir havuzda değil,
            2/3 çoklu imzayla korunan escrow contract'ında durur.
          </p>
          <TestnetHint />
        </>
      ) : (
        <>
          <div className="mb-4 flex items-baseline justify-between text-sm">
            <span className="text-muted">Cüzdanınızdaki USDC</span>
            <span className="font-mono">{position ? position.balance : '…'}</span>
          </div>

          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                type="number"
                min="0"
                step="0.1"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full rounded-lg border border-edge bg-ink px-3 py-2.5 pr-16 font-mono text-sm outline-none focus:border-signal"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">
                USDC
              </span>
            </div>
            <button
              onClick={handleDonate}
              disabled={busy || noTrustline || insufficient || !(Number(amount) > 0)}
              className="inline-flex items-center gap-2 rounded-lg bg-signal px-5 py-2.5 text-sm font-semibold text-ink transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy && <Loader2 size={15} className="animate-spin" />}
              {busy ? 'İmzalanıyor…' : 'Bağışla'}
            </button>
          </div>

          {noTrustline && (
            <div className="mt-3 rounded-lg border border-signal/30 bg-signal/5 p-3">
              <p className="text-xs text-signal">
                Bu cüzdan USDC tutamıyor — trustline yok. Anchor'dan gelen bir
                deposit de bu yüzden <span className="font-mono">pending_trust</span>'ta
                beklerdi.
              </p>
              <button
                onClick={handleTrustline}
                disabled={busy}
                className="mt-2.5 inline-flex items-center gap-2 rounded-lg border border-signal/50 px-3 py-1.5 text-xs font-semibold text-signal transition hover:bg-signal/10 disabled:opacity-40"
              >
                {busy && <Loader2 size={12} className="animate-spin" />}
                USDC trustline aç
              </button>
            </div>
          )}
          {insufficient && !noTrustline && (
            <p className="mt-3 text-xs text-signal">Cüzdan bakiyesi yetersiz.</p>
          )}
        </>
      )}

      {lastTx && (
        <a
          href={explorerTx(lastTx.hash)}
          target="_blank"
          rel="noreferrer"
          className="mt-4 flex items-center gap-2 rounded-lg border border-verified/30 bg-verified/5 px-3 py-2.5 text-sm text-verified"
        >
          <ShieldCheck size={15} />
          {lastTx.label}
          <span className="ml-auto font-mono text-xs">{lastTx.hash.slice(0, 10)}…</span>
          <ArrowUpRight size={13} />
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

/**
 * Fon vault'taysa tek satırda söyle: bakiye artık token bakiyesi değil,
 * elde tutulan payın karşılığı.
 *
 * Getiri testnet'te 0 — o SAC için strateji yok. Bunu gizlemiyoruz; satır
 * "0.0000000" gösterecek. Dürüst olan bu, ve mainnet'te aynı satır dolacak.
 */
function VaultLine({ escrow }) {
  const principal = BigInt(escrow.campaign.principal ?? 0);
  const disbursed = BigInt(escrow.campaign.disbursed ?? 0);
  const yieldStroops = BigInt(escrow.balance ?? 0) - (principal - disbursed);

  return (
    <div className="mb-6 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-xl border border-edge bg-ink px-4 py-3 text-xs">
      <span className="text-muted">
        DeFindex vault'unda ·{' '}
        <a
          href={explorerContract(escrow.vault)}
          target="_blank"
          rel="noreferrer"
          className="font-mono hover:text-white"
        >
          {escrow.vault.slice(0, 6)}…{escrow.vault.slice(-4)}
        </a>
      </span>
      <span className="font-mono text-muted">
        {fromStroops(escrow.campaign.shares)} pay · getiri{' '}
        <span className={yieldStroops > 0n ? 'text-verified' : ''}>
          {fromStroops(yieldStroops)}
        </span>{' '}
        USDC
      </span>
    </div>
  );
}

/** Trustline için 0.5 XLM rezerv gerekir — Horizon'un hatası okunaksız. */
function trustlineHint(e) {
  const code = e?.response?.data?.extras?.result_codes?.transaction;
  if (code === 'tx_insufficient_balance') {
    return 'XLM yetersiz — trustline başına 0.5 XLM rezerv gerekiyor.';
  }
  return e.message;
}

function Stat({ label, value, unit, accent }) {
  return (
    <div className="rounded-xl border border-edge bg-ink p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 font-mono text-xl">
        <span className={accent ? 'text-verified' : ''}>{value}</span>
        <span className="ml-1.5 text-xs text-muted">{unit}</span>
      </div>
    </div>
  );
}
