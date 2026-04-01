import { Embed } from './Embed.js';
import { BUFFER_SIZE } from './constants.js';
import { Readable } from './node/Readable.js';
import { Writable } from './node/Writable.js';
import debug from 'debug';
import type { IReadable, IWritable, FileRecord } from './types.js';

const log = debug('mp4vault:image');

enum ImageFormat {
	JPEG = 'jpeg',
	PNG = 'png',
}

export class ImageVault {
	private _readable: IReadable | null = null;
	private _embed: Embed | null = null;
	private _key: Buffer | null = null;
	private _password: string | null = null;
	private _stealth = false;
	private _innerKey: Buffer | null = null;
	private _innerPassword: string | null = null;
	private _format: ImageFormat | null = null;
	private _payloadOffset = 0;
	private _initialEmbed: Embed | null = null;

	setKey(key: Buffer): void {
		this._key = key;
		this._password = null;
	}

	setPassword(password: string): void {
		this._password = password;
		this._key = null;
	}

	setStealth(enabled: boolean): void {
		if (enabled && !this._key) {
			throw new Error('Stealth mode requires a raw key (setKey), not a password');
		}
		this._stealth = enabled;
	}

	setInnerKey(key: Buffer): void {
		this._innerKey = key;
		this._innerPassword = null;
	}

	setInnerPassword(password: string): void {
		this._innerPassword = password;
		this._innerKey = null;
	}

	async loadFile(params: { filename: string }): Promise<void> {
		if (!params || !params.filename) {
			throw new Error('filename is required');
		}
		this._readable = new Readable(params);
		await this._detectFormat();
		await this._findPayloadOffset();

		log('format:', this._format, 'payload offset:', this._payloadOffset);

		const fileSize = await this._readable.size();
		if (this._payloadOffset < fileSize) {
			try {
				this._initialEmbed = new Embed();
				await this._initialEmbed.restoreFromReadable(
					this._readable,
					{
						key: this._key || undefined,
						password: this._password,
						innerKey: this._innerKey || undefined,
						innerPassword: this._innerPassword,
						stealth: this._stealth,
					},
					this._payloadOffset,
				);
			} catch {
				this._initialEmbed = null;
			}
		}

		await this._readable.close();
	}

	async embedFile(params: {
		filename?: string;
		file?: { name?: string };
		meta?: Record<string, unknown>;
		key?: Buffer | null;
		password?: string | null;
		inner?: boolean;
	}): Promise<void> {
		if (!this._embed) {
			this._embed = new Embed({
				key: this._key,
				password: this._password,
				stealth: this._stealth,
				innerKey: this._innerKey,
				innerPassword: this._innerPassword,
			});
		}
		await this._embed.addFile(params);
	}

	getEmbedFiles(): FileRecord[] {
		if (this._initialEmbed) {
			return this._initialEmbed.getFilesToExtract();
		}
		return [];
	}

	async extractFile(n: number, writable: IWritable | null = null): Promise<IWritable> {
		if (!this._initialEmbed) {
			throw new Error('No embedded files found in this image');
		}

		const result = await this._initialEmbed.restoreBinary(
			this._readable!,
			{
				key: this._key || undefined,
				password: this._password || undefined,
				innerKey: this._innerKey || undefined,
				innerPassword: this._innerPassword || undefined,
				stealth: this._stealth,
			},
			n,
			this._payloadOffset,
			writable,
		);

		await this._readable!.close();
		return result;
	}

	async embed(writable?: IWritable): Promise<IWritable> {
		if (!this._readable) {
			throw new Error('No image loaded. Call loadFile() first');
		}
		if (!writable) {
			writable = new Writable();
		}

		for (let i = 0; i < this._payloadOffset; i += BUFFER_SIZE) {
			const copySize = Math.min(BUFFER_SIZE, this._payloadOffset - i);
			const chunk = await this._readable.getSlice(i, copySize);
			await writable.write(chunk);
		}

		if (this._embed) {
			await this._embed.writeTo(writable);
		}

		await this._readable.close();
		await writable.close();

		return writable;
	}

	async getExpectedSize(): Promise<number> {
		let size = this._payloadOffset;
		if (this._embed) {
			size += await this._embed.getExpectedSize();
		}
		return size;
	}

