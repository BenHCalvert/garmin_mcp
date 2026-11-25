import AnyList from 'anylist';
import type { AnyListConfig } from './config.js';
import { registerSecrets } from './redact.js';

/** The subset of the AnyList library instance the service relies on. Tests provide a fake. */
export type AnyListLike = Pick<
  AnyList,
  'getLists' | 'createItem' | 'getMealPlanningCalendarEvents' | 'createEvent' | 'getRecipes' | 'teardown'
> & {
  mealPlanningCalendarEventLabels?: AnyList['mealPlanningCalendarEventLabels'];
  /** Raw decoded protobuf user data (private in the library; used read-only for category names). */
  _userData?: unknown;
};

export type AnyListProvider = () => Promise<AnyListLike>;

/**
 * Lazily logs in once and shares the session. If login fails, the next call retries.
 * The websocket listener is not started: every tool call fetches fresh data anyway.
 */
export function createAnyListProvider(config: AnyListConfig): AnyListProvider {
  let instance: AnyList | undefined;
  let pending: Promise<AnyListLike> | undefined;

  registerSecrets(() => {
    const lib = instance as unknown as { accessToken?: string; refreshToken?: string; clientId?: string } | undefined;
    return [config.password, config.email, lib?.accessToken, lib?.refreshToken, lib?.clientId];
  });

  return () => {
    if (!pending) {
      instance = new AnyList({
        email: config.email,
        password: config.password,
        credentialsFile: config.credentialsFile,
      });
      const lib = instance;
      pending = lib
        .login(false)
        .then(() => lib as AnyListLike)
        .catch(err => {
          pending = undefined;
          throw new AnyListLoginError(err);
        });
    }
    return pending;
  };
}

export class AnyListLoginError extends Error {
  constructor(cause: unknown) {
    const status = (cause as { response?: { statusCode?: number } })?.response?.statusCode;
    super(
      status === 401 || status === 400
        ? 'AnyList login failed: the server rejected the email/password.'
        : `AnyList login failed${status ? ` (HTTP ${status})` : ''}. Check network access and credentials.`,
    );
    this.name = 'AnyListLoginError';
  }
}
