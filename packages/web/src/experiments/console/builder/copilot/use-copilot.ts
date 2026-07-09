/**
 * Builder Copilot conversation + Proposal state. Reuses the console chat
 * end-to-end (DB-backed conversation, `useEntity`/SSE invalidation) exactly
 * like `ChatPage` — no dedicated endpoint, no parallel persistence (Pre-flight
 * #2). The pending Proposal is read off the last assistant message's
 * `toolCalls` (post-turn), never off the raw SSE payload.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useConversationSSE } from '../../lib/sse';
import { useEntity, invalidate } from '../../store/cache';
import { K } from '../../store/keys';
import * as skill from '../../skills';
import type { Message } from '../../primitives/message';
import type { BuilderWorkflow } from '../types';
import { toWorkflowDefinition } from '../model';
import type { EditorAction } from '../editor/state';
import { parseAndValidateOps } from './op-schema';
import { computeProposalPreview, type ProposalPreview } from './preview-diff';
import { opsToEditorActions } from './translate-ops';

const PROPOSE_TOOL_NAME = 'propose_workflow_edits';

export interface CopilotProposal {
  /** Identifies the source tool call so Accept/Reject can be recorded per-call. */
  key: string;
  /** Null only when `invalidReason` is set — an unparseable batch has nothing to preview. */
  preview: ProposalPreview | null;
  actions: readonly EditorAction[];
  /** Set when the tool call's `ops` failed to parse — the batch cannot be previewed or applied. */
  invalidReason: string | null;
}

export interface UseCopilotResult {
  messages: Message[];
  busy: boolean;
  error: string | null;
  proposal: CopilotProposal | null;
  send: (text: string) => Promise<void>;
  /** Returns the batch to hand to `BuilderPage`'s `applyBatch` prop; clears the pending Proposal. */
  accept: () => readonly EditorAction[] | null;
  reject: () => void;
}

/** Builder Copilot conversation + pending-Proposal state for one project + open workflow. */
export function useCopilot(
  projectId: string | undefined,
  currentWorkflow: BuilderWorkflow | null
): UseCopilotResult {
  const [convId, setConvId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tool-call keys the author has already Accepted/Rejected — keeps a resolved
  // Proposal from resurfacing while its message stays the latest assistant turn.
  const [resolvedKeys, setResolvedKeys] = useState<ReadonlySet<string>>(new Set());

  const messagesKey = convId !== null ? K.messages(convId) : 'noop:no-copilot-conv';
  const { data: messages } = useEntity<Message[]>(messagesKey, () =>
    convId !== null ? skill.listMessages(convId) : Promise.resolve([])
  );

  const onLockChange = useCallback((locked: boolean): void => {
    if (!locked) setBusy(false);
  }, []);
  useConversationSSE(convId, onLockChange);

  const messageList = useMemo(() => messages ?? [], [messages]);

  const pendingCall = useMemo(() => {
    for (let i = messageList.length - 1; i >= 0; i -= 1) {
      const m = messageList[i];
      if (m?.role !== 'assistant') continue;
      const call = m.toolCalls.find(c => c.name === PROPOSE_TOOL_NAME);
      if (call === undefined) continue;
      const key = `${m.id}:${PROPOSE_TOOL_NAME}`;
      return resolvedKeys.has(key) ? null : { key, input: call.input };
    }
    return null;
  }, [messageList, resolvedKeys]);

  const proposal = useMemo<CopilotProposal | null>(() => {
    if (pendingCall === null || currentWorkflow === null) return null;
    const raw = typeof pendingCall.input.ops === 'string' ? pendingCall.input.ops : '';
    const parsed = parseAndValidateOps(raw);
    if (!parsed.ok) {
      return { key: pendingCall.key, preview: null, actions: [], invalidReason: parsed.error };
    }
    const preview = computeProposalPreview(currentWorkflow, parsed.ops);
    const { actions } = opsToEditorActions(parsed.ops, currentWorkflow);
    return { key: pendingCall.key, preview, actions, invalidReason: null };
  }, [pendingCall, currentWorkflow]);

  // Guards against a StrictMode/double-invocation issuing two conversation creates
  // for the same first send — createConversation is called at most once per mount.
  const creatingRef = useRef<Promise<string> | null>(null);

  const send = useCallback(
    async (text: string): Promise<void> => {
      if (projectId === undefined || currentWorkflow === null) return;
      setError(null);
      setBusy(true);
      try {
        let id = convId;
        if (id === null) {
          if (creatingRef.current === null) {
            creatingRef.current = skill
              .createConversation(projectId)
              .then(conv => conv.conversationId);
          }
          id = await creatingRef.current;
          setConvId(id);
        }
        const canvasState = JSON.stringify(toWorkflowDefinition(currentWorkflow));
        await skill.sendMessage(id, text, undefined, { builderMode: true, canvasState });
        invalidate(K.messages(id));
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Send failed.');
        setBusy(false);
      }
      // On success `busy` stays true until the conversation-lock SSE event clears it.
    },
    [projectId, currentWorkflow, convId]
  );

  const accept = useCallback((): readonly EditorAction[] | null => {
    if (proposal?.invalidReason !== null) return null;
    setResolvedKeys(prev => new Set(prev).add(proposal.key));
    return proposal.actions;
  }, [proposal]);

  const reject = useCallback((): void => {
    if (proposal === null) return;
    setResolvedKeys(prev => new Set(prev).add(proposal.key));
  }, [proposal]);

  return { messages: messageList, busy, error, proposal, send, accept, reject };
}
