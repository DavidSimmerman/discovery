// Validator-focused endpoint tests. We hit POST /api/shuffle/timeline with
// malformed bodies and verify the validator throws before any DB work happens.
// Locks/loadSessionState are never reached on a 400, so no DB mocking required.

import { describe, it, expect } from 'vitest';
import { POST } from '../../src/routes/api/shuffle/timeline/+server';

function makeEvent(body: unknown, user: { id: string } | null = { id: 'u1' }) {
  return {
    locals: { user },
    request: new Request('http://localhost/api/shuffle/timeline', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as Parameters<typeof POST>[0];
}

describe('POST /api/shuffle/timeline — validation', () => {
  it('rejects when not logged in', async () => {
    await expect(POST(makeEvent({ action: 'advance' }, null))).rejects.toMatchObject({ status: 401 });
  });

  it('rejects missing action', async () => {
    await expect(POST(makeEvent({}))).rejects.toMatchObject({ status: 400 });
  });

  it('rejects unknown action', async () => {
    await expect(POST(makeEvent({ action: 'frobnicate' }))).rejects.toMatchObject({ status: 400 });
  });

  describe('add', () => {
    it('rejects missing uri', async () => {
      await expect(POST(makeEvent({ action: 'add' }))).rejects.toMatchObject({ status: 400 });
    });

    it('rejects fractional position', async () => {
      await expect(
        POST(makeEvent({ action: 'add', uri: 'spotify:track:a', position: 1.5 })),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('rejects negative position', async () => {
      await expect(
        POST(makeEvent({ action: 'add', uri: 'spotify:track:a', position: -1 })),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('remove', () => {
    it('rejects missing uri', async () => {
      await expect(POST(makeEvent({ action: 'remove' }))).rejects.toMatchObject({ status: 400 });
    });

    it('rejects non-integer index', async () => {
      await expect(
        POST(makeEvent({ action: 'remove', uri: 'spotify:track:a', index: 0.5 })),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('reorder', () => {
    it('rejects missing indices', async () => {
      await expect(POST(makeEvent({ action: 'reorder' }))).rejects.toMatchObject({ status: 400 });
    });

    it('rejects fractional fromIndex', async () => {
      await expect(
        POST(makeEvent({ action: 'reorder', fromIndex: 1.5, toIndex: 2 })),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('rejects negative toIndex', async () => {
      await expect(
        POST(makeEvent({ action: 'reorder', fromIndex: 0, toIndex: -1 })),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('rejects string indices', async () => {
      await expect(
        POST(makeEvent({ action: 'reorder', fromIndex: '0', toIndex: '1' })),
      ).rejects.toMatchObject({ status: 400 });
    });
  });
});
