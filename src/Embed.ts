import { EmbedObject } from './EmbedObject.js';
import { EmbedBinary } from './EmbedBinary.js';
import { Convert } from './Convert.js';
import type { IReadable, IWritable, FileRecord } from './types.js';

interface FileEntity {
	filename: string | null;
	embedBinary: EmbedBinary;
	isEncrypted: boolean;
	meta?: Record<string, unknown>;
}

export class Embed {
	private _files: FileEntity[] = [];
	private _headerEmbed: EmbedObject | null = null;
	_publicHeaderEmbed: EmbedObject | null = null;

	hasEncryptedFiles = false;
	hasPublicFiles = false;

	private _key: Buffer | null;
	private _password: string | null;

	// Stealth mode
	private _stealth: boolean;

	// Deniable inner layer
	private _innerKey: Buffer | null;
	private _innerPassword: string | null;
	private _innerFiles: FileEntity[] = [];
	private _innerHeaderEmbed: EmbedObject | null = null;
	hasInnerFiles = false;

	constructor(params: {
		key?: Buffer | null;
		password?: string | null;
		stealth?: boolean;
		innerKey?: Buffer | null;
		innerPassword?: string | null;
	} = {}) {
		this._key = params.key || null;
		this._password = params.password || null;
		this._stealth = params.stealth || false;
		this._innerKey = params.innerKey || null;
		this._innerPassword = params.innerPassword || null;
	}

	private basename(path: string): string {
		return ('' + path).split(/[\\/]/).pop() || '';
	}

	async addFile(params: {
		file?: { name?: string };
		filename?: string | null;
		meta?: Record<string, unknown>;
		key?: Buffer | null;
		password?: string | null;
		inner?: boolean;
	}): Promise<void> {
		const file = params.file || null;
		let filename = params.filename || null;
		const meta = params.meta || null;
		const isInner = params.inner || false;

		if (isInner) {
			// Inner layer file — uses inner key/password
			const embedBinary = new EmbedBinary({
				filename: filename || undefined,
				file: file || undefined,
				key: this._innerKey,
				password: this._innerPassword,
			});

			if (!filename && file) filename = file.name || null;

			const fileEntity: FileEntity = {
				filename,
				embedBinary,
				isEncrypted: true,
			};
			if (meta) fileEntity.meta = meta;

			this._innerFiles.push(fileEntity);
			return;
		}

		// Outer layer file (existing logic)
		let isEncrypted = false;
		if ((this._key || this._password) && params.key !== null && params.password !== null) {
			isEncrypted = true;
		}

		let embedBinary: EmbedBinary;
		if (isEncrypted) {
			embedBinary = new EmbedBinary({
				filename: filename || undefined,
				file: file || undefined,
				key: this._key,
				password: this._password,
			});
		} else {
			embedBinary = new EmbedBinary({
				filename: filename || undefined,
				file: file || undefined,
			});
		}

		if (!filename && file) filename = file.name || null;

		const fileEntity: FileEntity = {
			filename,
			embedBinary,
			isEncrypted,
		};
		if (meta) fileEntity.meta = meta;

		this._files.push(fileEntity);
	}

	async composeHeader(): Promise<boolean> {
		const headerObject: { files: FileRecord[]; _reserved?: number } = { files: [] };
		const publicHeaderObject: { files: FileRecord[] } = { files: [] };
		const innerHeaderObject: { files: FileRecord[] } = { files: [] };

		for (const fileEntity of this._files) {
			const size = await fileEntity.embedBinary.getExpectedSize();
			const fileRecord: FileRecord = {
				filename: this.basename(fileEntity.filename || ''),
				size,
			};
			if (fileEntity.meta) fileRecord.meta = fileEntity.meta;

			if (fileEntity.isEncrypted) {
				headerObject.files.push(fileRecord);
				this.hasEncryptedFiles = true;
			} else {
				publicHeaderObject.files.push(fileRecord);
				this.hasPublicFiles = true;
			}
		}

		for (const fileEntity of this._innerFiles) {
			const size = await fileEntity.embedBinary.getExpectedSize();
			const fileRecord: FileRecord = {
				filename: this.basename(fileEntity.filename || ''),
				size,
			};
			if (fileEntity.meta) fileRecord.meta = fileEntity.meta;
			innerHeaderObject.files.push(fileRecord);
			this.hasInnerFiles = true;
		}

		// Build inner header first so we know its size
		if (this.hasInnerFiles) {
			this._innerHeaderEmbed = new EmbedObject({
				object: innerHeaderObject,
				key: this._innerKey,
				password: this._innerPassword,
			});
			// Store inner header size in outer header so outer key holders
			// can skip past it when calculating file offsets.
			// This field looks like reserved/padding space — does not reveal inner content.
			headerObject._reserved = await this._innerHeaderEmbed.getExpectedSize();
		}

		this._publicHeaderEmbed = new EmbedObject({ object: publicHeaderObject });
		this._headerEmbed = new EmbedObject({
			object: headerObject,
			key: this._key,
			password: this._password,
		});

		return true;
	}

