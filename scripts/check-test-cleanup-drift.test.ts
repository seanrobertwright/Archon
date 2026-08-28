import { expect, test } from 'bun:test';
import { checkChangedSource, checkSource } from './check-test-cleanup-drift';

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

test('rejects historical bare recursive teardown', () => {
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
