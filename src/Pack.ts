const FORMAT_RE = /(\d+)?([IQs])/g;

const TOKEN_SIZE: Record<string, number> = { I: 4, Q: 8, s: 1 };

interface Token {
	count: number;
	type: string;
}

function parseFormat(fmt: string): Token[] {
	const tokens: Token[] = [];
	let m: RegExpExecArray | null;
	FORMAT_RE.lastIndex = 0;
	while ((m = FORMAT_RE.exec(fmt)) !== null) {
		const count = m[1] ? parseInt(m[1], 10) : 1;
		tokens.push({ count, type: m[2] });
	}
	return tokens;
}

function calcLength(tokens: Token[]): number {
	let len = 0;
	for (const t of tokens) {
		len += t.count * TOKEN_SIZE[t.type];
	}
	return len;
}

export class Pack {
	static pack(format: string, values: unknown[]): number[] {
		const tokens = parseFormat(format);
		const buf = Buffer.alloc(calcLength(tokens));
		let offset = 0;
		let vi = 0;

		for (const t of tokens) {
			if (t.type === 's') {
				const str = values[vi++] as string;
				for (let i = 0; i < t.count; i++) {
					buf[offset++] = i < str.length ? str.charCodeAt(i) : 0;
				}
			} else if (t.type === 'I') {
				for (let i = 0; i < t.count; i++) {
					buf.writeUInt32BE((values[vi++] as number) >>> 0, offset);
					offset += 4;
				}
			} else if (t.type === 'Q') {
				for (let i = 0; i < t.count; i++) {
					const v = values[vi++] as number;
					buf.writeBigUInt64BE(BigInt(Math.trunc(v)), offset);
					offset += 8;
				}
			}
		}

		return Array.from(buf);
	}

	static unpack(format: string, buffer: Uint8Array | number[]): number[] {
		const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
		const tokens = parseFormat(format);
		const result: (number | string)[] = [];
		let offset = 0;

		for (const t of tokens) {
			if (t.type === 's') {
				result.push(buf.toString('ascii', offset, offset + t.count));
				offset += t.count;
			} else if (t.type === 'I') {
				for (let i = 0; i < t.count; i++) {
					result.push(buf.readUInt32BE(offset));
					offset += 4;
				}
			} else if (t.type === 'Q') {
				for (let i = 0; i < t.count; i++) {
					result.push(Number(buf.readBigUInt64BE(offset)));
					offset += 8;
				}
			}
		}

		return result as number[];
	}
}
