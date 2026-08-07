/**
 * Unsupported variant: the read-only passthrough for engine node kinds this
 * build has no editor for (`loop_group`, `include`, `workflow`, …).
 *
 * The node's whole variant-specific wire fragment is preserved on
 * `BuilderNode.extra` and re-emitted verbatim by the exporter, so opening and
 * saving a workflow that contains one is lossless. `data` carries only the mode
 * field's NAME, for display.
 *
 * `toDag` returns an empty fragment on purpose: the payload rides in `extra`,
 * and emitting it from both places would double-write it.
 */
import type { UnsupportedNodeData, WireDagNode } from '../types';

/**
 * Engine mode fields with no builder editor, in the order `detectUnsupportedKind`
 * probes them. Mirrors `UnsupportedWireKey` in `types/wire-coverage.ts`; the
 * satellite fields (`with`, `input`, `isolation`, `fan_out`) are deliberately
 * absent because they never appear WITHOUT their owning mode field, so probing
 * them would mislabel the node.
 */
export const UNSUPPORTED_MODE_FIELDS: readonly string[] = ['loop_group', 'include', 'workflow'];

/**
 * Name the unsupported node kind from its wire fragment, or `null` when no
 * known-but-unmodelled mode field is present (a genuinely malformed node, which
 * the importer reports differently).
 */
export function detectUnsupportedKind(variantSpecific: Partial<WireDagNode>): string | null {
  const present = Object.keys(variantSpecific);
  return UNSUPPORTED_MODE_FIELDS.find(field => present.includes(field)) ?? null;
}

/**
 * Default data. Present only to satisfy the registry's uniform shape — the node
 * palette iterates `VARIANTS` (creatable), which excludes `'unsupported'`, so
 * this is never reached by user action. The `kind` reads `'unknown'` rather
 * than throwing so a hypothetical programmatic call degrades visibly instead of
 * crashing the editor.
 */
export function defaultUnsupportedData(): UnsupportedNodeData {
  return { kind: 'unknown' };
}

/** Build display data from a partitioned wire node's variant-specific fields. */
export function unsupportedFromDag(variantSpecific: Partial<WireDagNode>): UnsupportedNodeData {
  return { kind: detectUnsupportedKind(variantSpecific) ?? 'unknown' };
}

/**
 * Serialize to an EMPTY wire fragment. The real payload is restored from
 * `BuilderNode.extra` by the exporter — see `model/to-workflow.ts`.
 */
export function unsupportedToDag(_data: UnsupportedNodeData): Partial<WireDagNode> {
  return {};
}
