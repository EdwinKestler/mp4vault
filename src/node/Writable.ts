import fs from 'fs/promises';
import { tmpFileSync } from '../utils.js';
import type { FileHandle } from 'fs/promises';
import type { IReadable, IWritable } from '../types.js';
import { Readable } from './Readable.js';

export class Writable implements IWritable {
	private _chunks: Uint8Array[] = [];
	private _filename: string | undefined;
	private _prepared = false;
	private _bytesWrote = 0;
	private _fp: FileHandle | null = null;

	constructor(params: { filename?: string } = {}) {
		if (params.filename) {
			this._filename = params.filename;
		}
	}

	size(): number {
		return this._bytesWrote;
	}

	async prepare(): Promise<void> {
		if (this._prepared) {
			return;
		}

		if (this._filename) {
			this._fp = await fs.open(this._filename, 'w');
		}

		this._prepared = true;
	}

	async close(): Promise<void> {
		if (this._fp) {
			try {
				await this._fp.close();
			} catch {
				// file may already be closed
			}
			this._fp = null;
			this._prepared = false;
		}
		this._chunks = [];
	}

	private _concat(): Uint8Array {
		if (this._chunks.length === 0) return new Uint8Array(0);
		if (this._chunks.length === 1) return this._chunks[0];
		const result = new Uint8Array(this._bytesWrote);
		let offset = 0;
		for (const chunk of this._chunks) {
			result.set(chunk, offset);
			offset += chunk.length;
		}
		return result;
	}

	async saveToFile(filename: string): Promise<void> {
		await fs.writeFile(filename, this._concat());
	}

	async write(append: Uint8Array | number[]): Promise<void> {
		if (!this._prepared) {
			await this.prepare();
		}

		const data = append instanceof Uint8Array ? append : Uint8Array.from(append);

		if (this._fp) {
			await this._fp.write(data, 0, data.length);
			this._bytesWrote += data.length;
		} else {
			this._chunks.push(data);
			this._bytesWrote += data.length;
		}
	}

	async toReadable(): Promise<IReadable> {
		if (this._filename) {
			await this.close();
			return new Readable({ filename: this._filename });
		} else {
			const tmpName = tmpFileSync();
			await this.saveToFile(tmpName);
			await this.close();
			return new Readable({ filename: tmpName });
		}
	}
}
