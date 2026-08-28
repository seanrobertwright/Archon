import { expect, test } from 'bun:test';
import { checkChangedSource, checkSource, gitOutput } from './check-test-cleanup-drift';

test('rejects Bun-inert rm retry options', () => {
  const violations = checkSource(
    'packages/example/src/example.ts',
    "import { rm } from 'node:fs/promises';\nawait rm(path, { recursive: true, maxRetries: 10, retryDelay: 50 });"
  );

  expect(violations).toEqual([
    expect.objectContaining({
      message: 'rm options must not use maxRetries or retryDelay; Bun ignores them',
    }),
  ]);
});

test('identifies bare recursive teardown before baseline filtering', () => {
  const violations = checkSource(
    'scripts/migrate-state-dir.test.ts',
    "import { rm } from 'node:fs/promises';\ntry { await run(); } finally { await rm(root, { recursive: true, force: true }); }"
  );

  expect(violations).toEqual([
    expect.objectContaining({
      message: 'recursive rm test teardown must use removeTempTree or trackTempRoots',
    }),
  ]);
});

test('does not make the existing cleanup inventory fail lint', () => {
  const historicalSource =
    "import { rm } from 'node:fs/promises';\ntry { await run(); } finally { await rm(root, { recursive: true, force: true }); }";

  expect(checkChangedSource('scripts/legacy.test.ts', historicalSource, historicalSource)).toEqual(
    []
  );
});

test('rejects a relocated violation when its call changes', () => {
  const baseSource =
    "import { rm } from 'node:fs/promises';\nawait rm(oldRoot, { maxRetries: 1 });";
  const source = "import { rm } from 'node:fs/promises';\nawait rm(newRoot, { maxRetries: 1 });";

  expect(checkChangedSource('scripts/example.ts', source, baseSource)).toHaveLength(1);
});

test('recognizes quoted cleanup option keys', () => {
  const source = `
    import { afterEach } from 'bun:test';
    import { rm } from 'node:fs/promises';
    afterEach(() => rm(root, { 'recursive': true }));
    rm(root, { 'maxRetries': 1, 'retryDelay': 1 });
  `;

  expect(checkSource('scripts/example.test.ts', source)).toHaveLength(2);
});

test('recognizes static fs promises bindings', () => {
  const source = `
    import { promises as fs } from 'node:fs';
    import * as nodeFs from 'fs';
    fs.rm(root, { maxRetries: 1 });
    nodeFs.promises.rm(root, { retryDelay: 1 });
  `;

  expect(checkSource('scripts/example.ts', source)).toHaveLength(2);
});

test('recognizes imported Bun teardown hooks', () => {
  const source = `
    import { afterEach as cleanup } from 'bun:test';
    import * as Bun from 'bun:test';
    import { rm } from 'node:fs/promises';
    cleanup(() => rm(firstRoot, { recursive: true }));
    Bun.afterAll(() => rm(secondRoot, { recursive: true }));
  `;

  expect(checkSource('scripts/example.test.ts', source)).toHaveLength(2);
});

test('propagates Git scan failures', () => {
  expect(() => gitOutput(['definitely-not-a-git-command'])).toThrow(
    'Git command failed: git definitely-not-a-git-command'
  );
});

test('allows single-file cleanup and shared recursive cleanup', () => {
  const source = `
    import { afterEach } from 'bun:test';
    import { rm, unlink } from 'node:fs/promises';
    afterEach(async () => {
      await unlink(socketPath);
      await removeTempTree(root);
    });
  `;

  expect(checkSource('packages/example/src/example.test.ts', source)).toEqual([]);
});
