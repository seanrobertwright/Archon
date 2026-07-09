import { describe, test, expect } from 'bun:test';
import { FIXTURES } from '../fixtures';
import { fromWorkflowDefinition } from '../model';
import type { BuilderWorkflow } from '../types';
import { opsToEditorActions } from './translate-ops';
import type { ProposedEdit } from './op-schema';

function workflow(): BuilderWorkflow {
  return fromWorkflowDefinition(FIXTURES.mixed).workflow;
}

describe('opsToEditorActions — addNode', () => {
  test('maps to add-node with a staggered position and the requested id', () => {
    const { actions, issues } = opsToEditorActions(
      [{ op: 'addNode', id: 'gate', variant: 'approval' }],
      workflow()
    );
    expect(issues).toHaveLength(0);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'add-node', id: 'gate', variant: 'approval' });
  });

  test('addNode with data emits a follow-up patch-node merging over the variant defaults', () => {
    const { actions, issues } = opsToEditorActions(
      [{ op: 'addNode', id: 'gate', variant: 'approval', data: { message: 'Proceed?' } }],
      workflow()
    );
    expect(issues).toHaveLength(0);
    expect(actions).toHaveLength(2);
    expect(actions[0]?.type).toBe('add-node');
    expect(actions[1]).toMatchObject({
      type: 'patch-node',
      node: { id: 'gate', variant: 'approval', data: { message: 'Proceed?' } },
    });
  });

  test('addNode colliding with an existing id is dropped and surfaced as an issue', () => {
    const { actions, issues } = opsToEditorActions(
      [{ op: 'addNode', id: 'classify', variant: 'prompt' }],
      workflow()
    );
    expect(actions).toHaveLength(0);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.rule).toBe('copilot.addNode.duplicate');
  });

  test('two addNodes in one batch stagger to distinct positions', () => {
    const { actions } = opsToEditorActions(
      [
        { op: 'addNode', id: 'a', variant: 'prompt' },
        { op: 'addNode', id: 'b', variant: 'prompt' },
      ],
      workflow()
    );
    const positions = actions.filter(a => a.type === 'add-node').map(a => a.position);
    expect(positions[0]).not.toEqual(positions[1]);
  });
});

describe('opsToEditorActions — connect', () => {
  test('maps to add-edge', () => {
    const { actions, issues } = opsToEditorActions(
      [{ op: 'connect', source: 'classify', target: 'report' }],
      workflow()
    );
    expect(issues).toHaveLength(0);
    expect(actions).toEqual([{ type: 'add-edge', source: 'classify', target: 'report', at: 0 }]);
  });

  test('unknown source is an issue, not a thrown error', () => {
    const { actions, issues } = opsToEditorActions(
      [{ op: 'connect', source: 'nope', target: 'report' }],
      workflow()
    );
    expect(actions).toHaveLength(0);
    expect(issues[0]?.rule).toBe('copilot.connect.unknownSource');
  });

  test('unknown target is an issue', () => {
    const { issues } = opsToEditorActions(
      [{ op: 'connect', source: 'classify', target: 'nope' }],
      workflow()
    );
    expect(issues[0]?.rule).toBe('copilot.connect.unknownTarget');
  });

  test('connect can target a node added earlier in the same batch', () => {
    const { actions, issues } = opsToEditorActions(
      [
        { op: 'addNode', id: 'gate', variant: 'approval' },
        { op: 'connect', source: 'classify', target: 'gate' },
      ],
      workflow()
    );
    expect(issues).toHaveLength(0);
    expect(actions.some(a => a.type === 'add-edge' && a.target === 'gate')).toBe(true);
  });
});

