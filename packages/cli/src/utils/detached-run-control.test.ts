import { describe, expect, it } from 'bun:test';
import { createConnection } from 'node:net';
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
});
