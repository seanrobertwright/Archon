import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const SCRIPT_PATH = join(
  REPO_ROOT,
  '.archon',
  'workflows',
  'sdlc',
  'review',
  'scripts',
  'resolve-review-mode.py'
);
const PYTHON_COMMAND = globalThis.process.platform === 'win32' ? 'python' : 'python3';
const tempDirs: string[] = [];

async function runResolver(priorReport: string): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const process = Bun.spawn([PYTHON_COMMAND, SCRIPT_PATH], {
    cwd: REPO_ROOT,
    env: { ...globalThis.process.env, INPUTS_PRIOR_REPORT: priorReport },
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

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('resolve-review-mode', () => {
  it('distinguishes full, continuation, and broken continuation inputs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'archon-review-mode-'));
    tempDirs.push(dir);
    const existingReport = join(dir, 'report.md');
    const missingReport = join(dir, 'missing.md');
    await writeFile(existingReport, '# Prior review\n');

    const full = await runResolver('');
    expect(full.exitCode).toBe(0);
    expect(JSON.parse(full.stdout)).toEqual({ continuation: false });

    const continuation = await runResolver(existingReport);
    expect(continuation.exitCode).toBe(0);
    expect(JSON.parse(continuation.stdout)).toEqual({ continuation: true });

    const broken = await runResolver(missingReport);
    expect(broken.exitCode).toBe(1);
    expect(broken.stderr).toContain(`Previous review report does not exist: ${missingReport}`);
  });
});
