import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { IWorkflowPlatform } from '@archon/workflows/deps';

const mockListDueWorkflowContinuations = mock(async () => [] as WorkflowRun[]);
const mockDeferWorkflowContinuation = mock(async () => undefined);
const mockResolveRunContinuation = mock(async () => ({ ok: false as const, message: 'unused' }));
const mockHydrateResumableRun = mock(async () => null as null | Record<string, unknown>);
const mockExecuteWorkflow = mock(async () => undefined);

mock.module('@archon/core', () => ({
  createChildWorktreeResolver: mock(() => undefined),
  createWorkflowDeps: mock(() => ({})),
}));
mock.module('@archon/core/handlers', () => ({
  resolveRunContinuation: mockResolveRunContinuation,
}));
mock.module('@archon/core/db/codebases', () => ({ getCodebase: mock(async () => null) }));
mock.module('@archon/core/db/workflows', () => ({
  listDueWorkflowContinuations: mockListDueWorkflowContinuations,
  deferWorkflowContinuation: mockDeferWorkflowContinuation,
  WorkflowNotResumableError: class WorkflowNotResumableError extends Error {},
}));
mock.module('@archon/paths', () => ({
  createLogger: () => ({
    debug: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  }),
  getArchonWorkspacesPath: () => '/tmp/workspaces',
}));
mock.module('@archon/workflows/executor', () => ({
  executeWorkflow: mockExecuteWorkflow,
  hydrateResumableRun: mockHydrateResumableRun,
}));

import {
  resumeWorkflowRunFromServer,
  scanDueWorkflowContinuations,
} from './workflow-resume-service';

function run(
  id: string,
  status: 'paused' | 'failed',
  metadata: Record<string, unknown>
): WorkflowRun {
  return {
    id,
    workflow_name: 'deliver',
    conversation_id: 'conv-1',
    parent_conversation_id: null,
    codebase_id: null,
    status,
    outcome: null,
    user_message: 'deliver',
    metadata,
    started_at: new Date('2026-08-24T10:00:00.000Z'),
    completed_at: status === 'failed' ? new Date('2026-08-24T10:01:00.000Z') : null,
    last_activity_at: null,
    working_path: '/tmp/worktree',
    user_id: null,
    parent_run_id: null,
    output_root: null,
  };
}

describe('workflow continuation scanner', () => {
  beforeEach(() => {
    mockListDueWorkflowContinuations.mockReset();
    mockDeferWorkflowContinuation.mockReset();
    mockDeferWorkflowContinuation.mockResolvedValue(undefined);
    mockResolveRunContinuation.mockReset();
    mockResolveRunContinuation.mockResolvedValue({ ok: false, message: 'unused' });
    mockHydrateResumableRun.mockReset();
    mockHydrateResumableRun.mockResolvedValue(null);
    mockExecuteWorkflow.mockReset();
    mockExecuteWorkflow.mockResolvedValue(undefined);
  });

  test('resumes due waits and quota continuations through the shared resume CAS', async () => {
    const scheduled = {
      reason: 'quota' as const,
      resumeAt: '2026-08-24T11:00:00.000Z',
      deadlineAt: '2026-08-25T11:00:00.000Z',
      attempt: 1,
      maxAttempts: 2,
      error: 'usage limit reached',
    };
    mockListDueWorkflowContinuations.mockResolvedValue([
      run('wait-1', 'paused', {
        wait: {
          nodeId: 'delay',
          kind: 'time',
          waitingSince: '2026-08-24T10:00:00.000Z',
          resumeAt: '2026-08-24T11:00:00.000Z',
        },
      }),
      run('quota-1', 'failed', { scheduled_resume: scheduled }),
    ]);
    const resume = mock(async (_run: WorkflowRun) => true);

    await expect(
      scanDueWorkflowContinuations(new Date('2026-08-24T11:00:01.000Z'), resume)
    ).resolves.toBe(2);
    expect(resume).toHaveBeenCalledTimes(2);
  });

  test('resumes a paused wait even when the run retains historical quota metadata', async () => {
    const scheduled = {
      reason: 'quota' as const,
      resumeAt: '2026-08-24T10:30:00.000Z',
      deadlineAt: '2026-08-25T10:30:00.000Z',
      attempt: 1,
      maxAttempts: 2,
      error: 'usage limit reached',
      triggeredAt: '2026-08-24T10:30:01.000Z',
    };
    mockListDueWorkflowContinuations.mockResolvedValue([
      run('wait-after-quota', 'paused', {
        wait: {
          nodeId: 'delay',
          kind: 'time',
          waitingSince: '2026-08-24T10:31:00.000Z',
          resumeAt: '2026-08-24T11:00:00.000Z',
        },
        scheduled_resume: scheduled,
      }),
    ]);
    const resume = mock(async (_run: WorkflowRun) => true);

    await expect(
      scanDueWorkflowContinuations(new Date('2026-08-24T11:00:01.000Z'), resume)
    ).resolves.toBe(1);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  test('uses the originating platform destination when one is available', async () => {
    const paused = run('wait-platform', 'paused', {});
    mockResolveRunContinuation.mockResolvedValueOnce({
      ok: true,
      workflowName: 'deliver',
      workflow: { definition: { name: 'deliver', nodes: [] } },
    });
    mockHydrateResumableRun.mockResolvedValueOnce({
      preCreatedRun: { ...paused, status: 'running' },
      priorCompletedNodes: new Map(),
      priorUsage: { costUsd: 0 },
      priorNodeSessions: [],
    });
    const platform = {
      sendMessage: mock(async () => undefined),
      getStreamingMode: () => 'batch' as const,
      getPlatformType: () => 'slack',
    } satisfies IWorkflowPlatform;

    await expect(
      resumeWorkflowRunFromServer(paused, undefined, {
        platform,
        conversationId: 'slack-thread-123',
      })
    ).resolves.toBe(true);

    expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
    expect(mockExecuteWorkflow.mock.calls[0]?.[1]).toBe(platform);
    expect(mockExecuteWorkflow.mock.calls[0]?.[2]).toBe('slack-thread-123');
  });

  test('backs off a due row when execution prerequisites are unavailable', async () => {
    mockListDueWorkflowContinuations.mockResolvedValueOnce([run('wait-poison', 'paused', {})]);
    const resume = mock(async () => false);

    await expect(
      scanDueWorkflowContinuations(new Date('2026-08-24T11:00:00.000Z'), resume)
    ).resolves.toBe(0);

    expect(mockDeferWorkflowContinuation).toHaveBeenCalledWith(
      'wait-poison',
      '2026-08-24T11:01:00.000Z'
    );
  });
});
