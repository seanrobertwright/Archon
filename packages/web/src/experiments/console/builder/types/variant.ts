/**
 * Builder type definitions — the in-editor data model for a workflow under edit.
 *
 * A `BuilderNode` partitions a wire `DagNode` into `{ id, variant, base, data }`:
 *   - `variant`  — the discriminant (which of the seven node kinds this is)
 *   - `base`     — shared base fields (depends_on, when, model, …) minus `id`
 *   - `data`     — variant-specific fields, discriminated by `variant`
 *
 * Wire shapes are reached only through `./wire`; the variant id is the
 * console's existing `WorkflowNodeKind` primitive.
 */
import type { WorkflowNodeKind } from '../../primitives/workflow-graph';
import type { WireDagNode, WireWorkflowDefinition } from './wire';

/**
 * The seven variants a user can CREATE — an alias of the console's
 * `WorkflowNodeKind` primitive so the builder and the graph renderer share one
 * union (the builder does not redefine the kinds).
 */
export type CreatableVariantId = WorkflowNodeKind;

/**
 * Every variant the builder can REPRESENT: the seven creatable kinds plus
 * `'unsupported'`, the read-only passthrough for engine node kinds this build
 * has no editor for (`loop_group`, `include`, `workflow`, …).
 *
 * Kept distinct from {@link CreatableVariantId} on purpose. `'unsupported'` is
 * an import-only artifact: it must never reach the node palette, the drag-drop
 * payload, or the Copilot's `addNode`, so those surfaces iterate `VARIANTS`
 * (creatable) while the registry, capabilities map, and `BuilderNode` union are
 * keyed by `VariantId` (representable). Widening happens HERE rather than in
 * `WorkflowNodeKind` because the run-graph renderer's `kindGlyph` switch is
 * exhaustive over that primitive and a run graph never shows an unsupported
 * node — it renders the engine's own expanded DAG.
 */
export type VariantId = CreatableVariantId | 'unsupported';

// ---------------------------------------------------------------------------
// Base fields — shared across every variant (the wire base keys minus `id`)
// ---------------------------------------------------------------------------

/**
 * The base-field keys present on every wire `DagNode`, excluding `id` (which is
 * partitioned out separately) and the seven mutually-exclusive mode fields
 * (command/prompt/bash/script/loop/approval/cancel) plus their satellites
 * (runtime/deps/timeout). Picking from `WireDagNode` keeps `BaseFields` exactly
 * in sync with the generated spec.
 *
 * Exported so `variants/base-fields.ts` can derive its runtime key list from an
 * exhaustive `Record<WireBaseKey, true>` — adding a key here without updating
 * the record (or vice versa) is a compile error, not silent round-trip loss.
 */
export type WireBaseKey =
  | 'depends_on'
  | 'when'
  | 'trigger_rule'
  | 'model'
  | 'provider'
  | 'context'
  | 'output_format'
  | 'allowed_tools'
  | 'denied_tools'
  | 'idle_timeout'
  | 'retry'
  | 'hooks'
  | 'mcp'
  | 'skills'
  | 'agents'
  | 'effort'
  | 'thinking'
  | 'maxBudgetUsd'
  | 'systemPrompt'
  | 'fallbackModel'
  | 'betas'
  | 'sandbox'
  | 'always_run'
  | 'persist_session'
  | 'output_type'
  // Base fields that apply to any node kind. `description` is the node-level
  // doc string (distinct from the workflow-level `description`); `settingSources`
  // (#2216) and `pi` (#2144) are per-node provider posture. All three predate
  // this classification and were previously dropped on import — see
  // `wire-coverage.ts` for the assert that keeps this list exhaustive.
  | 'description'
  | 'settingSources'
  | 'pi';

/** Shared base fields carried verbatim across the round-trip. All optional. */
export type BaseFields = Pick<WireDagNode, WireBaseKey>;

// ---------------------------------------------------------------------------
// Per-variant data shapes
// ---------------------------------------------------------------------------

/**
 * Loop config. `fresh_context` is always present (engine default `false`).
 *
 * Exactly ONE of `prompt` (inline per-iteration prompt) / `command` (named
 * command file whose body is the per-iteration prompt) is present — mirroring
 * the engine schema's one-of rule. The inspector's source toggle maintains the
 * invariant while editing; structural validation reports a violation instead
 * of letting export guess.
 */
