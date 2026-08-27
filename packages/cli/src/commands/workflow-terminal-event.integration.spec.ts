import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { detachedRunControlPath, requestDetachedRunStop } from '../utils/detached-run-control';

const cleanupPaths: string[] = [];
const activeRunIds = new Set<string>();

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

async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 15_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(25);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for detached workflow${detail}`);
}

async function endpointIsReachable(runId: string): Promise<boolean> {
  return await new Promise(resolveReachability => {
    const socket = createConnection(detachedRunControlPath(runId));
    const settle = (reachable: boolean): void => {
      socket.destroy();
      resolveReachability(reachable);
    };
    socket.setTimeout(250, () => {
      settle(false);
    });
    socket.once('connect', () => {
      settle(true);
    });
    socket.once('error', () => {
      settle(false);
    });
  });
}

function readRun(
  databasePath: string,
  workflowName: string
): { id: string; status: string } | undefined {
  if (!existsSync(databasePath)) return undefined;
  const database = new Database(databasePath, { readonly: true });
  try {
    return (
      database
        .query<{ id: string; status: string }, [string]>(
          `SELECT id, status FROM remote_agent_workflow_runs
         WHERE workflow_name = ? ORDER BY started_at DESC LIMIT 1`
        )
        .get(workflowName) ?? undefined
    );
  } finally {
    database.close();
  }
}

function readTerminalEvents(
  databasePath: string,
  runId: string,
  eventType: string
): { data: string }[] {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database
      .query<{ data: string }, [string, string]>(
        `SELECT data FROM remote_agent_workflow_events
         WHERE workflow_run_id = ? AND event_type = ? ORDER BY event_order`
      )
      .all(runId, eventType);
  } finally {
    database.close();
  }
}

describe('detached workflow terminal database events', () => {
  test('persists one matching event before successful and failed owners exit', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'archon-terminal-event-'));
    cleanupPaths.push(fixtureRoot);
    const archonHome = join(fixtureRoot, 'home');
    const projectRoot = join(fixtureRoot, 'project');
    const workflowsDir = join(projectRoot, '.archon', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(
      join(workflowsDir, 'terminal-success.yaml'),
      'name: terminal-success\ndescription: Detached terminal success fixture.\nnodes:\n  - id: finish\n    bash: "echo done"\n'
    );
    writeFileSync(
      join(workflowsDir, 'terminal-failure.yaml'),
      'name: terminal-failure\ndescription: Detached terminal failure fixture.\nnodes:\n  - id: fail\n    bash: "echo failed >&2; exit 42"\n'
    );

    const cliPath = resolve(import.meta.dir, '..', 'cli.ts');
    const databasePath = join(archonHome, 'archon.db');
    const cases = [
      { workflow: 'terminal-success', status: 'completed', event: 'workflow_completed' },
      { workflow: 'terminal-failure', status: 'failed', event: 'workflow_failed' },
    ] as const;

    for (const fixture of cases) {
      const conversationId = `terminal-event-${fixture.workflow}-${crypto.randomUUID()}`;
      const launcher = Bun.spawn(
        [
          process.execPath,
          cliPath,
          'workflow',
          'run',
          fixture.workflow,
          'terminal event integration',
          '--folder',
          '--detach',
          '--json',
          '--conversation-id',
          conversationId,
        ],
        {
          cwd: projectRoot,
          env: { ...process.env, ARCHON_HOME: archonHome },
          stdout: 'pipe',
          stderr: 'pipe',
        }
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        launcher.exited,
        new Response(launcher.stdout).text(),
        new Response(launcher.stderr).text(),
      ]);
      if (exitCode !== 0) throw new Error(`Detached launcher failed: ${stderr || stdout}`);
      expect(JSON.parse(stdout.trim())).toMatchObject({ ok: true, detached: true });

      const created = await waitFor(() => readRun(databasePath, fixture.workflow));
      activeRunIds.add(created.id);
      await waitFor(async () => ((await endpointIsReachable(created.id)) ? undefined : true));
      expect(await endpointIsReachable(created.id)).toBe(false);
      activeRunIds.delete(created.id);

      const terminal = await waitFor(() => {
        const run = readRun(databasePath, fixture.workflow);
        return run?.status === fixture.status ? run : undefined;
      });
      expect(terminal.id).toBe(created.id);
      // The status row and the terminal-event row are two separate writes, so a terminal
      // status does not mean the event is visible to a second connection yet — on Windows
      // that contention surfaced as `SQLiteError: disk I/O error` from a single-shot read
      // (#2306). Waiting for the row is safe rather than lenient about the count: the
      // owner's endpoint is already unreachable above, so no further event can be written
      // after the first one appears.
      const events = await waitFor(() => {
        const rows = readTerminalEvents(databasePath, terminal.id, fixture.event);
        return rows.length > 0 ? rows : undefined;
      });
      expect(events).toHaveLength(1);
      const data = JSON.parse(events[0]?.data ?? '{}') as Record<string, unknown>;
      if (fixture.status === 'completed') expect(data.duration_ms).toBeNumber();
      else expect(data.error).toContain('fail');
    }
  }, 40_000);
});
