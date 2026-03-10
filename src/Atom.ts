import { Pack } from './Pack.js';
import { BUFFER_SIZE, MAX_INT32 } from './constants.js';
import type { IReadable, IWritable } from './types.js';

export class Atom {
	readable: IReadable | null;
	name: string;
	start: number;
	size: number;
	header_size: number;
	mother: Atom | null;
	children: Atom[];
	contents: number[] | null;

	constructor(params: {
		readable?: IReadable;
		name: string;
		start: number;
		size: number;
		header_size: number;
		mother?: Atom | null;
	}) {
		this.readable = params.readable || null;
		this.name = params.name;
		this.start = params.start;
		this.size = params.size;
		this.header_size = params.header_size;
		this.mother = params.mother || null;
		this.children = [];
		this.contents = null;
	}

	findAtoms(atoms: Atom[] | null, name: string): Atom[] {
		atoms = atoms || this.children;

		let ret: Atom[] = [];
		for (const a of atoms) {
			if (a.name === name) {
				ret.push(a);
			}
			if (a.children.length) {
				ret = ret.concat(this.findAtoms(a.children, name));
			}
		}

		return ret;
	}

	async unpackFromOffset(offset: number, length: number, fmt: string): Promise<number[]> {
		try {
			const data = await this.readable!.getSlice(this.start + offset, length);
			return Pack.unpack(fmt, data);
		} catch {
			return [];
		}
	}

	isVideo(): boolean {
		const vmhdAtoms = this.findAtoms(null, 'vmhd');
		return !!(vmhdAtoms && vmhdAtoms.length);
	}

	isAudio(): boolean {
		const smhdAtoms = this.findAtoms(null, 'smhd');
		return !!(smhdAtoms && smhdAtoms.length);
	}

	async getChunkOffsets(): Promise<number[]> {
		let sampleOffsets: number[] = [];
		if (this.name !== 'stco' && this.name !== 'co64') {
			const sampleAtoms = this.findAtoms(null, 'stco').concat(this.findAtoms(null, 'co64'));
			for (const atom of sampleAtoms) {
				sampleOffsets = sampleOffsets.concat(await atom.getChunkOffsets());
			}
			return sampleOffsets;
		}

		const data = await this.readable!.getSlice(this.start + this.header_size, 8);
		const unpacked = Pack.unpack('>II', data);
		const count = unpacked[1];

		if (this.name === 'stco') {
			for (let i = 0; i < count; i += 1024) {
				const cToRead = Math.min(1024, count - i);
				const readOffsets = Pack.unpack(
					'>' + 'I'.repeat(cToRead),
					await this.readable!.getSlice(this.start + this.header_size + 8 + i * 4, cToRead * 4),
				);
				sampleOffsets.push(...readOffsets);
			}
		} else if (this.name === 'co64') {
			for (let i = 0; i < count; i += 1024) {
				const cToRead = Math.min(1024, count - i);
				const readOffsets = Pack.unpack(
					'>' + 'Q'.repeat(cToRead),
					await this.readable!.getSlice(this.start + this.header_size + 8 + i * 8, cToRead * 8),
				);
				sampleOffsets.push(...readOffsets);
			}
		}

		return sampleOffsets;
	}

	async writeHeader(writable: IWritable): Promise<void> {
		if (this.size > MAX_INT32 && this.header_size === 8) {
			throw new Error('Size too large for compact header');
		}

		if (this.size < MAX_INT32) {
			await writable.write(Pack.pack('>I4s', [this.size, this.name]));
		} else {
			await writable.write(Pack.pack('>I4sQ', [1, this.name, this.size]));
		}
	}

	async writePayload(writable: IWritable): Promise<void> {
		if (this.children.length) {
			for (const a of this.children) {
				await a.write(writable);
			}
		} else {
			const bodySize = this.size - this.header_size;
			if (this.readable) {
				for (let i = 0; i < bodySize; i += BUFFER_SIZE) {
					const copySize = Math.min(BUFFER_SIZE, bodySize - i);
					const chunk = await this.readable.getSlice(this.start + this.header_size + i, copySize);
					await writable.write(chunk);
				}
			} else if (this.contents) {
				if (this.contents.length === bodySize) {
					await writable.write(this.contents);
				} else {
					throw new Error('Invalid bodySize for contents chunk');
				}
			} else {
				if (bodySize > 0) {
					await writable.write(new Uint8Array([0]));
				}
			}
		}
	}

	async write(writable: IWritable): Promise<void> {
		await this.writeHeader(writable);
		await this.writePayload(writable);
	}
}
