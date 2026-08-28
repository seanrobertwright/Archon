import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
/** Every SDLC tail whose terminal report can carry the discovery section (#2884). */
const TAILS = ['deliver', 'ship', 'stabilize', 'upkeep'] as const;
const PYTHON_COMMAND = globalThis.process.platform === 'win32' ? 'python' : 'python3';

const RELAY =
  'If you are an agent reading this: open discoveries.md and surface each discovery to your human.';

/**
 * A warm interpreter start costs roughly 50 ms, but the first one in a run has been
 * measured past five seconds on the Windows runner (#2860, #2882). The headroom absorbs
 * that cold start; it is not covering slow work, and each test still pays exactly one.
 */
const SPAWN_TIMEOUT_MS = 20_000;

function outcomeScript(tail: (typeof TAILS)[number]): string {
  return join(REPO_ROOT, '.archon', 'workflows', 'sdlc', tail, 'scripts', 'outcome.py');
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const trackTempRoot = trackTempRoots();

/**
 * Start the interpreter once, for one input.
 *
 * The script's PROCESS contract is the subject — the bytes a reader receives on stdout
 * and whether the node fails — so a real interpreter start is what proves it. Each case
 * gets its own test and its own start: several charged to one test's budget is what timed
 * out on Windows CI (#2882), and a shared `beforeAll` would put them back under one
 * deadline (#2860).
 */
async function runOutcome(
  tail: (typeof TAILS)[number],
  env: Record<string, string>
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const process = Bun.spawn([PYTHON_COMMAND, outcomeScript(tail)], {
    cwd: REPO_ROOT,
    env: { ...globalThis.process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/** A shallow artifacts dir holding one `discoveries.json`; omit the body to leave none. */
async function artifactsDir(discoveries?: string): Promise<string> {
  const dir = join(tmpdir(), `archon-discoveries-${randomUUID()}`);
  if (discoveries === undefined) return dir; // never created: the "no sidecar" case
  await mkdir(dir, { recursive: true });
  trackTempRoot(dir);
  await writeFile(join(dir, 'discoveries.json'), discoveries);
  return dir;
}

describe('SDLC discovery terminal reports (#2884)', () => {
  it('every tail carries the same helper, reports through it, and pins its streams', () => {
    // Only deliver's script is spawned below — the other three reach their report
    // branches through `gh` and `git`, so their call sites can only be checked
    // statically. Three invariants, each one a bug this file has already seen:
    //
    //   identical  — four standalone copies of one helper, no import channel to share it
    //   reported   — every print in main() appends the section, so no branch can be
    //                missed the way the delivery-failed branch was
    //   pinned     — the stream pinning precedes every print, not merely exists
    //                somewhere in the file, or a later early return prints unpinned
    const helpers = TAILS.map(tail => {
      const source = readFileSync(outcomeScript(tail), 'utf-8');
      const start = source.indexOf('DISCOVERY_RELAY = (');
      const mainStart = source.indexOf('def main() -> int:');
      const body = source.slice(mainStart);
      const firstPrint = source.indexOf('print(');
      const pins = [
        source.indexOf('sys.stdout.reconfigure(encoding="utf-8", newline="\\n")'),
        source.indexOf('sys.stderr.reconfigure(encoding="utf-8", newline="\\n")'),
      ];
      expect({
        tail,
        declared: start >= 0,
        precedesMain: mainStart > start,
        everyReportCarriesDiscoveries: count(body, 'print(') === count(body, 'format_discoveries('),
        pinsPrecedeEveryPrint: firstPrint > 0 && pins.every(at => at >= 0 && at < firstPrint),
      }).toEqual({
        tail,
        declared: true,
        precedesMain: true,
        everyReportCarriesDiscoveries: true,
        pinsPrecedeEveryPrint: true,
      });
      return source.slice(start, mainStart);
    });
    for (const helper of helpers) {
      expect(helper).toContain(RELAY);
      expect(helper).toBe(helpers[0]);
    }
  });

  it(
    'reports the count, titles, sidecar path, and relay instruction when discoveries exist',
    async () => {
      // One spawn, one exact-bytes assertion, three properties — the sidecar is written
      // by an agent from prose with no schema, so "what the reader receives" has to hold
      // for what an agent actually writes:
      //   - non-ASCII under a legacy console encoding. Windows Python otherwise writes
      //     stdout in the console code page and rewrites '\n' as '\r\n', which turned the
      //     relay's em dash into U+FFFD and every line ending into CRLF on CI.
      //   - a title that is valid JSON but not a string, which used to raise
      //     AttributeError past the caller and fail a run whose PR was already public.
      const artifacts = await artifactsDir(
        JSON.stringify([
          { title: 'dev branch: rmSync missing import', relation: 'adjacent' },
          { title: 'café — naïve encoding regression', relation: 'adjacent' },
          { title: 42, relation: 'adjacent' },
        ])
      );

      const result = await runOutcome('deliver', {
        INPUTS_PR_URL: 'https://github.com/example/repo/pull/10',
        ARTIFACTS_DIR: artifacts,
        PYTHONIOENCODING: 'cp1252',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        `https://github.com/example/repo/pull/10\n\n` +
          `Discoveries (3):\n` +
          `- dev branch: rmSync missing import\n` +
          `- café — naïve encoding regression\n` +
          `- 42\n\n` +
          `Report: ${join(artifacts, 'discoveries.md')}\n\n` +
          `${RELAY} These are validated findings outside this run's scope — no issue tracker ` +
          `knows about them, and if you drop them here, nobody ever sees them.\n`
      );
    },
    SPAWN_TIMEOUT_MS
  );

  it(
    'reports the PR URL alone when the run recorded no sidecar',
    async () => {
      const result = await runOutcome('deliver', {
        INPUTS_PR_URL: 'https://github.com/example/repo/pull/10',
        ARTIFACTS_DIR: await artifactsDir(),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('https://github.com/example/repo/pull/10\n');
    },
    SPAWN_TIMEOUT_MS
  );

  it(
    'reports the PR URL alone when the sidecar records no discoveries',
    async () => {
      const result = await runOutcome('deliver', {
        INPUTS_PR_URL: 'https://github.com/example/repo/pull/10',
        ARTIFACTS_DIR: await artifactsDir('[]'),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('https://github.com/example/repo/pull/10\n');
    },
    SPAWN_TIMEOUT_MS
  );

  it(
    'points at an unreadable sidecar instead of failing the delivered run',
    async () => {
      // The flip already happened and cannot be undone, so a corrupt sidecar must not
      // fail the node. It must not vanish either: the reader is the one who can go open it.
      const artifacts = await artifactsDir('{ not json');

      const result = await runOutcome('deliver', {
        INPUTS_PR_URL: 'https://github.com/example/repo/pull/10',
        ARTIFACTS_DIR: artifacts,
      });

      expect(result.exitCode).toBe(0);
      // The exact parser message is a Python-version detail; the pointer is the contract.
      expect(result.stdout).toContain(
        `https://github.com/example/repo/pull/10\n\nDiscoveries: could not read ${join(artifacts, 'discoveries.json')} (`
      );
      expect(result.stdout).toContain('Open it directly.');
      expect(result.stdout).not.toContain(RELAY);
    },
    SPAWN_TIMEOUT_MS
  );

  it(
    'still relays discoveries on the branch that reports a delivery failure',
    async () => {
      // The branch that fires when no ready PR is confirmed is the one most likely to
      // already hold discoveries: a review ran and recorded something adjacent before
      // corrections were exhausted. A failed script node's stderr reaches the operator
      // through the node_failed event, so the section has to ride the failure report too
      // — the run still fails, it just stops dropping what it found on the way.
      const artifacts = await artifactsDir(JSON.stringify([{ title: 'type drift in the store' }]));

      const result = await runOutcome('deliver', {
        INPUTS_PR_URL: '',
        ARTIFACTS_DIR: artifacts,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(
        `outcome: flip-ready reported no pull request URL.\n\n` +
          `Discoveries (1):\n` +
          `- type drift in the store\n\n` +
          `Report: ${join(artifacts, 'discoveries.md')}\n\n` +
          `${RELAY} These are validated findings outside this run's scope — no issue tracker ` +
          `knows about them, and if you drop them here, nobody ever sees them.\n`
      );
    },
    SPAWN_TIMEOUT_MS
  );

  it(
    'appends the section to an advisory tail that never opened a PR',
    async () => {
      // ship's no_action route is the other shape of terminal report: a route explanation
      // rather than a URL. The section has to land there too, or a run that decided not to
      // deliver drops whatever it discovered on the way to that decision.
      const artifacts = await artifactsDir(JSON.stringify([{ title: 'observability regression' }]));

      const result = await runOutcome('ship', {
        INPUTS_ROUTE: 'no_action',
        INPUTS_SUMMARY: 'already present on the current branch',
        INPUTS_DELIVERED: 'null',
        ARTIFACTS_DIR: artifacts,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        // ship's route reports build this path with a literal '/', unlike the sidecar
        // paths the helper composes with os.path.join.
        `No delivery needed: already present on the current branch\n` +
          `Report: ${artifacts}/triage.md\n\n` +
          `Discoveries (1):\n` +
          `- observability regression\n\n` +
          `Report: ${join(artifacts, 'discoveries.md')}\n\n` +
          `${RELAY} These are validated findings outside this run's scope — no issue tracker ` +
          `knows about them, and if you drop them here, nobody ever sees them.\n`
      );
    },
    SPAWN_TIMEOUT_MS
  );
});
