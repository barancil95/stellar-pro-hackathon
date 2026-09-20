/**
 * poa_escrow contract client.
 *
 * The spec is read from the chain (`contract.Client.from`), so there is no binding
 * generation step — when the contract changes the frontend stays current on its own.
 */

import { contract, rpc } from '@stellar/stellar-sdk';

// Only NEXT_PUBLIC_* is inlined in the browser; Node scripts read the bare names
// from .env. Both are supported so the same module runs on either side.
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

/** USDC has 7 decimals. We never use floats — no lost cents. */
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
 * @param options.publicKey    the signing address (may be empty for reads)
 * @param options.signTransaction  the signer coming from Wallets Kit
 */
export async function escrowClient({ publicKey, signTransaction } = {}) {
  if (!CONTRACT_ID) throw new Error('POA_CONTRACT_ID is not set — check .env');

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

/** Drop the cache when the wallet changes — otherwise we ask the old address to sign. */
export function resetClientCache() {
  clientCache.clear();
}

/* ---------------------------------- reads --------------------------------- */

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
    // Option<Address> → an address or undefined. When set, the funds are not in the
    // escrow but in the DeFindex vault, and `balance` is the value of the shares.
    vault: unwrap(config).vault ?? null,
  };
}

export async function readRequest(id) {
  const client = await escrowClient();
  const tx = await client.get_request({ request_id: BigInt(id) });
  return unwrap(tx.result);
}

/** All requests, newest first. At hackathon scale the count is small. */
export async function readAllRequests() {
  const client = await escrowClient();
  const count = Number((await client.request_count()).result);
  const ids = Array.from({ length: count }, (_, i) => count - 1 - i);
  return Promise.all(
    ids.map(async (id) => ({ ...(await readRequest(id)), id: BigInt(id) })),
  );
}

/** Which coordinator approved — feeds the 2/3 bar. */
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
 * The transaction hash. `getTransactionResponse` is a property (not a function);
 * if the transaction is not confirmed yet we fall back to the hash in the send
 * response.
 */
function txHashOf(sent) {
  return sent.getTransactionResponse?.txHash ?? sent.sendTransactionResponse?.hash;
}

/** The contract returns Result<T, Error>; the SDK hands it over in an Ok/Err wrapper. */
function unwrap(result) {
  if (result && typeof result === 'object' && 'isOk' in result) {
    if (!result.isOk()) throw new Error(`Contract error: ${result.unwrapErr().message}`);
    return result.unwrap();
  }
  return result;
}

/* --------------------------------- writes --------------------------------- */

/** A donor deposits USDC into the escrow. The wallet signs. */
export async function deposit({ publicKey, signTransaction, amount }) {
  const client = await escrowClient({ publicKey, signTransaction });
  const tx = await client.deposit({ from: publicKey, amount: toStroops(amount) });
  const sent = await tx.signAndSend();
  unwrap(sent.result);
  return txHashOf(sent);
}

/** A field actor opens a request. */
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

/** A coordinator approval — signed with their own wallet. */
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

/** Releases the funds to the relayer after 2/3 approvals. The destination is fixed
 * in the contract. */
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
