import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('$lib/server/tokens', () => ({
  getValidAccessToken: vi.fn(async () => ({
    access_token: 'tkn',
    expires_at: new Date(Date.now() + 60_000),
  })),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import {
  armPendingPlay,
  getPendingPlay,
  cancelPendingPlay,
  _resetPendingPlayForTests,
} from '../../src/lib/server/playback/pending-play';

const PHONE = { id: 'phone', is_active: false, is_restricted: false, name: 'iPhone', type: 'Smartphone' };

function devicesResponse(devices: unknown[]) {
  return new Response(JSON.stringify({ devices }), { status: 200 });
}
// GET /me/player returns 204 when no playback session exists.
const NOT_PLAYING = () => new Response(null, { status: 204 });
const PLAYING = () => new Response(JSON.stringify({ is_playing: true }), { status: 200 });

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  _resetPendingPlayForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('pending play job', () => {
  it('fires play with device_id once a device appears, then reports started', async () => {
    // tick 1: no devices. tick 2: phone appears, not playing → play (204).
    fetchMock
      .mockResolvedValueOnce(devicesResponse([]))
      .mockResolvedValueOnce(devicesResponse([PHONE]))
      .mockResolvedValueOnce(NOT_PLAYING())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    armPendingPlay('u1', { uris: ['spotify:track:a', 'spotify:track:b'], position_ms: 500 });
    expect(getPendingPlay('u1')).toMatchObject({ status: 'pending' });

    await vi.advanceTimersByTimeAsync(2100); // tick 1 — empty list, keep waiting
    expect(getPendingPlay('u1')).toMatchObject({ status: 'pending' });

    await vi.advanceTimersByTimeAsync(2100); // tick 2 — device appeared
    expect(getPendingPlay('u1')).toMatchObject({ status: 'started' });

    const playCall = fetchMock.mock.calls[3] as [string, RequestInit];
    expect(playCall[0]).toBe('https://api.spotify.com/v1/me/player/play?device_id=phone');
    expect(JSON.parse(playCall[1].body as string)).toEqual({
      uris: ['spotify:track:a', 'spotify:track:b'],
      position_ms: 500,
    });
  });

  it('does not stomp on playback the user started themselves', async () => {
    fetchMock
      .mockResolvedValueOnce(devicesResponse([PHONE]))
      .mockResolvedValueOnce(PLAYING());

    armPendingPlay('u1', { uris: ['spotify:track:a'] });
    await vi.advanceTimersByTimeAsync(2100);

    expect(getPendingPlay('u1')).toMatchObject({ status: 'superseded' });
    // devices + playback-state only; no play call.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('expires after the TTL', async () => {
    fetchMock.mockResolvedValue(devicesResponse([]));
    armPendingPlay('u1', { uris: ['spotify:track:a'] });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(getPendingPlay('u1')).toMatchObject({ status: 'expired' });
  });

  it('cancel stops polling and reports cancelled', async () => {
    fetchMock.mockResolvedValue(devicesResponse([]));
    armPendingPlay('u1', { uris: ['spotify:track:a'] });
    await vi.advanceTimersByTimeAsync(2100);
    cancelPendingPlay('u1');
    const callsAtCancel = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock.mock.calls.length).toBe(callsAtCancel);
    expect(getPendingPlay('u1')).toMatchObject({ status: 'cancelled' });
  });

  it('re-arming replaces the previous job', async () => {
    fetchMock.mockResolvedValue(devicesResponse([]));
    armPendingPlay('u1', { uris: ['spotify:track:a'] });
    armPendingPlay('u1', { uris: ['spotify:track:b'] });
    expect(getPendingPlay('u1')).toMatchObject({
      status: 'pending',
      payload: { uris: ['spotify:track:b'] },
    });
  });

  it('keeps polling through transient play failures until the deadline', async () => {
    fetchMock
      .mockResolvedValueOnce(devicesResponse([PHONE]))
      .mockResolvedValueOnce(NOT_PLAYING())
      .mockResolvedValueOnce(new Response('{}', { status: 502 })) // play fails
      .mockResolvedValueOnce(devicesResponse([PHONE]))
      .mockResolvedValueOnce(NOT_PLAYING())
      .mockResolvedValueOnce(new Response(null, { status: 204 })); // retry lands

    armPendingPlay('u1', { uris: ['spotify:track:a'] });
    await vi.advanceTimersByTimeAsync(2100);
    expect(getPendingPlay('u1')).toMatchObject({ status: 'pending' });
    await vi.advanceTimersByTimeAsync(2100);
    expect(getPendingPlay('u1')).toMatchObject({ status: 'started' });
  });

  it('isolates jobs per user', async () => {
    fetchMock.mockResolvedValue(devicesResponse([]));
    armPendingPlay('u1', { uris: ['spotify:track:a'] });
    armPendingPlay('u2', { uris: ['spotify:track:b'] });
    cancelPendingPlay('u1');
    expect(getPendingPlay('u1')).toMatchObject({ status: 'cancelled' });
    expect(getPendingPlay('u2')).toMatchObject({ status: 'pending' });
  });

  it('returns null for a user with no job', () => {
    expect(getPendingPlay('nobody')).toBeNull();
  });
});
