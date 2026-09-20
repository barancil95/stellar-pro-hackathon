/**
 * Stellar Wallets Kit — `allowAllModules()`.
 *
 * This is what satisfies the hackathon's Integration requirement (#1). Using only
 * Freighter would not be enough: Freighter is not on the curated list, it is a
 * module under the Kit. The 2/3 approval flow requires signing with different
 * wallets anyway.
 */

'use client';

import {
  StellarWalletsKit,
  WalletNetwork,
  allowAllModules,
  FREIGHTER_ID,
} from '@creit.tech/stellar-wallets-kit';

let kit = null;

/** The Kit lives in the browser — it cannot be constructed during SSR. */
export function getKit() {
  if (typeof window === 'undefined') return null;
  if (!kit) {
    kit = new StellarWalletsKit({
      network: WalletNetwork.TESTNET,
      selectedWalletId: FREIGHTER_ID,
      modules: allowAllModules(),
    });
  }
  return kit;
}

/**
 * Prompts for a wallet and returns the address.
 * Freighter opens on Mainnet by default — the user has to switch to Testnet.
 */
export async function connect() {
  const k = getKit();
  return new Promise((resolve, reject) => {
    k.openModal({
      onWalletSelected: async (option) => {
        try {
          k.setWallet(option.id);
          const { address } = await k.getAddress();
          resolve({
            address,
            walletId: option.id,
            walletName: option.name,
            sign: signer(address),
          });
        } catch (e) {
          reject(e);
        }
      },
      onClosed: () => reject(new Error('Wallet selection cancelled')),
    });
  });
}

/** The signer shape stellar-sdk's contract client expects. */
export function signer(address) {
  return async (xdr, opts) => {
    const k = getKit();
    const { signedTxXdr, signerAddress } = await k.signTransaction(xdr, {
      address,
      networkPassphrase: opts?.networkPassphrase || WalletNetwork.TESTNET,
    });
    return { signedTxXdr, signerAddress: signerAddress || address };
  };
}

/* ------------------------------ demo signer ------------------------------ */

/**
 * A fallback path that needs no extension. The key stays in browser memory and the
 * signature is made locally. For testnet demo accounts only — the server hands out
 * no key unless DEMO_MODE=true.
 */
export async function loadDemoAccounts() {
  try {
    const res = await fetch('/api/demo-accounts');
    if (!res.ok) return [];
    const { accounts } = await res.json();
    return accounts ?? [];
  } catch {
    return [];
  }
}

export function demoSigner(secret) {
  return async (xdr, opts) => {
    // stellar-sdk works in the browser too; imported dynamically to keep the bundle small.
    const { Keypair, TransactionBuilder } = await import('@stellar/stellar-sdk');
    const keypair = Keypair.fromSecret(secret);
    const passphrase =
      opts?.networkPassphrase ||
      process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ||
      WalletNetwork.TESTNET;

    const tx = TransactionBuilder.fromXDR(xdr, passphrase);
    tx.sign(keypair);
    return { signedTxXdr: tx.toXDR(), signerAddress: keypair.publicKey() };
  };
}

export const shorten = (addr, n = 4) =>
  addr ? `${addr.slice(0, n + 1)}…${addr.slice(-n)}` : '';
