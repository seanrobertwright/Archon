import { describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import {
  detachedRunControlPath,
  DetachedRunOwnerUnavailableError,
  requestDetachedRunStop,
  startDetachedRunControlServer,
} from './detached-run-control';

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

  it('fails when the owner closes before committing termination', async () => {
    const runId = `close-before-ready-${crypto.randomUUID()}`;
    const path = detachedRunControlPath(runId);
    const server = createServer(socket => {
      socket.setEncoding('utf8');
      let request = '';
      socket.on('data', chunk => {
        request += chunk;
        if (request.includes('stop\n')) {
          socket.write(`${JSON.stringify({ pid: 12345 })}\n`);
          request = request.replace('stop\n', '');
        }
        if (request.includes('terminate\n')) socket.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });

    try {
      const target = await requestDetachedRunStop(runId);
      await expect(target.stop()).rejects.toThrow(/closed before committing termination/);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (process.platform !== 'win32') rmSync(path, { force: true });
    }
  });
});
