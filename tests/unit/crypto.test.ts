import { describe, it, expect } from 'vitest';
import { encryptToken, decryptToken } from '../../src/lib/server/crypto';

const KEY = Buffer.from('00'.repeat(32), 'hex'); // 32 zero bytes for test

describe('crypto', () => {
	it('round-trips a string', () => {
		const enc = encryptToken('hello-refresh-token', KEY);
		const dec = decryptToken(enc, KEY);
		expect(dec).toBe('hello-refresh-token');
	});

	it('produces different ciphertext each call (random nonce)', () => {
		const a = encryptToken('same-input', KEY);
		const b = encryptToken('same-input', KEY);
		expect(Buffer.compare(a, b)).not.toBe(0);
	});

	it('throws on tampered ciphertext', () => {
		const enc = encryptToken('hello', KEY);
		enc[enc.length - 1] ^= 0xff; // flip the last byte (in the auth tag)
		expect(() => decryptToken(enc, KEY)).toThrow();
	});

	it('throws on wrong key', () => {
		const enc = encryptToken('hello', KEY);
		const wrong = Buffer.from('ff'.repeat(32), 'hex');
		expect(() => decryptToken(enc, wrong)).toThrow();
	});
});
