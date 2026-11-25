export interface AnyListConfig {
  email: string;
  password: string;
  /** Where the library caches its (encrypted) refresh token. null = don't persist. */
  credentialsFile: string | null;
}

export interface HttpConfig {
  host: string;
  port: number;
  /** Static bearer token. Also the owner password on the OAuth approval page. */
  authToken: string;
  /** Public base URL (e.g. https://anylist.example.com). Enables OAuth when set. */
  publicUrl?: URL;
  /** Optional JSON file to persist OAuth clients and (hashed) tokens across restarts. */
  oauthStateFile?: string;
  /** Hostnames OAuth clients may redirect to. */
  allowedRedirectHosts: string[];
  trustProxy: boolean;
}

export class ConfigError extends Error {}

export function loadAnyListConfig(env: NodeJS.ProcessEnv = process.env): AnyListConfig {
  const email = env.ANYLIST_EMAIL?.trim();
  const password = env.ANYLIST_PASSWORD;
  if (!email || !password) {
    throw new ConfigError('ANYLIST_EMAIL and ANYLIST_PASSWORD must be set in the environment.');
  }
  const file = env.ANYLIST_CREDENTIALS_FILE?.trim();
  return { email, password, credentialsFile: file ? file : null };
}

export const MIN_AUTH_TOKEN_LENGTH = 32;

export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const authToken = env.MCP_AUTH_TOKEN ?? '';
  if (authToken.length < MIN_AUTH_TOKEN_LENGTH) {
    throw new ConfigError(
      `MCP_AUTH_TOKEN must be set to a random string of at least ${MIN_AUTH_TOKEN_LENGTH} characters ` +
        '(e.g. `openssl rand -hex 32`). The HTTP server refuses to start without it.',
    );
  }
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port <= 0) throw new ConfigError('PORT must be a positive integer.');

  let publicUrl: URL | undefined;
  if (env.PUBLIC_URL) {
    try {
      publicUrl = new URL(env.PUBLIC_URL);
    } catch {
      throw new ConfigError('PUBLIC_URL must be a valid URL, e.g. https://anylist.example.com');
    }
    const local = publicUrl.hostname === 'localhost' || publicUrl.hostname === '127.0.0.1';
    if (publicUrl.protocol !== 'https:' && !local) {
      throw new ConfigError('PUBLIC_URL must use https:// (OAuth requires it).');
    }
  }

  return {
    host: env.HOST ?? '0.0.0.0',
    port,
    authToken,
    publicUrl,
    oauthStateFile: env.OAUTH_STATE_FILE?.trim() || undefined,
    allowedRedirectHosts: (env.OAUTH_ALLOWED_REDIRECT_HOSTS ?? 'claude.ai,claude.com,localhost,127.0.0.1')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean),
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
  };
}
