import { Atom } from './Atom.js';
import { Embed } from './Embed.js';
import { Pack } from './Pack.js';
import { MAX_INT32 } from './constants.js';
import { Readable } from './node/Readable.js';
import { Writable } from './node/Writable.js';
import debug from 'debug';
import type { IReadable, IWritable, FileRecord } from './types.js';

const log = debug('mp4vault');

export class MP4 {
	private _analyzed = false;
	_readable: IReadable | null = null;
	private _embed: Embed | null = null;
	private _key: Buffer | null = null;
	private _password: string | null = null;
	_atoms: Atom[] = [];
	private _initialMdatStart: number | null = null;
	private _initialEmbed: Embed | null = null;

	getEmbedFiles(): FileRecord[] {
		if (this._initialEmbed) {
			return this._initialEmbed.getFilesToExtract();
		}
		return [];
	}

	setKey(key: Buffer): void {
		this._key = key;
		this._password = null;
	}

	setPassword(password: string): void {
		this._password = password;
		this._key = null;
	}

	async loadFile(params: { filename: string }): Promise<void> {
		if (!params || !params.filename) {
			throw new Error('filename is required');
		}
		this._readable = new Readable(params);
		await this.analyzeFile();
		await this._readable.close();
	}

	async embedFile(params: {
		filename?: string;
		file?: { name?: string };
		meta?: Record<string, unknown>;
		key?: Buffer | null;
		password?: string | null;
	}): Promise<void> {
		if (!this._embed) {
			this._embed = new Embed({ key: this._key, password: this._password });
		}
		await this._embed.addFile(params);
	}

	async getExpectedSize(): Promise<number> {
		let expectedSize = 0;

		const ftyp = this.findAtom('ftyp');
		const mdat = this.findAtom('mdat');
		const moov = this.findAtom('moov');

		if (!ftyp || !mdat || !moov) {
			throw new Error('ftyp, mdat and moov atoms required');
		}

		const extendOffset = this._embed ? (await this._embed.getExpectedSize()) : 0;
		let mdatOffset = 0;
		const mdatNewSize = mdat.size - mdat.header_size;

		mdatOffset += ftyp.size;
		expectedSize += ftyp.size;

		const tempH = mdat.header_size;
		const tempL = mdat.size;

		if (mdatNewSize <= MAX_INT32) {
			const freeAtom = new Atom({
				name: 'free',
				start: 0,
				size: 8,
				header_size: 8,
			});
			expectedSize += freeAtom.size;
			mdat.size += extendOffset;
			expectedSize += mdat.header_size;
			mdatOffset += 8;
			mdatOffset += 8;
		} else {
			mdat.size += extendOffset;
			mdat.header_size = 16;
			expectedSize += mdat.header_size;
			mdatOffset += 16;
		}

		mdat.header_size = tempH;
		mdat.size = tempL;

		if (this._embed) {
			expectedSize += await this._embed.getExpectedSize();
		}

		expectedSize += (mdat.size - mdat.header_size);

		const shiftOffsets = extendOffset + (mdatOffset - this._initialMdatStart!);
		await this.adjustSampleOffsets(shiftOffsets);

		expectedSize += moov.size;

		return expectedSize;
	}

	async adjustSampleOffsets(offset: number): Promise<void> {
		const sampleAtoms = this.findAtoms(null, 'stco').concat(this.findAtoms(null, 'co64'));

		log('adjusting sample offsets by', offset, 'stco co64 atoms count:', sampleAtoms.length);
		for (const atom of sampleAtoms) {
			const data = await this._readable!.getSlice(atom.start + atom.header_size, 8);
			const unpacked = Pack.unpack('>II', data);
			const verFlags = unpacked[0];
			const count = unpacked[1];

			const sampleOffsets: number[] = [];

			if (atom.name === 'stco') {
				for (let i = 0; i < count; i += 1024) {
					const cToRead = Math.min(1024, count - i);
					const readOffsets = Pack.unpack(
						'>' + 'I'.repeat(cToRead),
						await this._readable!.getSlice(atom.start + atom.header_size + 8 + i * 4, cToRead * 4),
					);
					sampleOffsets.push(...readOffsets);
				}
			} else if (atom.name === 'co64') {
				for (let i = 0; i < count; i += 1024) {
					const cToRead = Math.min(1024, count - i);
					const readOffsets = Pack.unpack(
						'>' + 'Q'.repeat(cToRead),
						await this._readable!.getSlice(atom.start + atom.header_size + 8 + i * 8, cToRead * 8),
					);
					sampleOffsets.push(...readOffsets);
				}
			}

			for (let i = 0; i < sampleOffsets.length; i++) {
				sampleOffsets[i] = sampleOffsets[i] + offset;
				if (atom.name === 'stco' && sampleOffsets[i] >= MAX_INT32) {
					atom.name = 'co64';
				}
			}

			if (atom.name === 'stco') {
				atom.contents = Pack.pack('>II', [verFlags, count]).concat(
					Pack.pack('>' + 'I'.repeat(count), sampleOffsets),
				);
				atom.size = atom.contents.length + 8;
			} else {
				atom.contents = Pack.pack('>II', [verFlags, count]).concat(
					Pack.pack('>' + 'Q'.repeat(count), sampleOffsets),
				);
				atom.size = atom.contents.length + 8;
			}

			atom.readable = null;
		}
	}

