import { afterEach, describe, expect, it } from 'vitest';
import { _resetConsoleForTests, installSafeConsole } from '../src/logging.js';
import { clearSecretSources, redact, registerSecrets } from '../src/redact.js';

afterEach(() => clearSecretSources());

describe('redact', () => {
  it('removes registered secrets, bearer tokens, JWTs and token-ish key/values', () => {
    registerSecrets(() => ['p@ssw0rd!', undefined, 'ab']);
    const out = redact(
      'pw p@ssw0rd! auth Bearer abc.def-123 jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk refresh_token=xyz789 "access_token":"qqq"',
    );
    expect(out).not.toMatch(/p@ssw0rd|abc\.def-123|eyJhbGci|xyz789|qqq/);
    // Very short secrets are ignored so normal text isn't mangled
    expect(redact('about')).toBe('about');
  });

  it('reads secrets lazily so rotated tokens are covered', () => {
    let token = 'first-token-value';
    registerSecrets(() => [token]);
    token = 'second-token-value';
    expect(redact('x second-token-value x')).toBe('x [REDACTED] x');
  });
});

describe('safe console', () => {
  it('routes all console output away from stdout and redacts it', () => {
    const lines: string[] = [];
    const original = { ...console };
    const stdoutWrite = process.stdout.write;
    let stdoutUsed = false;
    process.stdout.write = (() => { stdoutUsed = true; return true; }) as typeof process.stdout.write;
    try {
      _resetConsoleForTests();
      registerSecrets(() => ['super-secret-pw']);
      installSafeConsole(l => lines.push(l));
      console.log('login with super-secret-pw');
      console.info('Endpoint https://www.anylist.com/auth/token returned 401');
      console.error(Object.assign(new Error('boom'), { options: { headers: { authorization: 'Bearer leaked' } } }));
    } finally {
      Object.assign(console, original);
      process.stdout.write = stdoutWrite;
      _resetConsoleForTests();
    }
    expect(stdoutUsed).toBe(false);
    expect(lines).toHaveLength(3);
    expect(lines.join('')).not.toMatch(/super-secret-pw|leaked/);
    expect(lines[2]).toContain('Error: boom');
  });
});
