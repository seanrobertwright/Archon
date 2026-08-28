import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { shouldRunTestSuite } from './should-run-test-suite';

const EMPTY_GIT_SHA = '0000000000000000000000000000000000000000';

describe('test-suite change decision', () => {
  test.each(['push', 'pull_request'])('%s skips Markdown-only changes', () => {
    expect(shouldRunTestSuite(['README.md', 'packages/core/notes.md'])).toBe(false);
  });

  test.each(['push', 'pull_request'])('%s skips docs-source-only changes', () => {
    expect(
      shouldRunTestSuite([
        'packages/docs-web/src/content/docs/guide.mdx',
        'packages/docs-web/public/logo.svg',
      ])
    ).toBe(false);
  });

  test.each(['push', 'pull_request'])('%s runs when the docs manifest changes', () => {
    expect(shouldRunTestSuite(['packages/docs-web/package.json'])).toBe(true);
  });

  test('runs for a non-documentation change after thousands of documentation files', () => {
    const changedFiles = [
      ...Array.from({ length: 3_001 }, (_, index) => `docs/${index}.md`),
      'packages/docs-web/package.json',
    ];

    expect(shouldRunTestSuite(changedFiles)).toBe(true);
  });

  test('runs for a push that creates a branch', () => {
    const script = resolve(import.meta.dir, 'should-run-test-suite.ts');
    const result = Bun.spawnSync(['bun', script, 'push', EMPTY_GIT_SHA, 'unavailable-head'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe('true');
  });

  test('the workflow delegates both automatic routes to the complete-diff decision', () => {
    // A Windows checkout writes the workflow with CRLF endings, and every assertion below
    // anchors on LF. Normalize at the read site: what is asserted is YAML structure, not
    // the line terminator the working tree happens to carry.
    const workflow = readFileSync(
      resolve(import.meta.dir, '../.github/workflows/test.yml'),
      'utf8'
    ).replaceAll('\r\n', '\n');
    const changesJob = workflow.slice(workflow.indexOf('  changes:'), workflow.indexOf('  test:'));

    expect(workflow).toContain('  push:\n');
    expect(workflow).toContain('  pull_request:\n');
    expect(workflow).not.toContain('\n    paths:');
    expect(changesJob).toContain('EVENT_NAME: ${{ github.event_name }}');
    expect(changesJob).toContain(
      'BASE_SHA: ${{ github.event.before || github.event.pull_request.base.sha }}'
    );
    expect(changesJob).toContain(
      'HEAD_SHA: ${{ github.event.after || github.event.pull_request.head.sha }}'
    );
    expect(changesJob).toContain('fetch-depth: 0');
    expect(changesJob).toContain('uses: oven-sh/setup-bun@v2');
    expect(changesJob).toContain('bun scripts/should-run-test-suite.ts');
  });
});
