/**
 * Hive KMS abstraction — wraps Data Encryption Keys (DEKs) under a Key
 * Encryption Key (KEK). A KEK lives in the provider (static env, AWS KMS, …);
 * DEKs are short-lived 32-byte buffers that live only in memory inside this
 * process.
 *
 * Envelope encryption flow:
 *   1. On write: generate a random DEK → encrypt plaintext under DEK →
 *      provider.encryptDek(DEK) → store { keyId, encDek, ciphertext } together.
 *   2. On read: parse envelope → provider.decryptDek(encDek) → decrypt
 *      ciphertext under DEK → drop DEK.
 *   3. Key rotation = re-encrypting every DEK under the new KEK while leaving
 *      the data ciphertext untouched. Cheap and online.
 */

export interface EncryptedDek {
  /** Provider-opaque ciphertext of the 32-byte DEK, base64. */
  ciphertext: string;
  /** Stable identifier of the KEK that wrapped this DEK. Survives rotation. */
  keyId: string;
  /** Symmetric algorithm used for the data ciphertext (NOT the KEK). */
  algorithm: 'AES_256' | 'XCHACHA20';
}

export interface HiveKmsProvider {
  /** Wrap a 32-byte DEK under the provider's current KEK. */
  encryptDek(dek: Buffer): Promise<EncryptedDek>;
  /** Unwrap an EncryptedDek. Implementations may need historical KEKs to be
   *  reachable during rotation windows. */
  decryptDek(encrypted: EncryptedDek): Promise<Buffer>;
  /** Identifier of the KEK that new DEKs would be wrapped under right now. */
  currentKeyId(): string;
}
