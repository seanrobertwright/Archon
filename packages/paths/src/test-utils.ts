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
 * Failing to delete a scratch directory is not a test failure, so exhausting the attempts
 * warns instead of throwing — but it does warn, so a genuine leak stays visible. Because
 * every outcome ends that same way, there is nothing to gain from classifying the error
 * code, and `force: true` already absorbs the one code that means "already gone".
 */
export async function removeTempTree(path: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS) {
        console.warn(`temp cleanup failed for ${path}: ${String(error)}`);
        return;
      }
      await Bun.sleep(RETRY_DELAY_MS);
    }
  }
}
