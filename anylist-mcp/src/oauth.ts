import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { Request, Response } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { log } from './logging.js';

const ACCESS_TOKEN_TTL_S = 60 * 60; // 1 hour
const REFRESH_TOKEN_TTL_S = 60 * 60 * 24 * 30; // 30 days
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_CLIENTS = 50;
const MAX_FAILED_LOGINS = 5;
const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;

interface TokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number; // seconds since epoch
  resource?: string;
}

interface CodeRecord {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  resource?: string;
  expiresAtMs: number;
}

interface PersistedState {
  clients: OAuthClientInformationFull[];
  accessTokens: Record<string, TokenRecord>;
  refreshTokens: Record<string, TokenRecord>;
}

/** Tokens are stored as SHA-256 hashes, so neither memory dumps of the maps nor the state file contain usable tokens. */
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

export function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export interface OwnerOAuthOptions {
  /** The secret the owner types on the approval page (MCP_AUTH_TOKEN). */
  ownerSecret: string;
  allowedRedirectHosts: string[];
  stateFile?: string;
  /** Path the approval form posts to. */
  approvePath: string;
}

/**
 * A minimal single-user OAuth 2.1 authorization server for the MCP SDK's auth router.
 *
 * - Dynamic client registration is open (registration alone grants nothing), but redirect URIs
 *   are restricted to an allowlist of hosts (claude.ai by default).
 * - /authorize shows an approval page; the owner must enter MCP_AUTH_TOKEN to approve.
 * - PKCE is enforced by the SDK; codes are single use and short lived; refresh tokens rotate.
 */
export class OwnerOAuthProvider implements OAuthServerProvider {
  private clients = new Map<string, OAuthClientInformationFull>();
  private codes = new Map<string, CodeRecord>();
  private accessTokens = new Map<string, TokenRecord>();
  private refreshTokens = new Map<string, TokenRecord>();
  private failedLogins = new Map<string, number[]>();

  constructor(private readonly opts: OwnerOAuthOptions) {
    this.load();
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId: string) => this.clients.get(clientId),
      registerClient: (client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>) => {
        for (const uri of client.redirect_uris ?? []) {
          let host: string;
          try {
            host = new URL(uri).hostname.toLowerCase();
          } catch {
            throw new InvalidClientMetadataError(`Invalid redirect_uri: ${uri}`);
          }
          if (!this.opts.allowedRedirectHosts.includes(host)) {
            throw new InvalidClientMetadataError(
              `redirect_uri host "${host}" is not allowed. Add it to OAUTH_ALLOWED_REDIRECT_HOSTS if you trust it.`,
            );
          }
        }
        const full: OAuthClientInformationFull = {
          ...client,
          client_id: randomUUID(),
          client_id_issued_at: now(),
        };
        this.clients.set(full.client_id, full);
        while (this.clients.size > MAX_CLIENTS) {
          const oldest = this.clients.keys().next().value as string;
          this.clients.delete(oldest);
        }
        this.save();
        log.info(`OAuth client registered: ${sanitizeName(client.client_name)} (${full.client_id})`);
        return full;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
    res.send(
      approvalPage({
        action: this.opts.approvePath,
        clientName: sanitizeName(client.client_name) || 'An MCP client',
        redirectHost: safeHost(params.redirectUri),
        fields: {
          client_id: client.client_id,
          redirect_uri: params.redirectUri,
          code_challenge: params.codeChallenge,
          state: params.state ?? '',
          scope: (params.scopes ?? []).join(' '),
          resource: params.resource?.href ?? '',
        },
      }),
    );
  }

  /** POST handler for the approval form. */
  handleApprove = async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const ip = req.ip ?? 'unknown';
    const client = body.client_id ? this.clients.get(body.client_id) : undefined;
    const redirectUri = body.redirect_uri ?? '';
    if (!client || !client.redirect_uris.some(r => redirectUriMatches(redirectUri, r)) || !body.code_challenge) {
      res.status(400).type('text/plain').send('Invalid authorization request. Start again from your MCP client.');
      return;
    }
    if (this.isLockedOut(ip)) {
      res.status(429).type('text/plain').send('Too many failed attempts. Try again in 15 minutes.');
      return;
    }

