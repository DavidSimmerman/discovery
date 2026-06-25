import { connect } from 'node:http2';
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { env } from '$env/dynamic/private';

// Minimal APNs client for Live Activity pushes. Raw http2 + hand-rolled ES256
// JWT — the npm APNs wrappers are abandoned or don't support the
// `liveactivity` push type properly, and the whole protocol is ~60 lines.
//
// Env (all via $env/dynamic/private so Coolify can set them without rebuild):
//   APNS_TEAM_ID      Apple developer Team ID (10 chars)
//   APNS_KEY_ID       Key ID of the .p8 APNs auth key
//   APNS_AUTH_KEY     full PEM contents of the .p8 file (newlines or \n)
//   APNS_BUNDLE_ID    app bundle id (defaults to tech.simmerman.discovery)
//   APNS_USE_SANDBOX  'true' for the APNs sandbox (dev builds)

const MAX_PAYLOAD_BYTES = 4096; // hard APNs limit
const JWT_TTL_MS = 50 * 60_000; // Apple wants 20-60 min; refresh at 50

export interface ApnsSigningConfig {
  teamId: string;
  keyId: string;
  privateKeyPem: string;
}

export interface ApnsConfig extends ApnsSigningConfig {
  bundleId: string;
  useSandbox: boolean;
}

export type ApnsPushResult =
  | { ok: true; status: number }
  | { ok: false; status?: number; reason: string };

/**
 * Reconstruct a valid PEM from however the key ended up in the env var.
 * Coolify (and most env stores) collapse a multi-line `.p8` to one line —
 * newlines become spaces or vanish — which makes OpenSSL throw
 * "DECODER routines::unsupported". Re-wrap the base64 body at 64 cols so the
 * key parses whether it was pasted with real newlines, literal "\n", spaces,
 * or no separators at all.
 */
export function normalizePem(raw: string): string {
  const s = raw.replace(/\\n/g, '\n').trim();
  const m = s.match(/-----BEGIN ([A-Za-z0-9 ]+?)-----([\s\S]*?)-----END \1-----/);
  if (!m) return s; // not a recognizable PEM block — let crypto surface the error
  const body = (m[2].replace(/\s+/g, '').match(/.{1,64}/g) ?? []).join('\n');
  return `-----BEGIN ${m[1]}-----\n${body}\n-----END ${m[1]}-----\n`;
}

export function readApnsConfig(): ApnsConfig | null {
  const teamId = env.APNS_TEAM_ID;
  const keyId = env.APNS_KEY_ID;
  const privateKeyPem = env.APNS_AUTH_KEY ? normalizePem(env.APNS_AUTH_KEY) : undefined;
  if (!teamId || !keyId || !privateKeyPem) return null;
  return {
    teamId,
    keyId,
    privateKeyPem,
    bundleId: env.APNS_BUNDLE_ID ?? 'tech.simmerman.discovery',
    useSandbox: env.APNS_USE_SANDBOX === 'true',
  };
}

export function apnsHost(useSandbox: boolean): string {
  return useSandbox ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
}

const b64url = (s: string) => Buffer.from(s).toString('base64url');

// NOTE: no `typ` field in the header — APNs rejects tokens that carry it.
export function signApnsJwt(cfg: ApnsSigningConfig, nowSeconds: number): string {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: cfg.keyId }));
  const payload = b64url(JSON.stringify({ iss: cfg.teamId, iat: nowSeconds }));
  const signingInput = `${header}.${payload}`;
  const signature = cryptoSign('sha256', Buffer.from(signingInput), {
    key: createPrivateKey(cfg.privateKeyPem),
    dsaEncoding: 'ieee-p1363', // raw r||s, i.e. JOSE format — no DER conversion needed
  });
  return `${signingInput}.${signature.toString('base64url')}`;
}

let jwtCache: { token: string; mintedAt: number; keyId: string } | null = null;

export function getApnsJwt(cfg: ApnsSigningConfig, nowMs = Date.now()): string {
  if (jwtCache && jwtCache.keyId === cfg.keyId && nowMs - jwtCache.mintedAt < JWT_TTL_MS) {
    return jwtCache.token;
  }
  const token = signApnsJwt(cfg, Math.floor(nowMs / 1000));
  jwtCache = { token, mintedAt: nowMs, keyId: cfg.keyId };
  return token;
}

export function __resetApnsJwtCache() {
  jwtCache = null;
}

export interface LiveActivityPushOptions {
  event: 'update' | 'end';
  /** Unix seconds; defaults to now. */
  timestamp?: number;
  /** Unix seconds; only meaningful with event 'end'. */
  dismissalDate?: number;
  /** APNs priority; 10 = immediate (default), 5 = budget-friendly. */
  priority?: 5 | 10;
}

export function buildLiveActivityPayload(
  contentState: Record<string, unknown> | null,
  opts: LiveActivityPushOptions,
): string {
  const aps: Record<string, unknown> = {
    timestamp: opts.timestamp ?? Math.floor(Date.now() / 1000),
    event: opts.event,
  };
  // `content-state` is required for updates but optional on end events — an
  // end push after Spotify reports nothing playing has no state to send.
  if (contentState !== null) aps['content-state'] = contentState;
  if (opts.event === 'end' && opts.dismissalDate !== undefined) {
    aps['dismissal-date'] = opts.dismissalDate;
  }
  const body = JSON.stringify({ aps });
  if (Buffer.byteLength(body) > MAX_PAYLOAD_BYTES) {
    throw new Error(`APNs payload exceeds ${MAX_PAYLOAD_BYTES} bytes (${Buffer.byteLength(body)})`);
  }
  return body;
}

/** Push a content-state update (or end event) to one Live Activity. */
export async function pushActivityUpdate(
  pushToken: string,
  contentState: Record<string, unknown> | null,
  opts: LiveActivityPushOptions,
): Promise<ApnsPushResult> {
  const cfg = readApnsConfig();
  if (!cfg) {
    console.warn('[apns] push skipped — APNS_TEAM_ID/APNS_KEY_ID/APNS_AUTH_KEY not configured');
    return { ok: false, reason: 'apns-not-configured' };
  }

  const body = buildLiveActivityPayload(contentState, opts);
  const client = connect(apnsHost(cfg.useSandbox));

  try {
    return await new Promise<ApnsPushResult>((resolve, reject) => {
      client.on('error', reject);
      const req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${pushToken}`,
        authorization: `bearer ${getApnsJwt(cfg)}`,
        'apns-push-type': 'liveactivity',
        'apns-topic': `${cfg.bundleId}.push-type.liveactivity`,
        'apns-priority': String(opts.priority ?? 10),
        'content-type': 'application/json',
      });
      let status = 0;
      let responseBody = '';
      req.setEncoding('utf8');
      req.on('response', (headers) => {
        status = Number(headers[':status'] ?? 0);
      });
      req.on('data', (chunk: string) => {
        responseBody += chunk;
      });
      req.on('end', () => {
        if (status >= 200 && status < 300) {
          resolve({ ok: true, status });
        } else {
          let reason = `apns-${status}`;
          try {
            reason = JSON.parse(responseBody).reason ?? reason;
          } catch {
            // keep fallback reason
          }
          resolve({ ok: false, status, reason });
        }
      });
      req.on('error', reject);
      req.end(body);
    });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    client.close();
  }
}
