# Node Reference

Mechanical reference: every node type, its fields, how nodes wire together, and
how to prove wiring with fixtures. For design judgment (gates, primitives,
prompting) read `authoring-workflows.md` in this folder first.

## Workflow-level fields

```yaml
name: my-workflow            # unique; user workflows may shadow bundled names
description: |
  What this does and when to use it. Shown by `archon workflow list`.
model: large                 # tier keyword (small|medium|large) or @alias — never a literal model id
inputs:                      # declared signature; callers pass via --input name=value
  work:
    default: ""
    description: What to implement; empty means the run's trigger message
returns: implement           # which node's output is the workflow's terminal output
outcome_field: green         # persist one authored boolean beside run status (e.g. green/ready/rooted)
interactive: false           # true REQUIRED if any approval gate exists (run can never be detached)
worktree:
  isolation: worktree        # explicit, always; never inferred. Bounds git files ONLY —
                             # not ~/.archon, env vars, database, or sessions
mutates_checkout: false      # declare when the workflow never touches the working tree
```

## The eight node types

Exactly one of these appears per node: `command`, `prompt`, `bash`, `script`,
`loop`, `loop_group`, `approval`, `cancel`.

### command / prompt — AI nodes

```yaml
- id: plan
  command: plan              # loads <workflow-folder>/commands/plan.md — prefer files over inline prose
  depends_on: [investigate]
```
```yaml
- id: classify
  prompt: "Classify: $ARGUMENTS. Output only BUG or FEATURE."
  allowed_tools: []          # no tools needed for pure judgment
  output_format:             # declare ONLY when a machine consumes a field (gate/until_field/script)
    type: object
    properties:
      type: { type: string, enum: [BUG, FEATURE] }
    required: [type]
```

Key fields on AI nodes: `model`/`provider` (tiers), `output_format` (+ `output_type`
for typed artifact sidecars), `allowed_tools`/`denied_tools`, `effort`/`thinking`,
`retry` (default 2x on transient), `persist_session`, `idle_timeout`.

### bash — deterministic shell, no AI

```yaml
- id: test-gate
  bash: bun run test
  timeout: 300000            # ms; stdout captured as $test-gate.output
```
Exit code decides pass/fail. One-or-two-line glue only; anything with branching
is a script node.

### script — TypeScript (bun) or Python (uv), no AI

```yaml
- id: verify-report
  script: verify-report      # loads <workflow-folder>/scripts/verify-report.py
  runtime: uv
  depends_on: [implement]
  with:                      # typed value transport into INPUTS_<UPPER_SNAKE> env vars
    green: "$implement.output.green"
    prior: {from: review.output, if_skipped: "none"}
```

Prefer named script files over inline bodies. Python (`runtime: uv`) preferred,
TypeScript (`runtime: bun`) fine. `deps:` adds uv dependencies.

### loop — iterate ONE AI job

```yaml
- id: implement
  loop:
    command: implement
    until_field: done        # boolean in this node's output_format
    max_iterations: 5
  depends_on: [record-start]
```

Completion channels — declare at least one, pick by tier:

- `until_bash: "<exit-0 check>"` — completion externally checkable (deterministic)
- `until_field: <bool>` — completion is the model's judgment, via `output_format`
- `until: TOKEN` — prose sentinel; interactive gates a human reads ONLY (deprecated elsewhere)

Also: `fresh_context: true` (each iteration starts clean), `$LOOP_PREV_OUTPUT`
and `$LOOP_PREV.<nodeId>.output` inside body prompts for previous-iteration state.
A failed iteration fails the loop at `max_iterations` — bound exhaustion fails
truthfully rather than blessing a bad last attempt.

### loop_group — repeat a sub-DAG

```yaml
- id: fix-cycle
  loop_group:
    nodes:
      - id: fix
        prompt: "Address findings: $review-findings.output"
      - id: recheck
        prompt: "Verify each finding is fixed with evidence."
        depends_on: [fix]
        output_format: {type: object, properties: {ready: {type: boolean}}, required: [ready]}
    until_bash: 'test "$recheck.output.ready" = "true"'
    max_iterations: 5
```

