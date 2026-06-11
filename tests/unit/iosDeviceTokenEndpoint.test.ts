import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  mintDeviceToken: vi.fn(),
  readSessionCookie: vi.fn(),
}));

vi.mock('$lib/server/deviceTokens', () => ({ mintDeviceToken: h.mintDeviceToken }));
vi.mock('$lib/server/session', () => ({ readSessionCookie: h.readSessionCookie }));

import { POST } from '../../src/routes/api/ios/device-token/+server';

function event(opts: { user?: { id: string }; cookieUserId?: string | null; body?: unknown }) {
  return {
    locals: { user: opts.user ?? null },
    cookies: {},
    request: { json: async () => opts.body ?? {} },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.mintDeviceToken.mockResolvedValue('minted-token-value');
  h.readSessionCookie.mockReturnValue('user-1');
});

describe('POST /api/ios/device-token', () => {
  it('401s when unauthenticated', async () => {
    await expect(POST(event({ user: undefined }))).rejects.toMatchObject({ status: 401 });
  });

  it('403s for bearer-authed callers (no session cookie) — tokens cannot mint tokens', async () => {
    h.readSessionCookie.mockReturnValue(null);
    await expect(POST(event({ user: { id: 'user-1' } }))).rejects.toMatchObject({ status: 403 });
    expect(h.mintDeviceToken).not.toHaveBeenCalled();
  });

  it('mints and returns the plaintext token + owning userId for cookie-authed users', async () => {
    const res = await POST(event({ user: { id: 'user-1' }, body: { label: 'iPhone 17' } }));
    expect(res.status).toBe(200);
    // userId lets native bind the token to an account and detect switches.
    expect(await res.json()).toEqual({ token: 'minted-token-value', userId: 'user-1' });
    expect(h.mintDeviceToken).toHaveBeenCalledWith('user-1', 'iPhone 17');
  });

  it('works without a label', async () => {
    const res = await POST(event({ user: { id: 'user-1' }, body: {} }));
    expect(res.status).toBe(200);
    expect(h.mintDeviceToken).toHaveBeenCalledWith('user-1', undefined);
  });
});
