import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, mkdirSync, openSync, rmSync, statSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

export const DETACHED_RUN_OWNER_ENV = 'ARCHON_DETACHED_RUN_OWNER';

const STOP_REQUEST = 'stop\n';
const IPC_TIMEOUT_MS = 2_000;
const TERMINATION_GRACE_MS = 5_000;
const TERMINATION_CONFIRM_MS = 1_000;
const POLL_INTERVAL_MS = 50;
const MAX_MESSAGE_BYTES = 256;

const execFileAsync = promisify(execFile);

export interface DetachedRunControlServer {
  close(): Promise<void>;
  isStopRequested(): boolean;
}

export interface DetachedRunStopTarget {
  stop(): Promise<void>;
  release(): void;
}

export class DetachedRunOwnerUnavailableError extends Error {
  constructor(runId: string, detail?: string) {
    super(
      `No live detached CLI owner is reachable for run ${runId}. The run was not changed.` +
        `${detail ? ` (${detail})` : ''} ` +
        `If you have verified that its process is gone, use 'archon workflow abandon ${runId}' to release its persisted state.`
    );
    this.name = 'DetachedRunOwnerUnavailableError';
  }
}

function endpointToken(runId: string): string {
  return createHash('sha256').update(runId).digest('hex').slice(0, 32);
}

function controlDirectory(): string {
  const uid = process.getuid?.();
  const directory =
    process.platform === 'win32'
      ? join(tmpdir(), 'archon-run-control')
      : `/tmp/archon-${uid === undefined ? 'user' : String(uid)}`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

/** A bounded, user-scoped endpoint: Unix socket on POSIX, named pipe on Windows. */
export function detachedRunControlPath(runId: string): string {
  const token = endpointToken(runId);
  if (process.platform === 'win32') return `\\\\.\\pipe\\archon-workflow-${token}`;
  return join(controlDirectory(), `${token}.sock`);
}

function detachedRunControlLockPath(runId: string): string {
  return join(controlDirectory(), `${endpointToken(runId)}.lock`);
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(path);
  });
}

