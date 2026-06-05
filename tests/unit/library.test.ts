import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mocks (hoisted so the vi.mock factory can reference them) --------------
const h = vi.hoisted(() => ({
  listLibrary: vi.fn(),
  libraryFacets: vi.fn(),
}));

vi.mock('$lib/server/library', () => ({
  listLibrary: h.listLibrary,
  libraryFacets: h.libraryFacets,
}));

import { GET } from '../../src/routes/api/library/+server';

const USER_ID = 'user-1';
const USER = { id: USER_ID };

// GET reads locals.user and url.searchParams.get(...).
function getEvent(opts: { user?: { id: string }; query?: Record<string, string> }) {
  const url = new URL('http://localhost/api/library');
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, v);
  }
  return { locals: { user: opts.user }, url } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.listLibrary.mockResolvedValue([{ id: 'row-1' }]);
  h.libraryFacets.mockResolvedValue({ labels: [] });
});

describe('GET /api/library', () => {
  it('no locals.user → 401; listLibrary not called', async () => {
    await expect(GET(getEvent({}))).rejects.toMatchObject({ status: 401 });
    expect(h.listLibrary).not.toHaveBeenCalled();
  });

  it('no params → 200, body { rows, facets }; helpers wired with empty opts', async () => {
    const res = await GET(getEvent({ user: USER }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ rows: [{ id: 'row-1' }], facets: { labels: [] } });
    // Endpoint only assigns present filters, so opts is exactly {} when no params.
    expect(h.listLibrary).toHaveBeenCalledWith(USER_ID, {});
    expect(h.libraryFacets).toHaveBeenCalledWith(USER_ID);
  });

  it('?search=foo → opts.search "foo"', async () => {
    await GET(getEvent({ user: USER, query: { search: 'foo' } }));
    expect(h.listLibrary).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ search: 'foo' }),
    );
  });

  it('?search= (empty) → treated as absent', async () => {
    await GET(getEvent({ user: USER, query: { search: '' } }));
    expect(h.listLibrary).toHaveBeenCalledWith(USER_ID, {});
  });

  it('?search=   (whitespace) → treated as absent', async () => {
    await GET(getEvent({ user: USER, query: { search: '   ' } }));
    expect(h.listLibrary).toHaveBeenCalledWith(USER_ID, {});
  });

  it('?search with 101 chars → 400; listLibrary not called', async () => {
    await expect(
      GET(getEvent({ user: USER, query: { search: 'x'.repeat(101) } })),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.listLibrary).not.toHaveBeenCalled();
  });

  it('?minRating=4 → opts.minRating 4', async () => {
    await GET(getEvent({ user: USER, query: { minRating: '4' } }));
    expect(h.listLibrary).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ minRating: 4 }),
    );
  });

  it.each(['0', '6', 'abc', '3.5'])('?minRating=%s → 400; listLibrary not called', async (v) => {
    await expect(
      GET(getEvent({ user: USER, query: { minRating: v } })),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.listLibrary).not.toHaveBeenCalled();
  });

  it('?label=workout → opts.label "workout"', async () => {
    await GET(getEvent({ user: USER, query: { label: 'workout' } }));
    expect(h.listLibrary).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ label: 'workout' }),
    );
  });

  it('?label with 51 chars → 400; listLibrary not called', async () => {
    await expect(
      GET(getEvent({ user: USER, query: { label: 'x'.repeat(51) } })),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.listLibrary).not.toHaveBeenCalled();
  });

  it('combined search + minRating + label → full opts', async () => {
    await GET(
      getEvent({ user: USER, query: { search: 'foo', minRating: '4', label: 'workout' } }),
    );
    expect(h.listLibrary).toHaveBeenCalledWith(USER_ID, {
      search: 'foo',
      minRating: 4,
      label: 'workout',
    });
  });

  it.each(['recency', 'rating', 'name', 'artist', 'top'])('?sort=%s → opts.sort %s', async (s) => {
    await GET(getEvent({ user: USER, query: { sort: s } }));
    expect(h.listLibrary).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ sort: s }));
  });

  it('?sort=bogus → 400; listLibrary not called', async () => {
    await expect(
      GET(getEvent({ user: USER, query: { sort: 'bogus' } })),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.listLibrary).not.toHaveBeenCalled();
  });

  it('?artist=Radiohead → opts.artist "Radiohead"', async () => {
    await GET(getEvent({ user: USER, query: { artist: 'Radiohead' } }));
    expect(h.listLibrary).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ artist: 'Radiohead' }),
    );
  });

  it('?artist= (empty) → treated as absent', async () => {
    await GET(getEvent({ user: USER, query: { artist: '' } }));
    expect(h.listLibrary).toHaveBeenCalledWith(USER_ID, {});
  });
});
