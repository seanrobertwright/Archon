import { expect, test } from 'bun:test';
import type { DagNode } from './schemas';
import { mapNodeTemplateSlots, visitNodeTemplateSlots } from './template-walker';

test('walks dynamic template slots without mutating the source node', () => {
  const node = {
    id: 'group',
    kind: 'loop_group',
    systemPrompt: '$setup.output',
    agents: { reviewer: { prompt: '$setup.output', description: '$setup.output' } },
    loop_group: {
      until_bash: 'test $setup.output',
      nodes: [
        {
          id: 'run',
          kind: 'exec',
          runtime: 'bun',
          script: 'console.log($setup.output)',
          with: {
            value: '$setup.output',
            required: { from: '$setup.output', if_skipped: '$setup.output' },
            literal: true,
          },
        },
      ],
    },
  } as unknown as DagNode;

  const slots: string[] = [];
  visitNodeTemplateSlots(node, slot => slots.push(`${slot.path}:${slot.surface}`));
  expect(slots).toEqual([
    'systemPrompt:prompt',
    'agents.reviewer.prompt:prompt',
    'agents.reviewer.description:prompt',
    'loop_group.until_bash:shell',
    'loop_group.nodes.0.script:script',
    'loop_group.nodes.0.with.value:value',
    'loop_group.nodes.0.with.required.from:binding_from',
    'loop_group.nodes.0.with.required.if_skipped:binding_default',
  ]);

  const mapped = mapNodeTemplateSlots(node, slot => slot.value.replace('$setup', '$renamed'));
  expect(mapped).not.toBe(node);
  expect(JSON.stringify(node)).toContain('$setup.output');
  expect(JSON.stringify(mapped)).toContain('$renamed.output');
  if (mapped.kind !== 'loop_group') throw new Error('expected loop group');
  expect(mapped.loop_group.nodes[0]).toMatchObject({
    with: { literal: true },
  });
});
