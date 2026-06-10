// Spotify Connect device discovery, used for cold-start playback: when a play
// command hits NO_ACTIVE_DEVICE, the play endpoint (and the pending-play job)
// look up the user's *available* devices and target one explicitly via
// ?device_id. A backgrounded Spotify app still shows up here as inactive-but-
// available, so this turns "open Spotify and press play first" into "it just
// works" for the common case. Uses the user-read-playback-state scope we
// already hold for currently-playing polling — no new scope.

export interface SpotifyDevice {
  id: string | null;
  is_active: boolean;
  is_restricted: boolean;
  name: string;
  type: string; // 'Computer' | 'Smartphone' | 'Speaker' | ...
}

export async function listDevices(accessToken: string): Promise<SpotifyDevice[]> {
  try {
    const res = await fetch('https://api.spotify.com/v1/me/player/devices', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return [];
    const j = (await res.json()) as { devices?: SpotifyDevice[] };
    return Array.isArray(j?.devices) ? j.devices : [];
  } catch {
    return [];
  }
}

// active > smartphone > first usable. Restricted devices (e.g. some Cast
// targets) reject Web API commands, and a null id can't be targeted at all.
// Smartphone outranks the rest because discovery is a phone-first PWA — the
// phone in your hand is almost always the device you meant.
export function pickBestDevice(devices: SpotifyDevice[]): SpotifyDevice | null {
  const usable = devices.filter((d) => d.id != null && !d.is_restricted);
  return (
    usable.find((d) => d.is_active) ??
    usable.find((d) => d.type === 'Smartphone') ??
    usable[0] ??
    null
  );
}