	private async _detectFormat(): Promise<void> {
		const header = await this._readable!.getSlice(0, 8);

		if (header[0] === 0xff && header[1] === 0xd8) {
			this._format = ImageFormat.JPEG;
		} else if (
			header[0] === 0x89 && header[1] === 0x50 &&
			header[2] === 0x4e && header[3] === 0x47 &&
			header[4] === 0x0d && header[5] === 0x0a &&
			header[6] === 0x1a && header[7] === 0x0a
		) {
			this._format = ImageFormat.PNG;
		} else {
			throw new Error('Unsupported image format. Expected JPEG or PNG');
		}
	}

	private async _findPayloadOffset(): Promise<void> {
		if (this._format === ImageFormat.JPEG) {
			await this._findJpegPayloadOffset();
		} else if (this._format === ImageFormat.PNG) {
			await this._findPngPayloadOffset();
		}
	}

	private async _findJpegPayloadOffset(): Promise<void> {
		const fileSize = await this._readable!.size();
		let offset = 2; // skip SOI (FF D8)

		while (offset < fileSize - 1) {
			const marker = await this._readable!.getSlice(offset, 2);

			if (marker[0] !== 0xff) {
				throw new Error('Invalid JPEG: expected marker at offset ' + offset);
			}

			const type = marker[1];

			// Fill bytes (FF FF)
			if (type === 0xff) {
				offset += 1;
				continue;
			}

			// EOI
			if (type === 0xd9) {
				this._payloadOffset = offset + 2;
				log('JPEG EOI at', offset);
				return;
			}

			// Standalone markers (RST0-RST7, TEM, SOI)
			if ((type >= 0xd0 && type <= 0xd7) || type === 0x01 || type === 0xd8) {
				offset += 2;
				continue;
			}

			// SOS — start of scan, followed by entropy-coded data
			if (type === 0xda) {
				const lenBytes = await this._readable!.getSlice(offset + 2, 2);
				const segLen = (lenBytes[0] << 8) | lenBytes[1];
				const entropyStart = offset + 2 + segLen;
				offset = await this._scanJpegEntropyData(entropyStart, fileSize);
				continue;
			}

			// All other marker segments: read 2-byte length, skip
			const lenBytes = await this._readable!.getSlice(offset + 2, 2);
			const segLen = (lenBytes[0] << 8) | lenBytes[1];
			offset += 2 + segLen;
		}

		// No EOI found — treat entire file as the image
		this._payloadOffset = fileSize;
	}

	private async _scanJpegEntropyData(start: number, fileSize: number): Promise<number> {
		let offset = start;

		while (offset < fileSize) {
			const readSize = Math.min(BUFFER_SIZE, fileSize - offset);
			const chunk = await this._readable!.getSlice(offset, readSize);

			for (let i = 0; i < chunk.length; i++) {
				if (chunk[i] !== 0xff) continue;

				// FF at last byte of chunk — can't peek next byte
				if (i + 1 >= chunk.length) {
					return offset + i;
				}

				const next = chunk[i + 1];

				// FF 00 — byte stuffing, skip
				if (next === 0x00) {
					i += 1;
					continue;
				}

				// FF D0-D7 — RST markers, skip
				if (next >= 0xd0 && next <= 0xd7) {
					i += 1;
					continue;
				}

				// FF FF — fill byte
				if (next === 0xff) {
					continue;
				}

				// Any other FF xx — real marker, return its position
				return offset + i;
			}

			offset += readSize;
		}

		return fileSize;
	}

	private async _findPngPayloadOffset(): Promise<void> {
		const fileSize = await this._readable!.size();
		let offset = 8; // skip PNG signature

		while (offset < fileSize) {
			const header = await this._readable!.getSlice(offset, 8);
			const dataLength = ((header[0] << 24) | (header[1] << 16) | (header[2] << 8) | header[3]) >>> 0;
			const type = String.fromCharCode(header[4], header[5], header[6], header[7]);

			const chunkTotal = 12 + dataLength; // 4 length + 4 type + data + 4 CRC

			if (type === 'IEND') {
				this._payloadOffset = offset + chunkTotal;
				log('PNG IEND at', offset);
				return;
			}

			offset += chunkTotal;
		}

		// No IEND found — treat entire file as the image
		this._payloadOffset = fileSize;
	}
}
