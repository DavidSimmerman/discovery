import { describe, it, expect } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { deviceTokens, liveActivities } from '$lib/server/db/schema';

describe('device_tokens schema', () => {
  it('has the expected table name and columns', () => {
    expect(getTableName(deviceTokens)).toBe('device_tokens');
    const cols = getTableColumns(deviceTokens);
    expect(cols.id).toBeDefined();
    expect(cols.userId.notNull).toBe(true);
    expect(cols.tokenHash.notNull).toBe(true);
    expect(cols.tokenHash.isUnique).toBe(true);
    expect(cols.label).toBeDefined();
    expect(cols.createdAt.notNull).toBe(true);
    expect(cols.lastUsedAt.notNull).toBe(false);
  });
});

describe('live_activities schema', () => {
  it('has the expected table name and columns', () => {
    expect(getTableName(liveActivities)).toBe('live_activities');
    const cols = getTableColumns(liveActivities);
    expect(cols.id).toBeDefined();
    expect(cols.userId.notNull).toBe(true);
    expect(cols.apnsPushToken.notNull).toBe(true);
    expect(cols.deviceTokenId.notNull).toBe(false);
    // Poller bookkeeping: dedupe pushes + detect stop-state.
    expect(cols.contentStateHash.notNull).toBe(false);
    expect(cols.lastTrackUri.notNull).toBe(false);
    expect(cols.stoppedSince.notNull).toBe(false);
    expect(cols.startedAt.notNull).toBe(true);
    expect(cols.endedAt.notNull).toBe(false);
  });
});
