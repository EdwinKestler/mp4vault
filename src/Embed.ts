import { EmbedObject } from './EmbedObject.js';
import { EmbedBinary } from './EmbedBinary.js';
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

	constructor(params: {
		key?: Buffer | null;
		password?: string | null;
	} = {}) {
		this._key = params.key || null;
		this._password = params.password || null;
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
	}): Promise<void> {
		const file = params.file || null;
		let filename = params.filename || null;
		const meta = params.meta || null;

		// Per-file encryption opt-out: setting params.key or params.password to null
		// explicitly disables encryption for this file, even if the Embed instance has a key/password.
		// This enables mixing public and encrypted files in the same container.
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

		if (!filename && file) {
			filename = file.name || null;
		}

		const fileEntity: FileEntity = {
			filename: filename,
			embedBinary: embedBinary,
			isEncrypted: isEncrypted,
		};

		if (meta) {
			fileEntity.meta = meta;
		}

		this._files.push(fileEntity);
	}

	async composeHeader(): Promise<boolean> {
		const headerObject: { files: FileRecord[] } = { files: [] };
		const publicHeaderObject: { files: FileRecord[] } = { files: [] };

		for (const fileEntity of this._files) {
			const size = await fileEntity.embedBinary.getExpectedSize();
			const fileRecord: FileRecord = {
				filename: this.basename(fileEntity.filename || ''),
				size: size,
			};
			if (fileEntity.meta) {
				fileRecord.meta = fileEntity.meta;
			}

			if (fileEntity.isEncrypted) {
				headerObject.files.push(fileRecord);
				this.hasEncryptedFiles = true;
			} else {
				publicHeaderObject.files.push(fileRecord);
				this.hasPublicFiles = true;
			}
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
		if (this.hasEncryptedFiles) {
			size += await this._headerEmbed!.getExpectedSize();
		}
		if (this.hasPublicFiles) {
			size += await this._publicHeaderEmbed!.getExpectedSize();
		}

		const encFiles = (this._headerEmbed!.object as { files: FileRecord[] }).files;
		for (const file of encFiles) {
			size += file.size;
		}
		const pubFiles = (this._publicHeaderEmbed!.object as { files: FileRecord[] }).files;
		for (const file of pubFiles) {
			size += file.size;
		}

		return size;
	}

	async writeTo(writable: IWritable): Promise<void> {
		await this.composeHeader();
		if (this.hasPublicFiles) {
			await this._publicHeaderEmbed!.writeTo(writable);
		}
		if (this.hasEncryptedFiles) {
			await this._headerEmbed!.writeTo(writable);
		}
		for (const file of this._files) {
			await file.embedBinary.writeTo(writable);
		}
	}

	async restoreFromReadable(
		readable: IReadable,
		params: { key?: Buffer; password?: string | null } = {},
		offset = 0,
	): Promise<void> {
		const publicParams: { password?: string | null; key?: Buffer } = {};
		Object.assign(publicParams, params);
		Object.assign(publicParams, { password: null, key: undefined });

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

		try {
			this._headerEmbed = await EmbedObject.restoreFromReadable(
				readable,
				params as Parameters<typeof EmbedObject.restoreFromReadable>[1],
				offset + encryptedHeaderOffset,
			);
		} catch {
			this._headerEmbed = new EmbedObject({
				object: { files: [] },
				key: this._key,
				password: this._password,
			});
		}

		const encObj = this._headerEmbed._object as { files?: unknown[] } | null;
		this.hasEncryptedFiles = !!(encObj && encObj.files && encObj.files.length);
	}

	getFilesToExtract(): FileRecord[] {
		const filesToExtract: FileRecord[] = [];
		let offset = 0;
		offset += this._publicHeaderEmbed!.readBytes;
		offset += this._headerEmbed!.readBytes;

		const pubFiles = (this._publicHeaderEmbed!._object as { files: FileRecord[] }).files;
		for (const fileRecord of pubFiles) {
			filesToExtract.push({ ...fileRecord, isEncrypted: false, offset: offset });
			offset += fileRecord.size;
		}
		const encFiles = (this._headerEmbed!._object as { files: FileRecord[] }).files;
		for (const fileRecord of encFiles) {
			filesToExtract.push({ ...fileRecord, isEncrypted: true, offset: offset });
			offset += fileRecord.size;
		}

		return filesToExtract;
	}

	async restoreBinary(
		readable: IReadable,
		params: { key?: Buffer; password?: string | undefined },
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

		if (filesToExtract[n].isEncrypted) {
			return await EmbedBinary.restoreFromReadable(readable, params, fileOffset, fileSize, writable);
		} else {
			const publicParams = { ...params, password: undefined, key: undefined };
			return await EmbedBinary.restoreFromReadable(readable, publicParams, fileOffset, fileSize, writable);
		}
	}
}
