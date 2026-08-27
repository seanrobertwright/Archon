import { describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  DETACHED_RUN_IPC_TIMEOUT_MS,
  detachedRunControlPath,
  requestDetachedRunStop,
  startDetachedRunControlServer,
} from './detached-run-control';

// These fixtures are torn down after tests that spawn, and then kill, a real detached
// child. A killed process can still hold a handle inside its temp tree at the instant of
// cleanup, and an unretried removal fails a test whose assertions already passed (#2306).
const trackTempRoot = trackTempRoots();

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for fixture');
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }
}

function waitForExit(
  child: ChildProcess
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Detached owner did not exit'));
    }, 8_000);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * Ask the endpoint itself whether it is still serving. Connection refusal is the
 * owner's own answer, so this reports shutdown progress without timing it.
 *
 * The bound is the same one production `canConnect` puts on its own probe: a
 * connect that neither succeeds nor errors would otherwise hang until the test
 * budget expired, which reads as an unrelated timeout instead of an unreachable
 * endpoint. It is a backstop, not a measurement — on both the reachable and the
 * refused path the socket settles immediately.
 */
function endpointIsReachable(path: string): Promise<boolean> {
  return new Promise<boolean>((resolve: (reachable: boolean) => void): void => {
    const probe = createConnection(path);
    const settle = (reachable: boolean): void => {
      probe.destroy();
      resolve(reachable);
    };
    probe.setTimeout(DETACHED_RUN_IPC_TIMEOUT_MS, (): void => {
      settle(false);
    });
    probe.once('connect', (): void => {
      settle(true);
    });
    probe.once('error', (): void => {
      settle(false);
    });
  });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve: () => void, reject: (reason?: unknown) => void): void => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve: () => void): void => {
    server.close((): void => {
      resolve();
    });
  });
}

async function rejectedError(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`Expected an Error rejection, received ${String(error)}`);
  }
  throw new Error('Expected the operation to reject');
}

describe('detached run control integration', () => {
  it('stops the detached owner process group before its descendant can leak work', async () => {
    const runId = `tree-${crypto.randomUUID()}`;
    const fixtureDir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-detached-control-')));
    const readyPath = join(fixtureDir, 'ready');
    const leakPath = join(fixtureDir, 'leaked');
    const goPath = join(fixtureDir, 'go');
    const fixturePath = join(import.meta.dir, 'fixtures', 'detached-run-owner.ts');
    const owner = spawn(process.execPath, [fixturePath, runId, readyPath, leakPath, goPath], {
      detached: true,
      stdio: 'ignore',
    });
    if (owner.pid === undefined) throw new Error('Failed to spawn detached owner fixture');
    const exited = waitForExit(owner);

    try {
      await waitFor(() => existsSync(readyPath));
      const pids = JSON.parse(readFileSync(readyPath, 'utf8')) as {
        owner: number;
        leakWriter: number;
      };
      // The descendant is live and armed before the stop: if the coming stop
      // failed to take the process group, it would remain able to act on the
      // go signal, so its death is a meaningful (not vacuous) transition.
      expect(pids.leakWriter).toBeGreaterThan(0);
      expect(processExists(pids.leakWriter)).toBe(true);
      const target = await requestDetachedRunStop(runId);
      await target.stop();
      await exited;
      // Event-driven proof instead of a fixed sleep: wait for the descendant's
      // observable death. A dead process cannot act on any future signal.
      await waitFor(() => !processExists(pids.leakWriter));
      writeFileSync(goPath, 'go');
      expect(existsSync(leakPath)).toBe(false);
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) {
        try {
          if (process.platform === 'win32') owner.kill();
          else process.kill(-owner.pid, 'SIGKILL');
        } catch {
          // The primary assertion reports failures; cleanup is best-effort for an already-gone fixture.
        }
      }
      if (process.platform !== 'win32') rmSync(detachedRunControlPath(runId), { force: true });
    }
  });

  it('refuses a marked POSIX owner that does not own its expected process group', async () => {
    if (process.platform === 'win32') return;

    const runId = `foreground-${crypto.randomUUID()}`;
    const fixtureDir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-foreground-control-')));
    const readyPath = join(fixtureDir, 'ready');
    const leakPath = join(fixtureDir, 'leaked');
    const goPath = join(fixtureDir, 'go');
    const fixturePath = join(import.meta.dir, 'fixtures', 'detached-run-owner.ts');
    const owner = spawn(process.execPath, [fixturePath, runId, readyPath, leakPath, goPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    if (owner.pid === undefined) throw new Error('Failed to spawn foreground owner fixture');
    let stderr = '';
    owner.stderr?.on('data', chunk => {
      stderr += String(chunk);
    });

    const result = await waitForExit(owner);
    expect(result.code).not.toBe(0);
    expect(stderr).toContain('does not own process group');
    expect(existsSync(readyPath)).toBe(false);
  });

  it('bounds owner shutdown when a controller retains an uncommitted stop lease', async () => {
    const runId = `retained-${crypto.randomUUID()}`;
    const endpointPath = detachedRunControlPath(runId);
    const owner = await startDetachedRunControlServer(runId);
    const client = createConnection(endpointPath);
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    // The client never sends 'terminate' and never hangs up, so the owner-side
    // idle timeout is the only thing that can release close(). Assert the order
    // that timeout produces rather than measuring how long it took: an elapsed
    // floor against a real timer carries a couple of milliseconds of headroom
    // and fails whenever the timer and the clock disagree by that much (#2859).
    client.write('stop\n');
    await waitFor(() => owner.isStopRequested());

    const closing = owner.close();
    // close() is parked on the retained lease and has gone no further: it stops
    // the server and unlinks the endpoint only afterwards, so a close() that
    // ignored the lease would already have made this probe unreachable.
    expect(await endpointIsReachable(endpointPath)).toBe(true);
    expect(owner.isStopRequested()).toBe(true);

    await closing;
    expect(owner.isStopRequested()).toBe(false);
    expect(await endpointIsReachable(endpointPath)).toBe(false);
    client.destroy();
  });

  it('fails when the owner closes before identifying itself', async () => {
    const runId = `close-before-pid-${crypto.randomUUID()}`;
    const path = detachedRunControlPath(runId);
    const server = createServer((socket: Socket): void => {
      socket.once('data', (): void => {
        socket.end();
      });
    });
    await listen(server, path);

    try {
      const error = await rejectedError(
        async (): Promise<unknown> => requestDetachedRunStop(runId)
      );
      expect(error.message).toMatch(/owner (?:ended|closed) before identifying itself/);
    } finally {
      await close(server);
      if (process.platform !== 'win32') rmSync(path, { force: true });
    }
  });

  it('fails when the owner closes before committing termination', async () => {
    const runId = `close-before-ready-${crypto.randomUUID()}`;
    const path = detachedRunControlPath(runId);
    const server = createServer((socket: Socket): void => {
      socket.setEncoding('utf8');
      let request = '';
      socket.on('data', (chunk: string): void => {
        request += chunk;
        if (request.includes('stop\n')) {
          socket.write(`${JSON.stringify({ pid: 12345 })}\n`);
          request = request.replace('stop\n', '');
        }
        if (request.includes('terminate\n')) socket.end();
      });
    });
    await listen(server, path);

    try {
      const target = await requestDetachedRunStop(runId);
      const error = await rejectedError(async (): Promise<void> => target.stop());
      expect(error.message).toMatch(/(?:ended|closed) before committing termination/);
    } finally {
      await close(server);
      if (process.platform !== 'win32') rmSync(path, { force: true });
    }
  });
});
