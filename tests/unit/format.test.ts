import { describe, it, expect } from 'vitest';
import { formatPlays, formatRelativeTime } from '$lib/format';

describe('formatPlays', () => {
  it('formats millions with one decimal', () => {
    expect(formatPlays(1_234_567)).toBe('1.2M');
    expect(formatPlays(12_000_000)).toBe('12.0M');
  });

  it('rounds 10K+ to whole thousands', () => {
    expect(formatPlays(45_200)).toBe('45K');
    expect(formatPlays(640_000)).toBe('640K');
  });

  it('keeps one decimal between 1K and 10K', () => {
    expect(formatPlays(1_500)).toBe('1.5K');
  });

  it('shows raw counts under 1000', () => {
    expect(formatPlays(512)).toBe('512');
    expect(formatPlays(0)).toBe('0');
  });
});

describe('formatRelativeTime', () => {
  const now = Date.parse('2024-06-09T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const MIN = 60_000;
  const HR = 3_600_000;
  const DAY = 86_400_000;

  it('shows "just now" under a minute', () => {
    expect(formatRelativeTime(ago(30_000), now)).toBe('just now');
  });

  it('shows minutes, hours, and days', () => {
    expect(formatRelativeTime(ago(2 * MIN), now)).toBe('2m ago');
    expect(formatRelativeTime(ago(3 * HR), now)).toBe('3h ago');
    expect(formatRelativeTime(ago(2 * DAY), now)).toBe('2d ago');
  });

  it('falls back to a short date past a week', () => {
    const out = formatRelativeTime(ago(10 * DAY), now);
    expect(out).not.toMatch(/ago|just now/);
  });

  it('returns empty string for an unparseable timestamp', () => {
    expect(formatRelativeTime('not-a-date', now)).toBe('');
  });
});
