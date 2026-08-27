# Review Scope

Establish exactly what this review round examines, and write it down for the lens reviewers. You do not judge anything — you make the target precise.

## Inputs

**Requested scope** (may be empty):

$INPUTS.scope

**Previous round's report** (path; empty — or a path that does not exist yet — means this is the first round, full review):

$INPUTS.prior_report

**Accepted work order** (may be empty for a standalone review):

$INPUTS.work_order

The run's trigger message, which may narrow or override the above:

$ARGUMENTS

## Resolve the target

- A PR number, URL, or branch → resolve it with `gh pr view` (title, body, base, head, state, files) and `gh pr diff`. Make sure the PR's head is what the local checkout reflects; note the head SHA. **In PR mode the review object is the PR's diff, exactly — uncommitted or untracked local state is out of scope and must not appear in the scope file.**
- Empty scope → first check whether the current branch has an open PR (`gh pr view`); if it does, that PR is the target (PR mode, as above). Otherwise the working diff: uncommitted changes plus commits ahead of the merge-base with the default/base branch (`git merge-base`, `git diff`, `git log`). Note the current HEAD SHA.

## Resolve the accepted contract

- When `work_order` is non-empty, read it in full. It is the accepted contract implementation received. Preserve its required outcome, explicit non-goals, and boundaries as prose; do not parse it with scripts, regexes, or keyword extraction.
- When `work_order` is empty and the target is a PR, use the PR body's problem/outcome and explicit scope or non-goals as the standalone review contract. Do not infer a broader promise from the changed files.
- When neither supplies an explicit boundary, state that the review is using the requested scope and repository contracts without inventing a non-goal.

## Light mode (a prior report exists)

Read the prior report. Extract its **reviewed-head cursor** (the SHA it records) and its findings list. This round's diff is **only the delta**: `git diff <cursor>..HEAD` plus any uncommitted changes. List each prior finding with its ID and status so lens reviewers verify those first instead of re-discovering the whole change.

## Write the scope file

Write `$ARTIFACTS_DIR/review/scope.md` containing:

1. **Accepted contract** — the required outcome, followed by explicit non-goals or boundaries. State the source: supplied work order, PR body, or requested scope/repository contracts.
2. **Target** — PR reference or "working diff", base branch, and the **head SHA under review** (this becomes the next round's cursor).
3. **Mode** — full review, or light (delta since `<cursor>`).
4. **Changed files** — path list with a one-line shape of the change per file (added/modified/deleted, rough size).
5. **The diff to review** — inline when small; for a large diff, the exact commands a reviewer runs to see it (`git diff <range>`, `gh pr diff <n>`).
6. **Prior findings to verify** — light mode only: ID, severity, one-line claim, and the file it points at.

## Verify before finishing

Confirm `$ARTIFACTS_DIR/review/scope.md` exists, names the accepted contract and head SHA, and that the diff commands in it actually produce output in this checkout. Reply with the target, mode, head SHA, and file count — nothing else.
