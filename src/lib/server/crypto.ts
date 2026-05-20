import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const NONCE_LEN = 12;
const TAG_LEN = 16;

/**
 * Encrypts a UTF-8 string. Layout of returned buffer:
 *   [12-byte nonce][ciphertext][16-byte auth tag]
 */
export function encryptToken(plaintext: string, key: Buffer): Buffer {
	if (key.length !== 32) throw new Error('crypto: key must be 32 bytes');
	const nonce = randomBytes(NONCE_LEN);
	const cipher = createCipheriv(ALGO, key, nonce);
	const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return Buffer.concat([nonce, enc, tag]);
}

export function decryptToken(blob: Buffer, key: Buffer): string {
	if (key.length !== 32) throw new Error('crypto: key must be 32 bytes');
	if (blob.length < NONCE_LEN + TAG_LEN) throw new Error('crypto: blob too short');
	const nonce = blob.subarray(0, NONCE_LEN);
	const tag = blob.subarray(blob.length - TAG_LEN);
	const ct = blob.subarray(NONCE_LEN, blob.length - TAG_LEN);
	const decipher = createDecipheriv(ALGO, key, nonce);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export function loadKey(): Buffer {
	const hex = process.env.TOKEN_ENC_KEY;
	if (!hex) throw new Error('TOKEN_ENC_KEY env var missing');
	const buf = Buffer.from(hex, 'hex');
	if (buf.length !== 32) throw new Error('TOKEN_ENC_KEY must be 32 bytes (64 hex chars)');
	return buf;
}
