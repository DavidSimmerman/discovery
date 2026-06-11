import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const readSessionCookie = vi.fn();
  const resolveDeviceToken = vi.fn();
  const state = { userRows: [] as unknown[] };
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(state.userRows) }),
      }),
    }),
  };
  return { readSessionCookie, resolveDeviceToken, state, db };
});

vi.mock('$lib/server/session', () => ({ readSessionCookie: h.readSessionCookie }));
vi.mock('$lib/server/deviceTokens', () => ({ resolveDeviceToken: h.resolveDeviceToken }));
vi.mock('$lib/server/db', () => ({ db: h.db }));

import { handle } from '../../src/hooks.server';

const USER_ROW = {
  id: 'user-1',
  spotifyId: 'spotify-1',
  displayName: 'David',
  product: 'premium',
  needsReauth: false,
};

function makeEvent(authHeader?: string) {
  return {
    cookies: {},
    request: { headers: new Headers(authHeader ? { authorization: authHeader } : {}) },
    locals: {} as { user: unknown },
  };
}

const resolve = vi.fn(async (event: unknown) => ({ event }));

beforeEach(() => {
  vi.clearAllMocks();
  h.readSessionCookie.mockReturnValue(null);
  h.resolveDeviceToken.mockResolvedValue(null);
  h.state.userRows = [USER_ROW];
});

describe('hooks.server.ts bearer auth', () => {
  it('cookie auth still works and wins over bearer', async () => {
    h.readSessionCookie.mockReturnValue('user-1');
    const event = makeEvent('Bearer sometoken');
    await handle({ event, resolve } as never);
    expect(event.locals.user).toMatchObject({ id: 'user-1' });
    expect(h.resolveDeviceToken).not.toHaveBeenCalled();
  });

  it('resolves a Bearer token to a user when no cookie', async () => {
    h.resolveDeviceToken.mockResolvedValue('user-1');
    const event = makeEvent('Bearer goodtoken');
    await handle({ event, resolve } as never);
    expect(h.resolveDeviceToken).toHaveBeenCalledWith('goodtoken');
    expect(event.locals.user).toMatchObject({ id: 'user-1', spotifyId: 'spotify-1' });
  });

  it('invalid bearer token leaves user null', async () => {
    h.resolveDeviceToken.mockResolvedValue(null);
    const event = makeEvent('Bearer badtoken');
    await handle({ event, resolve } as never);
    expect(event.locals.user).toBeNull();
  });

  it('no cookie, no header → user null, no token lookup', async () => {
    const event = makeEvent();
    await handle({ event, resolve } as never);
    expect(event.locals.user).toBeNull();
    expect(h.resolveDeviceToken).not.toHaveBeenCalled();
  });
});
