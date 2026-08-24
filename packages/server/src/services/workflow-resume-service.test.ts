import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';

const mockListDueWorkflowContinuations = mock(async () => [] as WorkflowRun[]);
const mockClaimScheduledWorkflowResume = mock(async () => ({ claimed: true }));

mock.module('@archon/core', () => ({
  createChildWorktreeResolver: mock(() => undefined),
  createWorkflowDeps: mock(() => ({})),
}));
mock.module('@archon/core/handlers', () => ({
  resolveRunContinuation: mock(async () => ({ ok: false, message: 'unused' })),
}));
mock.module('@archon/core/db/codebases', () => ({ getCodebase: mock(async () => null) }));
mock.module('@archon/core/db/workflows', () => ({
  listDueWorkflowContinuations: mockListDueWorkflowContinuations,
  claimScheduledWorkflowResume: mockClaimScheduledWorkflowResume,
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
  executeWorkflow: mock(async () => undefined),
  hydrateResumableRun: mock(async () => null),
}));

import { scanDueWorkflowContinuations } from './workflow-resume-service';

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
    mockClaimScheduledWorkflowResume.mockReset();
    mockClaimScheduledWorkflowResume.mockResolvedValue({ claimed: true });
  });

  test('resumes due waits and claims quota continuations before launching them', async () => {
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
    expect(mockClaimScheduledWorkflowResume).toHaveBeenCalledWith(
      'quota-1',
      scheduled,
      '2026-08-24T11:00:01.000Z'
    );
  });

  test('does not launch a quota continuation when another scanner won the claim', async () => {
    mockListDueWorkflowContinuations.mockResolvedValue([
      run('quota-2', 'failed', {
        scheduled_resume: {
          reason: 'quota',
          resumeAt: '2026-08-24T11:00:00.000Z',
          deadlineAt: '2026-08-25T11:00:00.000Z',
          attempt: 1,
          maxAttempts: 1,
          error: 'usage limit reached',
        },
      }),
    ]);
    mockClaimScheduledWorkflowResume.mockResolvedValue({ claimed: false });
    const resume = mock(async (_run: WorkflowRun) => true);

    await expect(scanDueWorkflowContinuations(new Date(), resume)).resolves.toBe(0);
    expect(resume).not.toHaveBeenCalled();
  });
});
