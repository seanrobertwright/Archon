# Archon engineering craft

This document is what work gets checked against, not instructions for doing work. Operational rules for agents stay in `AGENTS.md`, which every agent loads and which stays short. This document is loaded selectively by evaluative agents: the review orchestrator, review lenses, and future evaluators such as the questioner and gate-designer patterns. It can afford depth because only evaluators carry it.

## How this document works

- The operator writes it. Agents may propose entries as artifacts from real runs; promotion into this file is always an operator edit. An evaluator that revises its own criteria is not calibrating, it is drifting.
- Anything here that becomes machine-checkable graduates to a lint rule, a type, or a CI check, and then leaves this file. One owner per rule. This file holds what needs judgment; checkers hold what needs enforcement.
- Entries are phrased so drift is catchable: prefer claims that can be audited against the codebase over vibes. A periodic pass grades entries confirmed or drifted. Drifted entries are deleted, not annotated; a stale correction is worse than none.
- Facts that change (counts, paths, inventories) do not belong here at all. Point at the owning source.

## The objective function

Correct first. Cost-efficient second. Speed last.

Speed is a convenience for the operator while working, never a reason to thin verification. A review that is fast and wrong failed. Spend more on changes that can destroy things and less on changes that cannot; a flat cost per change is a sign nobody is judging stakes.

## Aspirations

**The survival shape.** The tools that survive the agentic era, above all tools for engineers and their agents, have a small strong core and extend at the seams. Agents multiply how fast everything around a tool changes: providers, models, harnesses, and integrations churn monthly, and no monolith keeps up by adding surface. It keeps up by owning less, harder. The core must be usable from any surface: our CLI, our server, someone else's product, a script in CI. Users build their own surfaces, providers, adapters, and isolation backends at their own convenience, against contracts we keep stable. That is why the engine becomes an SDK. The SDK is not a packaging decision; it is the survival shape of the product.

The review test this yields: when a change grows the core, ask whether a seam could have carried it. Core growth that a plugin, adapter, or host could express is a finding, not a feature.

These describe where the engineering is going. Do not reject a change for failing to complete an aspiration; reject new coupling that makes one materially harder.

- **The core becomes self-sufficient.** The engine stands alone as an SDK: define, validate, run, resume, govern, and query workflows with no server, no UI, no database, no platform adapter required. Core plus CLI is a complete install. Append-only files are the default persistence; a database is an adapter.
- **Adapters and providers sit behind clear contracts.** A provider or platform integration attaches through a typed seam the engine owns. If adding an integration requires touching engine control flow, the contract is missing or wrong.
- **Provider SDKs are for observability and for running the user's configuration.** They translate options, surface events and usage truthfully, and preserve the user's native config, auth, and guidance. They are not a place for engine logic, capability widening, or config replacement.
- **Every engine capability has a host seam.** Wakes, schedules, triggers, and cleanup are core surfaces a CLI, server loop, or third-party host can drive. The server is a batteries-included host, not the owner.

## Taste

- The smallest truthful system. Every validator, guard, state, and compatibility path protects a named requirement or a concrete failure mode. Before adding machinery, look for machinery to delete.
- Types carry invariants. Invalid states should be hard to represent; a sound type beats a runtime check beats a comment. Escape hatches carry a justification or they are findings.
- Explicit control flow over meta-programming, shared mutable state, or hidden coupling. Duplicate small local logic until a pattern has repeated and stabilized.
- Fail early and loudly on unsupported, ambiguous, or unsafe states. A fallback is intentional, documented at the branch, and observable, or it is a bug.
- Comments clarify functionality and how code is used, and they stay current when behavior changes. Never request a comment on self-explanatory code; request removal or editing of comments on self-explanatory code instead. Code that is not self-explanatory is usually too complex and the finding is simplification, not narration. A missing comment is reportable only when the change introduces durable knowledge that code or types cannot express: a surprising external constraint, a non-obvious safety or ordering requirement, a deliberate compatibility compromise a future maintainer could clean up and break, or operational behavior not discoverable from the local code. Never request narration of control flow, parameter names, or implementation steps.

## Risk taxonomy

What raises the stakes of a change, and therefore the depth of its review:

- Irreversible or destructive paths: deletion, force operations, terminal state transitions, anything that touches user-owned estate.
- Lifecycle ownership: code that decides whether work is alive, dead, resumable, or abandoned.
- Schema and persisted contracts: identifiers, wire values, additive-only evolution.
- Credentials and auth boundaries.
- Provider and adapter boundaries: native config preservation, capability scoping.
- Concurrency and shared estate: worktrees, sessions, leases.

A change in these areas gets adversarial review depth: an explicit attempt to refute, input-set variation, and a stated answer to "what would make this merge wrong." A docs or prose change gets the minimum. The review orchestrator's depth signal derives from this list, and so do the pre-triage script's path weights; this section is their single source.

## Case law

Proven rules from real failures. Each entry states the rule, then the mechanism that made it necessary. Origins are dated in prose; this file does not index by tracker numbers.

1. **Status sets near destructive actions are derived, never enumerated, and tests vary them.** A cleanup path defined "live" as "non-terminal" while the codebase's own vocabulary made failed runs resumable; the sweep would have force-deleted recoverable branches. Two review rounds missed it because every test stubbed the deciding primitive and no test varied the status set. Rule: derive such sets from the owning vocabulary so a new status inherits safety automatically; in tests, exercise the real primitive and vary the one input the decision turns on. (Proven live, August 2026, isolation cleanup.)
2. **The work order outranks the implementation's account of itself.** An implementation narrowed a contract, its PR body described the narrowed version, and review verified the narrowed claims instead of the requested outcome. Rule: review anchors on the original request; the implementor's self-report is a file of claims to verify, never a scope definition. (Proven live, August 2026, fixture isolation.)
3. **Same function, same invariant: in scope.** A review filed a regression inside the exact function the change rewrote as an out-of-scope discovery. Rule: a defect that violates the same invariant through the same mechanism as the change under review is a correction, not a discovery, no matter how the implementation frames it. (Proven live, August 2026, fixture targeting.)
4. **A guard is evidence only once seen red.** Cleanup retries via built-in options shipped twice as fixes while the runtime silently ignored those options; the pattern read as safety and did nothing. Rule: before trusting any guard, watch it fail against the condition it claims to catch; a probe beats a documented promise. (Proven live, August 2026, the runtime retry options.)
5. **Green plus green can be red.** Two individually green changes composed into a runtime failure because no check ever ran on the composition, and the file class involved was invisible to both static gates. Rule: compositions need their own verification, and "the checks passed" is a claim about what the checks cover, not about the code. (Proven live, August 2026, the parallel-merge break.)
6. **Suppressing inherited state requires an explicit presence, not an absence.** Deleting an environment key from a child process's env did nothing because the child reloaded it from its own configuration files; only an explicitly present empty value suppressed it. Rule: when isolating a boundary, prove the isolation against every path in, not the one you thought of. (Proven live, August 2026, the test sandbox env.)

## Review posture

- An unengaged risk is a failure. If the orchestrator names a risk and no lens engages it, the review is not clean, it is incomplete, and the verdict must say so.
- "Could not tell" is a verdict. Ambiguity, lens disagreement, and low confidence produce an inconclusive outcome for a human, never a silent pass and never a manufactured correction.
- A malformed or failed verdict call defaults conservative: toward not-ready, never toward pass.
- Findings and discoveries carry their source. Attribution is what makes calibration possible; an unattributed finding cannot teach anything.
