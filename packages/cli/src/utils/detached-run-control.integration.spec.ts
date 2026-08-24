import { afterEach, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detachedRunControlPath,
  requestDetachedRunStop,
  startDetachedRunControlServer,
} from './detached-run-control';

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

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

describe('detached run control integration', () => {
  it('stops the detached owner process group before its descendant can leak work', async () => {
    const runId = `tree-${crypto.randomUUID()}`;
    const fixtureDir = mkdtempSync(join(tmpdir(), 'archon-detached-control-'));
    cleanupPaths.push(fixtureDir);
    const readyPath = join(fixtureDir, 'ready');
    const leakPath = join(fixtureDir, 'leaked');
    const fixturePath = join(import.meta.dir, 'fixtures', 'detached-run-owner.ts');
    const owner = spawn(process.execPath, [fixturePath, runId, readyPath, leakPath], {
      detached: true,
      stdio: 'ignore',
    });
    if (owner.pid === undefined) throw new Error('Failed to spawn detached owner fixture');
    const exited = waitForExit(owner);

    try {
      await waitFor(() => existsSync(readyPath));
      const target = await requestDetachedRunStop(runId);
      await target.stop();
      await exited;
      await new Promise<void>(resolve => setTimeout(resolve, 1_300));
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
    const fixtureDir = mkdtempSync(join(tmpdir(), 'archon-foreground-control-'));
    cleanupPaths.push(fixtureDir);
    const readyPath = join(fixtureDir, 'ready');
    const leakPath = join(fixtureDir, 'leaked');
    const fixturePath = join(import.meta.dir, 'fixtures', 'detached-run-owner.ts');
    const owner = spawn(process.execPath, [fixturePath, runId, readyPath, leakPath], {
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
    const owner = await startDetachedRunControlServer(runId);
    const client = createConnection(detachedRunControlPath(runId));
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    client.write('stop\n');
    await waitFor(() => owner.isStopRequested());

    const startedAt = Date.now();
    await owner.close();
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    client.destroy();
  });
});
