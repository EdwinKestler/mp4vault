import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ImageVault } from '../src/ImageVault.js';
import { Writable } from '../src/node/Writable.js';
import { Convert } from '../src/Convert.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const testJpeg = path.join(__dirname, 'image1.jpg');
const testPng = path.join(__dirname, 'image2.png');
const testTxt = path.join(__dirname, 'test.txt');
const testImage = path.join(__dirname, 'image.jpg');
const testPdf = path.join(__dirname, 'pdf1.pdf');

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

describe('ImageVault: JPEG', () => {
	it('embed text without encryption, extract and verify', async () => {
		const img = new ImageVault();
		await img.loadFile({ filename: testJpeg });

		await img.embedFile({ filename: testTxt });
		const outFile = tmpPath('iv_noenc.jpg');
		const wr = new Writable({ filename: outFile });
		await img.embed(wr);

		const restored = new ImageVault();
		await restored.loadFile({ filename: outFile });

		const files = restored.getEmbedFiles();
		expect(files.length).toBe(1);
		expect(files[0].filename).toBe('test.txt');
		expect(files[0].isEncrypted).toBe(false);

		const extracted = await restored.extractFile(0);
		const extractedPath = tmpPath('iv_noenc_extracted.txt');
		await (extracted as Writable).saveToFile(extractedPath);

		expect(fs.readFileSync(extractedPath, 'utf-8')).toBe(fs.readFileSync(testTxt, 'utf-8'));
	});

	it('embed text with key encryption, extract and verify', async () => {
		const key = Convert.hexStringToBuffer('000102030405060708090a0b0c0d0e0f');

		const img = new ImageVault();
		img.setKey(key);
		await img.loadFile({ filename: testJpeg });

		await img.embedFile({ filename: testTxt });
		const outFile = tmpPath('iv_key.jpg');
		const wr = new Writable({ filename: outFile });
		await img.embed(wr);

		const restored = new ImageVault();
		restored.setKey(key);
		await restored.loadFile({ filename: outFile });

		const files = restored.getEmbedFiles();
		expect(files.length).toBe(1);
		expect(files[0].isEncrypted).toBe(true);

		const extracted = await restored.extractFile(0);
		const extractedPath = tmpPath('iv_key_extracted.txt');
		await (extracted as Writable).saveToFile(extractedPath);

		expect(fs.readFileSync(extractedPath, 'utf-8')).toBe(fs.readFileSync(testTxt, 'utf-8'));
	});

	it('embed binary (PDF) with password, extract byte-for-byte', async () => {
		const password = 'my-secret-password-123';

		const img = new ImageVault();
		img.setPassword(password);
		await img.loadFile({ filename: testJpeg });

		await img.embedFile({ filename: testPdf });
		const outFile = tmpPath('iv_pass.jpg');
		const wr = new Writable({ filename: outFile });
		await img.embed(wr);

		const restored = new ImageVault();
		restored.setPassword(password);
		await restored.loadFile({ filename: outFile });

		const files = restored.getEmbedFiles();
		expect(files.length).toBe(1);
		expect(files[0].filename).toBe('pdf1.pdf');

		const extracted = await restored.extractFile(0);
		const extractedPath = tmpPath('iv_pass_extracted.pdf');
		await (extracted as Writable).saveToFile(extractedPath);

		expect(Buffer.compare(
			fs.readFileSync(testPdf),
			fs.readFileSync(extractedPath),
		)).toBe(0);
	});

	it('embed multiple files (public + encrypted), extract both', async () => {
		const key = crypto.randomBytes(32);

		const img = new ImageVault();
		img.setKey(key);
		await img.loadFile({ filename: testJpeg });

		await img.embedFile({ filename: testTxt, password: null }); // public
		await img.embedFile({ filename: testImage }); // encrypted

		const outFile = tmpPath('iv_multi.jpg');
		const wr = new Writable({ filename: outFile });
		await img.embed(wr);

		const restored = new ImageVault();
		restored.setKey(key);
		await restored.loadFile({ filename: outFile });

		const files = restored.getEmbedFiles();
		expect(files.length).toBe(2);
		expect(files[0].isEncrypted).toBe(false);
		expect(files[0].filename).toBe('test.txt');
		expect(files[1].isEncrypted).toBe(true);
		expect(files[1].filename).toBe('image.jpg');

		const ext0 = await restored.extractFile(0);
		const ext0Path = tmpPath('iv_multi_public.txt');
		await (ext0 as Writable).saveToFile(ext0Path);
		expect(fs.readFileSync(ext0Path, 'utf-8')).toBe(fs.readFileSync(testTxt, 'utf-8'));

		const ext1 = await restored.extractFile(1);
		const ext1Path = tmpPath('iv_multi_encrypted.jpg');
		await (ext1 as Writable).saveToFile(ext1Path);
		expect(Buffer.compare(fs.readFileSync(testImage), fs.readFileSync(ext1Path))).toBe(0);
	});

	it('output is still a valid JPEG', async () => {
		const img = new ImageVault();
		await img.loadFile({ filename: testJpeg });
		await img.embedFile({ filename: testTxt });

		const outFile = tmpPath('iv_valid.jpg');
		const wr = new Writable({ filename: outFile });
		await img.embed(wr);

		const header = Buffer.alloc(2);
		const fd = fs.openSync(outFile, 'r');
		fs.readSync(fd, header, 0, 2, 0);
		fs.closeSync(fd);

		expect(header[0]).toBe(0xff);
		expect(header[1]).toBe(0xd8);
	});

	it('wrong key cannot read encrypted file list', async () => {
		const key = Convert.hexStringToBuffer('000102030405060708090a0b0c0d0e0f');

		const img = new ImageVault();
		img.setKey(key);
		await img.loadFile({ filename: testJpeg });
		await img.embedFile({ filename: testTxt });

		const outFile = tmpPath('iv_wrongkey.jpg');
		const wr = new Writable({ filename: outFile });
		await img.embed(wr);

		const wrongKey = Convert.hexStringToBuffer('ff0102030405060708090a0b0c0d0e0f');
		const restored = new ImageVault();
		restored.setKey(wrongKey);
		await restored.loadFile({ filename: outFile });

		const files = restored.getEmbedFiles();
		const encryptedFiles = files.filter(f => f.isEncrypted);
		expect(encryptedFiles.length).toBe(0);
	});

	it('getExpectedSize matches actual output size', async () => {
		const key = Convert.hexStringToBuffer('000102030405060708090a0b0c0d0e0f');

		const img = new ImageVault();
		img.setKey(key);
		await img.loadFile({ filename: testJpeg });
		await img.embedFile({ filename: testTxt });

		const expectedSize = await img.getExpectedSize();

		const outFile = tmpPath('iv_size.jpg');
		const wr = new Writable({ filename: outFile });
		await img.embed(wr);

		expect(fs.statSync(outFile).size).toBe(expectedSize);
	});
});

