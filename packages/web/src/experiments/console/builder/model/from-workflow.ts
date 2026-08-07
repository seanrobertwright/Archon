/**
 * Importer: wire `WorkflowDefinition` → `BuilderWorkflow` + import issues.
 *
 * Each node is partitioned into `{ id, base, variantSpecific }`, its variant is
 * detected, and its variant data is built via the registry. Anything the
 * round-trip cannot represent faithfully — a node with no mode field, a script
 * node missing `runtime`, a wire key the variant's converters do not carry —
 * surfaces as an `Issue` instead of being silently defaulted or dropped.
 */
import type { BuilderNode, BuilderWorkflow, Issue, WireWorkflowDefinition } from '../types';
import {
  detectUnsupportedKind,
  detectVariantOrNull,
  defaultPromptData,
  partitionNode,
  VARIANT_REGISTRY,
  variantDataFromDag,
} from '../variants';
import { makeIssue } from '../validation/make-issue';

/** A converted workflow plus everything the importer had to flag along the way. */
export interface ImportResult {
  workflow: BuilderWorkflow;
  issues: Issue[];
}

/** Convert a single wire node into a `BuilderNode`, collecting import issues. */
function nodeFromDag(node: WireWorkflowDefinition['nodes'][number], issues: Issue[]): BuilderNode {
  const { id, base, variantSpecific } = partitionNode(node);

  const variant = detectVariantOrNull(node);
  if (variant === null) {
    const unsupportedKind = detectUnsupportedKind(variantSpecific);
    if (unsupportedKind !== null) {
      // A node kind the ENGINE supports but this build has no editor for
      // (`loop_group`, `include`, `workflow`). Preserve the entire wire
      // fragment on `extra` so save is lossless, and render it read-only.
      // Severity is `warning`, not `error`: the node round-trips perfectly, so
      // blocking the save would strand every workflow that uses one.
      issues.push(
        makeIssue({
          rule: 'structural.variant.unsupported',
          severity: 'warning',
          source: 'client-instant',
          message:
            `'${unsupportedKind}' nodes have no editor in this build; ` +
            'the node is preserved exactly as written and cannot be edited here',
          path: { nodeId: id },
        })
      );
      return {
        id,
        variant: 'unsupported',
        base,
        data: { kind: unsupportedKind },
        extra: variantSpecific,
      };
    }

    // No recognizable mode field at all — genuinely malformed. Preserve whatever
    // was there on `extra` (so a save cannot erase it) and fall back to an empty
    // prompt node so the rest of the workflow stays editable. Severity stays
    // `error`: unlike the case above, this node is NOT valid engine input, and
    // the empty prompt keeps the save blocked until a human resolves it.
    issues.push(
      makeIssue({
        rule: 'structural.variant.unknown',
        severity: 'error',
        source: 'client-instant',
        message:
          'cannot determine the node variant (no mode field present); editing as an empty prompt node',
        path: { nodeId: id },
      })
    );
    return {
      id,
      variant: 'prompt',
      base,
      data: defaultPromptData(),
      ...(Object.keys(variantSpecific).length > 0 ? { extra: variantSpecific } : {}),
    };
  }

  if (
    variant === 'loop' &&
    typeof variantSpecific.loop?.prompt === 'string' &&
    typeof variantSpecific.loop.command === 'string'
  ) {
    // The engine schema rejects a loop carrying both prompt sources; a wire
    // node that somehow has both cannot round-trip faithfully. loopFromDag
    // deterministically keeps `prompt` — surface the dropped `command`.
    issues.push(
      makeIssue({
        rule: 'structural.field.unsupported',
        severity: 'error',
        source: 'client-instant',
        message:
          "loop node has both 'prompt' and 'command' (engine allows exactly one); editing as an inline-prompt loop — 'command' was dropped",
        path: { nodeId: id, field: 'loop.command' },
      })
    );
  }

  if (variant === 'script' && variantSpecific.runtime === undefined) {
    // The engine requires `runtime` on script nodes. scriptFromDag defaults to
    // 'bun' so the node stays editable, but the gap must not be silent.
    issues.push(
      makeIssue({
        rule: 'structural.field.missing',
        severity: 'error',
        source: 'client-instant',
        message: "script node is missing required 'runtime' ('bun' or 'uv'); editing as 'bun'",
        path: { nodeId: id, field: 'runtime' },
      })
    );
  }

  // Wire keys the variant's converters do not carry. These are PRESERVED on
  // `extra` and re-emitted verbatim rather than dropped — before this, a field
  // a newer engine had added (e.g. `settingSources`, #2216) was warned about and
  // then silently erased on the next save, because a warning does not block the
  // save gate (`blockingErrors` filters severity `'error'`).
  //
  // Widen to `string[]` so the `.includes(key)` membership test accepts the
  // arbitrary keys present on the wire node (the registry types these as
  // `keyof WireDagNode` for compile-time drift safety).
  const wireKeys: readonly string[] = VARIANT_REGISTRY[variant].wireKeys;
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(variantSpecific)) {
    if (!wireKeys.includes(key)) {
      extra[key] = value;
      issues.push(
        makeIssue({
          rule: 'structural.field.unsupported',
          severity: 'warning',
          source: 'client-instant',
          message:
            `field '${key}' has no editor on ${variant} nodes; ` +
            'it is preserved as written but cannot be edited here',
          path: { nodeId: id, field: key },
        })
      );
    }
  }

  const data = variantDataFromDag(variant, variantSpecific);
  // The (variant, data) pair is consistent by construction — detectVariantOrNull
  // and variantDataFromDag read the same fields — so this assembles a valid
  // member of the BuilderNode discriminated union.
  return {
    id,
    variant,
    base,
    data,
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  } as BuilderNode;
}

/** Convert a wire workflow definition into a `BuilderWorkflow` plus import issues. */
export function fromWorkflowDefinition(def: WireWorkflowDefinition): ImportResult {
  const { name, description, nodes, ...meta } = def;
  const issues: Issue[] = [];
  return {
    workflow: {
      name,
      description,
      meta,
      nodes: nodes.map(node => nodeFromDag(node, issues)),
    },
    issues,
  };
}

/**
 * Import a workflow definition, surfacing any import issues to the console.
 *
 * Callers that seed the editor from a definition but have nowhere to render the
 * issue list (the fixture route, the preview page) should use this instead of
 * dropping `.issues` on the floor — an unknown node variant silently becomes an
 * empty prompt node, and a missing script `runtime` silently becomes `bun`, so
 * the degradation must at least be visible in the console. PR-3's live editor
 * routes the same issues into the validation panel.
 */
export function importWorkflowDefinition(
  def: WireWorkflowDefinition,
  label: string
): BuilderWorkflow {
  const { workflow, issues } = fromWorkflowDefinition(def);
  if (issues.length > 0) {
    // Dev-visibility surface for import degradation; these routes have no issue
    // panel (PR-3's live editor routes the same issues into the panel).
    console.warn(
      `[builder] imported "${label}" with ${String(issues.length)} import issue(s):`,
      issues.map(i => i.message)
    );
  }
  return workflow;
}
