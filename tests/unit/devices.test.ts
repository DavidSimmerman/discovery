import { describe, it, expect, beforeEach, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { listDevices, pickBestDevice, type SpotifyDevice } from '../../src/lib/server/playback/devices';

function dev(over: Partial<SpotifyDevice>): SpotifyDevice {
  return {
    id: 'id-default',
    is_active: false,
    is_restricted: false,
    name: 'Device',
    type: 'Computer',
    ...over,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('listDevices', () => {
  it('returns the devices array', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ devices: [dev({ id: 'a' }), dev({ id: 'b' })] }), { status: 200 }),
    );
    const devices = await listDevices('tkn');
    expect(devices.map((d) => d.id)).toEqual(['a', 'b']);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.spotify.com/v1/me/player/devices');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tkn');
  });

  it('returns [] on non-OK responses', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 502 }));
    expect(await listDevices('tkn')).toEqual([]);
  });

  it('returns [] on malformed bodies', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    expect(await listDevices('tkn')).toEqual([]);
  });
});

describe('pickBestDevice', () => {
  it('prefers the active device', () => {
    const picked = pickBestDevice([
      dev({ id: 'laptop', type: 'Computer' }),
      dev({ id: 'phone', type: 'Smartphone' }),
      dev({ id: 'speaker', type: 'Speaker', is_active: true }),
    ]);
    expect(picked?.id).toBe('speaker');
  });

  it('prefers a smartphone when nothing is active', () => {
    const picked = pickBestDevice([
      dev({ id: 'laptop', type: 'Computer' }),
      dev({ id: 'phone', type: 'Smartphone' }),
    ]);
    expect(picked?.id).toBe('phone');
  });

  it('falls back to the first usable device', () => {
    const picked = pickBestDevice([
      dev({ id: 'laptop', type: 'Computer' }),
      dev({ id: 'speaker', type: 'Speaker' }),
    ]);
    expect(picked?.id).toBe('laptop');
  });

  it('skips restricted devices and devices without ids', () => {
    const picked = pickBestDevice([
      dev({ id: null, type: 'Smartphone', is_active: true }),
      dev({ id: 'cast', type: 'CastAudio', is_restricted: true }),
      dev({ id: 'laptop', type: 'Computer' }),
    ]);
    expect(picked?.id).toBe('laptop');
  });

  it('returns null when nothing is usable', () => {
    expect(pickBestDevice([])).toBeNull();
    expect(pickBestDevice([dev({ id: null })])).toBeNull();
  });
});
