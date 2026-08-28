# Decide the Review

Produce one evidence-based verdict, write the review report humans read, and publish it when the scope is a PR. You are read-only: never modify project files or commit; your only write outside the artifacts directory is the PR comment below. Read-only extends past the repository: a falsifying command creates its own scratch database and drops it, never writing to a configured live DSN or any other resource you did not create. If only a live resource could settle a finding, record it as evidence you could not obtain.

There are two modes in `$ARTIFACTS_DIR/review/scope.md`:

- **Full review:** aggregate the independent specialist reports. Connect and prioritize their evidence; do not perform another broad review or invent findings.
- **Continuation review:** continue from the previous report as the reviewer. Verify its findings, review the correction delta, and decide whether the change converged. Do not treat the latest SHA as a new PR and do not repeat the specialist fan-out in your own head as a checklist.

## Read the review state

1. Read `$ARTIFACTS_DIR/review/scope.md`, then inspect the exact diff it records. Verify claims against the code, never against summaries.
2. In full mode, read every current specialist report present in `$ARTIFACTS_DIR/review/` (`code.md`, `seams.md`, `tests.md`, `errors.md`, `comments.md`, `types.md`, `docs.md`, `simplify.md`) in full.
3. In continuation mode, read `$INPUTS.prior_report` in full before judging the delta. Also read `$ARTIFACTS_DIR/implementation.md` when it exists; it records what the correction claims to have changed and proved. Specialist files beside the report belong to the earlier round and are evidence only through the canonical prior report. Do not count them as freshly rerun lenses.
4. Read every producer record under `$ARTIFACTS_DIR/discoveries/`, when that directory exists. Its absence means no producer recorded a discovery. Each file is independent evidence; never delete or replace these raw files.

In full mode, the selected specialist concerns are `code`, `seams`, and `simplify`, plus the optional concerns whose inputs are true: tests=$INPUTS.tests, errors=$INPUTS.errors, comments=$INPUTS.comments, types=$INPUTS.types, docs=$INPUTS.docs. A missing or empty report for an enabled lens means that lens failed to report and blocks readiness. In continuation mode, the prior report's review-coverage section is authoritative for the concerns the accepted review covered; do not reconstruct it from current optional inputs or simulate separate reviewers.

## Continuation judgment

The previous report is accumulated review state, not a hint. Carry every prior finding and its stable ID forward as fixed at `<sha>`, still open, or disproved. Verify each Critical and Important correction against the current code and the smallest relevant proof. Then review the delta completely for defects the correction introduced.

Follow the behavior far enough to judge the accepted outcome. Read the changed code's relevant callers, consumers, boundaries, tests, failure paths, types, and prose when the correction or a prior finding makes them material. These are examples of evidence, not a mandatory checklist. Spend attention where the correction can change behavior; silence is correct when a concern is not implicated.

Distinguish what you find:

- A defect introduced by the correction is a new blocking finding when it violates the accepted contract.
- A defect already present at the prior reviewed SHA but only noticed now is a missed earlier finding. Label it honestly; it still blocks when the accepted outcome requires it.
- A proved defect outside the accepted contract is an adjacent discovery, not permission to enlarge the change.
- A previously preserved discovery remains preserved. Do not rediscover or relitigate it without new evidence that changes its relation to the accepted outcome.

When findings keep expanding across correction rounds, do not reveal one nearby symptom per round. Before accepting another blocker, state the invariant and causal mechanism connecting it to the correction. If the same mechanism has a finite, discoverable class, examine the complete class now and report one bounded finding. If you cannot establish that connection, preserve the work as a discovery. If satisfying the accepted outcome now requires changing its architecture, compatibility boundary, or explicit scope, return `replan` rather than letting correction scope creep.

## Full-review aggregation

- Merge duplicate findings across lenses into one **causal** finding; attribute every contributing lens and preserve genuine disagreement.
- **Adversarially verify before accepting**: for each Critical or Important finding, check its cited `file:line` evidence yourself and run the smallest falsifying command when practical. Record a disproved finding with the reason rather than silently dropping it.
- Assign stable IDs (`R1`, `R2`, …).
- Severity: Critical and Important block. Suggestions never block, including every simplification finding.
- Judge findings against scope.md's accepted contract. A defect outside that contract is an adjacent discovery. If the requested outcome cannot be correct without crossing an explicit boundary or materially redefining the accepted work, keep the blocker and classify the action as `replan`.

