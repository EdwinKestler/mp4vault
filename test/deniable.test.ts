import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { MP4 } from '../src/MP4.js';
import { ImageVault } from '../src/ImageVault.js';
import { Convert } from '../src/Convert.js';
import { Writable } from '../src/node/Writable.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const tmpFiles: string[] = [];

function tmpFile(ext: string): string {
	const p = path.join(__dirname, `deniable_test_${crypto.randomUUID()}${ext}`);
	tmpFiles.push(p);
	return p;
}

afterAll(() => {
	for (const f of tmpFiles) {
		try { fs.unlinkSync(f); } catch {}
	}
});

const outerKey = crypto.randomBytes(32);
const innerKey = crypto.randomBytes(32);

describe('Deniable Dual-Layer Encryption', () => {
	let deniableMp4Path: string;

	it('creates a deniable MP4 with outer + inner files', async () => {
		const mp4 = new MP4();
		mp4.setKey(outerKey);
		mp4.setInnerKey(innerKey);
		await mp4.loadFile({ filename: path.join(__dirname, 'test.mp4') });

		await mp4.embedFile({ filename: path.join(__dirname, 'test.txt') });
		await mp4.embedFile({ filename: path.join(__dirname, 'pdf1.pdf'), inner: true });

		deniableMp4Path = tmpFile('.mp4');
		await mp4.embed(new Writable({ filename: deniableMp4Path }));

		expect(fs.existsSync(deniableMp4Path)).toBe(true);
	});

	it('outer key only → sees outer files', async () => {
		const mp4 = new MP4();
		mp4.setKey(outerKey);
		await mp4.loadFile({ filename: deniableMp4Path });

		const files = mp4.getEmbedFiles();
		expect(files.length).toBe(1);
		expect(files[0].filename).toBe('test.txt');
		expect(files[0].isEncrypted).toBe(true);
		expect(files[0].inner).toBeFalsy();
	});

	it('both keys → sees all files', async () => {
		const mp4 = new MP4();
		mp4.setKey(outerKey);
		mp4.setInnerKey(innerKey);
		await mp4.loadFile({ filename: deniableMp4Path });

		const files = mp4.getEmbedFiles();
		expect(files.length).toBe(2);
		expect(files[0].filename).toBe('test.txt');
		expect(files[0].inner).toBeFalsy();
		expect(files[1].filename).toBe('pdf1.pdf');
		expect(files[1].inner).toBe(true);
	});

	it('outer files byte-for-byte match after extract', async () => {
		const mp4 = new MP4();
		mp4.setKey(outerKey);
		await mp4.loadFile({ filename: deniableMp4Path });

		const extracted = await mp4.extractFile(0);
		const outPath = tmpFile('.txt');
		await extracted.saveToFile(outPath);

		const original = fs.readFileSync(path.join(__dirname, 'test.txt'));
		const result = fs.readFileSync(outPath);
		expect(Buffer.compare(original, result)).toBe(0);
	});

	it('inner files byte-for-byte match after extract', async () => {
		const mp4 = new MP4();
		mp4.setKey(outerKey);
		mp4.setInnerKey(innerKey);
		await mp4.loadFile({ filename: deniableMp4Path });

		const files = mp4.getEmbedFiles();
		const innerIndex = files.findIndex(f => f.inner);
		expect(innerIndex).toBeGreaterThanOrEqual(0);

		const extracted = await mp4.extractFile(innerIndex);
		const outPath = tmpFile('.pdf');
		await extracted.saveToFile(outPath);

		const original = fs.readFileSync(path.join(__dirname, 'pdf1.pdf'));
		const result = fs.readFileSync(outPath);
		expect(Buffer.compare(original, result)).toBe(0);
	});

	it('wrong outer key sees nothing', async () => {
		const mp4 = new MP4();
		mp4.setKey(crypto.randomBytes(32));
		await mp4.loadFile({ filename: deniableMp4Path });

		const files = mp4.getEmbedFiles();
		expect(files.length).toBe(0);
	});

	it('wrong inner key sees only outer files', async () => {
		const mp4 = new MP4();
		mp4.setKey(outerKey);
		mp4.setInnerKey(crypto.randomBytes(32));
		await mp4.loadFile({ filename: deniableMp4Path });

		const files = mp4.getEmbedFiles();
		expect(files.length).toBe(1);
		expect(files[0].filename).toBe('test.txt');
	});

	it('E2E via ImageVault (JPEG)', async () => {
		const img = new ImageVault();
		img.setKey(outerKey);
		img.setInnerKey(innerKey);
		await img.loadFile({ filename: path.join(__dirname, 'image.jpg') });

		await img.embedFile({ filename: path.join(__dirname, 'test.txt') });
		await img.embedFile({ filename: path.join(__dirname, 'pdf1.pdf'), inner: true });

		const outPath = tmpFile('.jpg');
		await img.embed(new Writable({ filename: outPath }));

		// Outer key only
		const outer = new ImageVault();
		outer.setKey(outerKey);
		await outer.loadFile({ filename: outPath });
		expect(outer.getEmbedFiles().length).toBe(1);
		expect(outer.getEmbedFiles()[0].filename).toBe('test.txt');

		// Both keys
		const both = new ImageVault();
		both.setKey(outerKey);
		both.setInnerKey(innerKey);
		await both.loadFile({ filename: outPath });
		expect(both.getEmbedFiles().length).toBe(2);

		// Verify inner file content
		const innerIdx = both.getEmbedFiles().findIndex(f => f.inner);
		const extracted = await both.extractFile(innerIdx);
		const extractedPath = tmpFile('.pdf');
		await extracted.saveToFile(extractedPath);

		const original = fs.readFileSync(path.join(__dirname, 'pdf1.pdf'));
		const result = fs.readFileSync(extractedPath);
		expect(Buffer.compare(original, result)).toBe(0);
	});

	it('stealth + deniable combined', async () => {
		const mp4 = new MP4();
		mp4.setKey(outerKey);
		mp4.setInnerKey(innerKey);
		mp4.setStealth(true);
		await mp4.loadFile({ filename: path.join(__dirname, 'test.mp4') });

		await mp4.embedFile({ filename: path.join(__dirname, 'test.txt') });
		await mp4.embedFile({ filename: path.join(__dirname, 'pdf1.pdf'), inner: true });

		const outPath = tmpFile('.mp4');
		await mp4.embed(new Writable({ filename: outPath }));

		// Both keys + stealth
		const restored = new MP4();
		restored.setKey(outerKey);
		restored.setInnerKey(innerKey);
		restored.setStealth(true);
		await restored.loadFile({ filename: outPath });

		const files = restored.getEmbedFiles();
		expect(files.length).toBe(2);
		expect(files[0].filename).toBe('test.txt');
		expect(files[1].filename).toBe('pdf1.pdf');
		expect(files[1].inner).toBe(true);
	});

	it('backward compat: reads old single-layer files', async () => {
		const mp4 = new MP4();
		mp4.setKey(outerKey);
		await mp4.loadFile({ filename: path.join(__dirname, 'test.mp4') });
		await mp4.embedFile({ filename: path.join(__dirname, 'test.txt') });

		const outPath = tmpFile('.mp4');
		await mp4.embed(new Writable({ filename: outPath }));

		// Read with inner key set (but no inner layer exists)
		const restored = new MP4();
		restored.setKey(outerKey);
		restored.setInnerKey(innerKey);
		await restored.loadFile({ filename: outPath });

		const files = restored.getEmbedFiles();
		expect(files.length).toBe(1);
		expect(files[0].filename).toBe('test.txt');
		expect(files[0].inner).toBeFalsy();
	});

	it('inner-only mode (no outer files)', async () => {
		const mp4 = new MP4();
		mp4.setKey(outerKey);
		mp4.setInnerKey(innerKey);
		await mp4.loadFile({ filename: path.join(__dirname, 'test.mp4') });

		// Only inner files, no outer
		await mp4.embedFile({ filename: path.join(__dirname, 'test.txt'), inner: true });

		const outPath = tmpFile('.mp4');
		await mp4.embed(new Writable({ filename: outPath }));

		// Outer key only — sees nothing (no outer files)
		const outerOnly = new MP4();
		outerOnly.setKey(outerKey);
		await outerOnly.loadFile({ filename: outPath });
		expect(outerOnly.getEmbedFiles().length).toBe(0);

		// Inner key with outer key — sees inner files
		const both = new MP4();
		both.setKey(outerKey);
		both.setInnerKey(innerKey);
		await both.loadFile({ filename: outPath });
		const files = both.getEmbedFiles();
		expect(files.length).toBe(1);
		expect(files[0].filename).toBe('test.txt');
		expect(files[0].inner).toBe(true);
	});

	it('output MP4 still valid (playable atoms)', async () => {
		const mp4 = new MP4();
		mp4.setKey(outerKey);
		mp4.setInnerKey(innerKey);
		await mp4.loadFile({ filename: path.join(__dirname, 'test.mp4') });
		await mp4.embedFile({ filename: path.join(__dirname, 'test.txt') });
		await mp4.embedFile({ filename: path.join(__dirname, 'pdf1.pdf'), inner: true });

		const outPath = tmpFile('.mp4');
		await mp4.embed(new Writable({ filename: outPath }));

		const check = new MP4();
		await check.loadFile({ filename: outPath });
		expect(check.findAtom('ftyp')).toBeTruthy();
		expect(check.findAtom('mdat')).toBeTruthy();
		expect(check.findAtom('moov')).toBeTruthy();
	});

	it('mixed key types: outer password + inner raw key', async () => {
		const mp4 = new MP4();
		mp4.setPassword('outer-pass');
		mp4.setInnerKey(innerKey);
		await mp4.loadFile({ filename: path.join(__dirname, 'test.mp4') });

		await mp4.embedFile({ filename: path.join(__dirname, 'test.txt') });
		await mp4.embedFile({ filename: path.join(__dirname, 'pdf1.pdf'), inner: true });

		const outPath = tmpFile('.mp4');
		await mp4.embed(new Writable({ filename: outPath }));

		// Extract with both
		const restored = new MP4();
		restored.setPassword('outer-pass');
		restored.setInnerKey(innerKey);
		await restored.loadFile({ filename: outPath });

		const files = restored.getEmbedFiles();
		expect(files.length).toBe(2);

		// Verify inner file
		const innerIdx = files.findIndex(f => f.inner);
		const extracted = await restored.extractFile(innerIdx);
		const extractedPath = tmpFile('.pdf');
		await extracted.saveToFile(extractedPath);

		const original = fs.readFileSync(path.join(__dirname, 'pdf1.pdf'));
		const result = fs.readFileSync(extractedPath);
		expect(Buffer.compare(original, result)).toBe(0);
	});
});
