/**
 * Pipe-safe `console.log` for CLI human-readable output.
 *
 * ## Why this exists (#2400)
 *
 * Pino's default destination opens fd 1 in non-blocking mode as a side effect
 * of `@archon/paths` being imported — every CLI command inherits that fd
 * state. On a non-blocking pipe (`archon … | less`, `archon … | head`,
 * `archon … | grep`), `console.log` calls that exceed the pipe's buffer can
 * silently drop the unwritten tail and exit 0 (see the file-redirect vs pipe
 * asymmetry in `utils/stdout.ts`). PR #2389 fixed the machine-readable
 * `--json` paths by routing every JSON emitter through `writeStdout` /
 * `writeJsonLine`. This patch is the symmetrical fix for human-readable
 * `console.log` calls — 226 of them across `packages/cli/src/commands/*.ts`,
 * every one a piped-failure site against a slow reader.
 *
 * The patch delegates through the same `writeStdout` primitive that
 * `--json` already uses, so short writes and `EAGAIN` are retried by the
 * stream rather than lost. The `void` return shape preserves the original
 * `console.log` signature so existing callers (and `spyOn(console, 'log')`
 * mocks in `workflow.test.ts` / `cli-adapter.test.ts`) keep working unchanged.
 *
 * ## Scope (deliberate)
 *
 * - `console.log` is patched; `console.warn` / `console.error` / `console.info`
 *   are NOT. Those default to stderr in Bun, which is not the fd pino flipped.
 *   `console.warn` is also used by CLI commands as the deliberate
 *   "non-pino diagnostic" channel (e.g. `workflow.ts`); routing it through
 *   `writeStdout` would change where it lands, which is a separate decision.
 * - Color is hard-disabled: Bun's built-in would colorize on TTY, but human
 *   CLI text (`console.log(\`some text\`)`) does not depend on ANSI. Pino
 *   pretty-printing (used when stdout is a TTY per `paths/src/logger.ts:62`)
 *   still colorizes its own output.
 * - Idempotent: a second call is a no-op so re-imports don't double-wrap.
 *
 * ## Maintainer warning
 *
 * Do not delete this patch because "the underlying cause lives in
 * `@archon/paths`" — moving pino to stderr is a wider blast-radius change
 * (server, adapters, every package that imports `@archon/paths`) and a
 * separate design call (see #2400 plan: this file vs `logger.ts` route).
 * Until that lands, this patch is the fix.
 */

import { formatWithOptions } from 'node:util';
import { writeStdout } from './stdout';

const ORIGINAL_LOG = console.log.bind(console);

let installed = false;

/**
 * Replace `console.log` with a pipe-safe delegate that awaits full delivery
 * through `writeStdout`. Safe to call multiple times — only the first call
 * has any effect.
 *
 * The patched function keeps `console.log`'s void-return signature. Callers
 * that don't await it (the entire existing call surface) keep working; the
 * underlying `process.stdout.write` stream callback fires once the bytes have
 * reached the OS, retrying short writes and `EAGAIN` through the event loop
 * (no busy-wait). See `utils/stdout.ts` for the underlying primitive.
 */
export function installPipeSafeConsole(): void {
  if (installed) return;
  installed = true;

  // `function` (not arrow) so `console.log.toString()` reports the name
  // and stack traces point at the wrapped symbol, which helps when a test
  // asserts on `console.log` identity.
  function pipeSafeLog(...args: unknown[]): void {
    // `colors: false` — Bun's built-in would colorize on TTY; CLI human
    // output (template strings, status lines) does not depend on ANSI.
    // `depth: 4` matches Bun's default for objects so a single-line diff in
    // CI is meaningful.
    const text = formatWithOptions({ colors: false, depth: 4 }, ...args) + '\n';
    // Fire-and-forget: keep `void` return so callers don't have to await,
    // and so tests that mock `console.log` with `() => {}` still pass.
    // Errors from `writeStdout` propagate to `process.stdout`'s uncaught
    // error handler (Bun surfaces EPIPE as a process error, matching the
    // behavior of the original `console.log` when the reader hangs up).
    void writeStdout(text);
  }

  // Preserve the original symbol name so logs / stack traces still read
  // "console.log" rather than "pipeSafeLog".
  Object.defineProperty(pipeSafeLog, 'name', { value: 'log', configurable: true });

  (console as { log: (...args: unknown[]) => void }).log = pipeSafeLog;
}

/** For tests / rollback: restore the original `console.log`. */
export function restoreConsole(): void {
  if (!installed) return;
  installed = false;
  (console as { log: (...args: unknown[]) => void }).log = ORIGINAL_LOG;
}
