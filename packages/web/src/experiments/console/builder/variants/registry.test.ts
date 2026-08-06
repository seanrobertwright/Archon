/**
 * Drift guard for the two hand-maintained mirrors of this registry that live
 * outside `@archon/web` and therefore cannot import it.
 *
 * `@archon/core`'s `propose-workflow-edits-tool.ts` (the Builder Copilot's
 * native tool) re-lists both the variant ids and the node-id pattern as
 * literals. If they drift, the Copilot silently rejects a legitimate variant
 * with "unknown variant 'x'", which reads to the author as a Copilot bug rather
 * than a missing registration.
 *
 * This test is the tripwire: it lives on the side where a variant actually gets
 * ADDED, so the build breaks here with a message naming the file to mirror.
 */
import { describe, expect, test } from 'bun:test';
import { VARIANTS, isVariantId } from './registry';
import { NODE_ID_PATTERN } from '../editor/state';

/** Keep in sync with `KNOWN_VARIANTS` in
 *  `packages/core/src/orchestrator/propose-workflow-edits-tool.ts`. */
const CORE_MIRRORED_VARIANTS: readonly string[] = [
  'prompt',
  'command',
  'bash',
  'script',
  'loop',
  'approval',
  'cancel',
];

/** Keep in sync with `NODE_ID_PATTERN` in the same core file. */
const CORE_MIRRORED_ID_PATTERN = '^[a-zA-Z_][a-zA-Z0-9_-]*$';

describe('variant registry ↔ @archon/core mirror', () => {
  test('VARIANTS matches KNOWN_VARIANTS in propose-workflow-edits-tool.ts', () => {
    expect([...(VARIANTS as readonly string[])].sort()).toEqual([...CORE_MIRRORED_VARIANTS].sort());
  });

  test('every registry variant is accepted by isVariantId', () => {
    for (const v of VARIANTS) expect(isVariantId(v)).toBe(true);
  });

  test('NODE_ID_PATTERN matches the pattern mirrored in propose-workflow-edits-tool.ts', () => {
    expect(NODE_ID_PATTERN.source).toBe(CORE_MIRRORED_ID_PATTERN);
  });
});
