import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mocks (hoisted so the vi.mock factory can reference them) --------------
const h = vi.hoisted(() => ({
  listLabels: vi.fn(),
  appliedLabelIds: vi.fn(),
  applyLabel: vi.fn(),
  unapplyLabel: vi.fn(),
}));

vi.mock('$lib/server/labels', () => ({
  listLabels: h.listLabels,
  appliedLabelIds: h.appliedLabelIds,
  applyLabel: h.applyLabel,
  unapplyLabel: h.unapplyLabel,
}));

import { GET } from '../../src/routes/api/labels/+server';
import { POST, DELETE } from '../../src/routes/api/track-labels/+server';

const URI = 'spotify:track:4cOdK2wGLETKBW3PvgPWqT';
const UUID = '11111111-1111-4111-8111-111111111111';
const USER = { id: 'user-1' };

// GET reads locals.user and url.searchParams.get('trackUri').
function getEvent(opts: { user?: { id: string }; trackUri?: string }) {
  const url = new URL('http://localhost/api/labels');
  if (opts.trackUri !== undefined) url.searchParams.set('trackUri', opts.trackUri);
  return { locals: { user: opts.user }, url } as never;
}

// POST/DELETE read locals.user and request.json().
function bodyEvent(opts: { user?: { id: string }; body?: unknown }) {
  return {
    locals: { user: opts.user },
    request: { json: async () => opts.body },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/labels', () => {
  it('no locals.user → 401', async () => {
    await expect(GET(getEvent({}))).rejects.toMatchObject({ status: 401 });
    expect(h.listLabels).not.toHaveBeenCalled();
  });

  it('malformed trackUri → 400', async () => {
    h.listLabels.mockResolvedValue([]);
    await expect(GET(getEvent({ user: USER, trackUri: 'garbage' }))).rejects.toMatchObject({
      status: 400,
    });
  });

  it('no trackUri → 200, labels without applied; appliedLabelIds not called', async () => {
    h.listLabels.mockResolvedValue([
      { id: 'l1', name: 'Chill', lastUsedAt: new Date() },
      { id: 'l2', name: 'Workout', lastUsedAt: new Date() },
    ]);
    const res = await GET(getEvent({ user: USER }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      labels: [
        { id: 'l1', name: 'Chill' },
        { id: 'l2', name: 'Workout' },
      ],
    });
    for (const label of body.labels) {
      expect(label).not.toHaveProperty('applied');
    }
    expect(h.listLabels).toHaveBeenCalledWith('user-1');
    expect(h.appliedLabelIds).not.toHaveBeenCalled();
  });

  it('valid trackUri → 200, labels annotated with applied', async () => {
    h.listLabels.mockResolvedValue([
      { id: 'l1', name: 'Chill', lastUsedAt: new Date() },
      { id: 'l2', name: 'Workout', lastUsedAt: new Date() },
    ]);
    h.appliedLabelIds.mockResolvedValue(['l2']);
    const res = await GET(getEvent({ user: USER, trackUri: URI }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      labels: [
        { id: 'l1', name: 'Chill', applied: false },
        { id: 'l2', name: 'Workout', applied: true },
      ],
    });
    expect(h.listLabels).toHaveBeenCalledWith('user-1');
    expect(h.appliedLabelIds).toHaveBeenCalledWith('user-1', URI);
  });
});

describe('POST /api/track-labels', () => {
  it('no user → 401', async () => {
    await expect(
      POST(bodyEvent({ body: { spotifyTrackUri: URI, name: 'Chill' } })),
    ).rejects.toMatchObject({ status: 401 });
    expect(h.applyLabel).not.toHaveBeenCalled();
  });

  it('malformed spotifyTrackUri → 400', async () => {
    await expect(
      POST(bodyEvent({ user: USER, body: { spotifyTrackUri: 'not-a-uri', name: 'Chill' } })),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.applyLabel).not.toHaveBeenCalled();
  });

  it('whitespace-only name → 400; applyLabel not called', async () => {
    await expect(
      POST(bodyEvent({ user: USER, body: { spotifyTrackUri: URI, name: '   ' } })),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.applyLabel).not.toHaveBeenCalled();
  });

  it('over-long name (51 chars) → 400', async () => {
    await expect(
      POST(bodyEvent({ user: USER, body: { spotifyTrackUri: URI, name: 'x'.repeat(51) } })),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.applyLabel).not.toHaveBeenCalled();
  });

  it('valid → 200, echoes applyLabel result; called with trimmed name', async () => {
    const label = { id: UUID, name: 'Chill' };
    h.applyLabel.mockResolvedValue(label);
    const res = await POST(
      bodyEvent({ user: USER, body: { spotifyTrackUri: URI, name: '  Chill  ' } }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, label });
    expect(h.applyLabel).toHaveBeenCalledWith('user-1', URI, 'Chill');
  });
});

describe('DELETE /api/track-labels', () => {
  it('no user → 401', async () => {
    await expect(
      DELETE(bodyEvent({ body: { spotifyTrackUri: URI, labelId: UUID } })),
    ).rejects.toMatchObject({ status: 401 });
    expect(h.unapplyLabel).not.toHaveBeenCalled();
  });

  it('malformed spotifyTrackUri → 400', async () => {
    await expect(
      DELETE(bodyEvent({ user: USER, body: { spotifyTrackUri: 'not-a-uri', labelId: UUID } })),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.unapplyLabel).not.toHaveBeenCalled();
  });

  it('non-UUID labelId → 400; unapplyLabel not called', async () => {
    await expect(
      DELETE(bodyEvent({ user: USER, body: { spotifyTrackUri: URI, labelId: 'not-a-uuid' } })),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.unapplyLabel).not.toHaveBeenCalled();
  });

  it('valid → 200 ok:true; unapplyLabel called with three args', async () => {
    h.unapplyLabel.mockResolvedValue(undefined);
    const res = await DELETE(
      bodyEvent({ user: USER, body: { spotifyTrackUri: URI, labelId: UUID } }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(h.unapplyLabel).toHaveBeenCalledWith('user-1', URI, UUID);
  });
});
