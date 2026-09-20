'use client';

/**
 * Wallet diagnostics page — /debug
 *
 * When you see "Not available", this tells you what the browser actually sees.
 * It is also the first place to look if something breaks during the demo.
 */

import { useEffect, useState } from 'react';
import { getKit } from '../../lib/wallet.js';

export default function Debug() {
  const [rows, setRows] = useState(null);
  const [env, setEnv] = useState(null);

  useEffect(() => {
    (async () => {
      setEnv({
        userAgent: navigator.userAgent,
        origin: window.location.origin,
        secure: window.isSecureContext,
        // The Freighter extension's content script injects this global.
        freighterApiGlobal: typeof window.freighterApi,
        freighterGlobal: typeof window.freighter,
      });

      try {
        const kit = getKit();
        const mods = kit.getSupportedWallets
          ? await kit.getSupportedWallets()
          : await kit.getSupportedModules?.();
        setRows(mods ?? []);
      } catch (e) {
        setRows({ error: e.message });
      }
    })();
  }, []);

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-10 font-mono text-sm">
      <h1 className="mb-6 text-xl font-bold">Wallet diagnostics</h1>

      <h2 className="mb-2 text-muted">Environment</h2>
      <pre className="mb-8 overflow-x-auto rounded-lg border border-edge bg-surface p-4 text-xs">
        {env ? JSON.stringify(env, null, 2) : 'loading…'}
      </pre>

      <h2 className="mb-2 text-muted">Wallets Kit modules</h2>
      {!rows ? (
        <p className="text-muted">loading…</p>
      ) : rows.error ? (
        <pre className="rounded-lg border border-signal/40 bg-signal/5 p-4 text-signal">
          {rows.error}
        </pre>
      ) : (
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-edge text-left text-muted">
              <th className="py-2">Wallet</th>
              <th>id</th>
              <th>available</th>
              <th>type</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((w) => (
              <tr key={w.id} className="border-b border-edge/50">
                <td className="py-2">{w.name}</td>
                <td className="text-muted">{w.id}</td>
                <td className={w.isAvailable ? 'text-verified' : 'text-signal'}>
                  {String(w.isAvailable)}
                </td>
                <td className="text-muted">{w.type ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="mt-8 rounded-lg border border-edge bg-surface p-4 text-xs leading-relaxed text-muted">
        <p className="mb-2 font-bold text-white">How to read this</p>
        <p>
          <code className="text-white">freighterApiGlobal: &quot;undefined&quot;</code> →
          the extension never injected into this page. If the page was opened before
          the extension was installed, a hard reload (⌘⇧R) is needed; if it is still
          undefined, the extension is not installed in this browser/profile.
        </p>
        <p className="mt-2">
          Every wallet with <code className="text-white">available: true</code> can
          connect. If they are all false, the problem is in the extension, not the app.
        </p>
      </div>
    </main>
  );
}
