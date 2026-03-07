import * as crypto from 'crypto';

/**
 * Encrypted payload structure.
 * All fields are base64-encoded for safe transmission over the data channel.
 */
export interface EncryptedPayload {
    /** Base64-encoded initialization vector (12 bytes for GCM) */
    iv: string;
    /** Base64-encoded authentication tag (16 bytes for GCM) */
    authTag: string;
    /** Base64-encoded ciphertext */
    ciphertext: string;
    /** Base64-encoded salt used for key derivation */
    salt: string;
}

/**
 * EncryptionService — AES-256-GCM encryption with scrypt key derivation.
 *
 * Architectural Decisions:
 *  - AES-256-GCM: Provides both confidentiality and integrity (authenticated encryption).
 *    The 16-byte auth tag ensures tampering is detected. GCM mode is chosen over CBC
 *    because it provides authentication natively, eliminating the need for a separate HMAC.
 *
 *  - scrypt for key derivation: Chosen over PBKDF2 because scrypt is memory-hard,
 *    making brute-force attacks significantly more expensive. The passphrase (wormhole code)
 *    is short (~3 words), so a strong KDF is critical.
 *
 *  - 12-byte IV: GCM's recommended IV length. A fresh random IV is generated for
 *    every encryption operation, ensuring unique (key, IV) pairs.
 *
 *  - 32-byte salt: Unique per encryption, prevents rainbow table attacks against the KDF.
 *
 * Security Model:
 *  - The passphrase (wormhole code) serves as the PAKE seed.
 *  - Both peers derive the same symmetric key from the same passphrase.
 *  - An attacker intercepting the ciphertext cannot decrypt without the passphrase.
 *  - The signaling server never sees plaintext or the passphrase.
 */
export class EncryptionService {
    private static readonly ALGORITHM = 'aes-256-gcm';
    private static readonly IV_LENGTH = 12;        // 12 bytes (96 bits) for GCM
    private static readonly AUTH_TAG_LENGTH = 16;   // 16 bytes (128 bits)
    private static readonly SALT_LENGTH = 32;       // 32 bytes
    private static readonly KEY_LENGTH = 32;        // 32 bytes (256 bits) for AES-256
    private static readonly SCRYPT_COST = 16384;    // N = 2^14 — balance of security and speed
    private static readonly SCRYPT_BLOCK_SIZE = 8;  // r
    private static readonly SCRYPT_PARALLELISM = 1; // p

    /**
     * Derive a 256-bit AES key from a passphrase using scrypt.
     *
     * @param passphrase The shared wormhole code (e.g., "apple-brave-chair")
     * @param salt A unique random salt (32 bytes). Must be the same on both sides.
     * @returns A 32-byte derived key as a Buffer.
     */
    public async deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            crypto.scrypt(
                passphrase,
                salt,
                EncryptionService.KEY_LENGTH,
                {
                    N: EncryptionService.SCRYPT_COST,
                    r: EncryptionService.SCRYPT_BLOCK_SIZE,
                    p: EncryptionService.SCRYPT_PARALLELISM,
                },
                (err, derivedKey) => {
                    if (err) {
                        reject(new Error(`Key derivation failed: ${err.message}`));
                    } else {
                        resolve(derivedKey);
                    }
                }
            );
        });
    }

    /**
     * Encrypt a plaintext buffer using AES-256-GCM.
     *
     * Generates a fresh random IV and salt for each encryption.
     * The salt is included in the output so the receiver can derive the same key.
     *
     * @param plaintext The data to encrypt (Buffer).
     * @param passphrase The shared wormhole code.
     * @returns An EncryptedPayload with base64-encoded fields.
     */
    public async encrypt(plaintext: Buffer, passphrase: string): Promise<EncryptedPayload> {
        // Generate fresh random salt and IV for this encryption
        const salt = crypto.randomBytes(EncryptionService.SALT_LENGTH);
        const iv = crypto.randomBytes(EncryptionService.IV_LENGTH);

        // Derive the encryption key
        const key = await this.deriveKey(passphrase, salt);

        // Encrypt
        const cipher = crypto.createCipheriv(EncryptionService.ALGORITHM, key, iv, {
            authTagLength: EncryptionService.AUTH_TAG_LENGTH,
        });

        const encrypted = Buffer.concat([
            cipher.update(plaintext),
            cipher.final(),
        ]);

        const authTag = cipher.getAuthTag();

        // Securely zero out the key from memory
        key.fill(0);

        return {
            iv: iv.toString('base64'),
            authTag: authTag.toString('base64'),
            ciphertext: encrypted.toString('base64'),
            salt: salt.toString('base64'),
        };
    }

    /**
     * Decrypt an AES-256-GCM encrypted payload.
     *
     * Uses the salt from the payload to re-derive the same key from the passphrase.
     * Verifies the authentication tag to ensure data integrity.
     *
     * @param payload The encrypted payload with base64-encoded fields.
     * @param passphrase The shared wormhole code (must match the one used for encryption).
     * @returns The decrypted plaintext as a Buffer.
     * @throws Error if decryption fails (wrong passphrase, tampered data, etc.)
     */
    public async decrypt(payload: EncryptedPayload, passphrase: string): Promise<Buffer> {
        const iv = Buffer.from(payload.iv, 'base64');
        const authTag = Buffer.from(payload.authTag, 'base64');
        const ciphertext = Buffer.from(payload.ciphertext, 'base64');
        const salt = Buffer.from(payload.salt, 'base64');

        // Re-derive the same key using the embedded salt
        const key = await this.deriveKey(passphrase, salt);

        try {
            const decipher = crypto.createDecipheriv(EncryptionService.ALGORITHM, key, iv, {
                authTagLength: EncryptionService.AUTH_TAG_LENGTH,
            });

            decipher.setAuthTag(authTag);

            const decrypted = Buffer.concat([
                decipher.update(ciphertext),
                decipher.final(),
            ]);

            return decrypted;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(
                `Decryption failed — this usually means the wormhole code is incorrect ` +
                `or the data was tampered with. Details: ${message}`
            );
        } finally {
            // Securely zero out the key from memory
            key.fill(0);
        }
    }

    /**
     * Generate a random salt for use with key derivation.
     */
    public generateSalt(): Buffer {
        return crypto.randomBytes(EncryptionService.SALT_LENGTH);
    }

    /**
     * Compute a SHA-256 hash of the passphrase for use as a room/channel identifier.
     * This ensures the signaling server never sees the raw passphrase.
     */
    public hashPassphrase(passphrase: string): string {
        return crypto.createHash('sha256').update(passphrase).digest('hex');
    }
}
