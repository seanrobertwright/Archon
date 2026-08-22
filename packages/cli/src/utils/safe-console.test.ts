/**
 * Real-pipe regression tests for #2400 (piped human-readable `console.log`
 * silently truncates against a slow reader).
 *
 * ## Why these tests spawn a shell pipeline
 *
 * The bug only exists when fd 1 is a **non-blocking pipe**, which is what a
 * shell creates for `archon … | less`. The causal chain is identical to
 * `--json` truncation in #2384:
 *
 *  1. Importing `@archon/paths` builds the pino root logger, whose default
 *     destination opens fd 1 in non-blocking mode.
 *  2. On a non-blocking pipe a `console.log` call that exceeds the pipe's
 *     buffer can return a short count, and the stream drops the unwritten tail
 *     without error.
 *
 * That is why `> out.txt` always looked fine: a regular-file fd stays
 * blocking. PR #2389 routed every `--json` payload through `writeStdout`
 * (`utils/stdout.ts`) and closed that gap. #2400 is the symmetrical gap for
 * human-readable `console.log` calls, fixed by monkey-patching `console.log`
 * to delegate through the same `writeStdout` primitive (see
 * `utils/safe-console.ts`).
 *
 * `Bun.spawn` with `stdout: 'pipe'` does NOT reproduce the truncation, and
 * neither does mocking `process.stdout.write` — both replace the exact thing
 * that was broken. These tests therefore drive a genuine
 * `bun … workflow list | { sleep 0.5; cat; } > file` shell pipeline.
 *
 * ## Calibration (measured on macOS/arm64, bun 1.3.11)
 *
 * The payload size and consumer pattern below are not arbitrary. Against the
 * pre-fix code, a ~1.07 MB `workflow list` payload piped to
 * `{ sleep 0.5; cat; }` truncated in 5/5 runs (delivery 89–96%). The same
 * harness against the patched code delivered 10/10 byte-identical to the
 * file redirect. The slow consumer (`sleep 0.5` before reading) is what makes
 * the truncation deterministic — a plain `cat` only truncates ~1% of runs at
 * this payload size because cat drains the pipe faster than the writer fills
 * it. Do not "simplify" the consumer back to plain `cat` without re-measuring
 * against a pre-fix build; the test would silently stop catching regressions.
 *
 * POSIX-only: Windows has no equivalent non-blocking-pipe path and no bash.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI_ENTRY = join(import.meta.dir, '..', 'cli.ts');
const BUN = process.execPath;

/** Tuned so the human-readable payload lands in the proven truncation window. */
const WORKFLOW_COUNT = 150;
const DESCRIPTION_CHARS = 7000;
/** Piped runs per assertion. Pre-fix truncates 5/5; post-fix passes 10/10. */
const PIPED_RUNS = 5;

let repoDir: string;
let archonHome: string;
let scratch: string;

