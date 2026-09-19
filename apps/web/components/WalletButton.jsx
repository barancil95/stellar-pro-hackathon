'use client';

import { useEffect, useState } from 'react';
import { Wallet, LogOut, AlertTriangle, FlaskConical, ChevronDown } from 'lucide-react';
import { connect, shorten, loadDemoAccounts, demoSigner } from '../lib/wallet.js';
import { resetClientCache } from '../lib/soroban.js';

export default function WalletButton({ wallet, onChange }) {
  const [demoAccounts, setDemoAccounts] = useState([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    loadDemoAccounts().then(setDemoAccounts);
  }, []);

  async function handleConnect() {
    try {
      resetClientCache();
      onChange(await connect());
    } catch (e) {
      if (!/iptal/.test(e.message)) onChange(null, e.message);
    }
  }

  function pickDemo(account) {
    resetClientCache();
    setOpen(false);
    onChange({
      address: account.address,
      walletId: 'demo',
      walletName: account.label,
      sign: demoSigner(account.secret),
      isDemo: true,
    });
  }

  if (wallet) {
    return (
      <div className="flex items-center gap-2">
        <div className="rounded-lg border border-edge bg-surface px-3 py-2 text-sm">
          <span className={wallet.isDemo ? 'text-signal' : 'text-muted'}>
            {wallet.walletName}
          </span>
          <span className="mx-2 text-edge">|</span>
          <span className="font-mono">{shorten(wallet.address)}</span>
        </div>
        {demoAccounts.length > 0 && (
          <DemoPicker
            accounts={demoAccounts}
            current={wallet.address}
            open={open}
            setOpen={setOpen}
            onPick={pickDemo}
            compact
          />
        )}
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

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleConnect}
        className="inline-flex items-center gap-2 rounded-lg bg-signal px-4 py-2.5 text-sm font-semibold text-ink transition hover:brightness-110"
      >
        <Wallet size={16} />
        Cüzdan bağla
      </button>
      {demoAccounts.length > 0 && (
        <DemoPicker
          accounts={demoAccounts}
          open={open}
          setOpen={setOpen}
          onPick={pickDemo}
        />
      )}
    </div>
  );
}

/**
 * Eklenti gerektirmeyen demo yolu. Yalnızca sunucuda DEMO_MODE=true iken
 * hesap listesi geldiği için üretimde bu düğme hiç görünmez.
 */
function DemoPicker({ accounts, current, open, setOpen, onPick, compact }) {
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-signal/40 px-3 py-2.5 text-sm text-signal transition hover:bg-signal/10"
        title="Eklenti olmadan testnet hesabı seç"
      >
        <FlaskConical size={15} />
        {!compact && 'Demo hesap'}
        <ChevronDown size={13} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-xl border border-edge bg-surface shadow-xl">
            <p className="border-b border-edge px-3 py-2 text-xs text-muted">
              Testnet demo — eklenti gerekmez
            </p>
            {accounts.map((a) => (
              <button
                key={a.id}
                onClick={() => onPick(a)}
                className={`flex w-full flex-col items-start px-3 py-2.5 text-left transition hover:bg-ink ${
                  a.address === current ? 'bg-ink' : ''
                }`}
              >
                <span className="text-sm">
                  {a.label}
                  {a.address === current && (
                    <span className="ml-2 text-xs text-verified">bağlı</span>
                  )}
                </span>
                <span className="font-mono text-[10px] text-muted">
                  {shorten(a.address, 5)}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function TestnetHint() {
  return (
    <p className="mt-3 flex items-start gap-2 text-xs text-muted">
      <AlertTriangle size={14} className="mt-px shrink-0 text-signal" />
      Cüzdan eklentisi yoksa <b className="text-signal">Demo hesap</b> ile devam
      edebilirsiniz — Freighter kullanacaksanız Testnet'e almayı unutmayın.
    </p>
  );
}
