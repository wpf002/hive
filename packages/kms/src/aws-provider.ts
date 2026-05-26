/**
 * AwsKmsProvider — wraps DEKs under an AWS KMS Customer Master Key.
 *
 * Env vars:
 *   HIVE_KMS_KEY_ID   ARN or alias of the KMS key (required)
 *   AWS_REGION        Standard AWS SDK region resolution
 *   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / instance role / etc.
 *
 * Cost note: every encryptDek/decryptDek is a real KMS API call (~$0.03 /10k).
 * Envelope encryption means one call per write; reads of the same encrypted
 * value reuse the wrapped DEK so a hot bot doesn't get re-charged per access.
 */
import { KMSClient, EncryptCommand, DecryptCommand } from '@aws-sdk/client-kms';
import type { EncryptedDek, HiveKmsProvider } from './types.js';

export interface AwsProviderOptions {
  /** KMS Key ARN or alias used for new wraps. */
  keyId?: string;
  /** Inject a pre-built client (for tests). Otherwise built from env. */
  client?: KMSClient;
  region?: string;
}

export class AwsKmsProvider implements HiveKmsProvider {
  private readonly client: KMSClient;
  private readonly keyId: string;

  constructor(opts: AwsProviderOptions = {}) {
    const keyId = opts.keyId ?? process.env.HIVE_KMS_KEY_ID;
    if (!keyId) {
      throw new Error('HIVE_KMS_KEY_ID is required when HIVE_KMS_PROVIDER=aws');
    }
    this.keyId = keyId;
    this.client = opts.client ?? new KMSClient({ region: opts.region ?? process.env.AWS_REGION });
  }

  currentKeyId(): string {
    return this.keyId;
  }

  async encryptDek(dek: Buffer): Promise<EncryptedDek> {
    const res = await this.client.send(
      new EncryptCommand({
        KeyId: this.keyId,
        Plaintext: dek,
      }),
    );
    if (!res.CiphertextBlob) {
      throw new Error('AWS KMS Encrypt returned no CiphertextBlob');
    }
    return {
      ciphertext: Buffer.from(res.CiphertextBlob).toString('base64'),
      keyId: res.KeyId ?? this.keyId,
      algorithm: 'AES_256',
    };
  }

  async decryptDek(encrypted: EncryptedDek): Promise<Buffer> {
    const res = await this.client.send(
      new DecryptCommand({
        CiphertextBlob: Buffer.from(encrypted.ciphertext, 'base64'),
        // KMS routes by metadata in the blob; supplying KeyId guards against
        // accidentally decrypting blobs that were wrapped under a different
        // KMS key than we think.
        KeyId: encrypted.keyId,
      }),
    );
    if (!res.Plaintext) {
      throw new Error('AWS KMS Decrypt returned no Plaintext');
    }
    return Buffer.from(res.Plaintext);
  }
}
