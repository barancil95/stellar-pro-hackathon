/**
 * Relayer'ın fiat bacağı — SUNUCU TARAFI. Asla client'a import edilmez.
 *
 * Contract'ın keypair'i yok: SEP-10 challenge imzalayamaz, HTTP isteği atamaz.
 * `execute_payout` fonu relayer'a bırakır, buradan sonrası zincir dışıdır.
 *
 * ⚠️ Mimarinin en kritik detayı (plan 5.2): off-ramp, TRY'yi **SEP-10 auth
 * yapan kimliğin** SEP-12 kaydındaki IBAN'a öder. Relayer memo'suz auth
 * yaparsa para relayer'ın IBAN'ına gider, tedarikçinin değil.
 * Çözüm: her tedarikçi için `G…:memo` kapsamlı ayrı müşteri kaydı.
 */

import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import * as anchor from './anchor.js';
import { linkAnchorTransaction } from './store.js';

const HORIZON_URL = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE || Networks.TESTNET;

function relayerKeypair() {
  const secret = process.env.RELAYER_SECRET;
  if (!secret) throw new Error('RELAYER_SECRET yok — bu modül sadece sunucuda çalışır');
  return Keypair.fromSecret(secret);
}

/**
 * Tedarikçiyi memo kapsamlı müşteri olarak kaydeder.
 * @param supplierId uint64 — backend'de supplier_ref ile eşlenir
 * @param iban Türk IBAN'ı; verilmezse anchor deterministik sandbox IBAN'ı atar
 */
export async function registerSupplier({ supplierId, iban, name }) {
  const session = anchor.makeSession(relayerKeypair(), { memo: supplierId });

  const fields = {};
  if (iban) fields.bank_account_number = iban;
  if (name) fields.bank_name = name;
  await session.call((t) => anchor.putCustomer(t, fields));

  const customer = await session.call((t) => anchor.getCustomer(t));
  return { session, sub: session.sub, status: customer.status, customerId: customer.id };
}

/**
 * Fiat bacağının BİRİNCİ fazı: kayıt → firm quote → withdraw → USDC gönder.
 *
 * Burada durup dönüyoruz. Eskiden bu fonksiyon anchor `completed` diyene kadar
 * 180 sn polling yapıyordu; Vercel'de fonksiyon tavanı (Hobby'de 60 sn) o
 * süreye yetmiyor ve istek timeout'a düşüyordu. Durum ikinci fazda geliyor:
 * asıl yol `on_change_callback`, yedek yol `fetchPayoutStatus`.
 *
 * @param usdcAmount  ondalık string, ör. "5.0000000"
 */
export async function startPayout({
  requestId,
  supplierId,
  iban,
  supplierName,
  usdcAmount,
  onChangeCallback,
  onProgress = () => {},
}) {
  const relayer = relayerKeypair();
  const h = await anchor.health();
  const ids = await anchor.assetIds();

  // Limit dışı tutarı anchor'a gitmeden yakala — hata mesajı okunaklı olsun.
  await anchor.assertOfframpAmount(usdcAmount);
  if (h.treasury.low_balance) {
    onProgress({ step: 'warn', message: 'anchor treasury düşük — off-ramp gecikebilir' });
  }

  onProgress({ step: 'register', supplierId });
  const { session, sub } = await registerSupplier({ supplierId, iban, name: supplierName });

  // Gösterge değil firm quote — ödeme anında kur kilitlenir (plan 5.5).
  onProgress({ step: 'quote' });
  const quote = await session.call((t) =>
    anchor.firmQuote(t, {
      sellAsset: ids.usdc,
      buyAsset: ids.try,
      sellAmount: usdcAmount,
    }),
  );
  onProgress({ step: 'quote', quoteId: quote.id, tryAmount: quote.buy_amount, price: quote.price });

  onProgress({ step: 'withdraw' });
  const withdrawal = await session.call((t) =>
    anchor.withdrawExchange(t, {
      sellAmount: usdcAmount,
      quoteId: quote.id,
      onChangeCallback,
    }),
  );

  if (!withdrawal.memo || withdrawal.memo_type !== 'id') {
    throw new Error(
      `Anchor memo_type="id" vermedi (${withdrawal.memo_type}) — memo olmadan ödeme atfedilemez`,
    );
  }

  // Köprüyü USDC'yi göndermeden ÖNCE kur: callback ödemeden saniyeler sonra
  // gelebilir ve hangi talebe ait olduğunu bilemezse kayıt düşer.
  if (requestId !== undefined && requestId !== null) {
    await linkAnchorTransaction(withdrawal.id, requestId);
  }

  onProgress({ step: 'send', to: withdrawal.account_id, memo: withdrawal.memo });
  const stellarTxHash = await sendUsdc({
    keypair: relayer,
    destination: withdrawal.account_id,
    issuer: h.asset.issuer,
    amount: usdcAmount,
    memoId: withdrawal.memo,
  });

  return {
    anchorTransactionId: withdrawal.id,
    sub,
    supplierId,
    quoteId: quote.id,
    stellarTxHash,
    memo: withdrawal.memo,
    usdcSent: usdcAmount,
    /// Firm quote'un vaat ettiği TRY — gerçekleşenle karşılaştırılacak.
    tryQuoted: quote.buy_amount,
    status: 'pending_anchor',
  };
}

