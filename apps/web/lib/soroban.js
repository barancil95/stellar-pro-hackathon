/**
 * poa_escrow contract istemcisi.
 *
 * Spec zincirden okunur (`contract.Client.from`), böylece binding üretme adımı
 * yok — contract değişince frontend kendiliğinden güncel kalıyor.
 */

import { contract, rpc } from '@stellar/stellar-sdk';

// Tarayıcıda yalnızca NEXT_PUBLIC_* gömülü olur; Node script'lerinde ise
// .env'deki çıplak adlar okunur. İkisi de desteklenir ki aynı modül her
// iki tarafta da çalışsın.
export const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ||
  process.env.SOROBAN_RPC_URL ||
  'https://soroban-testnet.stellar.org';
export const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ||
  process.env.NETWORK_PASSPHRASE ||
  'Test SDF Network ; September 2015';
export const CONTRACT_ID =
  process.env.NEXT_PUBLIC_POA_CONTRACT_ID || process.env.POA_CONTRACT_ID;
export const USDC_SAC_ID =
  process.env.NEXT_PUBLIC_USDC_SAC_ID || process.env.USDC_SAC_ID;

/** USDC 7 ondalıklı. Float kullanmıyoruz — kuruş kaybı olmasın. */
export const USDC_DECIMALS = 7;
const SCALE = 10n ** BigInt(USDC_DECIMALS);

export function toStroops(amount) {
  const [whole, frac = ''] = String(amount).trim().split('.');
  const padded = (frac + '0'.repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS);
  return BigInt(whole || '0') * SCALE + BigInt(padded || '0');
}

export function fromStroops(stroops) {
  const v = BigInt(stroops ?? 0);
  const sign = v < 0n ? '-' : '';
  const abs = v < 0n ? -v : v;
  const frac = (abs % SCALE).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  return `${sign}${abs / SCALE}${frac ? `.${frac}` : ''}`;
}

export const rpcServer = () => new rpc.Server(RPC_URL);

const clientCache = new Map();

/**
 * @param options.publicKey    imzalayacak adres (okuma için boş olabilir)
 * @param options.signTransaction  Wallets Kit'ten gelen imzalayıcı
 */
export async function escrowClient({ publicKey, signTransaction } = {}) {
  if (!CONTRACT_ID) throw new Error('POA_CONTRACT_ID tanımlı değil — .env kontrol edin');

  const key = publicKey || '__readonly__';
  if (!clientCache.has(key)) {
    clientCache.set(
      key,
      contract.Client.from({
        contractId: CONTRACT_ID,
        networkPassphrase: NETWORK_PASSPHRASE,
        rpcUrl: RPC_URL,
        allowHttp: RPC_URL.startsWith('http://'),
        publicKey,
        signTransaction,
      }),
    );
  }
  return clientCache.get(key);
}

/** Cüzdan değişince önbelleği at — yoksa eski adres adına imza istenir. */
export function resetClientCache() {
  clientCache.clear();
}

/* ------------------------------- okumalar -------------------------------- */

export async function readEscrow() {
  const client = await escrowClient();
  const [balance, campaign, count, config] = await Promise.all([
    client.balance().then((t) => t.result),
    client.get_campaign().then((t) => t.result),
    client.request_count().then((t) => t.result),
    client.get_config().then((t) => t.result),
  ]);
  return {
    balance: unwrap(balance),
    campaign: unwrap(campaign),
    requestCount: count,
    // Option<Address> → adres veya undefined. Doluysa fon escrow'da değil,
    // DeFindex vault'unda duruyor ve `balance` payın karşılığı.
    vault: unwrap(config).vault ?? null,
  };
}

export async function readRequest(id) {
  const client = await escrowClient();
  const tx = await client.get_request({ request_id: BigInt(id) });
  return unwrap(tx.result);
}

/** Tüm talepler, en yeni önce. Hackathon ölçeğinde sayı küçük. */
export async function readAllRequests() {
  const client = await escrowClient();
  const count = Number((await client.request_count()).result);
  const ids = Array.from({ length: count }, (_, i) => count - 1 - i);
  return Promise.all(
    ids.map(async (id) => ({ ...(await readRequest(id)), id: BigInt(id) })),
  );
}

/** Hangi koordinatör onayladı — 2/3 barını beslemek için. */
export async function readApprovals(requestId, coordinators) {
  const client = await escrowClient();
  return Promise.all(
    coordinators.map(async (address) => ({
      address,
      approved: (
        await client.has_approved({ request_id: BigInt(requestId), coordinator: address })
      ).result,
    })),
  );
}

export async function readConfig() {
  const client = await escrowClient();
  return unwrap((await client.get_config()).result);
}

/**
 * İşlem hash'i. `getTransactionResponse` bir property (fonksiyon değil);
 * işlem henüz onaylanmadıysa gönderim cevabındaki hash'e düşülür.
 */
function txHashOf(sent) {
  return sent.getTransactionResponse?.txHash ?? sent.sendTransactionResponse?.hash;
}

/** Contract Result<T, Error> dönüyor; SDK bunu Ok/Err sarmalıyla veriyor. */
function unwrap(result) {
  if (result && typeof result === 'object' && 'isOk' in result) {
    if (!result.isOk()) throw new Error(`Contract hatası: ${result.unwrapErr().message}`);
    return result.unwrap();
  }
  return result;
}

/* -------------------------------- yazmalar ------------------------------- */

/** Bağışçı escrow'a USDC yatırır. Cüzdan imzalar. */
export async function deposit({ publicKey, signTransaction, amount }) {
  const client = await escrowClient({ publicKey, signTransaction });
  const tx = await client.deposit({ from: publicKey, amount: toStroops(amount) });
  const sent = await tx.signAndSend();
  unwrap(sent.result);
  return txHashOf(sent);
}

/** Saha aktörü talep açar. */
export async function createRequest({ publicKey, signTransaction, supplierRef, amount, proofHash }) {
  const client = await escrowClient({ publicKey, signTransaction });
  const tx = await client.create_request({
    supplier_ref: supplierRef,
    amount: toStroops(amount),
    proof_hash: proofHash,
  });
  const sent = await tx.signAndSend();
  return {
    requestId: unwrap(sent.result),
    hash: txHashOf(sent),
  };
}

/** Koordinatör onayı — kendi cüzdanıyla imzalar. */
export async function approveRequest({ publicKey, signTransaction, requestId }) {
  const client = await escrowClient({ publicKey, signTransaction });
  const tx = await client.approve_request({
    coordinator: publicKey,
    request_id: BigInt(requestId),
  });
  const sent = await tx.signAndSend();
  unwrap(sent.result);
  return txHashOf(sent);
}

/** 2/3 onaydan sonra fonu relayer'a çıkarır. Hedef contract'ta sabit. */
export async function executePayout({ publicKey, signTransaction, requestId }) {
  const client = await escrowClient({ publicKey, signTransaction });
  const tx = await client.execute_payout({ request_id: BigInt(requestId) });
  const sent = await tx.signAndSend();
  unwrap(sent.result);
  return txHashOf(sent);
}

export const explorerTx = (hash) => `https://stellar.expert/explorer/testnet/tx/${hash}`;
export const explorerAccount = (id) => `https://stellar.expert/explorer/testnet/account/${id}`;
export const explorerContract = (id) => `https://stellar.expert/explorer/testnet/contract/${id}`;