Body is sealed (no external `depends_on`); outer outputs reach bodies via
`$nodeId.output`; previous iteration via `$LOOP_PREV.<body-id>.output`. A failed
body node fails the group immediately.

### approval — human gate

```yaml
- id: review-gate
  approval:
    message: "Review before proceeding"
    capture_response: true   # user comment becomes $review-gate.output
    on_reject:
      prompt: "Revise based on: $REJECTION_REASON"
      max_attempts: 3
  depends_on: [plan]
```

Requires `interactive: true` at workflow level → can never run detached. Only
for interactive sessions or super load-bearing actions.

### cancel — terminate deliberately

```yaml
- id: refuse
  cancel: "Refusing: input flagged UNSAFE."
  when: "$classify.output != 'SAFE'"
```

## Wiring nodes together

**`depends_on`** creates edges; independent nodes in one topological layer run
concurrently.

**Data flow** — declared values carry scalars, artifacts carry documents:

- `$nodeId.output` — whole text of an upstream node; unknown/skipped producer → `''`
- `$nodeId.output.field` — strict JSON access: missing key **fails the consumer**
  (never silent-empty); declared-optional field resolves to `''`
- `with:` bindings (#2637) — typed values into scripts/commands as
  `INPUTS_<UPPER_SNAKE>` env vars; `{from, if_skipped}` discriminates skipped
  producers from ran ones; a failed producer fails the binding
- `$INPUTS.<name>` — declared workflow inputs, also delivered as
  `INPUTS_<UPPER_SNAKE>` to bash/script
- `$ARTIFACTS_DIR` — pre-created directory for reports/evidence humans read
- In bash/script sources, user-controlled values arrive as ENV VARS
  (`ARGUMENTS`, `INPUTS_*`, ...) — never text-substituted (injection guard).
  `$nodeId.output` refs ARE substituted; give prose producers an `output_format`
  before assigning their output directly in a script.

**`when:` conditions** skip a node when false (skipped propagates to dependants):

```yaml
when: "$classify.output == 'BUG'"
when: "$score.output.confidence >= '0.9' && $gate.output.proceed == true"
```

Operators: `==`, `!=`, `<`, `>`, `<=`, `>=` (numbers auto-parse, fail-closed on
non-numeric), compound with `&&`/`||` (`&&` binds tighter, no parentheses).
Malformed expression → node skipped + warning. Dot-access contract violation →
node FAILS loudly. Guard optional paths with `when:` or `trigger_rule`.

**`trigger_rule`** — join semantics over dependencies:

| Value | Behavior |
|-------|----------|
| `all_success` | all deps succeeded (default) |
| `one_success` | at least one dep succeeded |
| `none_failed_min_one_success` | none failed AND ≥1 succeeded (skips OK) |
| `all_done` | all deps terminal (completed, failed, OR skipped) |

## Fixtures — prove wiring without AI spend

Every authored workflow ships dry-run fixtures in
`<workflow-folder>/fixtures/<name>.stubs.yaml`:

```yaml
# Declared expectations + node stubs. Every non-reserved key is a node output.
fixture:
  expect: completed          # or failed / paused / cancelled
  fail-node: assert-changed  # required when expect: failed — must match exactly
inputs:
  branch: task-42
implement:
  done: true
  green: true
  summary: "stub summary"
exec-code: false             # true executes bash/script nodes for real (clean tree!)
```

Run them:

```bash
archon workflow test                    # everything discovered
archon workflow test my-workflow        # one workflow's fixtures
```

Expected-red fixtures are the important ones: a guard that has never been seen
failing proves nothing. Prove reds red on a CLEAN tree — uncommitted edits
outside `.archon/` make deterministic change-detectors pass and turn your red
path green. Validate load-time errors with `archon workflow list`.
