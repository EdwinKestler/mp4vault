import { AES } from './AES.js';
import { Convert } from './Convert.js';
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
			// Browser File objects handled via browser Readable
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
		params: { key?: Buffer; password?: string } = {},
		offset = 0,
		size: number | null = null,
		writable: IWritable | null = null,
	): Promise<IWritable> {
		const firstByte = (await readable.getSlice(offset + 0, 1))[0];
		const typeByte = (await readable.getSlice(offset + 1, 1))[0];

		if (!size) {
			size = (await readable.size()) - offset;
		}

		let decryptor: AES | null = null;

		if (Convert.isByteIn(firstByte, 2, 1)) {
			let readOffset = offset + 2;

			const salt = await readable.getSlice(readOffset, AES.saltByteLength);
			readOffset += AES.saltByteLength;

			const iv = await readable.getSlice(readOffset, AES.ivByteLength);

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
}
