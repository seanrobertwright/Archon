# Builder Copilot reuses the console chat via a native tool (Claude/Pi-first)

**Status:** accepted

PR-5 adds an AI copilot to the builder that proposes workflow edits and previews them on the
canvas. We decided the copilot **reuses the existing console chat** (conversation + messages DB
persistence, `ChatStream`/`ChatComposer` UI, SSE streaming, multi-turn) rather than a dedicated
endpoint. The structured edits travel through a new in-process **native tool**,
`propose_workflow_edits(ops)` — a direct sibling of `manage_run`
(`packages/core/src/orchestrator/manage-run-tool.ts`). The builder client reads the tool call off
the SSE stream and renders an atomic preview (ghost nodes / dashed edges) that the user Accepts or
Rejects; Accept applies the ops through the PR-2 `editorReducer`, so undo/redo + validation come for
free.

## Why this shape

- The general chat already exposes bash + is subject to prompt injection; a "constrained agent for
  safety" buys nothing new here, so it isn't worth a separate endpoint on safety grounds.
- `manage_run` already proves the pattern: an in-process native tool injected into project-scoped
  chat for native-tool providers, surfaced into Archon's own stream where the client can act on it.

## The accepted tradeoff: Claude/Pi-first

The ops channel is a **native tool call**, and `nativeTools` is `true` only for **Claude and Pi**
(`packages/providers/src/*/capabilities.ts`). On Codex / OpenCode / Copilot the copilot can still
converse but **cannot drive the canvas**. This is narrower than the rejected dedicated-endpoint
design would have been: Codex and OpenCode have `structuredOutput: 'enforced'`, so a one-shot
structured-output endpoint could have brought them in. We accept Claude/Pi-first because reuse
eliminates an endpoint, a persistence decision, and a parallel chat UI — and the canvas door to
Codex/OpenCode stays open via the structured-output path if it's ever wanted.

## Required plumbing (reuse is not literally free)

- A **builder-mode conversation** flag so the orchestrator injects `propose_workflow_edits` ONLY for
  builder chats (not Slack/CLI/ordinary project chats), mirroring `manage_run`'s gating.
- The **live, possibly-unsaved canvas state** must be fed to the agent each turn (the console chat
  normally works off saved repo state).
- A builder **system prompt** that steers the agent to PROPOSE ops, not go edit the `.yaml` on disk
  itself (which would bypass the preview/accept gate).

## Consequences

- Adds server surface to the orchestrator tool registry (gated), consistent with ADR-0001's break
  from the builder's pure-web stance.
- Canvas-driving silently absent on non-native-tool providers — surface this in the UI (e.g. a
  "copilot needs Claude or Pi" note) rather than letting it fail quietly.