export interface LoopNodeData {
  prompt?: string;
  command?: string;
  until: string;
  max_iterations: number;
  fresh_context: boolean;
  until_bash?: string;
  interactive?: boolean;
  gate_message?: string;
}

/** The `on_reject` sub-object on an approval node. */
export interface ApprovalOnReject {
  prompt: string;
  max_attempts?: number;
}

/** Human-gate approval data. */
export interface ApprovalNodeData {
  message: string;
  capture_response?: boolean;
  on_reject?: ApprovalOnReject;
}

/** Cancel data — the wire `cancel` is a bare string; we wrap it as `reason`. */
export interface CancelNodeData {
  reason: string;
}

/** Script node data (inline code or named script run via bun/uv). */
export interface ScriptNodeData {
  script: string;
  runtime: 'bun' | 'uv';
  deps?: string[];
  timeout?: number;
}

/** Named-command node data. */
export interface CommandNodeData {
  command: string;
}

/** Inline-prompt node data. */
export interface PromptNodeData {
  prompt: string;
}

/** Bash node data. */
export interface BashNodeData {
  bash: string;
  timeout?: number;
}

/**
 * Read-only passthrough for an engine node kind this build cannot edit.
 *
 * Carries no payload of its own — the node's entire variant-specific wire
 * fragment rides in `BuilderNode.extra` and is re-emitted verbatim on export,
 * so an unsupported node survives an open/save cycle byte-identical. `kind` is
 * the mode-field name (`'loop_group'`, `'include'`, `'workflow'`, …) and exists
 * only so the canvas and inspector can name what they are refusing to edit.
 */
export interface UnsupportedNodeData {
  kind: string;
}

/** Maps each variant id to its concrete data shape. */
export interface VariantDataMap {
  loop: LoopNodeData;
  approval: ApprovalNodeData;
  cancel: CancelNodeData;
  script: ScriptNodeData;
  command: CommandNodeData;
  prompt: PromptNodeData;
  bash: BashNodeData;
  unsupported: UnsupportedNodeData;
}

/** Union of all variant data shapes. */
export type VariantData = VariantDataMap[VariantId];

// ---------------------------------------------------------------------------
// BuilderNode / BuilderWorkflow
// ---------------------------------------------------------------------------

/**
 * A node under edit. Modelled as a discriminated union over `variant` so that
 * `node.data` narrows to the correct shape in a `switch (node.variant)`.
 *
 * No `position`/selection/clipboard fields — those are canvas concerns owned by
 * PR-2 (added as an additive extension later).
 */
export type BuilderNode = {
  [K in VariantId]: {
    id: string;
    variant: K;
    base: BaseFields;
    data: VariantDataMap[K];
    /**
     * Wire keys this build cannot model, preserved verbatim and re-emitted on
     * export. Two populations land here:
     *   - an `'unsupported'` node's whole mode payload (`loop_group: {…}`)
     *   - any wire key absent from both `WireBaseKey` and the variant's
     *     `wireKeys` — i.e. a field a NEWER engine added that this build
     *     predates
     *
     * The second case is why this exists at runtime rather than being solved
     * purely by `wire-coverage.ts`: that assert only fires once
     * `api.generated.d.ts` has been regenerated, so a build running against a
     * newer server would otherwise silently erase the field on save.
     *
     * Optional so the many `BuilderNode` object literals (tests, clipboard,
     * `addNode`) stay valid — a node the user authored has nothing to preserve.
     */
    extra?: Record<string, unknown>;
  };
}[VariantId];

/** Workflow-level metadata (everything on the wire def except name/description/nodes). */
export type WorkflowMeta = Omit<WireWorkflowDefinition, 'name' | 'description' | 'nodes'>;

/**
 * A whole workflow definition under edit. Distinct from the console's list-entry
 * `Workflow` ({ name, description, source }) — this is the "definition being
 * edited" concept with a full node list.
 */
export interface BuilderWorkflow {
  name: string;
  description: string;
  meta: WorkflowMeta;
  nodes: BuilderNode[];
}
