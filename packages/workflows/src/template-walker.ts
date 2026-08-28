import type { DagNode } from './schemas';
import {
  isAgentNode,
  isComposeFanOutNode,
  isExecNode,
  isGateNode,
  isHaltNode,
  isIncludeDirective,
  isLoopGroupNode,
  isLoopNode,
  isWaitNode,
  isWorkflowNode,
  isBindingDirective,
} from './schemas';
import {
  COMPOSED_NODE,
  COMPILED_LOOP_COMMAND,
  type LoopWithCompiledCommand,
  readComposedMeta,
  type NodeWithComposedMeta,
} from './compiled-command';

/** The meaning of a template slot, independent of the transform using it. */
export type TemplateSurface =
  | 'condition'
  | 'prompt'
  | 'shell'
  | 'script'
  | 'value'
  | 'binding_from'
  | 'binding_default';

export interface TemplateSlot {
  path: string;
  surface: TemplateSurface;
  value: string;
}

type SlotCallback = (slot: TemplateSlot, replace: (value: string) => void) => void;

/**
 * The complete engine-owned template surface. Keep this type exhaustive: adding a
 * node kind or a template-bearing field requires choosing its transform semantics.
 */
type SlotSpec = Record<TemplateSurface, true>;
const SLOT_SPEC: SlotSpec = {
  condition: true,
  prompt: true,
  shell: true,
  script: true,
  value: true,
  binding_from: true,
  binding_default: true,
};
void SLOT_SPEC;

function walk(node: DagNode, callback: SlotCallback, prefix = '', recursive = true): void {
  const slot = (
    path: string,
    surface: TemplateSurface,
    value: string,
    replace: (value: string) => void
  ): void => {
    callback({ path: `${prefix}${path}`, surface, value }, replace);
  };
  if (node.when !== undefined) slot('when', 'condition', node.when, value => (node.when = value));
  if (node.systemPrompt !== undefined)
    slot('systemPrompt', 'prompt', node.systemPrompt, value => (node.systemPrompt = value));
  for (const [id, agent] of Object.entries(node.agents ?? {})) {
    slot(`agents.${id}.prompt`, 'prompt', agent.prompt, value => (agent.prompt = value));
    slot(
      `agents.${id}.description`,
      'prompt',
      agent.description,
      value => (agent.description = value)
    );
  }

  const walkBindings = (
    bindings: Record<string, unknown> | undefined,
    write: (name: string, value: unknown) => void
  ): void => {
    for (const [name, binding] of Object.entries(bindings ?? {})) {
      if (typeof binding === 'string') {
        slot(`with.${name}`, 'value', binding, value => {
          write(name, value);
        });
      } else if (isBindingDirective(binding)) {
        slot(`with.${name}.from`, 'binding_from', binding.from, value => (binding.from = value));
        if (typeof binding.if_skipped === 'string') {
          slot(
            `with.${name}.if_skipped`,
            'binding_default',
            binding.if_skipped,
            value => (binding.if_skipped = value)
          );
        }
      }
    }
  };

  if (isAgentNode(node)) {
    if (node.source.kind === 'inline') {
      const source = node.source;
      slot('prompt', 'prompt', source.prompt, value => (source.prompt = value));
    } else {
      walkBindings(node.source.with, (name, value) => {
        if (node.source.kind === 'command' && node.source.with !== undefined) {
          node.source.with[name] = value as never;
        }
      });
    }
  } else if (isExecNode(node)) {
    slot(
      node.runtime === 'sh' ? 'bash' : 'script',
      node.runtime === 'sh' ? 'shell' : 'script',
      node.script,
      value => (node.script = value)
    );
    walkBindings(node.with, (name, value) => {
      if (node.with !== undefined) node.with[name] = value as never;
    });
  } else if (isLoopNode(node)) {
    if (typeof node.loop.prompt === 'string')
      slot('loop.prompt', 'prompt', node.loop.prompt, value => (node.loop.prompt = value));
    if (node.loop.until_bash !== undefined)
      slot(
        'loop.until_bash',
        'shell',
        node.loop.until_bash,
        value => (node.loop.until_bash = value)
      );
    const compiled = (node.loop as typeof node.loop & LoopWithCompiledCommand)[
      COMPILED_LOOP_COMMAND
    ];
    if (compiled?.prompt !== undefined)
      slot('loop.compiled_prompt', 'prompt', compiled.prompt, value => (compiled.prompt = value));
  } else if (isLoopGroupNode(node)) {
    if (node.loop_group.until_bash !== undefined)
      slot(
        'loop_group.until_bash',
        'shell',
        node.loop_group.until_bash,
        value => (node.loop_group.until_bash = value)
      );
    if (recursive) {
      for (const [index, body] of node.loop_group.nodes.entries()) {
        if (!isIncludeDirective(body)) walk(body, callback, `${prefix}loop_group.nodes.${index}.`);
      }
    }
  } else if (isGateNode(node)) {
    slot('approval.message', 'prompt', node.message, value => (node.message = value));
    for (const decision of node.decisions) {
      const rework = decision.rework;
      if (rework !== undefined)
        slot('approval.on_reject.prompt', 'prompt', rework.prompt, value => {
          rework.prompt = value;
        });
    }
  } else if (isHaltNode(node)) {
    slot('cancel', 'prompt', node.reason, value => (node.reason = value));
  } else if (isWaitNode(node)) {
    if (node.wait.until !== undefined)
      slot('wait.until', 'value', node.wait.until, value => (node.wait = { until: value }));
    if (node.wait.event !== undefined) {
      const deadlineMs = node.wait.deadline_ms;
      if (deadlineMs !== undefined)
        slot(
          'wait.event',
          'value',
          node.wait.event,
          value => (node.wait = { event: value, deadline_ms: deadlineMs })
        );
    }
  } else if (isWorkflowNode(node)) {
    if (node.input !== undefined) slot('input', 'value', node.input, value => (node.input = value));
    const withMap = node.with;
    for (const [name, value] of Object.entries(withMap ?? {})) {
      if (typeof value === 'string' && withMap !== undefined)
        slot(`with.${name}`, 'value', value, next => {
          withMap[name] = next;
        });
    }
    const fanOut = node.fan_out;
    if (fanOut !== undefined)
      slot('fan_out.items', 'value', fanOut.items, value => {
        fanOut.items = value;
      });
  } else if (isComposeFanOutNode(node)) {
    const withMap = node.with;
    for (const [name, value] of Object.entries(withMap ?? {})) {
      if (typeof value === 'string' && withMap !== undefined)
        slot(`with.${name}`, 'value', value, next => {
          withMap[name] = next;
        });
    }
    slot('fan_out.items', 'value', node.fan_out.items, value => (node.fan_out.items = value));
  }

  const inputs = readComposedMeta(node)?.inputs;
  if (inputs !== undefined) {
    for (const [name, value] of Object.entries(inputs)) {
      if (typeof value === 'string')
        slot(`composed.inputs.${name}`, 'value', value, next => {
          inputs[name] = next;
        });
    }
  }
}

