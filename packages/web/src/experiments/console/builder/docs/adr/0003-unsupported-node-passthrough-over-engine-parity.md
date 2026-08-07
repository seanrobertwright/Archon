# Unsupported nodes pass through read-only, rather than the builder chasing engine parity

**Status:** accepted

The engine's `dagNodeSchema` has ten mode fields; the builder models seven. `loop_group` (#2032),
`include` (#2129), and `workflow` (#2169, with `fan_out` #2224 / `isolation` #2223 / `with`) landed
after the builder's variant registry was written, and nothing noticed. `settingSources` (#2216),
`pi` (#2144), and node-level `description` were likewise never classified as base fields.

We decided the builder **preserves what it cannot model** instead of trying to stay at parity with
the engine's node surface. An unmodelled node kind imports as a read-only `'unsupported'` variant
whose entire wire fragment rides on `BuilderNode.extra` and is re-emitted verbatim on export. The
builder is forward-compatible **by construction** rather than by vigilance: a node kind added
tomorrow degrades to "visible, wired into the DAG, not editable here" instead of to data loss.

## Why not the alternatives

**Build editors for all ten kinds.** Rejected as the primary fix, not permanently. `loop_group`
carries a sealed sub-DAG with its own `$LOOP_PREV` scoping; `workflow` carries fan-out join
semantics and per-child isolation. Those are real design surfaces, and none of that work removes
the need for a passthrough — the eleventh node kind would reopen the same hole. Editors can land
later per kind; each one simply moves an entry out of `UNSUPPORTED_MODE_FIELDS`.

**Block the save instead.** Rejected. It is what the old behavior effectively did, and it was worse
than it looked: unsupported nodes became `{prompt:'', id}` and the save was blocked by "prompt must
not be empty" — so the natural fix (type a prompt) destroyed the node. Blocking also strands every
workflow containing a node kind the build predates, which on this repo was three shipped defaults.

**Trust the compile-time assert alone.** Insufficient. `types/wire-coverage.ts` only fires once
`api.generated.d.ts` has been regenerated, so a client running against a newer server is exactly
the case it cannot see. `extra` is the runtime half; the two cover different windows.

## Consequences

- `VariantId` splits into `CreatableVariantId` (the seven — palette, drag-drop, Copilot `addNode`)
  and the full representable union. `'unsupported'` cannot be authored, only imported.
- `WorkflowNodeKind` (the console primitive shared with the run-graph renderer) is deliberately
  NOT widened. Its `kindGlyph` switch is exhaustive, and a run graph renders the engine's own
  expanded DAG, where an unsupported node never appears.
- Base fields are still partitioned normally on an unsupported node, so `depends_on` stays visible
  to graph validation and the canvas draws its edges. Only the mode payload is opaque.
- Unsupported nodes are reported as **warnings**, not errors. They round-trip perfectly, and
  `blockingErrors()` filters severity `'error'` — flagging them as errors would reintroduce the
  unfixable save gate this ADR exists to remove. A genuinely malformed node (no recognizable mode
  field) stays an error.
- The Copilot rejects `setField` on an unsupported node's `data.*`. Accepting it would render a
  changed ghost and report success for an edit that vanishes on save. `base.*` stays allowed so
  `connect` can still rewire the graph.
- The YAML preview renders preserved nested payloads (a `loop_group` body) with cosmetically loose
  indentation. It parses back correctly, and the preview is display-only — saves send JSON and the
  server serializes — so this is a known wart, not a correctness issue.

## Keeping it honest

Three guards, because each fails in a different way:

1. `types/wire-coverage.ts` — compile-time assert that every `DagNode` key is classified. Uses a
   constraint-based `AssertTrue<T extends true>`; a bare conditional type resolves silently, which
   would be an assert that never fires.
2. `BuilderNode.extra` — runtime preservation, covering the stale-generated-types window.
3. `model/corpus.test.ts` — round-trips every shipped default. Asserts a superset rather than
   equality, since the builder legitimately adds engine defaults on modelled variants; what must
   never happen is a key disappearing.

Note that `variants/registry.test.ts` does **not** cover this axis and never did — it only asserts
the web `VARIANTS` list matches the hand-copied mirror in `@archon/core`. Both lists could sit at
seven forever while the engine grew, which is precisely how this drift went unnoticed.
