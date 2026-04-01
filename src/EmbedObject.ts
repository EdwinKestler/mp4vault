import { Pack } from './Pack.js';
import { AES } from './AES.js';
import { Convert } from './Convert.js';
import { Stealth } from './Stealth.js';
import { MAX_HEADER_SIZE } from './constants.js';
import type { IReadable, IWritable } from './types.js';

export class EmbedObject {
	_object: Record<string, unknown> | null;
	private _binary: Buffer | null;
	private _key: Buffer | null;
	private _password: string | null;
	private _iv: Buffer | null;
	private _salt: Buffer | null;
	private _readBytes: number;
	private _encryptor: AES | null = null;

	constructor(params: {
		object?: Record<string, unknown>;
		key?: Buffer | null;
		password?: string | null;
		iv?: Buffer | null;
		salt?: Buffer | null;
		readBytes?: number;
	} = {}) {
		this._object = params.object || null;
		this._binary = params.object ? Convert.objectToBuffer(params.object) : null;

		this._key = params.key || null;
		this._password = params.password || null;
		this._iv = params.iv || null;
		this._salt = params.salt || null;
		this._readBytes = params.readBytes || 0;
	}

	get readBytes(): number {
		return this._readBytes;
	}

	async getExpectedSize(): Promise<number> {
		if (this._key || this._password) {
			return 2 + AES.saltByteLength + AES.ivByteLength + 4 + this._binary!.length + AES.authTagByteLength;
		} else {
			return 2 + 4 + this._binary!.length;
		}
	}

	get object(): Record<string, unknown> | null {
		return this._object;
	}

	getEncryptor(): AES {
		if (this._encryptor) {
			return this._encryptor;
		}

		this._encryptor = new AES({
			key: this._key || undefined,
			password: this._password || undefined,
			iv: this._iv || undefined,
			salt: this._salt || undefined,
		});

		if (!this._iv) {
			this._iv = this._encryptor.getIV();
		}
		if (!this._salt) {
			this._salt = this._encryptor.getSalt();
		}

		return this._encryptor;
	}

	getIV(): Buffer {
		if (!this._iv) {
			throw new Error('IV is not yet ready. Run getEncryptor() first, or specify one yourself');
		}
		return this._iv;
	}

	static async restoreFromReadable(
		readable: IReadable,
		params: {
			key?: Buffer;
			password?: string | null;
			object?: Record<string, unknown>;
			readBytes?: number;
			iv?: Buffer;
			salt?: Buffer;
			stealth?: boolean;
			stealthKey?: Buffer;
			chunkIndex?: number;
		} = {},
		offset = 0,
	): Promise<EmbedObject> {
		let firstByte = (await readable.getSlice(offset + 0, 1))[0];
		let typeByte = (await readable.getSlice(offset + 1, 1))[0];

		// Stealth auto-detect: if flag/type don't parse as valid and we have a stealth key, try decrypting
		let stealthActive = false;
		if (params.stealth && params.stealthKey) {
			const headerData = await readable.getSlice(offset, Stealth.HEADER_SIZE);
			const decrypted = Stealth.decryptHeader(
				Buffer.from(headerData), params.stealthKey, params.chunkIndex || 0
			);
			if (Stealth.isValidHeader(decrypted)) {
				stealthActive = true;
				firstByte = decrypted[0];
				typeByte = decrypted[1];
				// Replace salt and IV with decrypted values — they'll be used below
				params.salt = Buffer.from(decrypted.subarray(2, 2 + AES.saltByteLength));
				params.iv = Buffer.from(decrypted.subarray(2 + AES.saltByteLength, 2 + AES.saltByteLength + AES.ivByteLength));
			}
		} else if (!Convert.isByteIn(firstByte, 2, 0) && !Convert.isByteIn(firstByte, 2, 1)) {
			// Not valid normal mode either — try stealth if key available
			if (params.stealthKey) {
				const headerData = await readable.getSlice(offset, Stealth.HEADER_SIZE);
				const decrypted = Stealth.decryptHeader(
					Buffer.from(headerData), params.stealthKey, params.chunkIndex || 0
				);
				if (Stealth.isValidHeader(decrypted)) {
					stealthActive = true;
					firstByte = decrypted[0];
					typeByte = decrypted[1];
					params.salt = Buffer.from(decrypted.subarray(2, 2 + AES.saltByteLength));
					params.iv = Buffer.from(decrypted.subarray(2 + AES.saltByteLength, 2 + AES.saltByteLength + AES.ivByteLength));
				}
			}
		}

		let size: number | null = null;
		let readBytes = 2;

		if (Convert.isByteIn(firstByte, 2, 1)) {
			// encrypted
			let salt: Uint8Array;
			let iv: Uint8Array;

			if (stealthActive && params.salt && params.iv) {
				// Salt and IV were already recovered from stealth decryption
				salt = params.salt;
				iv = params.iv;
			} else {
				salt = await readable.getSlice(offset + 2, AES.saltByteLength);
				iv = await readable.getSlice(offset + 2 + AES.saltByteLength, AES.ivByteLength);
			}
			readBytes += AES.saltByteLength;
			readBytes += AES.ivByteLength;

			const headerDataOffset = offset + 2 + AES.saltByteLength + AES.ivByteLength;

			const sizeChunk = await readable.getSlice(headerDataOffset, 4);
			readBytes += 4;

			const decryptParams: {
				key?: Buffer;
				password?: string;
				iv: Buffer;
				salt: Buffer;
				authTag?: Buffer;
			} = {
				iv: Buffer.from(iv),
				salt: Buffer.from(salt),
			};
			if (params.key) decryptParams.key = params.key;
			if (params.password) decryptParams.password = params.password;

			// peek at encrypted size
			const peekDecryptor = new AES(decryptParams);
			const sizeDecrypted = peekDecryptor.decrypt(Buffer.from(sizeChunk));
			size = Pack.unpack('>I', sizeDecrypted)[0];

			if (!size) {
				throw new Error('Can not get size of EmbedObject to restore');
			}

			if (size > MAX_HEADER_SIZE) {
				throw new Error('Header is too large to extract');
			}

			const fullEncryptedSize = 4 + size;
			const authTagOffset = headerDataOffset + fullEncryptedSize;
			const authTag = await readable.getSlice(authTagOffset, AES.authTagByteLength);
			readBytes += size + AES.authTagByteLength;

			decryptParams.authTag = Buffer.from(authTag);
			const fullDecryptor = new AES(decryptParams);

			const fullChunk = await readable.getSlice(headerDataOffset, fullEncryptedSize);
			const decrypted = fullDecryptor.decrypt(Buffer.from(fullChunk), true);

			const jsonPayload = decrypted.subarray(4);
			params.object = Convert.bufferToObject(jsonPayload) as Record<string, unknown>;
		} else {
			// raw
			const sizeBytes = await readable.getSlice(offset + 2, 4);
			readBytes += 4;

			size = Pack.unpack('>I', sizeBytes)[0];

			if (!size) {
				throw new Error('Can not get size of EmbedObject to restore');
			}

			if (size > MAX_HEADER_SIZE) {
				throw new Error('Header is too large to extract');
			}

			const chunk = await readable.getSlice(offset + 6, size);
			readBytes += size;

			params.object = Convert.bufferToObject(Buffer.from(chunk)) as Record<string, unknown>;
		}

		delete params.iv;
		delete params.salt;

		params.readBytes = readBytes;
		return new EmbedObject(params);
	}

