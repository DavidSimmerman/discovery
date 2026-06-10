import { describe, it, expect, beforeEach, vi } from 'vitest';

const armMock = vi.fn();
const getMock = vi.fn();
const cancelMock = vi.fn();
vi.mock('$lib/server/playback/pending-play', () => ({
  armPendingPlay: (...a: unknown[]) => armMock(...a),
  getPendingPlay: (...a: unknown[]) => getMock(...a),
  cancelPendingPlay: (...a: unknown[]) => cancelMock(...a),
}));

import { POST, GET, DELETE } from '../../src/routes/api/spotify/player/pending/+server';

function makeEvent(body?: unknown, user: { id: string } | null = { id: 'u1' }) {
  return {
    locals: { user },
    request: new Request('http://localhost/api/spotify/player/pending', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  } as Parameters<typeof POST>[0];
}

beforeEach(() => {
  armMock.mockReset();
  getMock.mockReset();
  cancelMock.mockReset();
});

describe('POST /api/spotify/player/pending', () => {
  it('rejects when not logged in', async () => {
    await expect(POST(makeEvent({ uris: ['spotify:track:1'] }, null))).rejects.toMatchObject({
      status: 401,
    });
  });

  it('rejects an empty or missing uris array', async () => {
    await expect(POST(makeEvent({ uris: [] }))).rejects.toMatchObject({ status: 400 });
    await expect(POST(makeEvent({}))).rejects.toMatchObject({ status: 400 });
  });

  it('rejects more than 100 uris', async () => {
    const uris = Array.from({ length: 101 }, (_, i) => `spotify:track:${i}`);
    await expect(POST(makeEvent({ uris }))).rejects.toMatchObject({ status: 400 });
  });

  it('arms the job and returns pending', async () => {
    const res = await POST(makeEvent({ uris: ['spotify:track:1'], position_ms: 250 }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'pending' });
    expect(armMock).toHaveBeenCalledWith('u1', {
      uris: ['spotify:track:1'],
      position_ms: 250,
    });
  });
});

describe('GET /api/spotify/player/pending', () => {
  it('returns none when no job exists', async () => {
    getMock.mockReturnValueOnce(null);
    const res = await GET(makeEvent() as unknown as Parameters<typeof GET>[0]);
    expect(await res.json()).toEqual({ status: 'none' });
  });

  it('returns the job status', async () => {
    getMock.mockReturnValueOnce({ status: 'started', payload: { uris: ['spotify:track:1'] } });
    const res = await GET(makeEvent() as unknown as Parameters<typeof GET>[0]);
    expect(await res.json()).toEqual({ status: 'started' });
  });
});

describe('DELETE /api/spotify/player/pending', () => {
  it('cancels the job', async () => {
    const res = await DELETE(makeEvent() as unknown as Parameters<typeof DELETE>[0]);
    expect(res.status).toBe(204);
    expect(cancelMock).toHaveBeenCalledWith('u1');
  });
});
