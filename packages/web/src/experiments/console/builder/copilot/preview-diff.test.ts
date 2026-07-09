import { describe, test, expect } from 'bun:test';
import { FIXTURES } from '../fixtures';
import { fromWorkflowDefinition } from '../model';
import type { BuilderWorkflow } from '../types';
import { computeProposalPreview } from './preview-diff';
import type { ProposedEdit } from './op-schema';

function workflow(): BuilderWorkflow {
  return fromWorkflowDefinition(FIXTURES.mixed).workflow;
}

describe('computeProposalPreview', () => {
  test('an added node ghosts as "add" and keeps all current nodes intact', () => {
    const preview = computeProposalPreview(workflow(), [
      { op: 'addNode', id: 'gate', variant: 'approval', data: { message: 'ok?' } },
    ]);
    expect(preview.issues).toHaveLength(0);
    expect(preview.ghosts.get('gate')).toBe('add');
    const ids = preview.workflow.nodes.map(n => n.id);
    expect(ids).toContain('classify');
    expect(ids).toContain('fix');
    expect(ids).toContain('report');
    expect(ids).toContain('gate');
    expect(preview.positions.has('gate')).toBe(true);
  });

  test('a removed node ghosts as "remove" and is RE-INCLUDED in the union workflow', () => {
    const preview = computeProposalPreview(workflow(), [{ op: 'remove', id: 'fix' }]);
    expect(preview.ghosts.get('fix')).toBe('remove');
    expect(preview.workflow.nodes.map(n => n.id)).toContain('fix');
  });

  test('a changed node (setField) ghosts as "changed"', () => {
    const preview = computeProposalPreview(workflow(), [
      { op: 'setField', id: 'classify', path: 'data.prompt', value: 'Different prompt.' },
    ]);
    expect(preview.ghosts.get('classify')).toBe('changed');
    // Nodes untouched by the batch are not ghosted at all.
    expect(preview.ghosts.has('report')).toBe(false);
  });

  test('an unresolvable op contributes an issue but the rest of the batch still previews', () => {
    const ops: ProposedEdit[] = [
      { op: 'addNode', id: 'gate', variant: 'approval' },
      { op: 'connect', source: 'nope', target: 'gate' },
    ];
    const preview = computeProposalPreview(workflow(), ops);
    expect(preview.issues.some(i => i.rule === 'copilot.connect.unknownSource')).toBe(true);
    expect(preview.ghosts.get('gate')).toBe('add');
  });

  test('a batch that would introduce a would-be validation problem surfaces it via runValidation', () => {
    // Renaming to an id containing an invalid character trips validateStructural,
    // but the translator itself only blocks on collision — this proves would-be
    // structural/content issues from runValidation ride through, not just op issues.
    const preview = computeProposalPreview(workflow(), [
      { op: 'setField', id: 'fix', path: 'base.depends_on', value: ['does-not-exist'] },
    ]);
    expect(preview.issues.length).toBeGreaterThan(0);
  });

  test('an empty ops array is a no-op preview with no ghosts and no issues', () => {
    const preview = computeProposalPreview(workflow(), []);
    expect(preview.ghosts.size).toBe(0);
    expect(preview.issues).toHaveLength(0);
    expect(preview.workflow.nodes.map(n => n.id).sort()).toEqual(['classify', 'fix', 'report']);
  });
});