function runShell(script: string): { status: number | null; stdout: string } {
  // LOG_LEVEL=silent silences pino's diagnostic lines so two CLI invocations
  // produce byte-identical stdout (each invocation carries a unique timestamp
  // + pid in the first JSON line; the human-readable payload underneath is
  // stable, but pino's preamble is not). Without this the test would diff on
  // the pino preamble and pass trivially even when the real payload truncates.
  const result = spawnSync('bash', ['-c', script], {
    env: { ...process.env, ARCHON_HOME: archonHome, LOG_LEVEL: 'silent' },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout ?? '' };
}

/** `archon workflow list` with stdout redirected to a regular file (blocking fd). */
function listToFile(target: string): number | null {
  return runShell(
    `"${BUN}" "${CLI_ENTRY}" workflow list --cwd "${repoDir}" 2>/dev/null > "${target}"`
  ).status;
}

/**
 * The same command with stdout attached to a real pipe. The consumer sleeps
 * for 500 ms before draining so the writer fills the pipe buffer before the
 * reader pulls anything — that is what makes the pre-fix truncation
 * deterministic. `cat` alone truncates too rarely to be a useful test.
 */
function listThroughPipe(target: string): number | null {
  return runShell(
    `"${BUN}" "${CLI_ENTRY}" workflow list --cwd "${repoDir}" 2>/dev/null | { sleep 0.5; cat; } > "${target}"; exit \${PIPESTATUS[0]}`
  ).status;
}

/**
 * Very-slow consumer (1 s before reading). The CLI finishes in ~620 ms; with
 * the fire-and-forget shim and no exit-path flush, `process.exit()` would
 * fire while bytes are still queued in the stream buffer and the truncation
 * described in R1 (review report) returns. `flushPendingWrites()` in
 * `cli.ts` is what closes that window — do not delete it without re-running
 * this test.
 */
function listThroughVerySlowPipe(target: string): number | null {
  return runShell(
    `"${BUN}" "${CLI_ENTRY}" workflow list --cwd "${repoDir}" 2>/dev/null | { sleep 1; cat; } > "${target}"; exit \${PIPESTATUS[0]}`
  ).status;
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'archon-pipe-test-'));
  archonHome = join(scratch, 'home');
  repoDir = join(scratch, 'repo');
  mkdirSync(archonHome, { recursive: true });
  const workflowsDir = join(repoDir, '.archon', 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  spawnSync('git', ['init', '-q', '.'], { cwd: repoDir });

  const padding = 'x'.repeat(DESCRIPTION_CHARS);
  for (let i = 0; i < WORKFLOW_COUNT; i++) {
    const name = `probe-${String(i).padStart(3, '0')}`;
    writeFileSync(
      join(workflowsDir, `${name}.yaml`),
      `name: ${name}\ndescription: ${padding}${i}\nnodes:\n  - id: only\n    prompt: hello\n`
    );
  }
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('CLI human-readable console.log over a real pipe (#2400)', () => {
  it('delivers the whole document, byte-identical to a file redirect, against a slow consumer', () => {
    const referencePath = join(scratch, 'reference.txt');
    expect(listToFile(referencePath)).toBe(0);
    const reference = readFileSync(referencePath);

    // Guard the calibration: below the pipe capacity the bug cannot occur, so a
    // shrinking payload would silently turn this into a no-op test.
    expect(reference.byteLength).toBeGreaterThan(65_536);

    for (let run = 0; run < PIPED_RUNS; run++) {
      const pipedPath = join(scratch, `piped-${run}.txt`);
      const status = listThroughPipe(pipedPath);
      const piped = readFileSync(pipedPath);

      expect({ run, status }).toEqual({ run, status: 0 });
      // Report the byte count on failure — a bare buffer diff is unreadable.
      expect({ run, bytes: piped.byteLength }).toEqual({ run, bytes: reference.byteLength });
      expect(piped.equals(reference)).toBe(true);
    }
  }, 180_000);

  /**
   * Regression guard for the EPIPE propagation contract
   * (`safe-console.ts` file comment: "Bun surfaces EPIPE as a process
   * error, matching the behavior of the original `console.log` when the
   * reader hangs up"). A defensive `writeStdout(text).catch(() => {})`
   * regression in the shim would turn `archon … | head -c 100` into a
   * silent exit 0; the only test above uses `cat` and would not catch it.
   *
   * `head -c 100` closes the read end of the pipe after the first 100
   * bytes, so the writer's next `process.stdout.write` fails with EPIPE.
   * Bun's default unhandled-rejection-fatal policy then exits non-zero.
   * We capture `${PIPESTATUS[0]}` (the writer's status) so the surrounding
   * pipeline cannot mask a non-zero exit with a clean `head`.
   */
  it('propagates EPIPE as a non-zero exit when the consumer hangs up early', () => {
    const result = runShell(
      `"${BUN}" "${CLI_ENTRY}" workflow list --cwd "${repoDir}" 2>/dev/null | head -c 100 > /dev/null; exit \${PIPESTATUS[0]}`
    );
    expect(result.status).not.toBe(0);
  }, 60_000);

  /**
   * Regression guard for R1 (review report): the fire-and-forget shim
   * discards the per-write completion promise, so `process.exit()` would
   * race the stream drain and re-introduce the silent-exit-0 truncation
   * the patch is meant to eliminate. The fix is `flushPendingWrites()` in
   * `cli.ts` (awaited between `main()` and `process.exit()`); this test
   * sleeps 1 s on the consumer side — longer than the CLI's own runtime —
   * so without the flush the queued bytes are lost. With the flush in
   * place the output is byte-identical to the file redirect.
   */
  it('delivers the whole document to a very-slow consumer (sleep >= 1 s) without truncating', () => {
    const referencePath = join(scratch, 'reference.txt');
    const pipedPath = join(scratch, 'very-slow.txt');
    const status = listThroughVerySlowPipe(pipedPath);
    const reference = readFileSync(referencePath);
    const piped = readFileSync(pipedPath);

    expect(status).toBe(0);
    expect({ bytes: piped.byteLength }).toEqual({ bytes: reference.byteLength });
    expect(piped.equals(reference)).toBe(true);
  }, 120_000);
});