	async getExpectedSize(): Promise<number> {
		await this.composeHeader();
		let size = 0;

		if (this.hasPublicFiles) {
			size += await this._publicHeaderEmbed!.getExpectedSize();
		}
		if (this.hasEncryptedFiles || this.hasInnerFiles) {
			size += await this._headerEmbed!.getExpectedSize();
		}
		if (this.hasInnerFiles) {
			size += await this._innerHeaderEmbed!.getExpectedSize();
		}

		const pubFiles = (this._publicHeaderEmbed!._object as { files: FileRecord[] }).files;
		for (const file of pubFiles) size += file.size;

		const encFiles = (this._headerEmbed!._object as { files: FileRecord[] }).files;
		for (const file of encFiles) size += file.size;

		if (this._innerHeaderEmbed) {
			const innerFiles = (this._innerHeaderEmbed._object as { files: FileRecord[] }).files;
			for (const file of innerFiles) size += file.size;
		}

		return size;
	}

	async writeTo(writable: IWritable): Promise<void> {
		await this.composeHeader();

		let chunkIndex = 0;
		const stealthKey = this._stealth && this._key ? this._key : null;
		const innerStealthKey = this._stealth && this._innerKey ? this._innerKey : null;

		// 1. Public header (never stealthed — it's unencrypted)
		if (this.hasPublicFiles) {
			await this._publicHeaderEmbed!.writeTo(writable);
			chunkIndex++;
		}

		// 2. Outer encrypted header (always written when inner files exist, so structure is parseable)
		if (this.hasEncryptedFiles || this.hasInnerFiles) {
			if (stealthKey) {
				await this._headerEmbed!.writeToStealth(writable, stealthKey, chunkIndex);
			} else {
				await this._headerEmbed!.writeTo(writable);
			}
			chunkIndex++;
		}

		// 3. Inner encrypted header (encrypted with inner key — random to outer key holder)
		if (this.hasInnerFiles && this._innerHeaderEmbed) {
			if (innerStealthKey) {
				await this._innerHeaderEmbed.writeToStealth(writable, innerStealthKey, chunkIndex);
			} else {
				await this._innerHeaderEmbed.writeTo(writable);
			}
			chunkIndex++;
		}

		// 4. Outer files (public first, then encrypted)
		for (const file of this._files) {
			if (!file.isEncrypted) {
				await file.embedBinary.writeTo(writable);
				chunkIndex++;
			}
		}
		for (const file of this._files) {
			if (file.isEncrypted) {
				if (stealthKey) {
					await file.embedBinary.writeToStealth(writable, stealthKey, chunkIndex);
				} else {
					await file.embedBinary.writeTo(writable);
				}
				chunkIndex++;
			}
		}

		// 5. Inner files
		for (const file of this._innerFiles) {
			if (innerStealthKey) {
				await file.embedBinary.writeToStealth(writable, innerStealthKey, chunkIndex);
			} else {
				await file.embedBinary.writeTo(writable);
			}
			chunkIndex++;
		}
	}

