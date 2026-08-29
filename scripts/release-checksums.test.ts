import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

const trackTempRoot = trackTempRoots();
const releaseArtifacts = [
  'archon-darwin-arm64',
  'archon-darwin-x64',
  'archon-linux-arm64',
  'archon-linux-x64',
  'archon-windows-x64.exe',
  'archon-web.tar.gz',
];

test('release checksums include each release artifact once', () => {
  const workflow = readFileSync(
    resolve(import.meta.dir, '../.github/workflows/release.yml'),
    'utf8'
  );
  const checksumCommand = workflow.match(/^\s*(sha256sum .+ > checksums\.txt)$/m)?.[1];

  expect(checksumCommand).toBe('sha256sum archon-* > checksums.txt');
  if (checksumCommand === undefined) throw new Error('release workflow has no checksum command');

  const dist = trackTempRoot(mkdtempSync(join(tmpdir(), 'release-checksums-')));
  for (const artifact of releaseArtifacts) writeFileSync(join(dist, artifact), artifact);

  const result = Bun.spawnSync(['sh', '-c', checksumCommand], {
    cwd: dist,
    stderr: 'pipe',
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe('');

  const manifestFiles = readFileSync(join(dist, 'checksums.txt'), 'utf8')
    .trim()
    .split('\n')
    .map(line => line.match(/^[a-f0-9]{64}  (.+)$/)?.[1]);
  expect(manifestFiles.sort()).toEqual(releaseArtifacts.sort());
  expect(manifestFiles.filter(artifact => artifact === 'archon-web.tar.gz')).toHaveLength(1);
});
