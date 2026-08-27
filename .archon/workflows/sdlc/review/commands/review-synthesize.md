# Synthesize the Review

Aggregate the lens reports into one evidence-based verdict, write the review report humans read, and — when the scope is a PR — publish it there. Synthesis connects and prioritizes reviewer evidence — it does not perform another review, invent findings, or raise severity without evidence. Never modify project files or commit; your only write outside the artifacts directory is the PR comment below.

## Read — the findings reach you complete

1. `$ARTIFACTS_DIR/review/scope.md` — the target, mode, and the **head SHA under review** — and then **the diff itself**, using the commands scope.md records. You verify findings against the code, never against summaries.
2. Every lens report present in `$ARTIFACTS_DIR/review/` (`code.md`, `seams.md`, `tests.md`, `errors.md`, `comments.md`, `types.md`, `docs.md`, `simplify.md`) — read each **in full**. These files are the findings channel and nothing is truncated at this seam; the structured fields you emit at the end are only the loop signal, not the findings.
3. Every producer record under `$ARTIFACTS_DIR/discoveries/`, when that directory exists. Its absence means no producer recorded a discovery. Each file is independent evidence from one node; never delete or replace these raw files.

The lenses ENABLED this round: `code`, `seams`, and `simplify` always, plus the optional lenses whose input is true — tests=$INPUTS.tests, errors=$INPUTS.errors, comments=$INPUTS.comments, types=$INPUTS.types, docs=$INPUTS.docs. A missing file for a DISABLED lens is by design — record it as disabled, never as clean. A missing or empty file for an ENABLED lens means that lens **failed to report**: the review is missing evidence it was asked for — record the gap and apply the verdict rule below.

## Aggregate

- Merge duplicate findings across lenses into one **causal** finding; attribute every contributing lens; preserve genuine disagreement rather than averaging it away.
- **Adversarially verify before accepting**: for each Critical or Important finding, check its cited `file:line` evidence yourself (read the file, run the smallest falsifying command when practical). A finding whose evidence does not hold is recorded as rejected with the reason — not silently dropped.
- Assign stable IDs (`R1`, `R2`, …). In light mode, keep the prior report's IDs for the same causal finding, allocate new IDs after the prior maximum, and carry every prior finding forward with its verdict: still open, fixed at `<sha>`, or disproved — **never make an earlier finding disappear**.
- Severity: Critical and Important block; **Suggestions never block, including every simplify finding.**
- Judge accepted findings against scope.md's accepted contract. A defect outside that contract is an adjacent discovery, not permission to enlarge the pull request. If the requested outcome itself cannot be correct without crossing an explicit boundary or materially redefining the accepted work, keep the blocker and classify the action as `replan`.

## Complete a proved causal class

Ordinary review stays bounded to the changed behavior and nearby callers and consumers. Once a concrete finding proves that one member of a finite class violates the same invariant, verify the complete class before accepting the finding. The causal finding must state:

- the defining invariant and the deterministic discovery method used to enumerate the class;
- every affected member;
- every examined-clean member.

Do not turn this into an unrelated audit. Merge sibling instances into that one causal finding rather than revealing one per correction round.

## Consolidate discoveries

Validate each raw discovery against its cited evidence. Reject unsupported or speculative entries. Group genuine duplicates through your own judgment, preserving the source nodes and evidence.

Create parent directories as needed, then write both:

- `$ARTIFACTS_DIR/discoveries.json` — a JSON array of the accepted records with `title`, `claim`, `evidence`, `relation`, and `source_nodes`;
- `$ARTIFACTS_DIR/discoveries.md` — the same accepted discoveries for a human reader, grouped by `adjacent` and `scope_conflict`.

Write an empty array and a short "No proved adjacent discoveries" document when no records survive. Discovery records never create forge issues and an `adjacent` record never affects readiness. A `scope_conflict` accompanies `replan` only when the conflict is necessary to the requested outcome; otherwise it remains a non-blocking discovery.

If the verdict requires `replan`, the consolidated artifacts must contain its proved `scope_conflict`. When the accepting lens failed to write that raw record, write `$ARTIFACTS_DIR/discoveries/review-synthesize.json` from the accepted finding's already-verified evidence, then include it in both consolidated files. Never emit `replan` from an unsupported discovery.

## Verdict

`ready: true` exactly when there are **no open Critical or Important findings AND every enabled lens delivered its report**. An enabled lens with no report forces `ready: false` with the gap named — a review missing evidence it was asked for can refuse readiness, never certify it. "Nothing left to say" is not the bar — open Suggestions do not hold `ready` back, and a round that ran fewer lenses says so rather than implying a fuller clearance.

Set `action` from that verdict and the accepted contract:

- `none` exactly when `ready: true`;
- `correct` when every open blocker can be corrected inside the accepted contract;
- `replan` when a proved blocker is necessary to the requested outcome but its correction would cross an explicit boundary or materially redefine the work.

Never emit `ready:true` with `correct` or `replan`, or `ready:false` with `none`.

## Write the report

Write `$ARTIFACTS_DIR/review/report.md`:

1. **Verdict** — ready or not, the action (`none`, `correct`, or `replan`), and the one-sentence reason.
2. **Accepted contract** — required outcome and explicit boundaries carried from scope.md.
3. **Reviewed head SHA** — from scope.md, stated exactly (this is the next round's cursor).
4. **Findings** — by severity, each with ID, claim, `file:line` evidence, and the smallest correction; causal-class findings also include their discovery method, affected members, and examined-clean members. Then rejected findings with the disproving evidence; then Suggestions.
5. **Prior findings** (light mode) — the full carried-forward table with per-finding verdicts.
6. **Discoveries** — accepted discovery count and titles, with links to `$ARTIFACTS_DIR/discoveries.json` and `$ARTIFACTS_DIR/discoveries.md`. State explicitly that adjacent discoveries do not affect readiness.
7. **Lens roster** — which lenses ran, were disabled, failed to report, or found nothing. A lens that failed to report gets an explicit directive: it must run **in full** next round, not in delta mode — the next round's reviewers read this report first.

## Post to the PR

When scope.md names a PR: publish the complete report there as **one canonical comment** carrying the marker `<!-- archon-review-report -->` on its first line. Search the PR's existing comments for that marker first — if found, **edit that exact comment in place** (`gh api` / `gh pr comment --edit-last` only when it is the marked one); never append a second report. Then read the comment back and confirm its body matches what you wrote; record its URL in the report. Publication is not done until the read-back agrees. When the scope is the working diff (no PR), skip this section — the artifact report is the deliverable.

## Verify before finishing

Confirm the report exists, every lens file present is accounted for in the roster, the head SHA appears verbatim, every finding you accepted has evidence you actually checked, and — for a PR scope — the canonical comment read-back matched. Then declare:

- `ready` — the verdict as defined above.
- `action` — exactly `none`, `correct`, or `replan` under the rules above.
- `findings_summary` — 2-4 sentences: counts by severity, the dominant theme if one exists, and what blocks readiness (or that nothing does).