	async restoreFromReadable(
		readable: IReadable,
		params: {
			key?: Buffer;
			password?: string | null;
			innerKey?: Buffer;
			innerPassword?: string | null;
			stealth?: boolean;
		} = {},
		offset = 0,
	): Promise<void> {
		const stealthKey = params.stealth && params.key ? params.key : undefined;
		const innerStealthKey = params.stealth && params.innerKey ? params.innerKey : undefined;

		// 1. Try public header (unencrypted, no stealth)
		const publicParams: Record<string, unknown> = {};
		Object.assign(publicParams, params);
		Object.assign(publicParams, { password: null, key: undefined, stealth: false, stealthKey: undefined });

		let encryptedHeaderOffset = 0;
		try {
			this._publicHeaderEmbed = await EmbedObject.restoreFromReadable(
				readable,
				publicParams as Parameters<typeof EmbedObject.restoreFromReadable>[1],
				offset,
			);
			encryptedHeaderOffset = this._publicHeaderEmbed.readBytes;
		} catch {
			this._publicHeaderEmbed = new EmbedObject({ object: { files: [] } });
		}

		const pubObj = this._publicHeaderEmbed._object as { files?: unknown[] } | null;
		this.hasPublicFiles = !!(pubObj && pubObj.files && pubObj.files.length);

		// 2. Try outer encrypted header
		let innerHeaderOffset = encryptedHeaderOffset;
		try {
			this._headerEmbed = await EmbedObject.restoreFromReadable(
				readable,
				{
					...params,
					stealthKey,
					chunkIndex: this.hasPublicFiles ? 1 : 0,
				} as Parameters<typeof EmbedObject.restoreFromReadable>[1],
				offset + encryptedHeaderOffset,
			);
			innerHeaderOffset = encryptedHeaderOffset + this._headerEmbed.readBytes;
		} catch {
			this._headerEmbed = new EmbedObject({
				object: { files: [] },
				key: this._key,
				password: this._password,
			});
		}

		const encObj = this._headerEmbed._object as { files?: unknown[] } | null;
		this.hasEncryptedFiles = !!(encObj && encObj.files && encObj.files.length);

		// 3. Try inner encrypted header (if inner key provided)
		if (params.innerKey || params.innerPassword) {
			const innerChunkIndex = (this.hasPublicFiles ? 1 : 0)
				+ (this._headerEmbed.readBytes > 0 ? 1 : 0);

			if (innerHeaderOffset > 0) {
				// We know where the inner header is (after outer header)
				try {
					this._innerHeaderEmbed = await EmbedObject.restoreFromReadable(
						readable,
						{
							key: params.innerKey,
							password: params.innerPassword,
							stealth: params.stealth,
							stealthKey: innerStealthKey,
							chunkIndex: innerChunkIndex,
						} as Parameters<typeof EmbedObject.restoreFromReadable>[1],
						offset + innerHeaderOffset,
					);
				} catch {
					this._innerHeaderEmbed = new EmbedObject({ object: { files: [] } });
				}
			} else if (!params.key && !params.password) {
				// Inner-key-only mode: scan for the inner header
				this._innerHeaderEmbed = await this._scanForInnerHeader(
					readable, params, offset, innerStealthKey,
				);
			}

			const innerObj = this._innerHeaderEmbed?._object as { files?: unknown[] } | null;
			this.hasInnerFiles = !!(innerObj && innerObj.files && innerObj.files.length);
		}
	}

	/**
	 * Scan for the inner header when only the inner key is provided.
	 * Checks candidate offsets where bytes look like encrypted object headers.
	 */
	private async _scanForInnerHeader(
		readable: IReadable,
		params: { innerKey?: Buffer; innerPassword?: string | null; stealth?: boolean },
		baseOffset: number,
		innerStealthKey?: Buffer,
	): Promise<EmbedObject> {
		const fileSize = await readable.size();
		const maxScan = Math.min(fileSize - baseOffset, 1024 * 1024); // scan up to 1MB

		for (let scanOffset = 0; scanOffset < maxScan; scanOffset++) {
			const absOffset = baseOffset + scanOffset;
			if (absOffset + 6 >= fileSize) break;

			const byte0 = (await readable.getSlice(absOffset, 1))[0];
			const byte1 = (await readable.getSlice(absOffset + 1, 1))[0];

			// Check if this looks like an encrypted object header
			if (Convert.isByteIn(byte0, 2, 1) && Convert.isByteIn(byte1, 11, 0)) {
				try {
					return await EmbedObject.restoreFromReadable(
						readable,
						{
							key: params.innerKey,
							password: params.innerPassword,
							stealth: params.stealth,
							stealthKey: innerStealthKey,
							chunkIndex: 0,
						} as Parameters<typeof EmbedObject.restoreFromReadable>[1],
						absOffset,
					);
				} catch {
					// Wrong offset, continue scanning
				}
			}
		}

		return new EmbedObject({ object: { files: [] } });
	}

