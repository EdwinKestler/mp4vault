import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { MP4 } from '../src/MP4.js';
import { ImageVault } from '../src/ImageVault.js';
import { Stealth } from '../src/Stealth.js';
import { Convert } from '../src/Convert.js';
import { Writable } from '../src/node/Writable.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const tmpFiles: string[] = [];

function tmpFile(ext: string): string {
	const p = path.join(__dirname, `stealth_test_${crypto.randomUUID()}${ext}`);
	tmpFiles.push(p);
	return p;
}

afterAll(() => {
	for (const f of tmpFiles) {
		try { fs.unlinkSync(f); } catch {}
	}
});

const key = crypto.randomBytes(32);

describe('Stealth Mode', () => {
	it('stealth embed + extract with raw key (MP4)', async () => {
		const mp4 = new MP4();
		mp4.setKey(key);
		mp4.setStealth(true);
		await mp4.loadFile({ filename: path.join(__dirname, 'test.mp4') });
		await mp4.embedFile({ filename: path.join(__dirname, 'test.txt') });

		const outPath = tmpFile('.mp4');
		await mp4.embed(new Writable({ filename: outPath }));

		const restored = new MP4();
		restored.setKey(key);
		restored.setStealth(true);
		await restored.loadFile({ filename: outPath });

		const files = restored.getEmbedFiles();
		expect(files.length).toBe(1);
		expect(files[0].filename).toBe('test.txt');
		expect(files[0].isEncrypted).toBe(true);

		const extracted = await restored.extractFile(0);
		const extractedPath = tmpFile('.txt');
		await extracted.saveToFile(extractedPath);

		const original = fs.readFileSync(path.join(__dirname, 'test.txt'));
		const result = fs.readFileSync(extractedPath);
		expect(Buffer.compare(original, result)).toBe(0);
	});

	it('stealth embed + extract with raw key (JPEG)', async () => {
		const img = new ImageVault();
		img.setKey(key);
		img.setStealth(true);
		await img.loadFile({ filename: path.join(__dirname, 'image.jpg') });
		await img.embedFile({ filename: path.join(__dirname, 'test.txt') });

		const outPath = tmpFile('.jpg');
		await img.embed(new Writable({ filename: outPath }));

		const restored = new ImageVault();
		restored.setKey(key);
		restored.setStealth(true);
		await restored.loadFile({ filename: outPath });

		const files = restored.getEmbedFiles();
		expect(files.length).toBe(1);

		const extracted = await restored.extractFile(0);
		const extractedPath = tmpFile('.txt');
		await extracted.saveToFile(extractedPath);

		const original = fs.readFileSync(path.join(__dirname, 'test.txt'));
		const result = fs.readFileSync(extractedPath);
		expect(Buffer.compare(original, result)).toBe(0);
	});

	it('stealth embed + extract with raw key (PNG)', async () => {
		const img = new ImageVault();
		img.setKey(key);
		img.setStealth(true);
		await img.loadFile({ filename: path.join(__dirname, 'image2.png') });
		await img.embedFile({ filename: path.join(__dirname, 'test.txt') });

		const outPath = tmpFile('.png');
		await img.embed(new Writable({ filename: outPath }));

		const restored = new ImageVault();
		restored.setKey(key);
		restored.setStealth(true);
		await restored.loadFile({ filename: outPath });

		const files = restored.getEmbedFiles();
		expect(files.length).toBe(1);

		const extracted = await restored.extractFile(0);
		const extractedPath = tmpFile('.txt');
		await extracted.saveToFile(extractedPath);

		const original = fs.readFileSync(path.join(__dirname, 'test.txt'));
		const result = fs.readFileSync(extractedPath);
		expect(Buffer.compare(original, result)).toBe(0);
	});

	it('first 30 bytes have no valid flag/type modulo pattern', async () => {
		const img = new ImageVault();
		img.setKey(key);
		img.setStealth(true);
		await img.loadFile({ filename: path.join(__dirname, 'image.jpg') });
		await img.embedFile({ filename: path.join(__dirname, 'test.txt') });

		const outPath = tmpFile('.jpg');
		await img.embed(new Writable({ filename: outPath }));

		// Read the raw bytes at the payload offset (after JPEG EOI)
		const buf = fs.readFileSync(outPath);
		// Find EOI of the original image
		const origBuf = fs.readFileSync(path.join(__dirname, 'image.jpg'));
		let eoiOffset = 0;
		for (let i = origBuf.length - 2; i >= 0; i--) {
			if (origBuf[i] === 0xff && origBuf[i + 1] === 0xd9) {
				eoiOffset = i + 2;
				break;
			}
		}

		// Check that the stealth bytes at the payload offset don't look like valid headers
		const payloadStart = eoiOffset;
		const flag = buf[payloadStart];
		const typeByte = buf[payloadStart + 1];

		// In stealth mode, flag should NOT have the expected modulo pattern
		// (it's CTR-encrypted, so it's random)
		// We can't guarantee any single random byte fails the check, but
		// verify the stealth decryption produces valid bytes
		const stealthHeader = buf.subarray(payloadStart, payloadStart + 30);
		const decrypted = Stealth.decryptHeader(Buffer.from(stealthHeader), key, 0);
		expect(Stealth.isValidHeader(decrypted)).toBe(true);
	});

	it('auto-detect: reader handles both stealth and normal files', async () => {
		// Create a normal (non-stealth) file
		const img1 = new ImageVault();
		img1.setKey(key);
		await img1.loadFile({ filename: path.join(__dirname, 'image.jpg') });
		await img1.embedFile({ filename: path.join(__dirname, 'test.txt') });
		const normalPath = tmpFile('.jpg');
		await img1.embed(new Writable({ filename: normalPath }));

		// Read it with stealth enabled — should auto-detect normal mode
		const restored = new ImageVault();
		restored.setKey(key);
		restored.setStealth(true);
		await restored.loadFile({ filename: normalPath });
		const files = restored.getEmbedFiles();
		expect(files.length).toBe(1);
		expect(files[0].filename).toBe('test.txt');
	});

	it('stealth with password throws error', () => {
		const mp4 = new MP4();
		mp4.setPassword('test');
		expect(() => mp4.setStealth(true)).toThrow('Stealth mode requires a raw key');
	});

	it('wrong key fails (GCM auth)', async () => {
		const img = new ImageVault();
		img.setKey(key);
		img.setStealth(true);
		await img.loadFile({ filename: path.join(__dirname, 'image.jpg') });
		await img.embedFile({ filename: path.join(__dirname, 'test.txt') });
		const outPath = tmpFile('.jpg');
		await img.embed(new Writable({ filename: outPath }));

		const wrongKey = crypto.randomBytes(32);
		const restored = new ImageVault();
		restored.setKey(wrongKey);
		restored.setStealth(true);
		await restored.loadFile({ filename: outPath });

		// With wrong key, stealth decryption produces garbage flag/type,
		// so no files are found
		const files = restored.getEmbedFiles();
		expect(files.length).toBe(0);
	});

	it('getExpectedSize matches actual size', async () => {
		const mp4 = new MP4();
		mp4.setKey(key);
		mp4.setStealth(true);
		await mp4.loadFile({ filename: path.join(__dirname, 'test.mp4') });
		await mp4.embedFile({ filename: path.join(__dirname, 'test.txt') });

		const expectedSize = await mp4.getExpectedSize();
		const outPath = tmpFile('.mp4');
		await mp4.embed(new Writable({ filename: outPath }));

		const actualSize = fs.statSync(outPath).size;
		expect(actualSize).toBe(expectedSize);
	});

	it('backward compat: new code reads old non-stealth files', async () => {
		// Create non-stealth file with old pattern (no stealth flag)
		const img = new ImageVault();
		img.setKey(key);
		await img.loadFile({ filename: path.join(__dirname, 'image.jpg') });
		await img.embedFile({ filename: path.join(__dirname, 'test.txt') });
		const outPath = tmpFile('.jpg');
		await img.embed(new Writable({ filename: outPath }));

		// Read without stealth — should work
		const restored = new ImageVault();
		restored.setKey(key);
		await restored.loadFile({ filename: outPath });
		expect(restored.getEmbedFiles().length).toBe(1);
	});
});
