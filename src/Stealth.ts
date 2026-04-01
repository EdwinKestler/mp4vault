import crypto from 'crypto';

const STEALTH_KEY_INFO = 'mp4vault-stealth-key-v1';
const STEALTH_NONCE_INFO = 'mp4vault-stealth-nonce-v1';

/**
 * Stealth mode: encrypts the structural header bytes (flag, type, salt, IV)
 * of each encrypted chunk using AES-256-CTR, making the entire payload
 * indistinguishable from random data.
 *
 * Requires a raw key (not password mode) to avoid the chicken-and-egg
 * problem of needing the salt to derive the key.
 */
export class Stealth {
	/** Number of header bytes to stealth-encrypt: flag(1) + type(1) + salt(16) + IV(12) */
	static readonly HEADER_SIZE = 30;

	/**
	 * Derive a 32-byte stealth key from the raw encryption key.
	 * Uses HMAC-SHA256 so the stealth key is cryptographically independent.
	 */
	static deriveStealthKey(rawKey: Buffer): Buffer {
		return crypto.createHmac('sha256', rawKey)
			.update(STEALTH_KEY_INFO)
			.digest();
	}

	/**
	 * Derive a 16-byte CTR nonce for a specific chunk index.
	 * Each chunk gets a unique nonce to prevent identical headers from
	 * producing identical stealth ciphertext.
	 */
	static deriveStealthNonce(rawKey: Buffer, chunkIndex: number): Buffer {
		const indexBuf = Buffer.alloc(4);
		indexBuf.writeUInt32BE(chunkIndex);
		return crypto.createHmac('sha256', rawKey)
			.update(STEALTH_NONCE_INFO)
			.update(indexBuf)
			.digest()
			.subarray(0, 16);
	}

	/**
	 * CTR-encrypt the 30-byte header (flag + type + salt + IV).
	 * Since CTR is symmetric, encrypt and decrypt are the same operation.
	 */
	static encryptHeader(headerBytes: Buffer, rawKey: Buffer, chunkIndex: number): Buffer {
		const stealthKey = Stealth.deriveStealthKey(rawKey);
		const nonce = Stealth.deriveStealthNonce(rawKey, chunkIndex);
		const cipher = crypto.createCipheriv('aes-256-ctr', stealthKey, nonce);
		return Buffer.concat([cipher.update(headerBytes), cipher.final()]);
	}

	/**
	 * CTR-decrypt the 30-byte stealth header back to flag + type + salt + IV.
	 * Identical to encryptHeader (CTR is symmetric).
	 */
	static decryptHeader(encryptedBytes: Buffer, rawKey: Buffer, chunkIndex: number): Buffer {
		return Stealth.encryptHeader(encryptedBytes, rawKey, chunkIndex);
	}

	/**
	 * Check if decrypted header bytes have valid flag/type modulo values.
	 * Used for auto-detection of stealth mode.
	 */
	static isValidHeader(headerBytes: Buffer): boolean {
		if (headerBytes.length < 2) return false;
		const flag = headerBytes[0];
		const typeByte = headerBytes[1];
		// Flag must be odd (encrypted) for stealth-mode chunks
		if (flag % 2 !== 1) return false;
		// Type must be 0 (object) or 1 (binary) modulo 11
		const typeVal = typeByte % 11;
		return typeVal === 0 || typeVal === 1;
	}
}
