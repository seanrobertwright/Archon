/**
 * Golden corpus: every workflow Archon SHIPS must survive a builder round-trip
 * without losing a field.
 *
 * The synthetic tests in `passthrough.test.ts` prove the mechanism; this one
 * proves it against the real corpus, which is what actually regressed. Three of
 * the bundled defaults (`archon-idea-to-pr`, `archon-issue-review-full`,
 * `archon-plan-to-pr`) carry a live `include:` node, and before the passthrough
 * variant each of them degraded to `{prompt:'', id}` the moment a user opened it
 * in the builder.
 *
 * Parsed with `Bun.YAML` (built in — no new dependency) and read from the repo's
 * own `.archon/workflows/defaults/`, so a default added later is covered
 * automatically rather than needing a fixture copied in beside it.
 *
 * ASSERTION SHAPE — superset, not equality. The builder legitimately ADDS engine
 * defaults on modelled variants (a loop gains `fresh_context`, `max_iterations`),
 * so byte-equality would fail for reasons that are not data loss. What must never
 * happen is a key DISAPPEARING, so every source key is asserted present and equal
 * after the round-trip.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromWorkflowDefinition } from './from-workflow';
import { toWorkflowDefinition } from './to-workflow';
import type { WireWorkflowDefinition } from '../types';

/** model/ → builder → console → experiments → src → web → packages → repo root. */
const DEFAULTS_DIR = join(import.meta.dir, '../../../../../../..', '.archon/workflows/defaults');

interface CorpusEntry {
  file: string;
  def: WireWorkflowDefinition;
}

/**
 * Load every bundled default that uses the DAG `nodes:` format.
 *
 * Throws rather than returning `[]` on a missing/empty directory: a corpus test
 * that silently covers nothing is worse than no test, because it reports green.
 */
function loadCorpus(): CorpusEntry[] {
  let files: string[];
  try {
    files = readdirSync(DEFAULTS_DIR).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  } catch (err) {
    throw new Error(
      `corpus: cannot read ${DEFAULTS_DIR} (${err instanceof Error ? err.message : String(err)}). ` +
        'This test must run from a full repo checkout.'
    );
  }
  if (files.length === 0) throw new Error(`corpus: no workflow YAML found in ${DEFAULTS_DIR}`);

  const entries: CorpusEntry[] = [];
  for (const file of files) {
    const parsed = Bun.YAML.parse(readFileSync(join(DEFAULTS_DIR, file), 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) continue;
    const def = parsed as Partial<WireWorkflowDefinition>;
    if (!Array.isArray(def.nodes)) continue; // non-DAG or malformed — not this test's subject
    entries.push({ file, def: def as WireWorkflowDefinition });
  }
  return entries;
}

const CORPUS = loadCorpus();

describe('bundled default workflows round-trip without loss', () => {
  it('found a non-trivial corpus to check', () => {
    // Guards against the directory silently emptying out or the path drifting.
    expect(CORPUS.length).toBeGreaterThan(5);
  });

  for (const { file, def } of CORPUS) {
    it(`preserves every node field in ${file}`, () => {
      const { workflow } = fromWorkflowDefinition(def);
      const out = toWorkflowDefinition(workflow);

      expect(out.nodes).toHaveLength(def.nodes.length);

      def.nodes.forEach((sourceNode, i) => {
        const rounded = out.nodes[i] as Record<string, unknown> | undefined;
        const source = sourceNode as unknown as Record<string, unknown>;
        expect(rounded).toBeDefined();
        for (const [key, value] of Object.entries(source)) {
          // `depends_on: []` is dropped by both the engine transform and the
          // exporter's sparsify step, so its absence is correct, not loss.
          if (key === 'depends_on' && Array.isArray(value) && value.length === 0) continue;
          expect({ node: source.id, key, value: rounded?.[key] }).toEqual({
            node: source.id,
            key,
            value,
          });
        }
      });
    });

    it(`classifies every node in ${file} (no malformed fallback)`, () => {
      // The `structural.variant.unknown` error path means the builder could not
      // identify the node at all. No SHIPPED workflow should ever hit it — if one
      // does, either the engine gained a node kind that is not yet listed in
      // `UNSUPPORTED_MODE_FIELDS`, or the YAML is genuinely broken.
      const { issues } = fromWorkflowDefinition(def);
      const unknown = issues.filter(i => i.rule === 'structural.variant.unknown');
      expect(unknown.map(i => i.message)).toEqual([]);
    });
  }
});