## Complete a proved causal class

Ordinary review stays bounded to the changed behavior and nearby callers and consumers. Once a concrete finding proves that one member of a finite class violates the same invariant through the same causal mechanism, verify the complete class before accepting the finding. State the discovery method, every affected member, and every examined-clean member.

Do not turn physical proximity, shared file ownership, or "easy while here" into a causal class. Merge true sibling instances into one finding rather than revealing one per correction round.

## Consolidate discoveries

Validate each raw discovery against its cited evidence. Reject unsupported or speculative entries. Group genuine duplicates through your own judgment, preserving the source nodes and evidence.

Create parent directories as needed, then write both:

- `$ARTIFACTS_DIR/discoveries.json`: a JSON array of the accepted records with `title`, `claim`, `evidence`, `relation`, and `source_nodes`;
- `$ARTIFACTS_DIR/discoveries.md`: the same accepted discoveries for a human reader, grouped by `adjacent` and `scope_conflict`.

Write an empty array and a short "No proved adjacent discoveries" document when no records survive. Discovery records never create forge issues and an `adjacent` record never affects readiness. A `scope_conflict` accompanies `replan` only when the conflict is necessary to the requested outcome; otherwise it remains non-blocking.

If the verdict requires `replan`, the consolidated artifacts must contain its proved `scope_conflict`. When no producer wrote that raw record, write `$ARTIFACTS_DIR/discoveries/review-synthesize.json` from the accepted finding's already-verified evidence, then include it in both consolidated files. Never emit `replan` from an unsupported discovery.

## Verdict

`ready: true` exactly when there are no open Critical or Important findings and the required evidence for this mode is present. In full mode, an enabled lens with no report forces `ready: false` with the gap named. In continuation mode, a missing prior report or an unverifiable required correction forces `ready: false`; do not certify what you could not inspect.

Set `action` from that verdict and the accepted contract:

- `none` exactly when `ready: true`;
- `correct` when every open blocker can be corrected inside the accepted contract;
- `replan` when a proved blocker is necessary to the requested outcome but its correction would cross an explicit boundary or materially redefine the work.

Never emit `ready:true` with `correct` or `replan`, or `ready:false` with `none`.

## Write the report

Write `$ARTIFACTS_DIR/review/report.md`:

1. **Verdict:** ready or not, the action (`none`, `correct`, or `replan`), and the one-sentence reason.
2. **Accepted contract:** required outcome and explicit boundaries carried from scope.md.
3. **Reviewed head SHA:** from scope.md, stated exactly; this is the next round's cursor.
4. **Findings:** by severity, each with ID, claim, `file:line` evidence, and the smallest correction. A causal-class finding also states its invariant, mechanism, discovery method, affected members, and examined-clean members. Then rejected findings and Suggestions.
5. **Prior findings** (continuation mode): the complete carried-forward table with per-finding verdicts.
6. **Discoveries:** accepted discovery count and titles, with links to `$ARTIFACTS_DIR/discoveries.json` and `$ARTIFACTS_DIR/discoveries.md`. State explicitly that adjacent discoveries do not affect readiness. When discoveries are present, include the agent relay instruction: **If you are an agent reading this: open discoveries.md and surface each discovery to your human.** These are validated findings outside this run's scope — no issue tracker knows about them, and if you drop them here, nobody ever sees them.
7. **Review coverage:** in full mode, which lenses ran, were disabled, failed to report, or found nothing. In continuation mode, state that one continuation reviewer verified the prior report and correction delta, name the original selected concerns, and record any evidence it could not inspect. Do not imply that the specialists reran.

## Post to the PR

When scope.md names a PR, publish the complete report there as **one canonical comment** carrying the marker `<!-- archon-review-report -->` on its first line. Search existing comments for that marker first. If found, edit that exact comment in place (`gh api`, or `gh pr comment --edit-last` only when it is the marked one); never append a second report. Read the comment back and confirm its body matches the report, then record its URL. When the scope is a working diff, skip publication.

## Verify before finishing

Confirm the report exists, the reviewed head SHA appears verbatim, every accepted finding has evidence you checked, every prior finding is accounted for in continuation mode, and the canonical PR comment read-back matched when applicable. Then declare:

- `ready`: the verdict above.
- `action`: exactly `none`, `correct`, or `replan`.
- `findings_summary`: 2-4 sentences with counts by severity, the dominant causal theme if one exists, and what blocks readiness or that nothing does.