/**
 * İKİNCİ faz, yedek yol: anchor'a tek bir durum sorusu sorar.
 *
 * `on_change_callback` çalışıyorsa buna gerek kalmaz (Vercel'de çalışır).
 * Localhost'ta anchor bize ulaşamadığı için UI bunu çağırıyor.
 */
export async function fetchPayoutStatus({ supplierId, anchorTransactionId }) {
  const session = anchor.makeSession(relayerKeypair(), { memo: supplierId });
  const tx = await session.call((t) => anchor.getTransaction(t, anchorTransactionId));
  return {
    status: tx.status,
    usdcSent: tx.amount_in ?? null,
    tryPaid: tx.amount_out ?? null,
    fee: tx.amount_fee ?? null,
    /// Bankanın ödeme referansı — "para nereye gitti" sorusunun fiat tarafı.
    bankReference: tx.external_transaction_id ?? null,
    message: tx.message ?? null,
  };
}

/**
 * Başlat + bitene kadar bekle. Headless e2e için; HTTP route'u bunu
 * KULLANMAZ (süre tavanı).
 */
export async function payoutToSupplier(args) {
  const started = await startPayout(args);
  const session = anchor.makeSession(relayerKeypair(), { memo: args.supplierId });

  const settled = await anchor.pollTransaction(session, started.anchorTransactionId, {
    intervalMs: 5000, // off-ramp tespiti 5 sn kadence'ında
    timeoutMs: 180000,
    onUpdate: (tx) => args.onProgress?.({ step: 'status', status: tx.status }),
  });

  if (settled.status !== 'completed') {
    throw new Error(`Off-ramp ${settled.status} ile bitti: ${settled.message || ''}`);
  }

  return {
    ...started,
    status: settled.status,
    usdcSent: settled.amount_in,
    tryPaid: settled.amount_out,
    fee: settled.amount_fee,
    bankReference: settled.external_transaction_id,
  };
}

/** Memo.id ŞART — anchor ödemeyi memo ile eşliyor (plan 5.6). */
async function sendUsdc({ keypair, destination, issuer, amount, memoId }) {
  const horizon = new Horizon.Server(HORIZON_URL);
  const account = await horizon.loadAccount(keypair.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination,
        asset: new Asset('USDC', issuer),
        amount: String(amount),
      }),
    )
    .addMemo(Memo.id(String(memoId)))
    .setTimeout(60)
    .build();

  tx.sign(keypair);
  const res = await horizon.submitTransaction(tx);
  return res.hash;
}

/**
 * `on_change_callback` imza doğrulaması (plan 5.7).
 * İmza: Ed25519 over "<t>.<host>.<rawBody>", anchor'ın SIGNING_KEY'i ile.
 */
export async function verifyCallbackSignature({ signatureHeader, host, rawBody }) {
  if (!signatureHeader) return false;
  const match = /t=(\d+),\s*s=(.+)/.exec(signatureHeader);
  if (!match) return false;

  const [, t, s] = match;
  const h = await anchor.health();
  try {
    return Keypair.fromPublicKey(h.sep.signing_key).verify(
      Buffer.from(`${t}.${host}.${rawBody}`),
      Buffer.from(s, 'base64'),
    );
  } catch {
    return false;
  }
}
