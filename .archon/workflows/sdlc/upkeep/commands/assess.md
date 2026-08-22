# Assess a dependency update

Ground one dependency-update request against this repository as it exists right now, and decide whether an update is actually owed. You produce an assessment and a verdict; you change nothing.

You know nothing beyond this repository's checkout and the request below. You have no memory of previous runs, no knowledge of what this project's maintainers usually do, and no awareness of updates you may have assessed before. Everything you claim must be derived from files in this checkout, the project's own tooling, or the request itself — and your assessment must cite where each fact came from.

## The request

$INPUTS.target

If the block above is empty, the request is the message that started this run:

$ARGUMENTS

It may name a dependency, a version, a security advisory, or a general ask ("update sharp", "address the undici advisory", "get X off the vulnerable range"). A bare issue or PR reference in the request resolves against THIS repository's tracker unless the request says otherwise — read it there first; upstream projects' trackers are secondary sources for upstream facts only.

## How to assess

1. **Find the dependency in this repository.** Discover the package manager and manifest layout from the repository itself — lockfiles, manifest files, workspace configuration. Never assume a manager the repo does not show. Record: every manifest that declares the target, the declared constraint, and the exact locked version currently installed.
2. **Establish what "current" would mean.** Use the project's own tooling to learn the latest applicable version (registry info commands, the lockfile's metadata, a vendored changelog). If the environment cannot tell you, say so — name the exact command that failed or the information that is unavailable. Never guess a version number.
3. **Map the blast radius.** Find where the dependency is imported or configured in this repo. Read the upstream changelog or release notes between the locked and target versions if they are reachable (in the installed package, via the manager's tooling). List the breaking changes that touch code paths this repo actually uses — not every change upstream shipped.
4. **Check the constraint reality.** Does the declared range already admit the target version, or does the manifest need editing? Do peer/engine requirements or sibling dependencies pin it? A constraint that forbids the target is a finding, not a dead end — the assessment says what must change and what that risks.
5. **Check for duplicate copies.** A transitive, optional, or peer occurrence of the target elsewhere in the tree can keep the old version installed even after the direct bump — package managers do not always dedupe them. When the request's goal (an advisory, a version floor) requires those copies to move too, the update order must prescribe the exact mechanism this manager supports (an override or resolution entry, named precisely) and state which third-party pin it forces. When forcing that pin is a risk call the request did not clearly authorize, return `no_action` naming that decision instead of leaving the implementer an acceptance criterion the prescribed steps cannot meet. Prefer the manager's declared resolution mechanism — an override or resolution entry — over emergent tricks like adding a root dependency nothing imports: a declared constraint survives resolver changes and fails loudly, while an emergent dedupe can silently regress. Always name the third-party range the override forces; forcing a dependent past a major boundary is a human decision to surface, not one to make. Verify the mechanism against the project's pinned manager version — `engines`, CI pins, the lockfile format — because a form the pinned version ignores with a warning is not a mechanism. When the primary mechanism's support cannot be proven from this checkout alone, the update order must also name one authorized fallback with its blast radius (for example, a top-level override — stating every consumer it moves and whether each stays inside its declared range — when the scoped form may be unsupported), so the implementer is never stranded between a falsified primary and an unauthorized improvisation.
6. **Decide.** `update` when a concrete, currently-applicable newer version exists and the request calls for it. `no_action` when the repo is already current, the request does not apply here (the dependency is absent, the advisory concerns a version this repo never ships), or the update is impossible without a decision that belongs to a human (a major-version migration the request did not authorize, a fork-or-replace choice). State the reason plainly.

## Not your job

Do not edit any file, install anything, or touch the lockfile — this assessment is advisory and a guard verifies the tree is byte-identical after you finish. Do not perform the update. Do not open issues or PRs. Do not assess unrelated outdated dependencies you notice — note them in one line under "Also seen" and move on.

## Stop rules

If the request is ambiguous between several dependencies, present the candidates in the assessment and return `no_action` with the ambiguity as the reason — never pick one silently. If you cannot establish the locked version or the target version from this environment, say exactly what is missing and return `no_action`.

## Assessment artifact

Write `$ARTIFACTS_DIR/upkeep-assessment.md`:

- **Target**: dependency, locked version → proposed version, and the manifests involved.
- **Why / why not**: the request's motivation checked against reality (advisory applies / already fixed / not present).
- **Blast radius**: usage sites in this repo; breaking changes between the versions that touch them; peer or engine constraints.
- **Update order**: the exact steps the implementer should take — manifest edits if the constraint needs widening, the manager-native update command, code changes the breaking changes force, and what must be validated to call it green.
- **Also seen** (only if applicable): one line per unrelated observation.

Sections that do not apply are omitted, never filled with "N/A".

## Declare (every turn)

Before declaring, re-read your assessment against the checkout: every version number and file path in it must be verifiable, and the update order must be executable by someone who has read nothing but that file.

- `action` — `update` or `no_action`
- `summary` — two or three sentences: what you found and why the action follows