function canConnect(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection(path);
    const settle = (connected: boolean): void => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(IPC_TIMEOUT_MS, () => {
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

async function listenWithoutReplacingOwner(server: Server, path: string): Promise<void> {
  try {
    await listen(server, path);
    return;
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EADDRINUSE' || process.platform === 'win32') {
      throw error;
    }
  }

  if (await canConnect(path)) {
    throw new Error(`Detached run control endpoint is already owned: ${path}`);
  }

  // A crashed Unix owner can leave the socket pathname behind. Connection refusal,
  // not age, is the proof that no process owns it; remove only that stale pathname.
  rmSync(path, { force: true });
  await listen(server, path);
}

async function acquireOwnerLock(runId: string, endpointPath: string): Promise<number> {
  const lockPath = detachedRunControlLockPath(runId);
  try {
    return openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
  }

  if (await canConnect(endpointPath)) {
    throw new Error(`Detached run control endpoint is already owned: ${endpointPath}`);
  }
  // A lock is written immediately before listen. Give that narrow startup window
  // one chance to become reachable before treating both files as crash residue.
  await new Promise<void>(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  if (await canConnect(endpointPath)) {
    throw new Error(`Detached run control endpoint is already owned: ${endpointPath}`);
  }

  rmSync(lockPath, { force: true });
  if (process.platform !== 'win32') rmSync(endpointPath, { force: true });
  return openSync(lockPath, 'wx', 0o600);
}

function releaseOwnerLock(lockPath: string, lockFd: number): void {
  const owned = fstatSync(lockFd);
  closeSync(lockFd);
  try {
    const current = statSync(lockPath);
    if (current.dev === owned.dev && current.ino === owned.ino) rmSync(lockPath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
  }
}

/**
 * Start the exact-run control endpoint inside the detached CLI owner.
 * A connection alone is only a liveness probe; the explicit `stop` frame is the mutation request.
 */
export async function startDetachedRunControlServer(
  runId: string
): Promise<DetachedRunControlServer> {
  const path = detachedRunControlPath(runId);
  const lockPath = detachedRunControlLockPath(runId);
  const lockFd = await acquireOwnerLock(runId, path);
  const sockets = new Set<Socket>();
  const stopSockets = new Set<Socket>();
  const stopReleaseWaiters = new Set<() => void>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.setTimeout(IPC_TIMEOUT_MS, () => socket.destroy());

    let request = '';
    let handled = false;
    socket.on('data', chunk => {
      if (handled) return;
      request += chunk;
      if (Buffer.byteLength(request) > MAX_MESSAGE_BYTES) {
        handled = true;
        socket.destroy();
        return;
      }
      if (!request.includes('\n')) return;
      handled = true;
      if (request !== STOP_REQUEST) {
        socket.destroy();
        return;
      }

      stopSockets.add(socket);
      socket.setTimeout(0);
      socket.write(`${JSON.stringify({ pid: process.pid })}\n`);
      // Keep this connection open through process-tree termination. It is the
      // controller's live proof that the returned PID still belongs to this owner.
    });
    socket.once('close', () => {
      sockets.delete(socket);
      if (stopSockets.delete(socket) && stopSockets.size === 0) {
        for (const resolve of stopReleaseWaiters) resolve();
        stopReleaseWaiters.clear();
      }
    });
  });

  try {
    await listenWithoutReplacingOwner(server, path);
  } catch (error) {
    releaseOwnerLock(lockPath, lockFd);
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  return {
    close: async (): Promise<void> => {
      if (closePromise) return closePromise;
      closePromise = (async (): Promise<void> => {
        if (stopSockets.size > 0) {
          await new Promise<void>(resolve => {
            stopReleaseWaiters.add(resolve);
          });
        }
        for (const socket of sockets) socket.destroy();
        if (server.listening) {
          await new Promise<void>(resolve =>
            server.close(() => {
              resolve();
            })
          );
        }
        if (process.platform !== 'win32') rmSync(path, { force: true });
        releaseOwnerLock(lockPath, lockFd);
      })();
      return closePromise;
    },
    isStopRequested: (): boolean => stopSockets.size > 0,
  };
}

function parseOwnerResponse(runId: string, raw: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DetachedRunOwnerUnavailableError(runId, 'owner returned an invalid response');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('pid' in parsed) ||
    typeof parsed.pid !== 'number' ||
    !Number.isInteger(parsed.pid) ||
    parsed.pid <= 0
  ) {
    throw new DetachedRunOwnerUnavailableError(runId, 'owner returned an invalid PID');
  }
  return parsed.pid;
}

/** Ask the live exact-run owner for an opaque termination lease. */
export function requestDetachedRunStop(runId: string): Promise<DetachedRunStopTarget> {
  const path = detachedRunControlPath(runId);
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let response = '';
    let settled = false;
    const fail = (detail: string): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new DetachedRunOwnerUnavailableError(runId, detail));
    };

    socket.setEncoding('utf8');
    socket.setTimeout(IPC_TIMEOUT_MS, () => {
      fail('owner did not respond');
    });
    socket.once('error', error => {
      fail((error as NodeJS.ErrnoException).code ?? error.message);
    });
    socket.once('connect', () => {
      socket.write(STOP_REQUEST);
    });
    socket.on('data', chunk => {
      if (settled) return;
      response += chunk;
      if (Buffer.byteLength(response) > MAX_MESSAGE_BYTES) {
        fail('owner response exceeded its size limit');
        return;
      }
      const newline = response.indexOf('\n');
      if (newline === -1) return;
      try {
        const pid = parseOwnerResponse(runId, response.slice(0, newline));
        settled = true;
        socket.setTimeout(0);
        let released = false;
        const release = (): void => {
          if (released) return;
          released = true;
          socket.destroy();
        };
        resolve({
          stop: async (): Promise<void> => {
            try {
              await terminateDetachedProcessTree(pid, () => !released && !socket.destroyed);
            } finally {
              release();
            }
          },
          release,
        });
      } catch (error) {
        socket.destroy();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitUntilGone(exists: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (exists()) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return true;
}

/** Terminate the process tree while its exact-run owner holds the IPC lease open. */
async function terminateDetachedProcessTree(
  pid: number,
  ownsLiveLease: () => boolean
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    throw new Error(`Refusing to terminate invalid detached owner PID ${String(pid)}`);
  }
  if (!ownsLiveLease()) {
    throw new Error(`Detached workflow owner ${String(pid)} released its termination lease`);
  }

  if (process.platform === 'win32') {
    // A zero exit from taskkill /T is the platform's positive tree-termination
    // result. Never translate a timeout or partial failure into success merely
    // because the root disappeared; descendants are part of this contract.
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      timeout: TERMINATION_GRACE_MS,
      windowsHide: true,
    });
    if (!(await waitUntilGone(() => processExists(pid), TERMINATION_CONFIRM_MS))) {
      throw new Error(`Detached workflow process tree ${String(pid)} is still running`);
    }
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  if (await waitUntilGone(() => processGroupExists(pid), TERMINATION_GRACE_MS)) return;

  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  if (!(await waitUntilGone(() => processGroupExists(pid), TERMINATION_CONFIRM_MS))) {
    throw new Error(`Detached workflow process group ${String(pid)} is still running`);
  }
}