    const target = new URL(redirectUri);
    if (body.state) target.searchParams.set('state', body.state);

    if (body.decision !== 'approve') {
      target.searchParams.set('error', 'access_denied');
      res.redirect(302, target.href);
      return;
    }
    if (!body.password || !constantTimeEquals(body.password, this.opts.ownerSecret)) {
      this.recordFailure(ip);
      log.warn(`OAuth approval rejected: wrong password (ip ${ip})`);
      res.status(401).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(
        approvalPage({
          action: this.opts.approvePath,
          clientName: sanitizeName(client.client_name) || 'An MCP client',
          redirectHost: safeHost(redirectUri),
          error: 'Wrong password.',
          fields: {
            client_id: client.client_id,
            redirect_uri: redirectUri,
            code_challenge: body.code_challenge,
            state: body.state ?? '',
            scope: body.scope ?? '',
            resource: body.resource ?? '',
          },
        }),
      );
      return;
    }

    const code = newToken();
    this.codes.set(hash(code), {
      clientId: client.client_id,
      codeChallenge: body.code_challenge,
      redirectUri,
      scopes: (body.scope ?? '').split(' ').filter(Boolean),
      resource: body.resource || undefined,
      expiresAtMs: Date.now() + CODE_TTL_MS,
    });
    log.info(`OAuth access approved for client ${client.client_id}`);
    target.searchParams.set('code', code);
    res.redirect(302, target.href);
  };

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.getCode(client, code).codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const record = this.getCode(client, code);
    this.codes.delete(hash(code)); // single use
    if (redirectUri !== undefined && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    return this.issueTokens(client.client_id, record.scopes, record.resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[]): Promise<OAuthTokens> {
    const key = hash(refreshToken);
    const record = this.refreshTokens.get(key);
    if (!record || record.clientId !== client.client_id || record.expiresAt < now()) {
      throw new InvalidGrantError('Invalid or expired refresh token');
    }
    this.refreshTokens.delete(key); // rotate
    const granted = scopes?.length ? scopes.filter(s => record.scopes.includes(s)) : record.scopes;
    return this.issueTokens(client.client_id, granted, record.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.accessTokens.get(hash(token));
    if (!record || record.expiresAt < now()) throw new InvalidTokenError('Invalid or expired access token');
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      resource: record.resource ? new URL(record.resource) : undefined,
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const key = hash(request.token);
    for (const map of [this.accessTokens, this.refreshTokens]) {
      const rec = map.get(key);
      if (rec && rec.clientId === client.client_id) map.delete(key);
    }
    this.save();
  }

  // ------------------------------------------------------------------ internals

  private getCode(client: OAuthClientInformationFull, code: string): CodeRecord {
    const record = this.codes.get(hash(code));
    if (!record || record.clientId !== client.client_id || record.expiresAtMs < Date.now()) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    return record;
  }

  private issueTokens(clientId: string, scopes: string[], resource?: string): OAuthTokens {
    this.prune();
    const access = newToken();
    const refresh = newToken();
    this.accessTokens.set(hash(access), { clientId, scopes, resource, expiresAt: now() + ACCESS_TOKEN_TTL_S });
    this.refreshTokens.set(hash(refresh), { clientId, scopes, resource, expiresAt: now() + REFRESH_TOKEN_TTL_S });
    this.save();
    return {
      access_token: access,
      token_type: 'bearer',
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: refresh,
      ...(scopes.length ? { scope: scopes.join(' ') } : {}),
    };
  }

  private prune() {
    const t = now();
    for (const map of [this.accessTokens, this.refreshTokens]) {
      for (const [k, v] of map) if (v.expiresAt < t) map.delete(k);
    }
    for (const [k, v] of this.codes) if (v.expiresAtMs < Date.now()) this.codes.delete(k);
  }

  private isLockedOut(ip: string): boolean {
    const cutoff = Date.now() - FAILED_LOGIN_WINDOW_MS;
    const recent = (this.failedLogins.get(ip) ?? []).filter(t => t > cutoff);
    this.failedLogins.set(ip, recent);
    // Global cap too, in case the proxy hides client IPs.
    let total = 0;
    for (const times of this.failedLogins.values()) total += times.filter(t => t > cutoff).length;
    return recent.length >= MAX_FAILED_LOGINS || total >= MAX_FAILED_LOGINS * 4;
  }

  private recordFailure(ip: string) {
    const list = this.failedLogins.get(ip) ?? [];
    list.push(Date.now());
    this.failedLogins.set(ip, list);
  }

  private load() {
    const file = this.opts.stateFile;
    if (!file || !existsSync(file)) return;
    try {
      const state = JSON.parse(readFileSync(file, 'utf8')) as PersistedState;
      for (const c of state.clients ?? []) this.clients.set(c.client_id, c);
      for (const [k, v] of Object.entries(state.accessTokens ?? {})) this.accessTokens.set(k, v);
      for (const [k, v] of Object.entries(state.refreshTokens ?? {})) this.refreshTokens.set(k, v);
      this.prune();
      log.info(`Loaded OAuth state: ${this.clients.size} client(s)`);
    } catch (err) {
      log.warn('Could not read OAUTH_STATE_FILE; starting with empty OAuth state.', err);
    }
  }

  private save() {
    const file = this.opts.stateFile;
    if (!file) return;
    const state: PersistedState = {
      clients: [...this.clients.values()],
      accessTokens: Object.fromEntries(this.accessTokens),
      refreshTokens: Object.fromEntries(this.refreshTokens),
    };
    try {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      renameSync(tmp, file);
      chmodSync(file, 0o600);
    } catch (err) {
      log.warn('Could not write OAUTH_STATE_FILE.', err);
    }
  }
}

function sanitizeName(name: unknown): string {
  return typeof name === 'string' ? name.replace(/[^\p{L}\p{N} ._()-]/gu, '').slice(0, 80) : '';
}

function safeHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return 'unknown';
  }
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function approvalPage(p: { action: string; clientName: string; redirectHost: string; fields: Record<string, string>; error?: string }) {
  const hidden = Object.entries(p.fields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('\n      ');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize AnyList MCP</title>
<style>
  body{font-family:system-ui,sans-serif;background:#f5f5f4;color:#1c1917;margin:0;padding:16px}
  main{max-width:420px;margin:10vh auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.1)}
  h1{font-size:1.25rem;margin:0 0 12px} p{line-height:1.5} .err{color:#b91c1c;font-weight:600}
  input[type=password]{width:100%;box-sizing:border-box;padding:10px;font-size:1rem;margin:8px 0 16px;border:1px solid #d6d3d1;border-radius:8px}
  button{padding:10px 16px;font-size:1rem;border-radius:8px;border:0;cursor:pointer;margin-right:8px}
  .ok{background:#1d4ed8;color:#fff} .no{background:#e7e5e4}
  @media (prefers-color-scheme: dark){body{background:#1c1917;color:#f5f5f4} main{background:#292524} input[type=password]{background:#1c1917;color:#f5f5f4;border-color:#57534e} .no{background:#44403c;color:#f5f5f4}}
</style></head>
<body><main>
  <h1>Allow access to your AnyList?</h1>
  <p><strong>${esc(p.clientName)}</strong> (redirecting to <code>${esc(p.redirectHost)}</code>) wants to read and change your AnyList lists, meal plan and recipes.</p>
  ${p.error ? `<p class="err">${esc(p.error)}</p>` : ''}
  <form method="post" action="${esc(p.action)}">
      ${hidden}
      <label for="pw">Server password (MCP_AUTH_TOKEN)</label>
      <input id="pw" type="password" name="password" autocomplete="current-password" autofocus>
      <button class="ok" type="submit" name="decision" value="approve">Allow</button>
      <button class="no" type="submit" name="decision" value="deny">Deny</button>
  </form>
</main></body></html>`;
}
