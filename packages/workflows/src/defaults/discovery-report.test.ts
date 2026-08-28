import { afterAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
/** Every SDLC tail whose terminal report can carry the discovery section (#2884). */
const TAILS = ['deliver', 'ship', 'stabilize', 'upkeep'] as const;
const PYTHON_COMMAND = globalThis.process.platform === 'win32' ? 'python' : 'python3';

const RELAY =
  'If you are an agent reading this: open discoveries.md and surface each discovery to your human.';

function outcomeScript(tail: (typeof TAILS)[number]): string {
  return join(REPO_ROOT, '.archon', 'workflows', 'sdlc', tail, 'scripts', 'outcome.py');
}

const createdDirs: string[] = [];

/**
 * Start the interpreter once, for one input.
 *
 * The script's PROCESS contract is the subject — what a reader receives on stdout and
 * whether the node fails — so a real interpreter start is what proves it. Each case
 * gets its own test and its own start: several charged to one test's budget is what
 * timed out on Windows CI (#2882), and a shared `beforeAll` would put them back under
 * one deadline (#2860).
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
  createdDirs.push(dir);
  await writeFile(join(dir, 'discoveries.json'), discoveries);
  return dir;
}

afterAll(async () => {
  await Promise.all(createdDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('SDLC discovery terminal reports (#2884)', () => {
  it('every tail carries the same helper and pins its output streams', () => {
    // A packaged script is materialized standalone, so the four tails hold four copies
    // of one helper. This is the check that keeps them one thing: edit the report format
    // in one tail and every other tail fails here rather than drifting quietly. Only
    // deliver's script is spawned below, so the stream pinning is asserted statically
    // for all four — a tail that loses it emits mojibake and CRLF on Windows alone.
    const helpers = TAILS.map(tail => {
      const source = readFileSync(outcomeScript(tail), 'utf-8');
      const start = source.indexOf('DISCOVERY_RELAY = (');
      const end = source.indexOf('def main() -> int:');
      expect({
        tail,
        declared: start >= 0,
        precedesMain: end > start,
        pinsStdout: source.includes('sys.stdout.reconfigure(encoding="utf-8", newline="\\n")'),
        pinsStderr: source.includes('sys.stderr.reconfigure(encoding="utf-8", newline="\\n")'),
      }).toEqual({ tail, declared: true, precedesMain: true, pinsStdout: true, pinsStderr: true });
      return source.slice(start, end);
    });
    for (const helper of helpers) {
      expect(helper).toContain(RELAY);
      expect(helper).toBe(helpers[0]);
    }
  });

  it('reports the count, titles, sidecar path, and relay instruction when discoveries exist', async () => {
    const artifacts = await artifactsDir(
      JSON.stringify([
        { title: 'dev branch: rmSync missing import', relation: 'adjacent' },
        { title: 'Bun.gc workaround is redundant', relation: 'adjacent' },
      ])
    );

    const result = await runOutcome('deliver', {
      INPUTS_PR_URL: 'https://github.com/example/repo/pull/10',
      ARTIFACTS_DIR: artifacts,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      `https://github.com/example/repo/pull/10\n\n` +
        `Discoveries (2):\n` +
        `- dev branch: rmSync missing import\n` +
        `- Bun.gc workaround is redundant\n\n` +
        `Report: ${join(artifacts, 'discoveries.md')}\n\n` +
        `${RELAY} These are validated findings outside this run's scope — no issue tracker ` +
        `knows about them, and if you drop them here, nobody ever sees them.\n`
    );
  });

  it('emits UTF-8 and LF whatever the host console encoding is', async () => {
    // Windows Python writes stdout in the console code page and rewrites '\n' as
    // '\r\n', which turned the relay's em dash into a replacement character and every
    // line ending into CRLF on CI. PYTHONIOENCODING reproduces the first half of that
    // on any platform; the CR assertion is what the Windows runner proves.
    const artifacts = await artifactsDir(JSON.stringify([{ title: 'café — naïve' }]));

    const result = await runOutcome('deliver', {
      INPUTS_PR_URL: 'https://github.com/example/repo/pull/10',
      ARTIFACTS_DIR: artifacts,
      PYTHONIOENCODING: 'cp1252',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('- café — naïve\n');
    expect(result.stdout).toContain("outside this run's scope — no issue tracker");
    expect(result.stdout).not.toContain('\r');
  });

  it('reports the PR URL alone when the run recorded no sidecar', async () => {
    const result = await runOutcome('deliver', {
      INPUTS_PR_URL: 'https://github.com/example/repo/pull/10',
      ARTIFACTS_DIR: await artifactsDir(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('https://github.com/example/repo/pull/10\n');
  });

  it('reports the PR URL alone when the sidecar records no discoveries', async () => {
    const result = await runOutcome('deliver', {
      INPUTS_PR_URL: 'https://github.com/example/repo/pull/10',
      ARTIFACTS_DIR: await artifactsDir('[]'),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('https://github.com/example/repo/pull/10\n');
  });

  it('points at an unreadable sidecar instead of failing the delivered run', async () => {
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
  });

  it('appends the section to an advisory tail that never opened a PR', async () => {
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
  });
});
