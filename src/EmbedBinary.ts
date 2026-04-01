import { AES } from './AES.js';
import { Convert } from './Convert.js';
import { Stealth } from './Stealth.js';
import { BUFFER_SIZE } from './constants.js';
import { Readable } from './node/Readable.js';
import { Writable } from './node/Writable.js';
import type { IReadable, IWritable } from './types.js';

export class EmbedBinary {
	_readable: IReadable | null;
	private _key: Buffer | null;
	private _password: string | null;
	private _iv: Buffer | null;
	private _salt: Buffer | null;
	private _encryptor: AES | null = null;

	constructor(params: {
		readable?: IReadable;
		filename?: string;
		file?: { name?: string };
		key?: Buffer | null;
		password?: string | null;
		iv?: Buffer | null;
		salt?: Buffer | null;
	} = {}) {
		this._readable = null;

		if (params.readable) {
			this._readable = params.readable;
		} else if (params.filename && !params.file) {
			this._readable = new Readable({ filename: params.filename });
		} else if (params.file) {
			this._readable = new Readable({ filename: (params.file as { name: string }).name });
		}

		this._key = params.key || null;
		this._password = params.password || null;
		this._iv = params.iv || null;
		this._salt = params.salt || null;
	}

	async getExpectedSize(): Promise<number> {
		if (!this._readable) {
			throw new Error('No readable source. Provide a filename, file, or readable');
		}
		const readableSize = await this._readable.size();

		if (this._key || this._password) {
			return 2 + AES.saltByteLength + AES.ivByteLength + readableSize + AES.authTagByteLength;
		} else {
			return 2 + readableSize;
		}
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
			password?: string;
			stealth?: boolean;
			stealthKey?: Buffer;
			chunkIndex?: number;
		} = {},
		offset = 0,
		size: number | null = null,
		writable: IWritable | null = null,
	): Promise<IWritable> {
		let firstByte = (await readable.getSlice(offset + 0, 1))[0];
		let typeByte = (await readable.getSlice(offset + 1, 1))[0];

		if (!size) {
			size = (await readable.size()) - offset;
		}

		let decryptor: AES | null = null;
		let stealthDecrypted: Buffer | null = null;

		// Stealth detection: try to decrypt header if we have a stealth key
		if (params.stealthKey) {
			const headerData = await readable.getSlice(offset, Stealth.HEADER_SIZE);
			const decrypted = Stealth.decryptHeader(
				Buffer.from(headerData), params.stealthKey, params.chunkIndex || 0
			);
			if (Stealth.isValidHeader(decrypted)) {
				stealthDecrypted = decrypted;
				firstByte = decrypted[0];
				typeByte = decrypted[1];
			}
		}

		if (Convert.isByteIn(firstByte, 2, 1)) {
			let salt: Uint8Array;
			let iv: Uint8Array;

			if (stealthDecrypted) {
				salt = stealthDecrypted.subarray(2, 2 + AES.saltByteLength);
				iv = stealthDecrypted.subarray(2 + AES.saltByteLength, 2 + AES.saltByteLength + AES.ivByteLength);
			} else {
				salt = await readable.getSlice(offset + 2, AES.saltByteLength);
				iv = await readable.getSlice(offset + 2 + AES.saltByteLength, AES.ivByteLength);
			}

			const authTagOffset = offset + size - AES.authTagByteLength;
			const authTag = await readable.getSlice(authTagOffset, AES.authTagByteLength);

			const decryptParams: {
				key?: Buffer;
				password?: string;
				iv: Buffer;
				salt: Buffer;
				authTag: Buffer;
			} = {
				iv: Buffer.from(iv),
				salt: Buffer.from(salt),
				authTag: Buffer.from(authTag),
			};
			if (params.key) decryptParams.key = params.key;
			if (params.password) decryptParams.password = params.password;

			decryptor = new AES(decryptParams);
		}

		if (Convert.isByteIn(typeByte, 11, 1)) {
			if (!writable) {
				writable = new Writable();
			}

			let bodySize = size - 2;
			let bodyOffset = offset + 2;
			if (decryptor) {
				bodySize = bodySize - AES.saltByteLength - AES.ivByteLength - AES.authTagByteLength;
				bodyOffset = offset + 2 + AES.saltByteLength + AES.ivByteLength;
			}

			for (let i = 0; i < bodySize; i += BUFFER_SIZE) {
				const copySize = Math.min(BUFFER_SIZE, bodySize - i);
				const chunk = await readable.getSlice(bodyOffset + i, copySize);
				if (decryptor) {
					const isLast = (i + copySize >= bodySize);
					const decrypted = decryptor.decrypt(Buffer.from(chunk), isLast);
					await writable.write(decrypted);
				} else {
					await writable.write(chunk);
				}
			}

			if (decryptor && bodySize === 0) {
				const final = decryptor.decrypt(null, true);
				if (final.length > 0) {
					await writable.write(final);
				}
			}

			return writable;
		}

		throw new Error('Unknown embed type');
	}

	async writeTo(writable: IWritable): Promise<void> {
		if (!this._readable) return;

		let encryptor: AES | null = null;
		let firstByte = Convert.randomByteIn(2, 0);
		if (this._key || this._password) {
			encryptor = this.getEncryptor();
			firstByte = Convert.randomByteIn(2, 1);
		}

		await writable.write([firstByte]);
		await writable.write([Convert.randomByteIn(11, 1)]);

		if (encryptor) {
			await writable.write(this._encryptor!.getSalt() || Buffer.alloc(AES.saltByteLength));
			await writable.write(this.getIV());
		}

		const bodySize = await this._readable.size();
		for (let i = 0; i < bodySize; i += BUFFER_SIZE) {
			const copySize = Math.min(BUFFER_SIZE, bodySize - i);
			const chunk = await this._readable.getSlice(i, copySize);
			if (encryptor) {
				const isLast = (i + copySize >= bodySize);
				const encrypted = encryptor.encrypt(Buffer.from(chunk), isLast);
				await writable.write(encrypted);
			} else {
				await writable.write(chunk);
			}
		}

		if (encryptor) {
			await writable.write(encryptor.getAuthTag());
		}

		await this._readable.close();
	}

	async writeToStealth(writable: IWritable, stealthKey: Buffer, chunkIndex: number): Promise<void> {
		if (!this._readable) return;

		// Build the header bytes first, then stealth-encrypt them
		let encryptor: AES | null = null;
		const firstByte = Convert.randomByteIn(2, this._key || this._password ? 1 : 0);
		const secondByte = Convert.randomByteIn(11, 1);

		if (this._key || this._password) {
			encryptor = this.getEncryptor();
		}

		if (encryptor) {
			const salt = this._encryptor!.getSalt() || Buffer.alloc(AES.saltByteLength);
			const iv = this.getIV();

			// Build the 30-byte header
			const header = Buffer.alloc(Stealth.HEADER_SIZE);
			header[0] = firstByte;
			header[1] = secondByte;
			salt.copy(header, 2);
			iv.copy(header, 2 + AES.saltByteLength);

			// CTR-encrypt the header
			const stealthHeader = Stealth.encryptHeader(header, stealthKey, chunkIndex);
			await writable.write(stealthHeader);
		} else {
			// Unencrypted — no stealth needed (only 2-byte header, no salt/IV)
			await writable.write([firstByte]);
			await writable.write([secondByte]);
		}

		const bodySize = await this._readable.size();
		for (let i = 0; i < bodySize; i += BUFFER_SIZE) {
			const copySize = Math.min(BUFFER_SIZE, bodySize - i);
			const chunk = await this._readable.getSlice(i, copySize);
			if (encryptor) {
				const isLast = (i + copySize >= bodySize);
				const encrypted = encryptor.encrypt(Buffer.from(chunk), isLast);
				await writable.write(encrypted);
			} else {
				await writable.write(chunk);
			}
		}

		if (encryptor) {
			await writable.write(encryptor.getAuthTag());
		}

		await this._readable.close();
	}
}
