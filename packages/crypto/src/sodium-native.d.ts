declare module 'sodium-native' {
  // Only the subset @hive/crypto uses. sodium-native ships no .d.ts of its
  // own — add new exports here as needed instead of `any`-casting.
  export const crypto_aead_xchacha20poly1305_ietf_KEYBYTES: number;
  export const crypto_aead_xchacha20poly1305_ietf_NPUBBYTES: number;
  export const crypto_aead_xchacha20poly1305_ietf_ABYTES: number;
  export function crypto_aead_xchacha20poly1305_ietf_encrypt(
    c: Buffer,
    m: Buffer,
    ad: Buffer | null,
    nsec: null,
    npub: Buffer,
    k: Buffer,
  ): number;
  export function crypto_aead_xchacha20poly1305_ietf_decrypt(
    m: Buffer,
    nsec: null,
    c: Buffer,
    ad: Buffer | null,
    npub: Buffer,
    k: Buffer,
  ): number;
  export function randombytes_buf(buf: Buffer): void;
  const _default: {
    crypto_aead_xchacha20poly1305_ietf_KEYBYTES: number;
    crypto_aead_xchacha20poly1305_ietf_NPUBBYTES: number;
    crypto_aead_xchacha20poly1305_ietf_ABYTES: number;
    crypto_aead_xchacha20poly1305_ietf_encrypt: typeof crypto_aead_xchacha20poly1305_ietf_encrypt;
    crypto_aead_xchacha20poly1305_ietf_decrypt: typeof crypto_aead_xchacha20poly1305_ietf_decrypt;
    randombytes_buf: typeof randombytes_buf;
  };
  export default _default;
}
