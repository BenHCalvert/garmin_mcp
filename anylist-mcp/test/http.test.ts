import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadHttpConfig } from '../src/config.js';
import { createHttpApp } from '../src/http.js';
import { AnyListService } from '../src/service.js';
import { makeFakeClient } from './fakes.js';

const TOKEN = 'test-token-'.padEnd(48, 'x');
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer();
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  base = `http://localhost:${port}`;
  const config = loadHttpConfig({ MCP_AUTH_TOKEN: TOKEN, PUBLIC_URL: base });
  const app = createHttpApp(config, new AnyListService(async () => makeFakeClient().asClient));
  server.on('request', app);
});

afterAll(() => new Promise<void>(r => server.close(() => r())));

function mcp(body: unknown, token?: string) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const listTools = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

describe('HTTP auth', () => {
  it('health check is public', async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it('rejects requests without a token, pointing at resource metadata', async () => {
    const res = await mcp(listTools);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/mcp');
  });

  it('rejects a wrong token', async () => {
    expect((await mcp(listTools, 'nope')).status).toBe(401);
    expect((await mcp(listTools, TOKEN.slice(0, -1))).status).toBe(401);
  });

  it('accepts the static bearer token', async () => {
    const res = await mcp(listTools, TOKEN);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.result.tools.length).toBe(12);
  });

  it('calls a tool over HTTP', async () => {
    const res = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_lists', arguments: {} } }, TOKEN);
    const json = await res.json();
    expect(JSON.parse(json.result.content[0].text)[0].name).toBe('Groceries');
  });

  it('GET /mcp is 405 for the stateless server', async () => {
    const res = await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(405);
  });
});

describe('OAuth (single owner)', () => {
  const redirectUri = 'http://localhost:9999/callback';
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  async function register(uris = [redirectUri]) {
    return fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Test Client', redirect_uris: uris, token_endpoint_auth_method: 'none' }),
    });
  }

  function approve(clientId: string, password: string, decision = 'approve') {
    return fetch(`${base}/oauth/approve`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, state: 'st4te', scope: '', resource: '',
        password, decision,
      }),
    });
  }

  function token(params: Record<string, string>) {
    return fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
  }

  it('publishes discovery metadata', async () => {
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(as.authorization_endpoint).toBe(`${base}/authorize`);
    expect(as.code_challenge_methods_supported).toContain('S256');
    const pr = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(pr.resource).toBe(`${base}/mcp`);
  });

  it('refuses clients redirecting to hosts outside the allowlist', async () => {
    const res = await register(['https://evil.example.com/cb']);
    expect(res.status).toBe(400);
  });

  it('full flow: register, approve with password, exchange code with PKCE, use token, refresh', async () => {
    const client = await (await register()).json();
    expect(client.client_id).toBeTruthy();

    const authUrl = new URL(`${base}/authorize`);
    Object.entries({
      response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri,
      code_challenge: challenge, code_challenge_method: 'S256', state: 'st4te',
    }).forEach(([k, v]) => authUrl.searchParams.set(k, v));
    const page = await fetch(authUrl, { redirect: 'manual' });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Allow access to your AnyList?');
    expect(html).not.toContain(TOKEN);

    // Wrong password: no code
    const bad = await approve(client.client_id, 'wrong-password');
    expect(bad.status).toBe(401);
    expect(bad.headers.get('location')).toBeNull();

    // Deny: redirect with access_denied
    const denied = await approve(client.client_id, '', 'deny');
    expect(new URL(denied.headers.get('location')!).searchParams.get('error')).toBe('access_denied');

    // Correct password
    const ok = await approve(client.client_id, TOKEN);
    expect(ok.status).toBe(302);
    const location = new URL(ok.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(redirectUri);
    expect(location.searchParams.get('state')).toBe('st4te');
    const code = location.searchParams.get('code')!;

    // Wrong PKCE verifier fails
    const badPkce = await token({ grant_type: 'authorization_code', code, code_verifier: 'x'.repeat(43), client_id: client.client_id, redirect_uri: redirectUri });
    expect(badPkce.status).toBe(400);

    const tokens = await (
      await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: redirectUri })
    ).json();
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();

    // Code is single use
    const reuse = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: redirectUri });
    expect(reuse.status).toBe(400);

    expect((await mcp(listTools, tokens.access_token)).status).toBe(200);

    // Refresh rotates the refresh token
    const refreshed = await (await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id })).json();
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    const again = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(again.status).toBe(400);
    expect((await mcp(listTools, refreshed.access_token)).status).toBe(200);
  });

  it('locks out after repeated wrong passwords', async () => {
    const client = await (await register()).json();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await approve(client.client_id, `wrong-${i}`)).status);
    expect(statuses.at(-1)).toBe(429);
    // Even the right password is refused while locked out
    expect((await approve(client.client_id, TOKEN)).status).toBe(429);
  });
});
