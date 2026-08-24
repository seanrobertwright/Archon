import { afterEach, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detachedRunControlPath,
  DetachedRunOwnerUnavailableError,
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

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Detached owner did not exit')), 8_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe('detached run control', () => {
  it('treats a connection as a harmless probe and refuses to replace a live owner', async () => {
    const runId = `probe-${crypto.randomUUID()}`;
    const owner = await startDetachedRunControlServer(runId);

    const probe = createConnection(detachedRunControlPath(runId));
    await new Promise<void>((resolve, reject) => {
      probe.once('connect', resolve);
      probe.once('error', reject);
    });
    probe.destroy();

    expect(owner.isStopRequested()).toBe(false);
    await expect(startDetachedRunControlServer(runId)).rejects.toThrow(/already owned/);
    const target = await requestDetachedRunStop(runId);
    expect(owner.isStopRequested()).toBe(true);

    let closed = false;
    const closing = owner.close().then(() => {
      closed = true;
    });
    await new Promise<void>(resolve => setTimeout(resolve, 25));
    expect(closed).toBe(false);

    target.release();
    await closing;
    expect(owner.isStopRequested()).toBe(false);
  });

  it('fails explicitly when no live owner is reachable', async () => {
    const runId = `missing-${crypto.randomUUID()}`;
    await expect(requestDetachedRunStop(runId)).rejects.toBeInstanceOf(
      DetachedRunOwnerUnavailableError
    );
  });

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
});