describe('opsToEditorActions — setField', () => {
  test('maps to patch-node with the field merged into data', () => {
    const { actions, issues } = opsToEditorActions(
      [{ op: 'setField', id: 'classify', path: 'data.prompt', value: 'New prompt text' }],
      workflow()
    );
    expect(issues).toHaveLength(0);
    expect(actions).toHaveLength(1);
    const action = actions[0];
    expect(action?.type).toBe('patch-node');
    if (action?.type === 'patch-node') {
      expect(action.node.id).toBe('classify');
      expect(action.node.data).toMatchObject({ prompt: 'New prompt text' });
    }
  });

  test('maps a base. path onto the node base fields', () => {
    const { actions } = opsToEditorActions(
      [{ op: 'setField', id: 'classify', path: 'base.model', value: 'opus' }],
      workflow()
    );
    const action = actions[0];
    if (action?.type === 'patch-node') {
      expect(action.node.base.model).toBe('opus');
    } else {
      throw new Error('expected patch-node');
    }
  });

  test('unknown node is an issue', () => {
    const { actions, issues } = opsToEditorActions(
      [{ op: 'setField', id: 'nope', path: 'data.prompt', value: 'x' }],
      workflow()
    );
    expect(actions).toHaveLength(0);
    expect(issues[0]?.rule).toBe('copilot.setField.unknownNode');
  });

  test('setField on a node added earlier in the same batch is an issue, not silently dropped', () => {
    const { actions, issues } = opsToEditorActions(
      [
        { op: 'addNode', id: 'gate', variant: 'approval' },
        { op: 'setField', id: 'gate', path: 'data.message', value: 'Proceed?' },
      ],
      workflow()
    );
    // The add-node action still applies; only the setField is refused.
    expect(actions.some(a => a.type === 'add-node')).toBe(true);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.rule).toBe('copilot.setField.addedThisBatch');
  });
});

describe('opsToEditorActions — rename', () => {
  test('maps to rename-node', () => {
    const { actions, issues } = opsToEditorActions(
      [{ op: 'rename', id: 'classify', nextId: 'triage' }],
      workflow()
    );
    expect(issues).toHaveLength(0);
    expect(actions).toEqual([{ type: 'rename-node', id: 'classify', nextId: 'triage', at: 0 }]);
  });

  test('unknown node is an issue', () => {
    const { issues } = opsToEditorActions([{ op: 'rename', id: 'nope', nextId: 'x' }], workflow());
    expect(issues[0]?.rule).toBe('copilot.rename.unknownNode');
  });

  test('renaming onto an existing id is a collision issue', () => {
    const { actions, issues } = opsToEditorActions(
      [{ op: 'rename', id: 'classify', nextId: 'report' }],
      workflow()
    );
    expect(actions).toHaveLength(0);
    expect(issues[0]?.rule).toBe('copilot.rename.collision');
  });
});

describe('opsToEditorActions — remove', () => {
  test('maps to remove-nodes', () => {
    const { actions, issues } = opsToEditorActions([{ op: 'remove', id: 'report' }], workflow());
    expect(issues).toHaveLength(0);
    expect(actions).toEqual([{ type: 'remove-nodes', ids: ['report'], at: 0 }]);
  });

  test('unknown node is an issue', () => {
    const { issues } = opsToEditorActions([{ op: 'remove', id: 'nope' }], workflow());
    expect(issues[0]?.rule).toBe('copilot.remove.unknownNode');
  });
});

describe('opsToEditorActions — mixed batch', () => {
  test('one invalid op does not block the others', () => {
    const ops: ProposedEdit[] = [
      { op: 'addNode', id: 'gate', variant: 'approval', data: { message: 'ok?' } },
      { op: 'connect', source: 'classify', target: 'gate' },
      { op: 'remove', id: 'nonexistent' },
      { op: 'rename', id: 'report', nextId: 'summary' },
    ];
    const { actions, issues } = opsToEditorActions(ops, workflow());
    expect(issues).toHaveLength(1);
    expect(issues[0]?.rule).toBe('copilot.remove.unknownNode');
    const kinds = actions.map(a => a.type);
    expect(kinds).toEqual(['add-node', 'patch-node', 'add-edge', 'rename-node']);
  });
});
