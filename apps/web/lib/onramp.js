/**
 * TL → USDC on-ramp, bağışçının KENDİ cüzdanına — tarayıcıda çalışır.
 *
 * Bağışçı TL öder, anchor USDC'yi doğrudan bağışçının adresine gönderir, oradan
 * escrow'a yatırılır. USDC hiçbir ara hesaptan geçmez; SEP-10 kimliği de
 * bağışçının cüzdanıyla imzalanır (relayer burada yok).
 *
 * Anchor'ın CORS'u açık (`*`), o yüzden sunucu route'u gerekmiyor.
 *
 * İki aşama, çünkü arada gerçek hayatta bağışçının bankası var:
 *   1. startOnramp   — SEP-10 → SEP-12 → SEP-6 deposit → havale talimatı
 *   2. settleOnramp  — havale (sandbox'ta simüle) → USDC cüzdanda `completed`
 */

import * as anchor from './anchor.js';

/**
 * @param wallet  `{ address, sign }` — WalletButton'un verdiği nesne
 * @param tryAmount  string, 2 ondalık
 * @returns { session, deposit } — deposit.instructions banka talimatını taşır
 */
export async function startOnramp({ wallet, tryAmount, onStep }) {
  await anchor.assertOnrampAmount(tryAmount);

  const session = anchor.makeSession({
    publicKey: wallet.address,
    signTransaction: wallet.sign,
  });

  onStep?.('auth');
  await session.token();

  // KYC kendiliğinden ACCEPTED olmuyor; en az bir PUT gerekiyor.
  onStep?.('kyc');
  await session.call((t) => anchor.putCustomer(t, {}));

  onStep?.('deposit');
  const deposit = await session.call((t) =>
    anchor.deposit(t, { account: wallet.address, amount: tryAmount }),
  );
  return { session, deposit };
}

/**
 * Sandbox'ta banka havalesini simüle eder ve USDC cüzdana düşene kadar bekler.
 * Gerçek bir anchor'da bu adım bağışçının bankasıdır; biz yalnızca beklerdik.
 *
 * `simulated: true` ile çağrılırsa havale tekrarlanmaz, yalnızca beklenir —
 * anchor `pending_anchor`'da takılıp bekleme zaman aşımına uğrarsa aynı deposit
 * üzerinden yeniden sorulabilsin diye. İkinci bir havale ikinci bir TL demek
 * olurdu.
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
      `On-ramp ${settled.status} ile bitti${settled.message ? `: ${settled.message}` : ''}`,
    );
  }
  return settled;
}
