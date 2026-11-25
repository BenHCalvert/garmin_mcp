import { describe, expect, it } from 'vitest';
import { ConfigError, loadAnyListConfig, loadHttpConfig } from '../src/config.js';

const token = 'x'.repeat(40);

describe('config', () => {
  it('requires AnyList credentials', () => {
    expect(() => loadAnyListConfig({})).toThrow(ConfigError);
    expect(loadAnyListConfig({ ANYLIST_EMAIL: 'a@b.c', ANYLIST_PASSWORD: 'pw' })).toEqual({
      email: 'a@b.c', password: 'pw', credentialsFile: null,
    });
  });

  it('requires a long MCP_AUTH_TOKEN for HTTP', () => {
    expect(() => loadHttpConfig({})).toThrow(/MCP_AUTH_TOKEN/);
    expect(() => loadHttpConfig({ MCP_AUTH_TOKEN: 'short' })).toThrow(/at least 32/);
    expect(loadHttpConfig({ MCP_AUTH_TOKEN: token }).port).toBe(3000);
  });

  it('requires https PUBLIC_URL except on localhost', () => {
    expect(() => loadHttpConfig({ MCP_AUTH_TOKEN: token, PUBLIC_URL: 'http://example.com' })).toThrow(/https/);
    expect(loadHttpConfig({ MCP_AUTH_TOKEN: token, PUBLIC_URL: 'http://localhost:3000' }).publicUrl?.host).toBe('localhost:3000');
  });
});