	async writeTo(writable: IWritable): Promise<void> {
		const binary = this.getBinary();
		await writable.write(binary);
	}

	async writeToStealth(writable: IWritable, stealthKey: Buffer, chunkIndex: number): Promise<void> {
		const binary = this.getEncryptedStealth(stealthKey, chunkIndex);
		await writable.write(binary);
	}

	getBinary(): Uint8Array {
		if (this._key || this._password) {
			return this.getEncrypted();
		} else {
			return this.getRaw();
		}
	}

	getRaw(): Uint8Array {
		const payload = this._binary!;
		const ret = new Uint8Array(payload.length + 2 + 4);

		const firstByte = Convert.randomByteIn(2, 0);
		const secondByte = Convert.randomByteIn(11, 0);
		ret.set([firstByte], 0);
		ret.set([secondByte], 1);
		ret.set(Pack.pack('>I', [payload.length]), 2);
		ret.set(payload, 6);

		return ret;
	}

	getEncrypted(): Uint8Array {
		const encryptor = this.getEncryptor();

		const packedSize = Pack.pack('>I', [this._binary!.length]);
		const plaintext = Buffer.concat([Buffer.from(packedSize), this._binary!]);

		const ciphertext = encryptor.encrypt(plaintext, true);
		const iv = this.getIV();
		const salt = encryptor.getSalt() || Buffer.alloc(AES.saltByteLength);
		const authTag = encryptor.getAuthTag();

		const ret = new Uint8Array(2 + salt.length + iv.length + ciphertext.length + authTag.length);
		const firstByte = Convert.randomByteIn(2, 1);
		const secondByte = Convert.randomByteIn(11, 0);
		ret.set([firstByte], 0);
		ret.set([secondByte], 1);

		let pos = 2;
		ret.set(salt, pos); pos += salt.length;
		ret.set(iv, pos); pos += iv.length;
		ret.set(ciphertext, pos); pos += ciphertext.length;
		ret.set(authTag, pos);

		return ret;
	}

	getEncryptedStealth(stealthKey: Buffer, chunkIndex: number): Uint8Array {
		const raw = this.getEncrypted();

		// CTR-encrypt the first 30 bytes (flag + type + salt + IV)
		const header = Buffer.from(raw.subarray(0, Stealth.HEADER_SIZE));
		const encryptedHeader = Stealth.encryptHeader(header, stealthKey, chunkIndex);

		const ret = new Uint8Array(raw.length);
		ret.set(encryptedHeader, 0);
		ret.set(raw.subarray(Stealth.HEADER_SIZE), Stealth.HEADER_SIZE);

		return ret;
	}
}
