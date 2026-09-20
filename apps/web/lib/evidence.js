'use client';

/**
 * Proof of need → the 32-byte hash that goes on-chain.
 *
 * Plan M3 said "IPFS → CID → Soroban, plan B client-side SHA-256". With no
 * IPFS_API_KEY, plan B is the main path: the file is SHA-256'd in the browser and
 * the hash is written on-chain. The file itself is uploaded nowhere.
 *
 * In terms of proof this is no weaker than IPFS — the on-chain commitment is a
 * hash either way. What IPFS adds is the file's *availability*; we leave that to
 * the roadmap. The user keeps the file, an auditor hashes the same file and
 * compares.
 */

export async function hashEvidence(file) {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const bytes = new Uint8Array(digest);

  return {
    bytes,
    hex: [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(''),
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type,
    /// For the preview — browser-only, never sent to the server.
    previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
  };
}

/**
 * Proof is not mandatory — an actor who cannot take a photo in the field must
 * still be able to open a request. The contract wants `proof_hash` as 32 bytes, so
 * "no proof" is the zero hash. The screens do not render it as a hash.
 */
export const EMPTY_PROOF_HEX = '0'.repeat(64);

export const isEmptyProof = (hex) => !hex || /^0+$/.test(hex);

export const shortHash = (hex, n = 8) =>
  hex ? `${hex.slice(0, n)}…${hex.slice(-n)}` : '';

export function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
