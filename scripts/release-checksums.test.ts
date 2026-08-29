import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('release checksums include each release artifact once', () => {
  const workflow = readFileSync(
    resolve(import.meta.dir, '../.github/workflows/release.yml'),
    'utf8'
  );
  const checksumCommand = workflow.match(/^\s*(sha256sum .+ > checksums\.txt)$/m)?.[1];
  const releaseArtifacts = [
    'archon-darwin-arm64',
    'archon-darwin-x64',
    'archon-linux-arm64',
    'archon-linux-x64',
    'archon-windows-x64.exe',
    'archon-web.tar.gz',
  ];

  expect(checksumCommand).toBe('sha256sum archon-* > checksums.txt');
  expect(releaseArtifacts.filter(artifact => artifact.startsWith('archon-'))).toEqual(
    releaseArtifacts
  );
  expect(releaseArtifacts.filter(artifact => artifact === 'archon-web.tar.gz')).toHaveLength(1);
});
