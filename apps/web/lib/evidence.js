'use client';

/**
 * İhtiyaç kanıtı → zincire giden 32 baytlık hash.
 *
 * Plan M3 "IPFS → CID → Soroban, plan B client-side SHA-256" diyordu.
 * IPFS_API_KEY olmadığı için plan B asıl yol: dosya tarayıcıda SHA-256'lanır,
 * hash zincire yazılır. Dosyanın kendisi hiçbir yere yüklenmez.
 *
 * Bu, ispat açısından IPFS'ten zayıf değil — zincirdeki taahhüt zaten hash.
 * IPFS'in eklediği şey dosyanın *bulunabilirliği*; onu roadmap'e bırakıyoruz.
 * Kullanıcı dosyayı saklar, denetçi aynı dosyayı hash'leyip karşılaştırır.
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
    /// Önizleme için — yalnızca tarayıcıda, sunucuya gitmez.
    previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
  };
}

export const shortHash = (hex, n = 8) =>
  hex ? `${hex.slice(0, n)}…${hex.slice(-n)}` : '';

export function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
