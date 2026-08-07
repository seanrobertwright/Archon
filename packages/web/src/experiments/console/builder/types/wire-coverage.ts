/**
 * Compile-time tripwire: every wire `DagNode` key must be classified.
 *
 * The builder splits a wire node into `id` + base fields + variant-specific
 * fields. Nothing previously checked that split against the ENGINE. When
 * `loop_group` (#2032), `include` (#2129), and `workflow` (#2169) landed — and
 * again when `settingSources` (#2216) and `pi` (#2144) were added to every node
 * — the builder kept compiling, kept its tests green, and silently degraded the
 * nodes it could not model.
 *
 * `variants/registry.test.ts` does not catch this: it only asserts the web
 * `VARIANTS` list still matches the hand-copied mirror in `@archon/core`. Both
 * lists can stay at seven forever while the engine grows.
 *
 * So: `UnclassifiedWireKey` resolves to `never` only when every key of
 * `WireDagNode` is accounted for. When the engine adds a field and someone runs
 * `bun generate:types`, this file stops compiling and names the offending key
 * in the error. The fix is a deliberate choice, not a silent default:
 *   - a field meaningful on ANY node kind  → add it to `WireBaseKey`
 *   - a field owned by one variant         → add it to that variant's `wireKeys`
 *   - a whole new node kind                → add its mode field to
 *     `UNSUPPORTED_MODE_FIELDS` (ships immediately as a read-only passthrough)
 *     and open an issue for a real editor
 *
 * This is a static assert only — it deliberately emits no runtime value, so it
 * costs nothing in the bundle. Runtime preservation is `BuilderNode.extra`'s
 * job; the two layers cover different failure windows (see that field's
 * docblock).
 */
import type { WireBaseKey } from './variant';
import type { WireDagNode } from './wire';

/**
 * Variant-specific wire keys, summed across every entry in `VARIANT_REGISTRY`.
 *
 * Hand-maintained rather than derived from the registry because the registry
 * imports the type layer — deriving it here would be a cycle. `registry.test.ts`
 * asserts this union equals the real union of `wireKeys`, so drift between the
 * two is a test failure rather than a silent hole in the assert below.
 */
export type VariantWireKey =
  | 'prompt'
  | 'command'
  | 'bash'
  | 'script'
  | 'runtime'
  | 'deps'
  | 'timeout'
  | 'loop'
  | 'approval'
  | 'cancel';

/**
 * Mode fields for engine node kinds the builder can represent but not EDIT.
 * Each imports as an `'unsupported'` node: rendered read-only, re-emitted
 * verbatim on save. Satellite fields (`with`, `input`, `isolation`, `fan_out`)
 * are listed too so they are classified rather than falling through.
 */
export type UnsupportedWireKey =
  | 'loop_group'
  | 'include'
  | 'with'
  | 'workflow'
  | 'input'
  | 'isolation'
  | 'fan_out';

/**
 * Any `WireDagNode` key the builder has not classified. MUST be `never`.
 * A non-`never` result means the engine grew a field this build would drop.
 */
export type UnclassifiedWireKey = Exclude<
  keyof WireDagNode,
  'id' | WireBaseKey | VariantWireKey | UnsupportedWireKey
>;

/**
 * Resolves to `true` when nothing is unclassified, otherwise to a marker object
 * whose `keys` member names the offending engine field(s).
 */
export type EveryWireKeyClassified = [UnclassifiedWireKey] extends [never]
  ? true
  : { ERROR: 'Unclassified wire DagNode key(s) — see wire-coverage.ts'; keys: UnclassifiedWireKey };

/**
 * Constraint-based assert: `T extends true` is what turns a regression into a
 * compile ERROR. A bare conditional type would merely resolve to the marker
 * object and compile clean, which is precisely the silent-drift failure this
 * file exists to prevent.
 */
type AssertTrue<T extends true> = T;

/**
 * THE TRIPWIRE. If this line errors, the compiler prints the marker object and
 * its `keys` member names exactly which engine field is unclassified. Do not
 * "fix" it by widening `UnsupportedWireKey` reflexively — classify the field per
 * the docblock at the top of this file.
 */
export type WireCoverageCheck = AssertTrue<EveryWireKeyClassified>;
