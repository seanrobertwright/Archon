---
name: archon-cli-manage-run
description: Inspect, control, and resolve Archon workflow runs: list/get/status, approve, reject, respond, cancel vs abandon, resume. Read when a run is paused, failed, or the user asks about one.
---

# Managing Runs

Every run-control verb, what it actually does, and the gate semantics that are
easy to get wrong. All commands scope to the current project by cwd.

## Output contract

- `--json` → one clean JSON object on stdout; logs suppressed. Use when parsing.
- No flag → human-readable text; diagnostics on stderr.

## Overriding models for one run

When the user asks to run on different models for a specific run, rebind the
tier keywords or aliases at launch — the persistent config stays untouched:

```bash
# Rebind one or more tiers / @aliases for this run only; repeat per binding
archon workflow run archon-fix --branch fix/x "..." \
  --model large=pi/minimax/minimax-m3 \
  --model small=openai/gpt-5-mini
```

Spec format: `<tier|@alias>=<provider>/<model-ref>` where `<model-ref>` is what
the named provider expects (for Pi backends that is itself a `<vendor>/<model>
ref, e.g. `pi/minimax/minimax-m3`). An unknown tier/alias errors with the list
of defined names.

Verify before dispatching real work:

```bash
# dry-run prints each node's resolved provider/model without AI spend
archon workflow run <workflow> "test" --dry-run --model large=...   # see 'runs on:' lines
```

For reusable alternate setups, prefer a config layer instead of long flag lists
(see `../setup-and-config/setup-and-config.md`, "Alternate config layers").

## Verbs

| Goal | Command |
|---|---|
| List recent runs (this project) | `archon workflow runs --json` |
| Across all projects | `archon workflow runs --all --json` |
| Filter by status / cap rows | `archon workflow runs --status running --limit 50 --json` |
| One run's status/error | `archon workflow get <run-id> --json` |
| One run with per-node detail | `archon workflow get <run-id> --verbose --json` |
| Active runs only | `archon workflow status --json` |
| Resolve a gate with any declared decision | `archon workflow respond <run-id> <decision> [text]` |
| Approve (default vocabulary) | `archon workflow approve <run-id> [text]` |
| Reject (default vocabulary) | `archon workflow reject <run-id> "<reason>"` |
| Stop a live detached run | `archon workflow cancel <run-id>` |
| Mark paused/orphaned run cancelled (state only) | `archon workflow abandon <run-id>` |
| Resume failed/paused from completed nodes | `archon workflow resume <run-id>` |

## The approve/resume two-step

With `--json`, `approve`/`reject`/`respond` **record the decision and stop** —
the run becomes resumable but does not execute (streaming output would corrupt
the JSON). To record AND continue:

```bash
archon workflow approve <run-id> "ship it"   # no --json: records + auto-resumes; background task!
```

Or deliberately in two steps:

```bash
archon workflow approve <run-id> "ship it" --json   # recorded, resumable: true
archon workflow resume <run-id>                     # executes; background task
```

## Interactive-loop gates: comment or no comment is a decision

Read the gate state first:

```bash
archon workflow get <run-id> --json | jq .metadata.approval.completionSignaled
```

- `true` and you approve **without** a comment → accept & complete: the node
  finalizes from its already-computed output, no re-run.
- You approve **with** a comment → another full iteration runs using your text
  as feedback.
- Reject always needs a reason; it becomes `$REJECTION_REASON` for rework nodes.

Choose deliberately after reading what the gate produced — not by reflex.

## Cancel vs abandon

- `cancel` actively stops a live CLI-detached owner: it verifies the process tree
  is gone before recording `cancelled`. Use this to kill real work.
- `abandon` is state-only: for runs already paused, or after you have independently
  verified a "running" row is orphaned (crashed host). It never kills anything.

## Respond: gates beyond approve/reject

Some gates declare decisions beyond the default pair (`respond <run-id> <decision>
[text]`). Read the run's metadata to see which decisions its gates declare before
guessing one.

## Judging a finished run

Terminal ≠ good. From `get --verbose --json`, read:

- per-node states (what actually ran vs was skipped),
- declared outcome fields wherever the workflow declares an `outcome_field:`
  (sdlc pack uses `green`, `ready`, `rooted`; any workflow may declare its own),
- the report artifact path in metadata — read it before reporting to the user.

Report outcomes with their evidence: "completed, review verdict ready:false —
2 findings remain, report at <path>" beats "done".

## When a run looks wrong

- Paused unexpectedly → `get --verbose`; look at the failing node's error and the
  gate metadata.
- Failed mid-flight → fix the cause if you can name it, then `resume <run-id>`
  (background task). Resume skips completed nodes.
- A "running" row with nothing alive → verify the process is truly gone, then
  `abandon`.
- Logs live under `~/.archon/workspaces/<project>/logs/`; artifacts under
  `.../artifacts/runs/<run-id>/`. `archon doctor` checks the installation itself.
