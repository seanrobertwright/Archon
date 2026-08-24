import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import {
  assertDetachedRunProcessOwner,
  startDetachedRunControlServer,
} from '../detached-run-control';

const [runId, readyPath, leakPath] = process.argv.slice(2);
if (!runId || !readyPath || !leakPath) {
  throw new Error('Usage: detached-run-owner.ts <run-id> <ready-path> <leak-path>');
}

assertDetachedRunProcessOwner();

const leakWriter = spawn(
  process.execPath,
  [
    '-e',
    `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(leakPath)}, 'leaked'), 1200)`,
  ],
  { stdio: 'ignore' }
);
leakWriter.on('error', error => {
  throw error;
});

await startDetachedRunControlServer(runId);
writeFileSync(readyPath, String(process.pid));
setInterval(() => undefined, 1_000);
