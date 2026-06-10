// Validator-focused endpoint tests (same approach as timeline-endpoint):
// malformed input must throw before any DB work happens, so no mocking needed.

import { describe, it, expect } from 'vitest';
import { POST } from '../../src/routes/api/shuffle/presets/+server';
import { PUT, DELETE } from '../../src/routes/api/shuffle/presets/[id]/+server';
import { POST as APPLY } from '../../src/routes/api/shuffle/presets/[id]/apply/+server';
import { validPresetName, validPresetId } from '$lib/server/shuffle/presets';

function makeEvent(
  body: unknown,
  user: { id: string } | null = { id: 'u1' },
  params: Record<string, string> = {},
) {
  return {
    locals: { user },
    params,
    request: new Request('http://localhost/api/shuffle/presets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as unknown as Parameters<typeof POST>[0];
}

describe('preset name/id validators', () => {
  it('trims and accepts a sane name', () => {
    expect(validPresetName('  Road trip  ')).toBe('Road trip');
  });

  it('rejects empty / non-string / over-long names', () => {
    for (const bad of ['', '   ', 42, null, undefined, 'x'.repeat(61)]) {
      expect(() => validPresetName(bad)).toThrowError();
    }
  });

  it('accepts a uuid and 404s anything else', () => {
    const id = '6f1b24a0-1234-4abc-9def-0123456789ab';
    expect(validPresetId(id)).toBe(id);
    for (const bad of [undefined, '', 'nope', '6f1b24a0']) {
      expect(() => validPresetId(bad)).toThrowError();
    }
  });
});

describe('POST /api/shuffle/presets — validation', () => {
  it('rejects when not logged in', async () => {
    await expect(POST(makeEvent({ name: 'x' }, null))).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a missing body or name', async () => {
    await expect(POST(makeEvent(null))).rejects.toMatchObject({ status: 400 });
    await expect(POST(makeEvent({}))).rejects.toMatchObject({ status: 400 });
    await expect(POST(makeEvent({ name: '   ' }))).rejects.toMatchObject({ status: 400 });
  });
});

describe('PUT/DELETE/apply /api/shuffle/presets/[id] — validation', () => {
  const params = { id: 'not-a-uuid' };

  it('401 when not logged in', async () => {
    await expect(
      PUT(makeEvent({ name: 'x' }, null, params) as unknown as Parameters<typeof PUT>[0]),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('404 on a non-uuid id before any body parsing', async () => {
    await expect(
      PUT(makeEvent({ name: 'x' }, { id: 'u1' }, params) as unknown as Parameters<typeof PUT>[0]),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      DELETE(makeEvent(null, { id: 'u1' }, params) as unknown as Parameters<typeof DELETE>[0]),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      APPLY(makeEvent(null, { id: 'u1' }, params) as unknown as Parameters<typeof APPLY>[0]),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('400 when a PUT has nothing to update', async () => {
    const goodId = { id: '6f1b24a0-1234-4abc-9def-0123456789ab' };
    await expect(
      PUT(makeEvent({}, { id: 'u1' }, goodId) as unknown as Parameters<typeof PUT>[0]),
    ).rejects.toMatchObject({ status: 400 });
  });
});
