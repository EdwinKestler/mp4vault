import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

export function tmpFileSync(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp4vault-'));
	return path.join(dir, crypto.randomUUID());
}
