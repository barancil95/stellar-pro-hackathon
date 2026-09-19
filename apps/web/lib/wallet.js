/**
 * Stellar Wallets Kit — `allowAllModules()`.
 *
 * Bu, hackathon'un Integration şartının (#1) karşılığı. Sadece Freighter
 * kullanmak yetmez: Freighter curated listede yok, Kit'in altında bir modül.
 * 2/3 onay akışı da zaten farklı cüzdanlarla imzalamayı gerektiriyor.
 */

'use client';

import {
  StellarWalletsKit,
  WalletNetwork,
  allowAllModules,
  FREIGHTER_ID,
} from '@creit.tech/stellar-wallets-kit';

let kit = null;

/** Kit tarayıcıda yaşar — SSR sırasında oluşturulamaz. */
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
 * Cüzdan seçtirir ve adresi döner.
 * Freighter varsayılan olarak Mainnet'te açılır — kullanıcı Testnet'e almalı.
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
      onClosed: () => reject(new Error('Cüzdan seçimi iptal edildi')),
    });
  });
}

/** stellar-sdk'nın contract istemcisinin beklediği imzalayıcı şekli. */
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

/* ----------------------------- demo imzalayıcı --------------------------- */

/**
 * Eklenti gerektirmeyen yedek yol. Anahtar tarayıcıda bellekte durur,
 * imza yerel atılır. Yalnızca testnet demo hesapları için — sunucu tarafı
 * DEMO_MODE=true değilse zaten anahtar vermez.
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
    // stellar-sdk tarayıcıda da çalışıyor; dinamik import bundle'ı şişirmesin diye.
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
