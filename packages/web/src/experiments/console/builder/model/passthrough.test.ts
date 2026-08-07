/**
 * Round-trip preservation for node kinds and fields the builder cannot model.
 *
 * These cases all previously LOST data. `loop_group` / `include` / `workflow`
 * nodes degraded to `{prompt:'', id}`, and unmodelled base fields
 * (`settingSources` #2216, `pi` #2144, node-level `description`) were warned
 * about and then erased on the next save — a warning does not block the save
 * gate, which filters severity `'error'`.
 *
 * The invariant under test is narrow and total: for any wire node the builder
 * does not fully model, `toWorkflowDefinition(fromWorkflowDefinition(x))` must
 * equal `x`.
 */
import { describe, expect, it } from 'bun:test';
import { fromWorkflowDefinition } from './from-workflow';
import { toWorkflowDefinition } from './to-workflow';
import type { WireWorkflowDefinition } from '../types';

/** Wrap nodes in a minimal definition. Cast because these shapes are wider than the 7 modelled variants. */
function defOf(nodes: unknown[]): WireWorkflowDefinition {
  return { name: 'probe', description: 'd', nodes } as unknown as WireWorkflowDefinition;
}

/** Import then export, returning the round-tripped nodes plus the import issues. */
function roundTrip(def: WireWorkflowDefinition): {
  nodes: WireWorkflowDefinition['nodes'];
  messages: string[];
} {
  const { workflow, issues } = fromWorkflowDefinition(def);
  return { nodes: toWorkflowDefinition(workflow).nodes, messages: issues.map(i => i.message) };
}

describe('unsupported node kinds round-trip verbatim', () => {
  it('preserves a workflow: sub-run node with its satellites', () => {
    const def = defOf([
      {
        id: 'child',
        workflow: 'some-child-workflow',
        input: 'do the thing',
        isolation: 'worktree',
        depends_on: ['setup'],
      },
    ]);
    expect(roundTrip(def).nodes).toEqual(def.nodes);
  });

  it('preserves a fan_out workflow node', () => {
    const def = defOf([
      {
        id: 'fan',
        workflow: 'per-item',
        fan_out: { items: '$list.output', max_parallel: 3, join: 'all_done' },
      },
    ]);
    expect(roundTrip(def).nodes).toEqual(def.nodes);
  });

  it('preserves a loop_group node including its sealed body', () => {
    const def = defOf([
      {
        id: 'lg',
        loop_group: {
          until: 'DONE',
          max_iterations: 3,
          nodes: [{ id: 'inner', prompt: 'hi' }],
        },
      },
    ]);
    expect(roundTrip(def).nodes).toEqual(def.nodes);
  });

  it('preserves an include node with its `with:` parameter map', () => {
    const def = defOf([{ id: 'inc', include: 'shared-block', with: { target: 'main' } }]);
    expect(roundTrip(def).nodes).toEqual(def.nodes);
  });

  it('reports unsupported kinds as warnings, not blocking errors', () => {
    // Severity matters: `blockingErrors()` filters `'error'`, so flagging these
    // as errors would strand every workflow containing one behind an
    // unfixable save gate. They round-trip perfectly, so a warning is correct.
    const { workflow, issues } = fromWorkflowDefinition(
      defOf([{ id: 'inc', include: 'shared-block' }])
    );
    expect(workflow.nodes[0]?.variant).toBe('unsupported');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('warning');
    expect(issues[0]?.message).toContain('include');
  });

  it('names the engine node kind on the imported node', () => {
    const { workflow } = fromWorkflowDefinition(defOf([{ id: 'lg', loop_group: { nodes: [] } }]));
    const node = workflow.nodes[0];
    if (node?.variant !== 'unsupported') throw new Error('expected an unsupported node');
    expect(node.data.kind).toBe('loop_group');
  });

  it('keeps depends_on visible to graph validation rather than burying it in `extra`', () => {
    // Base fields are partitioned normally even for an unsupported node, so the
    // canvas still draws its edges and cycle/dep checks still see it.
    const { workflow } = fromWorkflowDefinition(
      defOf([{ id: 'inc', include: 'block', depends_on: ['a', 'b'] }])
    );
    expect(workflow.nodes[0]?.base.depends_on).toEqual(['a', 'b']);
    expect(workflow.nodes[0]?.extra).toEqual({ include: 'block' });
  });
});

describe('the Copilot cannot silently no-op on an unsupported node', () => {
  it('rejects a data.* setField and names the reason', async () => {
    // Before the guard this was ACCEPTED: `data` gained a junk key, a "changed"
    // ghost rendered, the tool reported success — and the edit vanished on save
    // because `unsupportedToDag` emits nothing. Same silent-failure class this
    // whole change exists to close, so it is tested here rather than in isolation.
    const { opsToEditorActions } = await import('../copilot/translate-ops');
    const { workflow } = fromWorkflowDefinition(defOf([{ id: 'inc', include: 'blk' }]));
    const r = opsToEditorActions(
      [{ op: 'setField', id: 'inc', path: 'data.prompt', value: 'x' }] as never,
      workflow
    );
    expect(r.actions).toEqual([]);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]?.message).toContain('include');
    expect(r.issues[0]?.message).toContain('YAML');
  });

  it('still allows base.* edits so `connect` can rewire the graph', async () => {
    const { opsToEditorActions } = await import('../copilot/translate-ops');
    const { workflow } = fromWorkflowDefinition(defOf([{ id: 'inc', include: 'blk' }]));
    const r = opsToEditorActions(
      [{ op: 'setField', id: 'inc', path: 'base.depends_on', value: ['a'] }] as never,
      workflow
    );
    expect(r.issues).toEqual([]);
    expect(r.actions).toHaveLength(1);
  });
});

describe('unmodelled fields on modelled variants round-trip verbatim', () => {
  it('preserves settingSources, pi, and node-level description', () => {
    const def = defOf([
      {
        id: 'p',
        prompt: 'hello',
        description: 'a node description',
        settingSources: ['project'],
        pi: { enableExtensions: true },
      },
    ]);
    const { nodes, messages } = roundTrip(def);
    expect(nodes).toEqual(def.nodes);
    // All three are now classified base fields, so nothing is flagged.
    expect(messages).toEqual([]);
  });

  it('preserves a field from a newer engine that this build predates', () => {
    // The stale-types window: `api.generated.d.ts` has not been regenerated, so
    // `wire-coverage.ts` cannot know about this key. `extra` is what stops the
    // save from erasing it.
    const def = defOf([{ id: 'p', prompt: 'hello', someFutureField: { a: 1 } }]);
    const { nodes, messages } = roundTrip(def);
    expect(nodes).toEqual(def.nodes);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('someFutureField');
    expect(messages[0]).toContain('preserved');
  });

  it('still surfaces a genuinely malformed node as a blocking error', () => {
    // No recognizable mode field at all. Unlike an unsupported KIND, this is not
    // valid engine input, so the empty-prompt fallback keeps the save blocked.
    const { workflow, issues } = fromWorkflowDefinition(defOf([{ id: 'huh', mystery: 1 }]));
    expect(workflow.nodes[0]?.variant).toBe('prompt');
    expect(issues.some(i => i.severity === 'error')).toBe(true);
    // …but the unknown payload is still preserved rather than erased.
    expect(workflow.nodes[0]?.extra).toEqual({ mystery: 1 });
  });
});