	getFilesToExtract(): FileRecord[] {
		const filesToExtract: FileRecord[] = [];
		let offset = 0;
		offset += this._publicHeaderEmbed!.readBytes;
		offset += this._headerEmbed!.readBytes;

		if (this._innerHeaderEmbed) {
			offset += this._innerHeaderEmbed.readBytes;
		} else {
			// If we don't have the inner key, check if the outer header
			// recorded a _reserved size (inner header bytes to skip)
			const encObj = this._headerEmbed!._object as { _reserved?: number } | null;
			if (encObj && encObj._reserved) {
				offset += encObj._reserved;
			}
		}

		// Public files
		const pubFiles = (this._publicHeaderEmbed!._object as { files: FileRecord[] }).files;
		for (const fileRecord of pubFiles) {
			filesToExtract.push({ ...fileRecord, isEncrypted: false, offset });
			offset += fileRecord.size;
		}

		// Outer encrypted files
		const encFiles = (this._headerEmbed!._object as { files: FileRecord[] }).files;
		for (const fileRecord of encFiles) {
			filesToExtract.push({ ...fileRecord, isEncrypted: true, offset });
			offset += fileRecord.size;
		}

		// Inner files
		if (this._innerHeaderEmbed) {
			const innerFiles = (this._innerHeaderEmbed._object as { files: FileRecord[] }).files;
			for (const fileRecord of innerFiles) {
				filesToExtract.push({ ...fileRecord, isEncrypted: true, inner: true, offset });
				offset += fileRecord.size;
			}
		}

		return filesToExtract;
	}

	async restoreBinary(
		readable: IReadable,
		params: {
			key?: Buffer;
			password?: string | undefined;
			innerKey?: Buffer;
			innerPassword?: string | undefined;
			stealth?: boolean;
		},
		n: number,
		offset: number,
		writable: IWritable | null = null,
	): Promise<IWritable> {
		if (!this._headerEmbed && !this._publicHeaderEmbed) {
			await this.restoreFromReadable(readable, params, offset);
		}

		const filesToExtract = this.getFilesToExtract();
		if (!filesToExtract[n]) {
			throw new Error('There is no file ' + n + ' found in this container');
		}

		const fileSize = filesToExtract[n].size;
		const fileOffset = offset + filesToExtract[n].offset!;
		const isInner = filesToExtract[n].inner;

		// Compute the stealth chunk index: headers first, then files in order
		// Headers: publicHeader=0, encryptedHeader=1, innerHeader=2
		// Files: start at headerCount, increment per file
		const headerCount = (this.hasPublicFiles ? 1 : 0)
			+ (this.hasEncryptedFiles ? 1 : 0)
			+ (this.hasInnerFiles ? 1 : 0);
		const fileChunkIndex = headerCount + n;

		const stealthKey = params.stealth
			? (isInner ? params.innerKey : params.key)
			: undefined;

		if (isInner) {
			return await EmbedBinary.restoreFromReadable(
				readable,
				{
					key: params.innerKey,
					password: params.innerPassword,
					stealth: params.stealth,
					stealthKey,
					chunkIndex: fileChunkIndex,
				},
				fileOffset, fileSize, writable,
			);
		} else if (filesToExtract[n].isEncrypted) {
			return await EmbedBinary.restoreFromReadable(
				readable,
				{
					key: params.key,
					password: params.password,
					stealth: params.stealth,
					stealthKey,
					chunkIndex: fileChunkIndex,
				},
				fileOffset, fileSize, writable,
			);
		} else {
			const publicParams = { key: undefined, password: undefined };
			return await EmbedBinary.restoreFromReadable(readable, publicParams, fileOffset, fileSize, writable);
		}
	}
}
