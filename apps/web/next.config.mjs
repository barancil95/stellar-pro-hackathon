import { config } from 'dotenv';

// Tek kaynak: repo kökündeki .env. Next varsayılan olarak sadece kendi
// dizinine bakar, o yüzden açıkça yükleniyor.
config({ path: new URL('../../.env', import.meta.url).pathname });

/** @type {import('next').NextConfig} */
export default {
  env: {
    // Yalnızca tarayıcıya açılabilecekler. RELAYER_SECRET burada ASLA yer almaz;
    // o sadece sunucu tarafı route'larda process.env'den okunur.
    NEXT_PUBLIC_ANCHOR_HOME_DOMAIN: process.env.ANCHOR_HOME_DOMAIN,
    NEXT_PUBLIC_SOROBAN_RPC_URL: process.env.SOROBAN_RPC_URL,
    NEXT_PUBLIC_HORIZON_URL: process.env.HORIZON_URL,
    NEXT_PUBLIC_NETWORK_PASSPHRASE: process.env.NETWORK_PASSPHRASE,
    NEXT_PUBLIC_POA_CONTRACT_ID: process.env.POA_CONTRACT_ID,
    NEXT_PUBLIC_USDC_SAC_ID: process.env.USDC_SAC_ID,
  },
};
