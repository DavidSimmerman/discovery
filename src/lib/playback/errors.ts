export type PlayErrorShape =
  | { error: 'no_active_device' }
  | { error: 'premium_required' }
  | { error: 'rate_limited'; retry_after?: number }
  | { error: 'transient' };

export function mapSpotifyPlayError(
  status: number,
  body: { error?: { reason?: string; message?: string } } | unknown,
  retryAfterHeader?: string | null,
): PlayErrorShape {
  const reason =
    body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object' && 'reason' in body.error
      ? (body.error as { reason?: string }).reason
      : undefined;

  if (status === 404 && reason === 'NO_ACTIVE_DEVICE') return { error: 'no_active_device' };
  if (status === 403 && reason === 'PREMIUM_REQUIRED') return { error: 'premium_required' };
  if (status === 429) {
    const n = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : NaN;
    return Number.isFinite(n) ? { error: 'rate_limited', retry_after: n } : { error: 'rate_limited' };
  }
  return { error: 'transient' };
}
