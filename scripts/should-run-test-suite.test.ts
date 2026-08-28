import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { shouldRunTestSuite } from './should-run-test-suite';

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

  test('the workflow delegates both automatic routes to the complete-diff decision', () => {
    const workflow = readFileSync(
      resolve(import.meta.dir, '../.github/workflows/test.yml'),
      'utf8'
    );

    expect(workflow).not.toContain('\n    paths:');
    expect(workflow).toContain('EVENT_NAME: ${{ github.event_name }}');
    expect(workflow).toContain(
      'BASE_SHA: ${{ github.event.before || github.event.pull_request.base.sha }}'
    );
    expect(workflow).toContain(
      'HEAD_SHA: ${{ github.event.after || github.event.pull_request.head.sha }}'
    );
    expect(workflow).toContain('git fetch --no-tags --depth=1 origin "$BASE_SHA" "$HEAD_SHA"');
    expect(workflow).toContain('bun scripts/should-run-test-suite.ts');
  });
});
