'use client';

/**
 * Cüzdan teşhis sayfası — /debug
 *
 * "Not available" gördüğünüzde tarayıcının gerçekte ne gördüğünü söyler.
 * Demo sırasında bir şey kırılırsa da ilk bakılacak yer burası.
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
        // Freighter eklentisi content script'i bu globali enjekte eder.
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
      <h1 className="mb-6 text-xl font-bold">Cüzdan teşhisi</h1>

      <h2 className="mb-2 text-muted">Ortam</h2>
      <pre className="mb-8 overflow-x-auto rounded-lg border border-edge bg-surface p-4 text-xs">
        {env ? JSON.stringify(env, null, 2) : 'okunuyor…'}
      </pre>

      <h2 className="mb-2 text-muted">Wallets Kit modülleri</h2>
      {!rows ? (
        <p className="text-muted">okunuyor…</p>
      ) : rows.error ? (
        <pre className="rounded-lg border border-signal/40 bg-signal/5 p-4 text-signal">
          {rows.error}
        </pre>
      ) : (
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-edge text-left text-muted">
              <th className="py-2">Cüzdan</th>
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
        <p className="mb-2 font-bold text-white">Nasıl okunur</p>
        <p>
          <code className="text-white">freighterApiGlobal: &quot;undefined&quot;</code> →
          eklenti bu sayfaya hiç enjekte olmamış. Sayfa, eklenti kurulmadan önce
          açıldıysa sert yenileme (⌘⇧R) gerekir; hâlâ undefined ise eklenti bu
          tarayıcıda/profilde kurulu değildir.
        </p>
        <p className="mt-2">
          <code className="text-white">available: true</code> olan her cüzdan
          bağlanabilir. Hepsi false ise sorun eklentide, uygulamada değil.
        </p>
      </div>
    </main>
  );
}
