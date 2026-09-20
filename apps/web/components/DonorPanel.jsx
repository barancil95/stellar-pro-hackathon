'use client';

import { useEffect, useState, useCallback } from 'react';
import { ArrowUpRight, Check, Circle, Landmark, Loader2, ShieldCheck } from 'lucide-react';
import {
  deposit,
  readEscrow,
  fromStroops,
  explorerTx,
  CONTRACT_ID,
  explorerContract,
} from '../lib/soroban.js';
import { usdcPosition, openUsdcTrustline } from '../lib/stellar-account.js';
import { indicativePrice, assetIds } from '../lib/anchor.js';
import { startOnramp, settleOnramp } from '../lib/onramp.js';
import { TestnetHint } from './WalletButton.jsx';

/** The steps of a TRY donation — ticked off in order on screen. */
const ONRAMP_STEPS = [
  ['auth', 'Anchor identity — SEP-10, signed with your wallet'],
  ['kyc', 'KYC — SEP-12'],
  ['deposit', 'Transfer instructions — SEP-6 deposit'],
  ['bank', 'Bank transfer — sandbox simulation'],
  ['settle', 'USDC arrived in your wallet'],
  ['escrow', 'Deposited into the escrow'],
];

export default function DonorPanel({ wallet, issuer }) {
  const [escrow, setEscrow] = useState(null);
  const [position, setPosition] = useState(null);
  const [mode, setMode] = useState('try'); // 'try' | 'usdc'
  const [amount, setAmount] = useState('5');
  const [tryAmount, setTryAmount] = useState('250');
  const [quote, setQuote] = useState(null);
  const [onramp, setOnramp] = useState(null); // { step, session, deposit, status }
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
        signTransaction: wallet.sign,
        issuer,
      });
      setLastTx({ hash, label: 'USDC trustline opened' });
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
        signTransaction: wallet.sign,
        amount,
      });
      setLastTx({ hash, label: 'Donation written on-chain' });
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // Indicative rate — how much USDC the TRY is worth. The anchor sets the exact
  // amount at deposit time.
  useEffect(() => {
    let alive = true;
    if (!(Number(tryAmount) > 0)) return setQuote(null);
    const timer = setTimeout(async () => {
      try {
        const ids = await assetIds();
        const price = await indicativePrice({
          sellAsset: ids.try,
          buyAsset: ids.usdc,
          sellAmount: tryAmount,
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

  // If the wallet changes, a half-finished on-ramp must not continue on someone
  // else's session.
  useEffect(() => setOnramp(null), [wallet?.address]);

  const onStep = (step) => setOnramp((o) => ({ ...o, step }));

  /** Stage 1: get the transfer instructions from the anchor. */
  async function handleStartOnramp() {
    setBusy(true);
    setError(null);
    setLastTx(null);
    setOnramp({ step: 'auth' });
    try {
      const { session, deposit: dep } = await startOnramp({ wallet, tryAmount, onStep });
      setOnramp({ step: 'bank', awaitingTransfer: true, session, deposit: dep, tryAmount });
    } catch (e) {
      setOnramp(null);
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  /** Stage 2: transfer → USDC in the wallet → into the escrow. */
  async function handleSettleOnramp() {
    const { session, deposit: dep, tryAmount: paid, simulated } = onramp;
    setBusy(true);
    setError(null);
    setOnramp((o) => ({ ...o, awaitingTransfer: false, simulated: true, retry: false }));
    let usdc = null;
    try {
      const settled = await settleOnramp({
        session,
        deposit: dep,
        tryAmount: paid,
        simulated,
        onStep,
        onStatus: (tx) => setOnramp((o) => ({ ...o, status: tx.status })),
      });
      usdc = settled.amount_out;
      setOnramp((o) => ({ ...o, step: 'escrow', usdc, onrampTx: settled.stellar_transaction_id }));
      await refresh();

      const hash = await deposit({
        publicKey: wallet.address,
        signTransaction: wallet.sign,
        amount: usdc,
      });
      setOnramp((o) => ({ ...o, step: 'done' }));
      setLastTx({ hash, label: `${paid} TRY → ${usdc} USDC in the escrow` });
      await refresh();
    } catch (e) {
      // If the transfer went out but the anchor has not paid the USDC yet, the job
      // is not half-done, only pending: the same deposit can be polled again.
      setOnramp((o) => ({ ...o, retry: !usdc }));
      setError(
        usdc
          ? `${usdc} USDC arrived in your wallet but could not be deposited into the escrow: ${e.message}. You can deposit it from the "With USDC" tab.`
          : e.message,
      );
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
        <h2 className="text-lg font-semibold">Make a donation</h2>
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
        <Stat label="Escrow balance" value={escrow ? fromStroops(escrow.balance) : '—'} unit="USDC" accent />
        <Stat label="Disbursed" value={escrow ? fromStroops(escrow.campaign.disbursed) : '—'} unit="USDC" />
      </div>

      {escrow?.vault && <VaultLine escrow={escrow} />}

      {!wallet ? (
        <>
          <p className="text-sm text-muted">
            Connect your wallet to donate. The funds are not in a central pool but in
            an escrow contract protected by a 2-of-3 multisig.
          </p>
          <TestnetHint />
        </>
      ) : (
        <>
          <div className="mb-4 flex items-baseline justify-between text-sm">
            <span className="text-muted">USDC in your wallet</span>
            <span className="font-mono">{position ? position.balance : '…'}</span>
          </div>

          <div className="mb-4 grid grid-cols-2 gap-1 rounded-lg border border-edge bg-ink p-1 text-sm">
            {[
              ['try', 'With TRY'],
              ['usdc', 'With USDC'],
            ].map(([id, label]) => (
              <button
                key={id}
                onClick={() => setMode(id)}
                disabled={busy}
                className={`rounded-md py-1.5 transition ${
                  mode === id ? 'bg-surface font-semibold text-white' : 'text-muted hover:text-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {mode === 'try' ? (
            <TryDonation
              tryAmount={tryAmount}
              setTryAmount={setTryAmount}
              quote={quote}
              onramp={onramp}
              busy={busy}
              disabled={noTrustline}
              onStart={handleStartOnramp}
              onSettle={handleSettleOnramp}
              onReset={() => setOnramp(null)}
            />
          ) : (
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
                {busy ? 'Signing…' : 'Donate'}
              </button>
            </div>
          )}

          {noTrustline && (
            <div className="mt-3 rounded-lg border border-signal/30 bg-signal/5 p-3">
              <p className="text-xs text-signal">
                This wallet cannot hold USDC — there is no trustline. A deposit from
                the anchor would wait in{' '}
                <span className="font-mono">pending_trust</span> for the same reason.
              </p>
              <button
                onClick={handleTrustline}
                disabled={busy}
                className="mt-2.5 inline-flex items-center gap-2 rounded-lg border border-signal/50 px-3 py-1.5 text-xs font-semibold text-signal transition hover:bg-signal/10 disabled:opacity-40"
              >
                {busy && <Loader2 size={12} className="animate-spin" />}
                Open a USDC trustline
              </button>
            </div>
          )}
          {mode === 'usdc' && insufficient && !noTrustline && (
            <p className="mt-3 text-xs text-signal">Insufficient wallet balance.</p>
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
 * Donating in TRY: the anchor takes the TRY, sends the USDC to the donor's wallet,
 * and from there it is deposited into the escrow. The transfer instructions are
 * shown on screen — in real life the donor makes that transfer at their bank; in
 * the sandbox a button simulates it.
 */
function TryDonation({
  tryAmount,
  setTryAmount,
  quote,
  onramp,
  busy,
  disabled,
  onStart,
  onSettle,
  onReset,
}) {
  const active = Boolean(onramp);
  const instr = onramp?.deposit?.instructions;

  return (
    <div>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            type="number"
            min="0"
            step="10"
            value={tryAmount}
            disabled={active && onramp.step !== 'done'}
            onChange={(e) => setTryAmount(e.target.value)}
            className="w-full rounded-lg border border-edge bg-ink px-3 py-2.5 pr-12 font-mono text-sm outline-none focus:border-signal disabled:opacity-60"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">
            TRY
          </span>
        </div>
        <button
          onClick={onStart}
          disabled={busy || disabled || (active && onramp.step !== 'done') || !(Number(tryAmount) > 0)}
          className="inline-flex items-center gap-2 rounded-lg bg-signal px-5 py-2.5 text-sm font-semibold text-ink transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy && !onramp?.awaitingTransfer && onramp?.step !== 'done' && (
            <Loader2 size={15} className="animate-spin" />
          )}
          Donate in TRY
        </button>
      </div>

      <p className="mt-2 text-xs text-muted">
        {quote ? (
          <>
            ≈ <span className="font-mono text-white">{Number(quote.buy_amount).toFixed(2)}</span> USDC
            · rate {Number(quote.price).toFixed(2)} · anchor fee included
            {quote.fee?.total ? ` (${quote.fee.total} TRY)` : ''}
          </>
        ) : (
          'Loading rate…'
        )}
      </p>

      {active && (
        <ol className="mt-4 space-y-1.5 rounded-xl border border-edge bg-ink p-4 text-xs">
          {ONRAMP_STEPS.map(([id, label]) => {
            const state = stepState(id, onramp);
            return (
              <li key={id} className="flex items-center gap-2">
                {state === 'done' ? (
                  <Check size={13} className="text-verified" />
                ) : state === 'active' ? (
                  <Loader2 size={13} className="animate-spin text-signal" />
                ) : (
                  <Circle size={13} className="text-edge" />
                )}
                <span className={state === 'pending' ? 'text-muted' : ''}>{label}</span>
                {id === 'settle' && state === 'active' && onramp.status && (
                  <span className="ml-auto font-mono text-muted">{onramp.status}</span>
                )}
                {id === 'settle' && onramp.usdc && (
                  <span className="ml-auto font-mono text-verified">{onramp.usdc} USDC</span>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {onramp?.awaitingTransfer && (
        <div className="mt-3 rounded-xl border border-signal/30 bg-signal/5 p-4 text-xs">
          <p className="mb-2 flex items-center gap-1.5 font-semibold text-signal">
            <Landmark size={13} /> Transfer instructions — from the anchor
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted">Bank</dt>
            <dd>{instr?.bank_name?.value ?? '—'}</dd>
            <dt className="text-muted">IBAN</dt>
            <dd className="font-mono">{instr?.bank_account_number?.value ?? '—'}</dd>
            <dt className="text-muted">Reference</dt>
            <dd className="font-mono">{instr?.external_transfer_memo?.value ?? '—'}</dd>
            <dt className="text-muted">Amount</dt>
            <dd className="font-mono">{onramp.tryAmount} TRY</dd>
          </dl>
          <button
            onClick={onSettle}
            disabled={busy}
            className="mt-3 inline-flex items-center gap-2 rounded-lg bg-signal px-4 py-2 text-xs font-semibold text-ink transition hover:brightness-110 disabled:opacity-40"
          >
            Send the transfer (sandbox)
          </button>
          <p className="mt-2 text-muted">
            With a real anchor this step is your bank. On the mock anchor the button simulates the transfer.
          </p>
        </div>
      )}

      {onramp?.retry && (
        <div className="mt-3 rounded-xl border border-edge bg-ink p-4 text-xs">
          <p className="text-muted">
            The transfer arrived, the anchor has not sent the USDC yet
            {onramp.status ? ` (${onramp.status})` : ''}. The wait is on the anchor's
            side; the transfer is not repeated, only the status is polled again.
          </p>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              onClick={onSettle}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-lg border border-signal/50 px-3 py-1.5 font-semibold text-signal transition hover:bg-signal/10 disabled:opacity-40"
            >
              {busy && <Loader2 size={12} className="animate-spin" />}
              Check the status again
            </button>
            <button onClick={onReset} disabled={busy} className="text-muted hover:text-white">
              cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The state of a row in the step list: done, in progress, pending. */
function stepState(id, onramp) {
  const order = ONRAMP_STEPS.map(([s]) => s);
  if (onramp.step === 'done') return 'done';
  const current = order.indexOf(onramp.step);
  const mine = order.indexOf(id);
  if (mine < current) return 'done';
  if (mine > current) return 'pending';
  // A spinning icon while waiting on the user or the anchor would suggest "working".
  return onramp.awaitingTransfer || onramp.retry ? 'pending' : 'active';
}

/**
 * If the funds are in the vault, say so in one line: the balance is no longer a
 * token balance but the value of the shares held.
 *
 * Yield is 0 on testnet — there is no strategy for that SAC. We do not hide it; the
 * line will read "0.0000000". That is the honest thing, and on mainnet the same
 * line fills up.
 */
function VaultLine({ escrow }) {
  const principal = BigInt(escrow.campaign.principal ?? 0);
  const disbursed = BigInt(escrow.campaign.disbursed ?? 0);
  const yieldStroops = BigInt(escrow.balance ?? 0) - (principal - disbursed);

  return (
    <div className="mb-6 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-xl border border-edge bg-ink px-4 py-3 text-xs">
      <span className="text-muted">
        In the DeFindex vault ·{' '}
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
        {fromStroops(escrow.campaign.shares)} shares · yield{' '}
        <span className={yieldStroops > 0n ? 'text-verified' : ''}>
          {fromStroops(yieldStroops)}
        </span>{' '}
        USDC
      </span>
    </div>
  );
}

/** A trustline needs a 0.5 XLM reserve — Horizon's own error is unreadable. */
function trustlineHint(e) {
  const code = e?.response?.data?.extras?.result_codes?.transaction;
  if (code === 'tx_insufficient_balance') {
    return 'Not enough XLM — each trustline needs a 0.5 XLM reserve.';
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
