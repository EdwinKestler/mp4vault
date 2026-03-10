import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { MP4 } from '../src/MP4.js';
import { Writable } from '../src/node/Writable.js';
import { Convert } from '../src/Convert.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const testMp4 = path.join(__dirname, 'test.mp4');
const testTxt = path.join(__dirname, 'test.txt');
const testImage = path.join(__dirname, 'image.jpg');

const tmpFiles: string[] = [];
function tmpPath(name: string): string {
	const p = path.join(__dirname, name);
	tmpFiles.push(p);
	return p;
}

afterAll(() => {
	for (const f of tmpFiles) {
		try { fs.unlinkSync(f); } catch {}
	}
});

describe('E2E: full embed and extract cycle', () => {
	it('embed text file without encryption, extract and verify', async () => {
		const mp4 = new MP4();
		await mp4.loadFile({ filename: testMp4 });

		await mp4.embedFile({ filename: testTxt });
		const outFile = tmpPath('e2e_noenc.mp4');
		const wr = new Writable({ filename: outFile });
		await mp4.embed(wr);

		const restored = new MP4();
		await restored.loadFile({ filename: outFile });

		const files = restored.getEmbedFiles();
		expect(files.length).toBe(1);
		expect(files[0].filename).toBe('test.txt');
		expect(files[0].isEncrypted).toBe(false);

		const extracted = await restored.extractFile(0);
		const extractedPath = tmpPath('e2e_noenc_extracted.txt');
		await (extracted as Writable).saveToFile(extractedPath);

		expect(fs.readFileSync(extractedPath, 'utf-8')).toBe(fs.readFileSync(testTxt, 'utf-8'));
	});

	it('embed text file with key encryption, extract and verify', async () => {
		const key = Convert.hexStringToBuffer('000102030405060708090a0b0c0d0e0f');

		const mp4 = new MP4();
		mp4.setKey(key);
		await mp4.loadFile({ filename: testMp4 });

		await mp4.embedFile({ filename: testTxt });
		const outFile = tmpPath('e2e_key.mp4');
		const wr = new Writable({ filename: outFile });
		await mp4.embed(wr);

		const restored = new MP4();
		restored.setKey(key);
		await restored.loadFile({ filename: outFile });

		const files = restored.getEmbedFiles();
		expect(files.length).toBe(1);
		expect(files[0].isEncrypted).toBe(true);

		const extracted = await restored.extractFile(0);
		const extractedPath = tmpPath('e2e_key_extracted.txt');
		await (extracted as Writable).saveToFile(extractedPath);

		expect(fs.readFileSync(extractedPath, 'utf-8')).toBe(fs.readFileSync(testTxt, 'utf-8'));
	});

	it('embed text file with password encryption, extract and verify', async () => {
		const password = 'my-secret-password-123';

		const mp4 = new MP4();
		mp4.setPassword(password);
		await mp4.loadFile({ filename: testMp4 });

		await mp4.embedFile({ filename: testTxt });
		const outFile = tmpPath('e2e_pass.mp4');
		const wr = new Writable({ filename: outFile });
		await mp4.embed(wr);

		const restored = new MP4();
		restored.setPassword(password);
		await restored.loadFile({ filename: outFile });

		const files = restored.getEmbedFiles();
		expect(files.length).toBe(1);
		expect(files[0].isEncrypted).toBe(true);

		const extracted = await restored.extractFile(0);
		const extractedPath = tmpPath('e2e_pass_extracted.txt');
		await (extracted as Writable).saveToFile(extractedPath);

		expect(fs.readFileSync(extractedPath, 'utf-8')).toBe(fs.readFileSync(testTxt, 'utf-8'));
	});

	it('embed binary file (image) with key encryption, extract and verify byte-for-byte', async () => {
		const key = crypto.randomBytes(32);

		const mp4 = new MP4();
		mp4.setKey(key);
		await mp4.loadFile({ filename: testMp4 });

		await mp4.embedFile({ filename: testImage });
		const outFile = tmpPath('e2e_image.mp4');
		const wr = new Writable({ filename: outFile });
		await mp4.embed(wr);

		const restored = new MP4();
		restored.setKey(key);
		await restored.loadFile({ filename: outFile });

		const files = restored.getEmbedFiles();
		expect(files.length).toBe(1);
		expect(files[0].filename).toBe('image.jpg');

		const extracted = await restored.extractFile(0);
		const extractedPath = tmpPath('e2e_image_extracted.jpg');
		await (extracted as Writable).saveToFile(extractedPath);

		const originalBuf = fs.readFileSync(testImage);
		const extractedBuf = fs.readFileSync(extractedPath);
		expect(Buffer.compare(originalBuf, extractedBuf)).toBe(0);
	});

	it('embed multiple files (public + encrypted), extract both', async () => {
		const key = Convert.hexStringToBuffer('000102030405060708090a0b0c0d0e0f');

		const mp4 = new MP4();
		mp4.setKey(key);
		await mp4.loadFile({ filename: testMp4 });

		await mp4.embedFile({ filename: testTxt, password: null }); // public
		await mp4.embedFile({ filename: testImage }); // encrypted with key

		const outFile = tmpPath('e2e_multi.mp4');
		const wr = new Writable({ filename: outFile });
		await mp4.embed(wr);

		const restored = new MP4();
		restored.setKey(key);
		await restored.loadFile({ filename: outFile });

		const files = restored.getEmbedFiles();
		expect(files.length).toBe(2);
		expect(files[0].isEncrypted).toBe(false);
		expect(files[0].filename).toBe('test.txt');
		expect(files[1].isEncrypted).toBe(true);
		expect(files[1].filename).toBe('image.jpg');

		// extract public file
		const ext0 = await restored.extractFile(0);
		const ext0Path = tmpPath('e2e_multi_public.txt');
		await (ext0 as Writable).saveToFile(ext0Path);
		expect(fs.readFileSync(ext0Path, 'utf-8')).toBe(fs.readFileSync(testTxt, 'utf-8'));

		// extract encrypted file
		const ext1 = await restored.extractFile(1);
		const ext1Path = tmpPath('e2e_multi_encrypted.jpg');
		await (ext1 as Writable).saveToFile(ext1Path);
		expect(Buffer.compare(fs.readFileSync(testImage), fs.readFileSync(ext1Path))).toBe(0);
	});

	it('output mp4 is a valid mp4 (ftyp, mdat, moov atoms present)', async () => {
		const key = crypto.randomBytes(16);

		const mp4 = new MP4();
		mp4.setKey(key);
		await mp4.loadFile({ filename: testMp4 });

		await mp4.embedFile({ filename: testImage });
		const outFile = tmpPath('e2e_valid.mp4');
		const wr = new Writable({ filename: outFile });
		await mp4.embed(wr);

		const check = new MP4();
		check.setKey(key);
		await check.loadFile({ filename: outFile });

		expect(check.findAtom('ftyp')).toBeTruthy();
		expect(check.findAtom('mdat')).toBeTruthy();
		expect(check.findAtom('moov')).toBeTruthy();

		// stco/co64 sample offsets should exist
		const stco = check.findAtoms(null, 'stco');
		const co64 = check.findAtoms(null, 'co64');
		expect(stco.length + co64.length).toBeGreaterThan(0);
	});

	it('getExpectedSize matches actual output size', async () => {
		const key = Convert.hexStringToBuffer('000102030405060708090a0b0c0d0e0f');

		const mp4 = new MP4();
		mp4.setKey(key);
		await mp4.loadFile({ filename: testMp4 });

		await mp4.embedFile({ filename: testTxt });
		const expectedSize = await mp4.getExpectedSize();

		const outFile = tmpPath('e2e_size.mp4');
		const wr = new Writable({ filename: outFile });
		await mp4.embed(wr);

		const actualSize = fs.statSync(outFile).size;
		expect(actualSize).toBe(expectedSize);
	});

	it('embed with meta, extract and verify meta is preserved', async () => {
		const key = crypto.randomBytes(24); // AES-192

		const mp4 = new MP4();
		mp4.setKey(key);
		await mp4.loadFile({ filename: testMp4 });

		const meta = { author: 'test-user', version: 42, tags: ['a', 'b', 'c'] };
		await mp4.embedFile({ filename: testTxt, meta });
		const outFile = tmpPath('e2e_meta.mp4');
		const wr = new Writable({ filename: outFile });
		await mp4.embed(wr);

		const restored = new MP4();
		restored.setKey(key);
		await restored.loadFile({ filename: outFile });

		const files = restored.getEmbedFiles();
		expect(files[0].meta).toBeDefined();
		expect(files[0].meta!.author).toBe('test-user');
		expect(files[0].meta!.version).toBe(42);
		expect(files[0].meta!.tags).toEqual(['a', 'b', 'c']);
	});

	it('wrong key cannot read encrypted file list', async () => {
		const key = Convert.hexStringToBuffer('000102030405060708090a0b0c0d0e0f');

		const mp4 = new MP4();
		mp4.setKey(key);
		await mp4.loadFile({ filename: testMp4 });

		await mp4.embedFile({ filename: testTxt });
		const outFile = tmpPath('e2e_wrongkey.mp4');
		const wr = new Writable({ filename: outFile });
		await mp4.embed(wr);

		// load with wrong key — encrypted header can't be decrypted
		const wrongKey = Convert.hexStringToBuffer('ff0102030405060708090a0b0c0d0e0f');
		const restored = new MP4();
		restored.setKey(wrongKey);
		await restored.loadFile({ filename: outFile });

		// encrypted files should not be visible with wrong key
		const files = restored.getEmbedFiles();
		const encryptedFiles = files.filter(f => f.isEncrypted);
		expect(encryptedFiles.length).toBe(0);
	});

	it('re-embed: embed into already-embedded mp4', async () => {
		const key = crypto.randomBytes(32);

		// first embed
		const mp4 = new MP4();
		mp4.setKey(key);
		await mp4.loadFile({ filename: testMp4 });
		await mp4.embedFile({ filename: testTxt });
		const firstOut = tmpPath('e2e_reembed_1.mp4');
		const wr1 = new Writable({ filename: firstOut });
		await mp4.embed(wr1);

		// second embed into the first output
		const mp4b = new MP4();
		mp4b.setKey(key);
		await mp4b.loadFile({ filename: firstOut });
		await mp4b.embedFile({ filename: testImage });
		const secondOut = tmpPath('e2e_reembed_2.mp4');
		const wr2 = new Writable({ filename: secondOut });
		await mp4b.embed(wr2);

		// verify second embed's file is extractable
		const restored = new MP4();
		restored.setKey(key);
		await restored.loadFile({ filename: secondOut });

		const files = restored.getEmbedFiles();
		expect(files.length).toBeGreaterThan(0);
		expect(files[0].filename).toBe('image.jpg');

		const extracted = await restored.extractFile(0);
		const extractedPath = tmpPath('e2e_reembed_extracted.jpg');
		await (extracted as Writable).saveToFile(extractedPath);
		expect(Buffer.compare(fs.readFileSync(testImage), fs.readFileSync(extractedPath))).toBe(0);
	});

	it('output mp4 is larger than input by at least the embedded file size', async () => {
		const mp4 = new MP4();
		await mp4.loadFile({ filename: testMp4 });

		await mp4.embedFile({ filename: testImage });
		const outFile = tmpPath('e2e_sizecheck.mp4');
		const wr = new Writable({ filename: outFile });
		await mp4.embed(wr);

		const originalSize = fs.statSync(testMp4).size;
		const outputSize = fs.statSync(outFile).size;
		const embeddedSize = fs.statSync(testImage).size;

		expect(outputSize).toBeGreaterThanOrEqual(originalSize + embeddedSize);
	});
});