describe('ImageVault: PNG', () => {
	it('embed text without encryption, extract and verify', async () => {
		const img = new ImageVault();
		await img.loadFile({ filename: testPng });

		await img.embedFile({ filename: testTxt });
		const outFile = tmpPath('iv_png_noenc.png');
		const wr = new Writable({ filename: outFile });
		await img.embed(wr);

		const restored = new ImageVault();
		await restored.loadFile({ filename: outFile });

		const files = restored.getEmbedFiles();
		expect(files.length).toBe(1);
		expect(files[0].filename).toBe('test.txt');

		const extracted = await restored.extractFile(0);
		const extractedPath = tmpPath('iv_png_noenc_extracted.txt');
		await (extracted as Writable).saveToFile(extractedPath);

		expect(fs.readFileSync(extractedPath, 'utf-8')).toBe(fs.readFileSync(testTxt, 'utf-8'));
	});

	it('embed with key encryption, extract and verify', async () => {
		const key = crypto.randomBytes(32);

		const img = new ImageVault();
		img.setKey(key);
		await img.loadFile({ filename: testPng });

		await img.embedFile({ filename: testPdf });
		const outFile = tmpPath('iv_png_key.png');
		const wr = new Writable({ filename: outFile });
		await img.embed(wr);

		const restored = new ImageVault();
		restored.setKey(key);
		await restored.loadFile({ filename: outFile });

		const files = restored.getEmbedFiles();
		expect(files.length).toBe(1);
		expect(files[0].isEncrypted).toBe(true);

		const extracted = await restored.extractFile(0);
		const extractedPath = tmpPath('iv_png_key_extracted.pdf');
		await (extracted as Writable).saveToFile(extractedPath);

		expect(Buffer.compare(fs.readFileSync(testPdf), fs.readFileSync(extractedPath))).toBe(0);

		// output starts with PNG signature
		const header = Buffer.alloc(8);
		const fd = fs.openSync(outFile, 'r');
		fs.readSync(fd, header, 0, 8, 0);
		fs.closeSync(fd);
		expect(header[0]).toBe(0x89);
		expect(header[1]).toBe(0x50); // P
		expect(header[2]).toBe(0x4e); // N
		expect(header[3]).toBe(0x47); // G
	});
});
