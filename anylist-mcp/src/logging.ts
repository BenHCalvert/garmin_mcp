import { format } from 'node:util';
import { redact } from './redact.js';

/**
 * The anylist library logs with console.info/console.error. On the stdio transport,
 * anything written to stdout corrupts the JSON-RPC stream, so every console method is
 * routed to stderr, and every line is passed through the redactor.
 *
 * Must be called before the anylist library is used.
 */
let installed = false;

export function installSafeConsole(write: (line: string) => void = line => process.stderr.write(line)): void {
  if (installed) return;
  installed = true;
  const quiet = process.env.LOG_LEVEL === 'silent';
  const debug = process.env.LOG_LEVEL === 'debug';
  const emit = (level: string) => (...args: unknown[]) => {
    if (quiet) return;
    if (level === 'debug' && !debug) return;
    write(`[${level}] ${redact(format(...args.map(scrubArg)))}\n`);
  };
  console.log = emit('info');
  console.info = emit('info');
  console.debug = emit('debug');
  console.warn = emit('warn');
  console.error = emit('error');
}

/** Errors from `got` carry request options (including Authorization headers); log only name + message. */
function scrubArg(arg: unknown): unknown {
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  return arg;
}

/** Test helper. */
export function _resetConsoleForTests(): void {
  installed = false;
}

export const log = {
  info: (...a: unknown[]) => console.info(...a),
  warn: (...a: unknown[]) => console.warn(...a),
  error: (...a: unknown[]) => console.error(...a),
};
