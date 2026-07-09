/**
 * Pure Proposed-Edit → `EditorAction` translator (Pre-flight #4). Maps the
 * copilot's op vocabulary 1:1 onto the console builder's `editorReducer`
 * actions. Never mutates `workflow` — callers fold the returned actions
 * through `editorReducer` themselves, either over a CLONE (preview) or the
 * live reducer (Accept, via the `batch` action).
 */
import { VARIANT_REGISTRY } from '../variants';
import type { BuilderNode, BuilderWorkflow, Issue } from '../types';
import type { EditorAction } from '../editor/state';
import type { XYPosition } from '../flow/types';
import { makeIssue } from '../validation/make-issue';
import type { ProposedEdit } from './op-schema';

function issue(rule: string, message: string, nodeId: string): Issue {
  return makeIssue({
    rule,
    severity: 'error',
    source: 'client-instant',
    message,
    path: { nodeId },
  });
}

/** Mirrors `BuilderPage`'s palette-click stagger so a batch of new nodes doesn't stack at one point. */
function staggeredPosition(index: number): XYPosition {
  return { x: 60 + (index % 5) * 36, y: 60 + index * 28 };
}

/** Set a dotted field path (`"data.<key>"` | `"base.<key>"`) on a cloned `BuilderNode`. */
function patchField(node: BuilderNode, path: string, value: unknown): BuilderNode {
  const dot = path.indexOf('.');
  const section = path.slice(0, dot);
  const key = path.slice(dot + 1);
  if (section === 'data') {
    return { ...node, data: { ...node.data, [key]: value } } as BuilderNode;
  }
  return { ...node, base: { ...node.base, [key]: value } } as BuilderNode;
}

/**
 * Translate a Proposal's ops into the `EditorAction`s that would apply it.
 * Ops referencing an unknown node, a name collision, or a malformed path are
 * dropped and surfaced as an `Issue` instead of throwing — an invalid op in a
 * batch never corrupts the ones around it; the caller decides whether any
 * issues should block Accept.
 */
export function opsToEditorActions(
  ops: readonly ProposedEdit[],
  workflow: BuilderWorkflow
): { actions: EditorAction[]; issues: Issue[] } {
  const actions: EditorAction[] = [];
  const issues: Issue[] = [];
  // Ids as the batch would apply them, in order — lets a later op in the SAME
  // batch reference a node an earlier op in that batch just added/renamed.
  const knownIds = new Set(workflow.nodes.map(n => n.id));
  const addedThisBatch = new Set<string>();
  let addedCount = 0;

  for (const op of ops) {
    switch (op.op) {
      case 'addNode': {
        if (knownIds.has(op.id)) {
          issues.push(issue('copilot.addNode.duplicate', `Node '${op.id}' already exists.`, op.id));
          break;
        }
        actions.push({
          type: 'add-node',
          id: op.id,
          variant: op.variant,
          position: staggeredPosition(workflow.nodes.length + addedCount),
          at: 0,
        });
        if (op.data !== undefined && Object.keys(op.data).length > 0) {
          // Merge proposed fields over the variant's defaults so a partial
          // addNode (e.g. only `message` for an approval node) still produces
          // a fully-shaped node — one follow-up patch-node in the same batch.
          const defaultData = VARIANT_REGISTRY[op.variant].defaultData();
          actions.push({
            type: 'patch-node',
            node: {
              id: op.id,
              variant: op.variant,
              base: {},
              data: { ...defaultData, ...op.data },
            } as BuilderNode,
            at: 0,
          });
        }
        knownIds.add(op.id);
        addedThisBatch.add(op.id);
        addedCount += 1;
        break;
      }

      case 'connect': {
        if (!knownIds.has(op.source)) {
          issues.push(
            issue('copilot.connect.unknownSource', `Unknown node '${op.source}'.`, op.source)
          );
          break;
        }
        if (!knownIds.has(op.target)) {
          issues.push(
            issue('copilot.connect.unknownTarget', `Unknown node '${op.target}'.`, op.target)
          );
          break;
        }
        actions.push({ type: 'add-edge', source: op.source, target: op.target, at: 0 });
        break;
      }

      case 'setField': {
        if (!knownIds.has(op.id)) {
          issues.push(issue('copilot.setField.unknownNode', `Unknown node '${op.id}'.`, op.id));
          break;
        }
        if (addedThisBatch.has(op.id)) {
          // The node's shape comes from a pending patch-node (the addNode
          // branch above), not from `workflow` yet — composing a further
          // setField against it is out of scope for v1. Fold the field into
          // addNode's `data` instead of a separate setField in the same batch.
          issues.push(
            issue(
              'copilot.setField.addedThisBatch',
              `Cannot set a field on '${op.id}' in the same batch it was added — include it in addNode's data instead.`,
              op.id
            )
          );
          break;
        }
        const existing = workflow.nodes.find(n => n.id === op.id);
        if (existing === undefined) {
          issues.push(issue('copilot.setField.unknownNode', `Unknown node '${op.id}'.`, op.id));
          break;
        }
        const dot = op.path.indexOf('.');
        if (dot === op.path.length - 1) {
          issues.push(issue('copilot.setField.badPath', `Malformed path '${op.path}'.`, op.id));
          break;
        }
        actions.push({ type: 'patch-node', node: patchField(existing, op.path, op.value), at: 0 });
        break;
      }

      case 'rename': {
        if (!knownIds.has(op.id)) {
          issues.push(issue('copilot.rename.unknownNode', `Unknown node '${op.id}'.`, op.id));
          break;
        }
        if (knownIds.has(op.nextId)) {
          issues.push(
            issue('copilot.rename.collision', `A node named '${op.nextId}' already exists.`, op.id)
          );
          break;
        }
        actions.push({ type: 'rename-node', id: op.id, nextId: op.nextId, at: 0 });
        knownIds.delete(op.id);
        knownIds.add(op.nextId);
        if (addedThisBatch.delete(op.id)) addedThisBatch.add(op.nextId);
        break;
      }

      case 'remove': {
        if (!knownIds.has(op.id)) {
          issues.push(issue('copilot.remove.unknownNode', `Unknown node '${op.id}'.`, op.id));
          break;
        }
        actions.push({ type: 'remove-nodes', ids: [op.id], at: 0 });
        knownIds.delete(op.id);
        addedThisBatch.delete(op.id);
        break;
      }
    }
  }

  return { actions, issues };
}
