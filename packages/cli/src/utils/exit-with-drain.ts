/**
 * Exit the CLI process after every fire-and-forget `writeStdout` write has
 * been drained to the OS.
 *
 * The pipe-safe `console.log` shim in `./safe-console.ts` delegates through
 * `writeStdout` and returns synchronously — bytes reach the OS via the
 * underlying stream callback, not synchronously. `process.exit()` does NOT
 * drain `process.stdout`'s pending writes, so a process that exits without
 * awaiting the shim's `flushPendingWrites()` will silently drop the tail of
 * queued stdout against a slow reader (the truncation the shim exists to
 * prevent — see R1 in the review report and #2400).
 *
 * Both `exitWithDrain` and `withDrainedExit` live here so `cli.ts`'s
 * top-level `main().then().catch()` chain and the `safe-console.test.ts`
 * R9 regression test fixture can share them: a regression that bypasses
 * `exitWithDrain` at the cli.ts call site (e.g. replacing `withDrainedExit`
 * with a direct `process.exit`) is caught by the fixture, which calls the
 * same helper from this module. See R9 / R12 in the review report.
 */
import { consumeWriteError, flushPendingWrites } from './safe-console';

export const exitWithDrain = async (code: number): Promise<never> => {
  await flushPendingWrites();
  // Any `process.stdout.write` failure captured by the patched `console.log`
  // (most commonly EPIPE from `archon … | head -c 100`) must surface as a
  // non-zero exit regardless of platform. Without this, a Linux CI runner
  // can schedule the unhandled-rejection handler after `process.exit()` and
  // silently lose the EPIPE — the writer exits 0 even though the piped
  // reader hung up before delivery completed.
  if (consumeWriteError() !== null && code === 0) {
    process.exit(1);
    return undefined as never;
  }
  process.exit(code);
};

/**
 * Run `main()` to completion, routing BOTH the resolved code (via
 * `exitWithDrain(code)`) and the fatal rejection (via `console.error` +
 * `exitWithDrain(1)`) through the same drain helper. This is the
 * single source of truth for the top-level `main().then().catch()`
 * chain shape that `cli.ts` uses and that the `safe-console.test.ts` R9
 * regression test fixture exercises.
 *
 * The chain wiring used to be duplicated as a string literal in two
 * places (cli.ts and the R9 fixture). Extracting it here makes a
 * regression that drops the drain from the catch arm only — e.g.
 * replacing `.catch(..., () => exitWithDrain(1))` with a direct
 * `process.exit(1)` — impossible without changing this module, which is
 * what the R9 test now catches. See R12 in the review report.
 */
export function withDrainedExit(
  main: () => Promise<number>,
  logFatal: (error: Error) => void = (error): void => {
    console.error('Fatal error:', error.message);
  }
): Promise<never> {
  return main()
    .then(exitWithDrain)
    .catch(async (error: unknown) => {
      logFatal(error as Error);
      return exitWithDrain(1);
    });
}
