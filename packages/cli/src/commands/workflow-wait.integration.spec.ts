/**
 * `archon workflow wait <run-id>` against a REAL detached run, in a second process.
 *
 * This is #2745's regression boundary: the launching command returns, a separate
 * process waits on the run id it was handed, and that wait — not a `workflow get`
 * loop — is what learns the outcome. Every case here runs `wait` as its own OS
 * process against a real SQLite database, so a wake that only works in-process
 * would fail here.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { requestDetachedRunStop } from '../utils/detached-run-control';

const cleanupPaths: string[] = [];
const activeRunIds = new Set<string>();

// One explicit hook, not `trackTempRoots()`: a still-running owner has to be stopped
// before its tree can go, and two hooks would leave registration order as the only
// thing keeping that correct.
afterEach(async () => {
  for (const runId of activeRunIds) {
    try {
      const target = await requestDetachedRunStop(runId);
      await target.stop();
    } catch {
      // A completed owner has already removed its endpoint.
    }
  }
  activeRunIds.clear();
  for (const path of cleanupPaths.splice(0)) {
    await removeTempTree(path);
  }
});

const CLI_PATH = resolve(import.meta.dir, '..', 'cli.ts');

interface Fixture {
  projectRoot: string;
  archonHome: string;
}

function makeFixture(
  prefix: string,
  workflows: Record<string, string>,
  options: { gitInit?: boolean } = {}
): Fixture {
  const fixtureRoot = mkdtempSync(join(tmpdir(), prefix));
  cleanupPaths.push(fixtureRoot);
  const archonHome = join(fixtureRoot, 'home');
  const projectRoot = join(fixtureRoot, 'project');
  const workflowsDir = join(projectRoot, '.archon', 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  for (const [name, body] of Object.entries(workflows)) {
    writeFileSync(join(workflowsDir, `${name}.yaml`), body);
  }
  if (options.gitInit) {
    // The CLI's pre-dispatch gate accepts a git repo OR a registered folder project.
    // Tests that launch a run register the folder on the way in; a test that only
    // runs `wait` has to be a repo.
    Bun.spawnSync(['git', 'init', '-q', projectRoot]);
  }
  return { projectRoot, archonHome };
}

async function runCli(
  fixture: Fixture,
  args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd: fixture.projectRoot,
    env: { ...process.env, ARCHON_HOME: fixture.archonHome },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

interface PendingWait {
  settled(): Promise<{ exitCode: number; payload: Record<string, unknown> }>;
}

/** Start `workflow wait` as its own process without awaiting it. */
function startWait(fixture: Fixture, runId: string, timeoutSeconds: number): PendingWait {
  const child = Bun.spawn(
    [
      process.execPath,
      CLI_PATH,
      'workflow',
      'wait',
      runId,
      '--json',
      '--timeout',
      String(timeoutSeconds),
    ],
    {
      cwd: fixture.projectRoot,
      env: { ...process.env, ARCHON_HOME: fixture.archonHome },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  return {
    async settled(): Promise<{ exitCode: number; payload: Record<string, unknown> }> {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      // `--json` silences logging, so stdout is exactly one (pretty-printed) document.
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(stdout.trim()) as Record<string, unknown>;
      } catch {
        throw new Error(`wait emitted no JSON (exit ${String(exitCode)}): ${stdout}${stderr}`);
      }
      return { exitCode, payload };
    },
  };
}

/** Launch a detached run and return the id its ack carried (#2872). */
async function launchDetached(
  fixture: Fixture,
  workflow: string
): Promise<{ runId: string; conversationId: string }> {
  const conversationId = `wait-${workflow}-${crypto.randomUUID()}`;
  const { exitCode, stdout, stderr } = await runCli(fixture, [
    'workflow',
    'run',
    workflow,
    'run-attention wait integration',
    '--folder',
    '--detach',
    '--json',
    '--conversation-id',
    conversationId,
  ]);
  if (exitCode !== 0) throw new Error(`Detached launcher failed: ${stderr || stdout}`);
  const ack = JSON.parse(stdout.trim()) as { runId?: unknown };
  if (typeof ack.runId !== 'string') throw new Error(`ack carried no run id: ${stdout}`);
  activeRunIds.add(ack.runId);
  return { runId: ack.runId, conversationId };
}

const SLOW_SUCCESS =
  'name: wait-success\ndescription: Detached success fixture.\n' +
  'nodes:\n  - id: finish\n    bash: "sleep 1; echo done"\n';
const SLOW_FAILURE =
  'name: wait-failure\ndescription: Detached failure fixture.\n' +
  'nodes:\n  - id: fail\n    bash: "sleep 1; echo failed >&2; exit 42"\n';
// `interactive: true` is refused for background dispatch by design (#2738), so this
// one runs in the foreground OF ANOTHER PROCESS — which is the property that matters:
// the waiter is not in the process that owns the run. The warm-up node is what lets
// the waiter attach BEFORE the gate exists, so the gate is a wake and not a read.
const GATED =
  'name: wait-gated\ndescription: Out-of-process gate fixture.\ninteractive: true\n' +
  'nodes:\n  - id: warmup\n    bash: "sleep 3; echo ready"\n' +
  '  - id: review\n    depends_on: [warmup]\n    approval:\n      message: Approve the plan?\n';

/** The newest run of `workflowName`, read straight from the database file. */
function readRunId(archonHome: string, workflowName: string): string | undefined {
  const databasePath = join(archonHome, 'archon.db');
  if (!existsSync(databasePath)) return undefined;
  const database = new Database(databasePath, { readonly: true });
  try {
    return database
      .query<{ id: string }, [string]>(
        `SELECT id FROM remote_agent_workflow_runs
         WHERE workflow_name = ? ORDER BY started_at DESC LIMIT 1`
      )
      .get(workflowName)?.id;
  } finally {
    database.close();
  }
}

/**
 * Poll `read` until it produces a value.
 *
 * The catch is load bearing, not defensive: an owner process creates `archon.db`
 * BEFORE it applies the schema, so a reader that opens the file inside that window
 * gets `SQLiteError: no such table` out of `prepare()` — a throw, not an empty
 * result. Windows widens the same window to `disk I/O error` while a commit settles
 * (#2306). `workflow-terminal-event.integration.spec.ts` catches for exactly this
 * reason; a bare loop here would surface a startup race as a test failure.
 */
async function waitFor<T>(read: () => T | undefined, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = read();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(50);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for the run row${detail}`);
}

describe('archon workflow wait against a detached run', () => {
  test.each([
    { workflow: 'wait-success', status: 'completed' },
    { workflow: 'wait-failure', status: 'failed' },
  ])(
    'wakes on $status without polling run status',
    async ({ workflow, status }) => {
      const fixture = makeFixture('archon-wait-terminal-', {
        'wait-success': SLOW_SUCCESS,
        'wait-failure': SLOW_FAILURE,
      });
      const { runId } = await launchDetached(fixture, workflow);

      // Started while the run is still live: the wake, not a durable read, is what
      // ends this wait. The waiter runs exactly one command — no `workflow get` loop.
      const waiter = startWait(fixture, runId, 60);
      const { exitCode, payload } = await waiter.settled();
      activeRunIds.delete(runId);

      // Exit 0 for `failed` too: the exit code describes the WAIT, not the run.
      expect(exitCode).toBe(0);
      expect(payload).toMatchObject({
        ok: true,
        action: 'wait',
        runId,
        result: 'attention',
        attention: { kind: 'terminal', runId, status },
      });

      // The detail comes from an ordinary inspection afterwards — polling is now a
      // diagnostic, not the orchestration contract.
      const detail = await runCli(fixture, ['workflow', 'get', runId, '--json']);
      expect(JSON.parse(detail.stdout.trim())).toMatchObject({
        id: runId,
        status,
      });
    },
    90_000
  );

  test('wakes with awaiting_response on a gate, then with cancelled when it is rejected', async () => {
    const fixture = makeFixture('archon-wait-gate-', { 'wait-gated': GATED });
    // Owned by another process; it exits on its own once the run parks on the gate.
    const owner = Bun.spawn(
      [
        process.execPath,
        CLI_PATH,
        'workflow',
        'run',
        'wait-gated',
        'run-attention wait integration',
        '--folder',
      ],
      {
        cwd: fixture.projectRoot,
        env: { ...process.env, ARCHON_HOME: fixture.archonHome },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );

    // Discovering the id is test setup, not the contract under test — the launcher
    // above has no `--detach --json` ack to carry one.
    const runId = await waitFor(() => readRunId(fixture.archonHome, 'wait-gated'));
    activeRunIds.add(runId);

    // Attached while the warm-up node is still running, so the gate is a WAKE.
    const gateWaiter = startWait(fixture, runId, 60);
    const gate = await gateWaiter.settled();

    expect(gate.exitCode).toBe(0);
    expect(gate.payload).toMatchObject({
      result: 'attention',
      attention: {
        kind: 'awaiting_response',
        runId,
        respondTo: { runId, nodeId: 'review' },
        message: 'Approve the plan?',
      },
    });
    await owner.exited;

    // Resolving the gate is the ordinary next step, and it is what makes the wake
    // actionable. Rejecting to termination also exercises the transition that writes
    // `cancelled` from the gate path.
    const rejected = await runCli(fixture, ['workflow', 'reject', runId, 'not this time']);
    if (rejected.exitCode !== 0) {
      throw new Error(`reject failed: ${rejected.stderr || rejected.stdout}`);
    }
    activeRunIds.delete(runId);
    const detail = await runCli(fixture, ['workflow', 'get', runId, '--json']);
    expect(JSON.parse(detail.stdout.trim())).toMatchObject({ id: runId, status: 'cancelled' });
  }, 120_000);

  test('wakes on a cancelled run stopped from a third process', async () => {
    // `cancelled` is the transition that never arrives on its own — someone else
    // causes it, in another process, which is exactly the shape a waiting host
    // cannot observe without this command.
    const fixture = makeFixture('archon-wait-cancel-', {
      'wait-slow':
        'name: wait-slow\ndescription: Long detached fixture.\n' +
        'nodes:\n  - id: hold\n    bash: "sleep 60; echo done"\n',
    });
    const { runId } = await launchDetached(fixture, 'wait-slow');

    const waiter = startWait(fixture, runId, 90);
    // Let the waiter attach before the run is stopped, so what ends this wait is the
    // wake and not a durable read of an already-cancelled row.
    await Bun.sleep(1500);
    const cancelled = await runCli(fixture, ['workflow', 'cancel', runId]);
    if (cancelled.exitCode !== 0) {
      throw new Error(`cancel failed: ${cancelled.stderr || cancelled.stdout}`);
    }
    const { exitCode, payload } = await waiter.settled();
    activeRunIds.delete(runId);

    expect(exitCode).toBe(0);
    expect(payload).toMatchObject({
      result: 'attention',
      attention: { kind: 'terminal', runId, status: 'cancelled' },
    });
  }, 120_000);

  test('exits 3 with the observed status when the timeout passes first', async () => {
    // A wait that runs out of time must never look like a run that finished.
    const fixture = makeFixture('archon-wait-deadline-', { 'wait-success': SLOW_SUCCESS });
    const { runId } = await launchDetached(fixture, 'wait-success');

    const { exitCode, payload } = await startWait(fixture, runId, 1).settled();

    if (exitCode === 3) {
      expect(payload).toMatchObject({ ok: true, result: 'deadline', runId });
      expect(payload).not.toHaveProperty('attention');
    } else {
      // The 1s run beat the 1s deadline; the only other honest outcome.
      expect(exitCode).toBe(0);
      expect(payload).toMatchObject({ result: 'attention' });
    }
  }, 90_000);

  test('exits 1 for a run id that names nothing', async () => {
    const fixture = makeFixture(
      'archon-wait-missing-',
      { 'wait-success': SLOW_SUCCESS },
      { gitInit: true }
    );
    const missing = '00000000-1111-2222-3333-444444444444';

    const { exitCode, payload } = await startWait(fixture, missing, 30).settled();

    expect(exitCode).toBe(1);
    expect(payload).toMatchObject({ ok: false, action: 'wait', error: 'not_found' });
  }, 60_000);
});
