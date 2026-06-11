import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { EventEmitter } from 'node:events';

const h = vi.hoisted(() => {
  const captured: {
    headers: Record<string, string> | null;
    body: string | null;
    authority: string | null;
  } = { headers: null, body: null, authority: null };
  const state = { responseStatus: 200, responseBody: '' };

  const connect = vi.fn((authority: string) => {
    captured.authority = authority;
    return {
      request(headers: Record<string, string>) {
        captured.headers = headers;
        const stream = new EventEmitter() as EventEmitter & {
          setEncoding: (e: string) => void;
          end: (body?: string) => void;
        };
        stream.setEncoding = () => {};
        stream.end = (body?: string) => {
          captured.body = body ?? null;
          queueMicrotask(() => {
            stream.emit('response', { ':status': state.responseStatus });
            if (state.responseBody) stream.emit('data', state.responseBody);
            stream.emit('end');
          });
        };
        return stream;
      },
      close() {},
      on() {},
    };
  });

  const env: Record<string, string | undefined> = {};
  return { captured, state, connect, env };
});

vi.mock('node:http2', () => ({ connect: h.connect, default: { connect: h.connect } }));
vi.mock('$env/dynamic/private', () => ({ env: h.env }));

import {
  signApnsJwt,
  getApnsJwt,
  buildLiveActivityPayload,
  apnsHost,
  pushActivityUpdate,
  __resetApnsJwtCache,
} from '$lib/server/apns';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const CFG = { teamId: 'TEAM123456', keyId: 'KEY1234567', privateKeyPem: PEM };

const b64urlJson = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString());

beforeEach(() => {
  vi.clearAllMocks();
  __resetApnsJwtCache();
  h.captured.headers = null;
  h.captured.body = null;
  h.state.responseStatus = 200;
  h.state.responseBody = '';
  for (const k of Object.keys(h.env)) delete h.env[k];
  Object.assign(h.env, {
    APNS_TEAM_ID: 'TEAM123456',
    APNS_KEY_ID: 'KEY1234567',
    APNS_AUTH_KEY: PEM,
    APNS_BUNDLE_ID: 'tech.simmerman.discovery',
  });
});

describe('signApnsJwt', () => {
  it('produces an ES256 JWT without a typ header that verifies', () => {
    const jwt = signApnsJwt(CFG, 1_700_000_000);
    const [header, payload, sig] = jwt.split('.');
    expect(b64urlJson(header)).toEqual({ alg: 'ES256', kid: 'KEY1234567' }); // no typ — Apple rejects it
    expect(b64urlJson(payload)).toEqual({ iss: 'TEAM123456', iat: 1_700_000_000 });
    const ok = cryptoVerify(
      'sha256',
      Buffer.from(`${header}.${payload}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(sig, 'base64url'),
    );
    expect(ok).toBe(true);
  });
});

describe('getApnsJwt cache', () => {
  it('reuses the token within 50 minutes and re-signs after', () => {
    const t0 = 1_700_000_000_000;
    const a = getApnsJwt(CFG, t0);
    const b = getApnsJwt(CFG, t0 + 49 * 60_000);
    const c = getApnsJwt(CFG, t0 + 51 * 60_000);
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });
});

describe('buildLiveActivityPayload', () => {
  it('builds an update payload', () => {
    const body = JSON.parse(
      buildLiveActivityPayload({ title: 'Song' }, { event: 'update', timestamp: 123 }),
    );
    expect(body).toEqual({ aps: { timestamp: 123, event: 'update', 'content-state': { title: 'Song' } } });
  });

  it('includes dismissal-date on end events', () => {
    const body = JSON.parse(
      buildLiveActivityPayload({}, { event: 'end', timestamp: 123, dismissalDate: 456 }),
    );
    expect(body.aps['dismissal-date']).toBe(456);
    expect(body.aps.event).toBe('end');
  });

  it('omits content-state when null (end without final state)', () => {
    const body = JSON.parse(buildLiveActivityPayload(null, { event: 'end', timestamp: 1 }));
    expect(body.aps).not.toHaveProperty('content-state');
    expect(body.aps.event).toBe('end');
  });

  it('rejects payloads over 4KB', () => {
    expect(() =>
      buildLiveActivityPayload({ blob: 'x'.repeat(5000) }, { event: 'update', timestamp: 1 }),
    ).toThrow(/4096/);
  });
});

describe('apnsHost', () => {
  it('selects sandbox vs production', () => {
    expect(apnsHost(true)).toBe('https://api.sandbox.push.apple.com');
    expect(apnsHost(false)).toBe('https://api.push.apple.com');
  });
});

describe('pushActivityUpdate', () => {
  it('no-ops gracefully when APNs env is not configured', async () => {
    delete h.env.APNS_TEAM_ID;
    const res = await pushActivityUpdate('ptoken', { title: 'x' }, { event: 'update' });
    expect(res).toEqual({ ok: false, reason: 'apns-not-configured' });
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('POSTs to /3/device/<token> with liveactivity headers', async () => {
    const res = await pushActivityUpdate('ptoken123', { title: 'x' }, { event: 'update' });
    expect(res.ok).toBe(true);
    expect(h.captured.authority).toBe('https://api.push.apple.com');
    expect(h.captured.headers).toMatchObject({
      ':method': 'POST',
      ':path': '/3/device/ptoken123',
      'apns-push-type': 'liveactivity',
      'apns-topic': 'tech.simmerman.discovery.push-type.liveactivity',
      'apns-priority': '10',
    });
    expect(h.captured.headers?.authorization).toMatch(/^bearer .+\..+\..+$/);
    const sent = JSON.parse(h.captured.body!);
    expect(sent.aps['content-state']).toEqual({ title: 'x' });
  });

  it('uses the sandbox host when APNS_USE_SANDBOX=true', async () => {
    h.env.APNS_USE_SANDBOX = 'true';
    await pushActivityUpdate('p', {}, { event: 'update' });
    expect(h.captured.authority).toBe('https://api.sandbox.push.apple.com');
  });

  it('surfaces APNs rejection status + reason', async () => {
    h.state.responseStatus = 410;
    h.state.responseBody = JSON.stringify({ reason: 'Unregistered' });
    const res = await pushActivityUpdate('p', {}, { event: 'update' });
    expect(res).toEqual({ ok: false, status: 410, reason: 'Unregistered' });
  });
});
