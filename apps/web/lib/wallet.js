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
          resolve({ address, walletId: option.id, walletName: option.name });
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

export const shorten = (addr, n = 4) =>
  addr ? `${addr.slice(0, n + 1)}…${addr.slice(-n)}` : '';
