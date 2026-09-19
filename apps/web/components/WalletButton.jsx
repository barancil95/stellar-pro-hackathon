'use client';

import { Wallet, LogOut, AlertTriangle } from 'lucide-react';
import { connect, shorten } from '../lib/wallet.js';
import { resetClientCache } from '../lib/soroban.js';

export default function WalletButton({ wallet, onChange }) {
  async function handleConnect() {
    try {
      resetClientCache();
      onChange(await connect());
    } catch (e) {
      if (!/iptal/.test(e.message)) onChange(null, e.message);
    }
  }

  if (!wallet) {
    return (
      <button
        onClick={handleConnect}
        className="inline-flex items-center gap-2 rounded-lg bg-signal px-4 py-2.5 text-sm font-semibold text-ink transition hover:brightness-110"
      >
        <Wallet size={16} />
        Cüzdan bağla
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <div className="rounded-lg border border-edge bg-surface px-3 py-2 text-sm">
        <span className="text-muted">{wallet.walletName}</span>
        <span className="mx-2 text-edge">|</span>
        <span className="font-mono">{shorten(wallet.address)}</span>
      </div>
      <button
        onClick={() => {
          resetClientCache();
          onChange(null);
        }}
        title="Bağlantıyı kes"
        className="rounded-lg border border-edge p-2.5 text-muted transition hover:text-white"
      >
        <LogOut size={16} />
      </button>
    </div>
  );
}

export function TestnetHint() {
  return (
    <p className="mt-3 flex items-start gap-2 text-xs text-muted">
      <AlertTriangle size={14} className="mt-px shrink-0 text-signal" />
      Freighter varsayılan olarak Mainnet açılır. Cüzdanınızı <b>Testnet</b>'e alın.
    </p>
  );
}
