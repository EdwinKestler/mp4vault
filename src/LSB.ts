/**
 * LSB.ts — Least-Significant-Bit steganography for small payloads.
 *
 * Encodes/decodes short strings (IPFS CIDs, URLs, etc.) into image pixel
 * data by modifying the least significant bit of RGB channel values.
 * Uses repetition coding for error correction to survive JPEG re-compression.
 *
 * Binary format inside pixels:
 *   [magic 16 bits: 0xDA7A] [length 16 bits] [payload N bytes] [checksum 8 bits]
 *   Each bit is repeated REDUNDANCY times across consecutive pixel channels.
 *
 * Operates on raw RGBA pixel buffers (Uint8Array from Canvas or sharp).
 */

const MAGIC = 0xDA7A; // 2 bytes
const HEADER_BITS = 16 + 16; // magic(16) + length(16)
const CHECKSUM_BITS = 8;
const DEFAULT_REDUNDANCY = 15; // each bit encoded 15 times — survives JPEG

export class LSB {
	/**
	 * Calculate how many RGB channels are needed for a payload.
	 */
	static channelsNeeded(payloadBytes: number, redundancy = DEFAULT_REDUNDANCY): number {
		const totalBits = (HEADER_BITS + payloadBytes * 8 + CHECKSUM_BITS) * redundancy;
		return totalBits;
	}

	/**
	 * Check if an image can hold the payload.
	 * @param width Image width
	 * @param height Image height
	 * @param payloadBytes Payload size in bytes
	 * @param redundancy Error correction factor
	 */
	static canFit(width: number, height: number, payloadBytes: number, redundancy = DEFAULT_REDUNDANCY): boolean {
		const availableChannels = width * height * 3; // RGB only, skip alpha
		return availableChannels >= LSB.channelsNeeded(payloadBytes, redundancy);
	}

	/**
	 * Encode a string payload into RGBA pixel data (in-place).
	 * @param pixels RGBA pixel buffer (Uint8Array, length = width * height * 4)
	 * @param payload String to encode (e.g., IPFS CID)
	 * @param redundancy Repetition factor for error correction
	 */
	static encode(pixels: Uint8Array, payload: string, redundancy = DEFAULT_REDUNDANCY): void {
		const payloadBytes = new TextEncoder().encode(payload);

		if (payloadBytes.length > 0xFFFF) {
			throw new Error('Payload too large (max 65535 bytes)');
		}

		// Build the bit stream: magic(16) + length(16) + payload + checksum(8)
		const checksum = LSB._checksum(payloadBytes);
		const rawBits: number[] = [];

		// Magic
		LSB._pushBits(rawBits, MAGIC, 16);
		// Length
		LSB._pushBits(rawBits, payloadBytes.length, 16);
		// Payload
		for (const byte of payloadBytes) {
			LSB._pushBits(rawBits, byte, 8);
		}
		// Checksum
		LSB._pushBits(rawBits, checksum, 8);

		// Apply redundancy
		const encodedBits: number[] = [];
		for (const bit of rawBits) {
			for (let r = 0; r < redundancy; r++) {
				encodedBits.push(bit);
			}
		}

		// Check capacity
		const availableChannels = (pixels.length / 4) * 3;
		if (encodedBits.length > availableChannels) {
			throw new Error(
				`Image too small: need ${encodedBits.length} channels, have ${availableChannels}. ` +
				`Try a larger image or reduce redundancy.`
			);
		}

		// Write bits into LSB of RGB channels (skip alpha at every 4th byte)
		let bitIndex = 0;
		for (let i = 0; i < pixels.length && bitIndex < encodedBits.length; i++) {
			// Skip alpha channel (every 4th byte: indices 3, 7, 11, ...)
			if ((i + 1) % 4 === 0) continue;

			pixels[i] = (pixels[i] & 0xFE) | encodedBits[bitIndex];
			bitIndex++;
		}
	}

	/**
	 * Decode a payload from RGBA pixel data.
	 * @param pixels RGBA pixel buffer
	 * @param redundancy Repetition factor (must match what was used to encode)
	 * @returns Decoded string, or null if no valid payload found
	 */
	static decode(pixels: Uint8Array, redundancy = DEFAULT_REDUNDANCY): string | null {
		// Read all LSBs from RGB channels
		const lsbBits: number[] = [];
		for (let i = 0; i < pixels.length; i++) {
			if ((i + 1) % 4 === 0) continue; // skip alpha
			lsbBits.push(pixels[i] & 1);
		}

		// Decode with majority vote
		const rawBits = LSB._majorityDecode(lsbBits, redundancy);

		if (rawBits.length < HEADER_BITS) return null;

		// Read magic
		const magic = LSB._readBits(rawBits, 0, 16);
		if (magic !== MAGIC) return null;

		// Read length
		const length = LSB._readBits(rawBits, 16, 16);
		if (length === 0 || length > 0xFFFF) return null;

		const totalRawBits = HEADER_BITS + length * 8 + CHECKSUM_BITS;
		if (rawBits.length < totalRawBits) return null;

		// Read payload bytes
		const payloadBytes = new Uint8Array(length);
		for (let i = 0; i < length; i++) {
			payloadBytes[i] = LSB._readBits(rawBits, 32 + i * 8, 8);
		}

		// Read and verify checksum
		const storedChecksum = LSB._readBits(rawBits, 32 + length * 8, 8);
		const computedChecksum = LSB._checksum(payloadBytes);
		if (storedChecksum !== computedChecksum) return null;

		return new TextDecoder().decode(payloadBytes);
	}

	/** Simple XOR checksum */
	private static _checksum(data: Uint8Array): number {
		let sum = 0;
		for (const byte of data) {
			sum ^= byte;
		}
		return sum & 0xFF;
	}

	/** Push N bits of a value (MSB first) into the bit array */
	private static _pushBits(bits: number[], value: number, count: number): void {
		for (let i = count - 1; i >= 0; i--) {
			bits.push((value >> i) & 1);
		}
	}

	/** Read N bits from the bit array starting at offset, return as number */
	private static _readBits(bits: number[], offset: number, count: number): number {
		let value = 0;
		for (let i = 0; i < count; i++) {
			value = (value << 1) | (bits[offset + i] || 0);
		}
		return value;
	}

	/** Majority-vote decode: every `redundancy` bits become 1 decoded bit */
	private static _majorityDecode(bits: number[], redundancy: number): number[] {
		const decoded: number[] = [];
		for (let i = 0; i + redundancy <= bits.length; i += redundancy) {
			let ones = 0;
			for (let r = 0; r < redundancy; r++) {
				ones += bits[i + r];
			}
			decoded.push(ones > redundancy / 2 ? 1 : 0);
		}
		return decoded;
	}
}
