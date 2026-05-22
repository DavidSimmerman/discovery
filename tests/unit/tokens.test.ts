import { describe, it, expect, vi, beforeEach } from 'vitest';
import { encryptToken } from '../../src/lib/server/crypto';

const KEY = Buffer.from('00'.repeat(32), 'hex');

// loadKey() reads TOKEN_ENC_KEY via $env/dynamic/private; set it before importing crypto consumers.
process.env.TOKEN_ENC_KEY = '00'.repeat(32);

// --- mocks (hoisted so the vi.mock factories can reference them) ------------
// db.select().from().where().limit() resolves to an array of rows.
// db.update().set().where() resolves (return value unused).
const h = vi.hoisted(() => {
	const state = { selectRows: [] as unknown[] };
	const setSpy = vi.fn();
	const refreshAccessToken = vi.fn();
	const db = {
		select: vi.fn(() => ({
			from: vi.fn(() => ({
				where: vi.fn(() => ({
					limit: vi.fn(() => Promise.resolve(state.selectRows)),
				})),
			})),
		})),
		update: vi.fn(() => ({
			set: vi.fn((vals: unknown) => {
				setSpy(vals);
				return { where: vi.fn(() => Promise.resolve()) };
			}),
		})),
	};
	return { state, setSpy, refreshAccessToken, db };
});
const { setSpy, refreshAccessToken } = h;

vi.mock('$lib/server/db', () => ({ db: h.db }));
vi.mock('$lib/server/db/schema', () => ({ spotifyTokens: { userId: 'user_id' } }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn(() => 'eq-cond') }));
vi.mock('$lib/server/spotify', () => ({ refreshAccessToken: h.refreshAccessToken }));

// --- crypto: keep real loadKey but pin it to the test key -------------------
vi.mock('$lib/server/crypto', async () => {
	const actual = await vi.importActual<typeof import('../../src/lib/server/crypto')>(
		'../../src/lib/server/crypto'
	);
	return { ...actual, loadKey: () => KEY };
});

import { getValidAccessToken } from '../../src/lib/server/tokens';

const USER = 'user-1';

beforeEach(() => {
	vi.clearAllMocks();
	h.state.selectRows = [];
});

function tokenRow(overrides: Record<string, unknown> = {}) {
	return {
		userId: USER,
		accessToken: 'cached-access',
		expiresAt: new Date(Date.now() + 3600_000),
		refreshTokenEnc: encryptToken('old-refresh', KEY),
		updatedAt: new Date(),
		...overrides,
	};
}

describe('getValidAccessToken', () => {
	it('returns the cached token when not expired', async () => {
		h.state.selectRows = [tokenRow()];
		const token = await getValidAccessToken(USER);
		expect(token).toBe('cached-access');
		expect(refreshAccessToken).not.toHaveBeenCalled();
	});

	it('refreshes when expired', async () => {
		h.state.selectRows = [tokenRow({ expiresAt: new Date(Date.now() - 1000) })];
		refreshAccessToken.mockResolvedValue({
			access_token: 'fresh-access',
			refresh_token: 'new-refresh',
			expires_in: 3600,
		});
		const token = await getValidAccessToken(USER);
		expect(token).toBe('fresh-access');
		expect(refreshAccessToken).toHaveBeenCalledWith('old-refresh');
		expect(setSpy).toHaveBeenCalledWith(
			expect.objectContaining({ accessToken: 'fresh-access' })
		);
	});

	it('preserves the old refresh token when Spotify omits a new one', async () => {
		// refreshAccessToken already falls back to the old token, so it returns old-refresh here.
		h.state.selectRows = [tokenRow({ expiresAt: new Date(Date.now() - 1000) })];
		refreshAccessToken.mockResolvedValue({
			access_token: 'fresh-access',
			refresh_token: 'old-refresh',
			expires_in: 3600,
		});
		await getValidAccessToken(USER);
		const written = setSpy.mock.calls[0][0] as { refreshTokenEnc: Buffer };
		const { decryptToken } = await import('../../src/lib/server/crypto');
		expect(decryptToken(written.refreshTokenEnc, KEY)).toBe('old-refresh');
	});

	it('shares a single in-flight refresh between concurrent callers', async () => {
		h.state.selectRows = [tokenRow({ expiresAt: new Date(Date.now() - 1000) })];
		let resolveRefresh!: (v: unknown) => void;
		refreshAccessToken.mockReturnValue(
			new Promise((resolve) => {
				resolveRefresh = resolve;
			})
		);

		const p1 = getValidAccessToken(USER);
		const p2 = getValidAccessToken(USER);

		// Both callers first await the DB select, so refreshAccessToken hasn't run yet.
		// Spin the microtask queue until the executor has assigned resolveRefresh.
		await vi.waitFor(() => expect(refreshAccessToken).toHaveBeenCalled());
		resolveRefresh({ access_token: 'fresh-access', refresh_token: 'new-refresh', expires_in: 3600 });

		const [t1, t2] = await Promise.all([p1, p2]);
		expect(t1).toBe('fresh-access');
		expect(t2).toBe('fresh-access');
		expect(refreshAccessToken).toHaveBeenCalledTimes(1);
	});
});
