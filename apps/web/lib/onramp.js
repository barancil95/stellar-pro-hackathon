/**
 * TRY → USDC on-ramp, into the donor's OWN wallet — runs in the browser.
 *
 * The donor pays TRY, the anchor sends the USDC straight to the donor's address,
 * and from there it is deposited into the escrow. The USDC passes through no
 * intermediate account; the SEP-10 identity is signed with the donor's wallet too
 * (no relayer here).
 *
 * The anchor's CORS is open (`*`), so no server route is needed.
 *
 * Two stages, because in real life the donor's bank sits in between:
 *   1. startOnramp   — SEP-10 → SEP-12 → SEP-6 deposit → transfer instructions
 *   2. settleOnramp  — the transfer (simulated in the sandbox) → USDC in the
 *                      wallet, `completed`
 */

import * as anchor from './anchor.js';

/**
 * @param wallet  `{ address, sign }` — the object WalletButton hands over
 * @param tryAmount  string, 2 decimals
 * @returns { session, deposit } — deposit.instructions carries the bank instructions
 */
export async function startOnramp({ wallet, tryAmount, onStep }) {
  await anchor.assertOnrampAmount(tryAmount);

  const session = anchor.makeSession({
    publicKey: wallet.address,
    signTransaction: wallet.sign,
  });

  onStep?.('auth');
  await session.token();

  // KYC does not become ACCEPTED on its own; at least one PUT is required.
  onStep?.('kyc');
  await session.call((t) => anchor.putCustomer(t, {}));

  onStep?.('deposit');
  const deposit = await session.call((t) =>
    anchor.deposit(t, { account: wallet.address, amount: tryAmount }),
  );
  return { session, deposit };
}

/**
 * Simulates the bank transfer in the sandbox and waits until the USDC lands in the
 * wallet. With a real anchor this step is the donor's bank; we would only wait.
 *
 * Called with `simulated: true` the transfer is not repeated, only awaited — so
 * that if the anchor stalls in `pending_anchor` and the wait times out, the same
 * deposit can be polled again. A second transfer would mean a second TRY payment.
 */
export async function settleOnramp({
  session,
  deposit,
  tryAmount,
  simulated = false,
  onStep,
  onStatus,
}) {
  if (!simulated) {
    onStep?.('bank');
    await anchor.simulateBankTransfer(deposit.id, tryAmount);
  }

  onStep?.('settle');
  const settled = await anchor.pollTransaction(session, deposit.id, {
    intervalMs: 3000,
    timeoutMs: 120000,
    onUpdate: onStatus,
  });

  if (settled.status !== 'completed') {
    throw new Error(
      `On-ramp ended as ${settled.status}${settled.message ? `: ${settled.message}` : ''}`,
    );
  }
  return settled;
}
