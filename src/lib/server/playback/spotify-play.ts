// Raw PUT /me/player/play against Spotify, shared by the play endpoint and the
// pending-play job. Callers map failures themselves (mapSpotifyPlayError).

export async function spotifyPlay(
  accessToken: string,
  payload: Record<string, unknown>,
  deviceId?: string,
): Promise<Response> {
  // device_id is optional: when absent, Spotify routes to whichever device the
  // user has marked active. Surfaces no_active_device (404) when nothing is.
  const qs = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
  return fetch(`https://api.spotify.com/v1/me/player/play${qs}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}
