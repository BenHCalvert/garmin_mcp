/**
 * Secret redaction. Every string that leaves this process (logs, tool results,
 * HTTP error bodies) should pass through `redact()` first.
 */

type SecretSource = () => Array<string | undefined | null>;

const sources: SecretSource[] = [];

/** Register a callback that returns current secret values (read lazily so rotated tokens are covered). */
export function registerSecrets(source: SecretSource): void {
  sources.push(source);
}

/** Test helper. */
export function clearSecretSources(): void {
  sources.length = 0;
}

const BEARER_RE = /(bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const KV_RE = /((?:access_token|refresh_token|password|client_secret|token)["']?\s*[:=]\s*["']?)[^"'\s,&}]+/gi;

export function redact(input: unknown): string {
  let text = typeof input === 'string' ? input : safeStringify(input);
  for (const source of sources) {
    for (const secret of source()) {
      // Very short values (e.g. an empty or 1-2 char password) would mangle normal text; skip them.
      if (secret && secret.length >= 4) {
        text = text.split(secret).join('[REDACTED]');
      }
    }
  }
  return text
    .replace(BEARER_RE, '$1[REDACTED]')
    .replace(JWT_RE, '[REDACTED]')
    .replace(KV_RE, '$1[REDACTED]');
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  } catch {
    return String(value);
  }
}
