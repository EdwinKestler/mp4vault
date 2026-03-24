import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { EmbedBinary } from '../src/EmbedBinary.js';
import { Writable } from '../src/node/Writable.js';
import { Convert } from '../src/Convert.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);

afterAll(() => {
	for (const f of ['test_restored_raw.txt', 'test_restored_key.txt', 'test_restored_pass.txt']) {
		try { fs.unlinkSync(path.join(__dirname, f)); } catch {}
	}
});

describe('EmbedBinary', () => {
	it('works without encryption', async () => {
		const embedBinary = new EmbedBinary({ filename: path.join(__dirname, 'test.txt') });
		const writable = new Writable();

		await embedBinary.writeTo(writable);
		expect(writable.size()).toBeGreaterThan(0);

		const readable = await writable.toReadable();
		const restored = await EmbedBinary.restoreFromReadable(readable);
		await readable.close();
		await (restored as Writable).saveToFile(path.join(__dirname, 'test_restored_raw.txt'));

		const original = fs.readFileSync(path.join(__dirname, 'test.txt'), 'utf-8');
		const restoredTXT = fs.readFileSync(path.join(__dirname, 'test_restored_raw.txt'), 'utf-8');
		expect(original).toBe(restoredTXT);
	});

	it('works with key encryption', async () => {
		const key = Convert.hexStringToBuffer('000102030405060708090a0b0c0d0e0f');
		const embedBinary = new EmbedBinary({ filename: path.join(__dirname, 'test.txt'), key });
		const writable = new Writable();

		await embedBinary.writeTo(writable);
		expect(writable.size()).toBeGreaterThan(0);

		const readable = await writable.toReadable();
		const restored = await EmbedBinary.restoreFromReadable(readable, { key });
		await readable.close();
		await (restored as Writable).saveToFile(path.join(__dirname, 'test_restored_key.txt'));

		const original = fs.readFileSync(path.join(__dirname, 'test.txt'), 'utf-8');
		const restoredTXT = fs.readFileSync(path.join(__dirname, 'test_restored_key.txt'), 'utf-8');
		expect(original).toBe(restoredTXT);
	});

	it('works with password encryption', async () => {
		const password = 'testpassword';
		const embedBinary = new EmbedBinary({ filename: path.join(__dirname, 'test.txt'), password });
		const writable = new Writable();

		await embedBinary.writeTo(writable);
		expect(writable.size()).toBeGreaterThan(0);

		const readable = await writable.toReadable();
		const restored = await EmbedBinary.restoreFromReadable(readable, { password });
		await readable.close();
		await (restored as Writable).saveToFile(path.join(__dirname, 'test_restored_pass.txt'));

		const original = fs.readFileSync(path.join(__dirname, 'test.txt'), 'utf-8');
		const restoredTXT = fs.readFileSync(path.join(__dirname, 'test_restored_pass.txt'), 'utf-8');
		expect(original).toBe(restoredTXT);
	});

	it('works with password encryption at offset', async () => {
		const password = 'testpassword';
		const embedBinary = new EmbedBinary({ filename: path.join(__dirname, 'test.txt'), password });
		const writable = new Writable();

		await writable.write(new Uint8Array(100000));
		await embedBinary.writeTo(writable);

		const expectedSize = await embedBinary.getExpectedSize();
		await embedBinary._readable!.close();
		await writable.write(new Uint8Array(100000));

		expect(writable.size()).toBeGreaterThan(200000);

		const readable = await writable.toReadable();
		const restored = await EmbedBinary.restoreFromReadable(readable, { password }, 100000, expectedSize);
		await readable.close();
		await (restored as Writable).saveToFile(path.join(__dirname, 'test_restored_pass.txt'));

		const original = fs.readFileSync(path.join(__dirname, 'test.txt'), 'utf-8');
		const restoredTXT = fs.readFileSync(path.join(__dirname, 'test_restored_pass.txt'), 'utf-8');
		expect(original).toBe(restoredTXT);
	});
});
