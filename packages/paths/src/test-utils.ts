/**
 * Filesystem helpers shared by tests across packages.
 *
 * This module is test-only. Nothing in `src/` imports it; it lives here because
 * `@archon/paths` is the one package every consumer of these helpers already depends on.
 */
import { rm } from 'node:fs/promises';

/** Attempts before a stuck tree is reported as a leak rather than retried again. */
const MAX_ATTEMPTS = 10;
const RETRY_DELAY_MS = 50;

/**
 * Codes meaning "something still holds this tree", not "this can never be removed".
 *
 * The first five are the set Node documents for `rm`'s own `maxRetries`. `EFAULT` is the
 * odd one, and it is not defensive padding — under Bun it is the only entry that does any
 * work. Bun's `rm` maps any underlying OS error it cannot classify onto `EFAULT`, so an
 * ordinary lock arrives wearing a code that reads as a bad pointer. Measured against the
 * probe described below, which induces a genuine `EPERM` with the macOS `uchg` flag and
 * releases it after 300 ms: with `EFAULT` listed the tree is removed after ~310 ms of
 * retrying; with it dropped the same call gives up in 0 ms and leaves the tree on disk,
 * because the `EPERM` never arrives under that name. This is the signature these cleanups
 * fail with on Windows CI (#2306).
 *
 * Because Bun collapses unmapped errors onto `EFAULT`, this set cannot be exhaustive in
 * either direction; a permanently unremovable tree may also arrive as `EFAULT` and simply
 * costs the full retry budget before it is reported. That is acceptable because both
 * paths end the same way — see `removeTempTree`.
 */
const TRANSIENT_CODES = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM', 'EFAULT']);

/**
 * Remove a test temp tree, retrying while the OS still holds a handle inside it.
 *
 * A just-exited child process, or the test's own preceding async writes, can leave a
 * handle open for a short window after the work that created it finished. Windows is
 * where this actually bites: an unretried cleanup there fails the test that just passed
 * (#2306).
 *
 * The retry is written out rather than delegated to `rm`'s own `maxRetries`/`retryDelay`
 * because **Bun accepts those options and ignores them**. Measured on Bun 1.3.11: against
 * a tree holding one file locked with the macOS `uchg` flag (unlink returns EPERM, which
 * is in the retry set Node documents), `rm(..., { maxRetries: 10, retryDelay: 50 })`
 * rejects in 0 ms, while the same call on node v25.6.1 retries for ~300 ms and succeeds
 * once the flag clears. `rmSync` behaves the same way. Bun also reports errors it cannot
 * map as `EFAULT` — that same locked-file probe surfaces EPERM as
 * `EFAULT: bad address in system call argument`, which is why cleanup failures on Windows
 * CI carry a code that looks nothing like a lock. Switching back to the built-in options
 * is safe only once Bun actually honors them.
 *
 * Failing to delete a scratch directory is not a test failure, so a tree that never comes
 * free warns instead of throwing — but it does warn, so a genuine leak stays visible. An
 * error outside `TRANSIENT_CODES` takes that same exit immediately rather than retrying
 * against a condition that will not clear. (`force: true` already absorbs "already gone".)
 */
export async function removeTempTree(path: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= MAX_ATTEMPTS || code === undefined || !TRANSIENT_CODES.has(code)) {
        console.warn(`temp cleanup failed for ${path}: ${String(error)}`);
        return;
      }
      await Bun.sleep(RETRY_DELAY_MS);
    }
  }
}