export function visitNodeTemplateSlots(
  node: DagNode,
  visitor: (slot: TemplateSlot) => void,
  options?: { recursive?: boolean }
): void {
  walk(
    node,
    slot => {
      visitor(slot);
    },
    '',
    options?.recursive ?? true
  );
}

/** Return a deep-enough clone of a node with every template slot mapped exactly once. */
export function mapNodeTemplateSlots(
  node: DagNode,
  mapper: (slot: TemplateSlot) => string
): DagNode {
  const clone = structuredClone(node);
  preserveInternalMetadata(node, clone);
  walk(clone, (slot, replace) => {
    replace(mapper(slot));
  });
  return clone;
}

function preserveInternalMetadata(source: DagNode, target: DagNode): void {
  const meta = readComposedMeta(source);
  if (meta !== undefined)
    (target as DagNode & NodeWithComposedMeta)[COMPOSED_NODE] = structuredClone(meta);
  if (isLoopNode(source) && isLoopNode(target)) {
    const compiled = (source.loop as typeof source.loop & LoopWithCompiledCommand)[
      COMPILED_LOOP_COMMAND
    ];
    if (compiled !== undefined)
      (target.loop as typeof target.loop & LoopWithCompiledCommand)[COMPILED_LOOP_COMMAND] =
        structuredClone(compiled);
  }
  if (isLoopGroupNode(source) && isLoopGroupNode(target)) {
    for (const [index, sourceBody] of source.loop_group.nodes.entries()) {
      const targetBody = target.loop_group.nodes[index];
      if (
        targetBody !== undefined &&
        !isIncludeDirective(sourceBody) &&
        !isIncludeDirective(targetBody)
      ) {
        preserveInternalMetadata(sourceBody, targetBody);
      }
    }
  }
}
