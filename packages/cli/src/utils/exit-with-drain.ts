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
 * Both arms of `cli.ts`'s top-level `main().then().catch()` chain route
 * through this helper so the drain contract is shared between the success
 * and fatal paths: a regression that re-splits the two arms (e.g. dropping
 * `flushPendingWrites()` from the catch arm only) cannot land without
 * changing this module, and the regression test in
 * `safe-console.test.ts` imports the same helper from here. See R9 in the
 * review report.
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