	async extractEmbedHeader(): Promise<void> {
		const mdat = this.findAtom('mdat')!;
		const offset = mdat.start + mdat.header_size;

		this._initialEmbed = new Embed();
		await this._initialEmbed.restoreFromReadable(
			this._readable!,
			{ key: this._key || undefined, password: this._password },
			offset,
		);
	}

	async extractFile(n: number, writable: IWritable | null = null): Promise<IWritable> {
		const mdat = this.findAtom('mdat')!;
		const offset = mdat.start + mdat.header_size;

		const result = await this._initialEmbed!.restoreBinary(
			this._readable!,
			{ key: this._key || undefined, password: this._password || undefined },
			n,
			offset,
			writable,
		);

		await this._readable!.close();
		return result;
	}

	async embed(writable?: IWritable): Promise<IWritable> {
		const ftyp = this.findAtom('ftyp');
		const mdat = this.findAtom('mdat');
		const moov = this.findAtom('moov');

		if (!ftyp || !mdat || !moov) {
			throw new Error('ftyp, mdat and moov atoms required');
		}

		if (!writable) {
			writable = new Writable();
		}

		const extendOffset = this._embed ? (await this._embed.getExpectedSize()) : 0;
		let mdatOffset = 0;
		const mdatNewSize = mdat.size - mdat.header_size;

		await ftyp.write(writable);
		mdatOffset += ftyp.size;

		const tempH = mdat.header_size;
		const tempL = mdat.size;

		if (mdatNewSize <= MAX_INT32) {
			const freeAtom = new Atom({
				name: 'free',
				start: 0,
				size: 8,
				header_size: 8,
			});
			await freeAtom.write(writable);
			mdat.size += extendOffset;
			await mdat.writeHeader(writable);
			mdatOffset += 8;
			mdatOffset += 8;
		} else {
			mdat.size += extendOffset;
			mdat.header_size = 16;
			await mdat.writeHeader(writable);
			mdatOffset += 16;
		}

		log('writing mdat atom start', mdatOffset);

		mdat.header_size = tempH;
		mdat.size = tempL;

		if (this._embed) {
			await this._embed.writeTo(writable);
		}

		await mdat.writePayload(writable);

		const shiftOffsets = extendOffset + (mdatOffset - this._initialMdatStart!);
		await this.adjustSampleOffsets(shiftOffsets);

		await moov.write(writable);

		await this._readable!.close();
		await writable.close();

		return writable;
	}

	async analyzeFile(): Promise<Atom[]> {
		this._atoms = [];

		const size = await this._readable!.size();
		await this.parseAtoms(0, size, null);

		this._analyzed = true;

		const mdat = this.findAtom('mdat')!;
		this._initialMdatStart = mdat.start + mdat.header_size;
		log('initial mdat atom start', this._initialMdatStart);

		try {
			await this.extractEmbedHeader();
		} catch {
			// no embedded data
		}

		return this._atoms;
	}

	printAtoms(atoms?: Atom[], level = 0): void {
		atoms = atoms || this._atoms;
		for (const a of atoms) {
			console.log(a.start, ''.padStart(level, '-'), a.name, a.size, a.header_size);
			if (a.children.length) {
				this.printAtoms(a.children, level + 1);
			}
		}
	}

	findAtom(name: string): Atom | null {
		if (!this._analyzed) {
			throw new Error('Run await analyzeFile() first');
		}
		const atoms = this.findAtoms(null, name);
		return atoms.length ? atoms[0] : null;
	}

	findAtoms(atoms: Atom[] | null, name: string): Atom[] {
		if (!this._analyzed) {
			throw new Error('Run await analyzeFile() first');
		}

		atoms = atoms || this._atoms;

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

	async parseAtoms(start: number, end: number, mother: Atom | null): Promise<Atom[]> {
		let offset = start;

		while (offset < end) {
			let atomSize = Pack.unpack('>I', await this._readable!.getSlice(offset, 4))[0];
			const atomType = Pack.unpack('>4s', await this._readable!.getSlice(offset + 4, 4))[0];
			let atomHeaderSize: number;

			if (atomSize === 1) {
				atomSize = Pack.unpack('>Q', await this._readable!.getSlice(offset + 8, 8))[0];
				atomHeaderSize = 16;
			} else {
				atomHeaderSize = 8;
				if (atomSize === 0) {
					atomSize = end - offset;
				}
			}

			const atom = new Atom({
				readable: this._readable!,
				name: String(atomType),
				start: offset,
				size: atomSize,
				header_size: atomHeaderSize,
				mother: mother,
			});

			if (mother) {
				mother.children.push(atom);
			} else {
				this._atoms.push(atom);
			}

			if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta'].includes(String(atomType))) {
				await this.parseAtoms(offset + atomHeaderSize, offset + atomSize, atom);
			}

			offset = offset + atomSize;
		}

		return this._atoms;
	}
}
