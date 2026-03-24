import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { AES } from '../src/AES.js';
import { Convert } from '../src/Convert.js';
import { Pack } from '../src/Pack.js';

describe('Convert.randomByteIn', () => {
	it('produces values with correct modulo', () => {
		let hasEvenIn0 = false;
		let hasOddIn1 = false;
		let hasWrong03 = false;
		let hasWrong13 = false;
		let hasWrong23 = false;
		let hasWrong524 = false;
		let somewrong = false;

		for (let i = 0; i < 1000000; i++) {
			const r0 = Convert.randomByteIn(2, 0);
			if (r0 % 2 === 1) hasEvenIn0 = true;

			const r1 = Convert.randomByteIn(2, 1);
			if (r1 % 2 === 0) hasOddIn1 = true;

			const r03 = Convert.randomByteIn(3, 0);
			const r13 = Convert.randomByteIn(3, 1);
			const r23 = Convert.randomByteIn(3, 2);
			if (r03 % 3 !== 0) hasWrong03 = true;
			if (r13 % 3 !== 1) hasWrong13 = true;
			if (r23 % 3 !== 2) hasWrong23 = true;
			if (!Convert.isByteIn(r03, 3, 0)) hasWrong03 = true;
			if (!Convert.isByteIn(r13, 3, 1)) hasWrong13 = true;
			if (!Convert.isByteIn(r23, 3, 2)) hasWrong23 = true;

			const r524 = Convert.randomByteIn(24, 5);
			if (r524 % 24 !== 5) hasWrong524 = true;
			if (!Convert.isByteIn(r524, 24, 5)) hasWrong524 = true;

			if (r0 < 0 || r1 < 0 || r03 < 0 || r13 < 0 || r23 < 0 || r524 < 0) somewrong = true;
			if (r0 > 255 || r1 > 255 || r03 > 255 || r13 > 255 || r23 > 255 || r524 > 255) somewrong = true;
		}

		expect(hasEvenIn0).toBe(false);
		expect(hasOddIn1).toBe(false);
		expect(hasWrong03).toBe(false);
		expect(hasWrong13).toBe(false);
		expect(hasWrong23).toBe(false);
		expect(hasWrong524).toBe(false);
		expect(somewrong).toBe(false);
	});
});

describe('AES', () => {
	it('encrypts/decrypts with key', () => {
		const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
		const plaintext = Buffer.from('test string for encryption');

		const encryptor = new AES({ key });
		const ciphertext = encryptor.encrypt(plaintext, true);
		const iv = encryptor.getIV();
		const authTag = encryptor.getAuthTag();

		expect(ciphertext.length).toBeGreaterThan(0);
		expect(plaintext.equals(ciphertext)).toBe(false);

		const decryptor = new AES({ key, iv, authTag });
		const restored = decryptor.decrypt(ciphertext, true);

		expect(restored.toString()).toBe(plaintext.toString());
	});

	it('encrypts/decrypts with password', () => {
		const password = 'my secure password';
		const plaintext = Buffer.from('test string for password encryption');

		const encryptor = new AES({ password });
		const ciphertext = encryptor.encrypt(plaintext, true);
		const iv = encryptor.getIV();
		const salt = encryptor.getSalt()!;
		const authTag = encryptor.getAuthTag();

		expect(salt.length).toBe(AES.saltByteLength);
		expect(iv.length).toBe(AES.ivByteLength);

		const decryptor = new AES({ password, iv, salt, authTag });
		const restored = decryptor.decrypt(ciphertext, true);

		expect(restored.toString()).toBe(plaintext.toString());
	});

	it('streaming encrypt/decrypt', () => {
		const key = crypto.randomBytes(32);
		const chunks = [
			Buffer.from('first chunk '),
			Buffer.from('second chunk '),
			Buffer.from('third chunk'),
		];

		const encryptor = new AES({ key });
		const encrypted: Buffer[] = [];
		encrypted.push(encryptor.encrypt(chunks[0]));
		encrypted.push(encryptor.encrypt(chunks[1]));
		encrypted.push(encryptor.encrypt(chunks[2], true));
		const iv = encryptor.getIV();
		const authTag = encryptor.getAuthTag();

		const decryptor = new AES({ key, iv, authTag });
		let restored = '';
		restored += decryptor.decrypt(encrypted[0]).toString();
		restored += decryptor.decrypt(encrypted[1]).toString();
		restored += decryptor.decrypt(encrypted[2], true).toString();

		expect(restored).toBe('first chunk second chunk third chunk');
	});

	it('detects tampered ciphertext', () => {
		const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
		const plaintext = Buffer.from('sensitive data');

		const encryptor = new AES({ key });
		const ciphertext = encryptor.encrypt(plaintext, true);
		const iv = encryptor.getIV();
		const authTag = encryptor.getAuthTag();

		const tampered = Buffer.from(ciphertext);
		tampered[0] ^= 0xff;

		const decryptor = new AES({ key, iv, authTag });
		expect(() => decryptor.decrypt(tampered, true)).toThrow();
	});
});

describe('Pack', () => {
	it('packs and unpacks large arrays', () => {
		const packedHuge = Pack.pack('>' + 'Q'.repeat(10000), new Uint8Array(10000) as unknown as unknown[]);
		expect(packedHuge.length).toBe(10000 * 8);
	});

	it('round-trips >I (uint32)', () => {
		for (const v of [0, 1, 255, 65535, 4294967295]) {
			const packed = Pack.pack('>I', [v]);
			expect(packed.length).toBe(4);
			const [unpacked] = Pack.unpack('>I', packed);
			expect(unpacked).toBe(v);
		}
	});

	it('round-trips >Q (uint64)', () => {
		for (const v of [0, 1, 4294967296, 281474976710656]) {
			const packed = Pack.pack('>Q', [v]);
			expect(packed.length).toBe(8);
			const [unpacked] = Pack.unpack('>Q', packed);
			expect(unpacked).toBe(v);
		}
	});

	it('round-trips >4s (ASCII string)', () => {
		for (const s of ['ftyp', 'mdat', 'moov', 'stco']) {
			const packed = Pack.pack('>4s', [s]);
			expect(packed.length).toBe(4);
			const [unpacked] = Pack.unpack('>4s', packed);
			expect(unpacked).toBe(s);
		}
	});

	it('round-trips >II (two uint32)', () => {
		const packed = Pack.pack('>II', [100, 200]);
		expect(packed.length).toBe(8);
		const result = Pack.unpack('>II', packed);
		expect(result).toEqual([100, 200]);
	});

	it('round-trips >I4s (uint32 + string)', () => {
		const packed = Pack.pack('>I4s', [42, 'ftyp']);
		expect(packed.length).toBe(8);
		const result = Pack.unpack('>I4s', packed);
		expect(result[0]).toBe(42);
		expect(result[1]).toBe('ftyp');
	});

	it('round-trips >I4sQ (uint32 + string + uint64)', () => {
		const packed = Pack.pack('>I4sQ', [1, 'mdat', 5000000000]);
		expect(packed.length).toBe(16);
		const result = Pack.unpack('>I4sQ', packed);
		expect(result[0]).toBe(1);
		expect(result[1]).toBe('mdat');
		expect(result[2]).toBe(5000000000);
	});

	it('round-trips repeated >IIIII', () => {
		const values = [10, 20, 30, 40, 50];
		const packed = Pack.pack('>' + 'I'.repeat(5), values);
		expect(packed.length).toBe(20);
		const result = Pack.unpack('>' + 'I'.repeat(5), packed);
		expect(result).toEqual(values);
	});
});
