import { createChildWorktreeResolver, createWorkflowDeps } from '@archon/core';
import { resolveRunContinuation } from '@archon/core/handlers';
import * as codebaseDb from '@archon/core/db/codebases';
import * as workflowDb from '@archon/core/db/workflows';
import { createLogger, getArchonWorkspacesPath } from '@archon/paths';
import { executeWorkflow, hydrateResumableRun } from '@archon/workflows/executor';
import type { IWorkflowPlatform } from '@archon/workflows/deps';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { HeadlessPlatform } from '../adapters/headless';

const log = createLogger('workflow-resume-service');
const CONTINUATION_SCAN_INTERVAL_MS = 5_000;
const CONTINUATION_SCAN_BATCH_SIZE = 25;
const CONTINUATION_RETRY_DELAY_MS = 60_000;
let continuationScheduler: ReturnType<typeof setInterval> | undefined;
let scanInProgress = false;

export interface WorkflowResumeDestination {
  platform: IWorkflowPlatform;
  conversationId: string;
}

export type WorkflowResumeDestinationResolver = (
  run: WorkflowRun
) => Promise<WorkflowResumeDestination | undefined>;

/** Resume one persisted run through the same frozen-source path used by the API. */
export async function resumeWorkflowRunFromServer(
  run: WorkflowRun,
  actorUserId?: string,
  destination?: WorkflowResumeDestination
): Promise<boolean> {
  if (!run.working_path) {
    log.debug({ runId: run.id }, 'workflow_resume_headless_no_working_path');
    return false;
  }
  try {
    const codebase = run.codebase_id ? await codebaseDb.getCodebase(run.codebase_id) : null;
    const workflowCwd = codebase?.default_cwd ?? getArchonWorkspacesPath();
    const deps = createWorkflowDeps();
    const continuation = await resolveRunContinuation(run.id, workflowCwd);
    if (!continuation.ok) {
      log.info(
        { runId: run.id, reason: continuation.message },
        'workflow_resume_headless_unresolvable'
      );
      return false;
    }

    const platform = destination?.platform ?? new HeadlessPlatform(run.conversation_id);
    const platformConversationId = destination?.conversationId ?? run.conversation_id;
    let hydrated: Awaited<ReturnType<typeof hydrateResumableRun>>;
    try {
      hydrated = await hydrateResumableRun(deps, run);
    } catch (error) {
      if (error instanceof workflowDb.WorkflowNotResumableError) {
        log.info(
          { runId: run.id, status: error.currentStatus },
          'workflow_resume_headless_lost_race'
        );
        return false;
      }
      throw error;
    }
    if (!hydrated) {
      log.info({ runId: run.id }, 'workflow_resume_headless_nothing_to_resume');
      return false;
    }

    const effectiveUserId = actorUserId ?? run.user_id ?? undefined;
    const resolveChildIsolation =
      codebase && codebase.kind !== 'folder'
        ? createChildWorktreeResolver({
            codebaseId: codebase.id,
            codebaseName: codebase.name,
            canonicalRepoPath: codebase.default_cwd,
            baseBranch: codebase.default_branch?.trim() || undefined,
            createdByPlatform: platform.getPlatformType(),
            createdByUserId: effectiveUserId,
          })
        : undefined;

    executeWorkflow(
      deps,
      platform,
      platformConversationId,
      run.working_path,
      continuation.workflow.definition,
      run.user_message ?? '',
      run.conversation_id,
      {
        codebaseId: run.codebase_id ?? undefined,
        userId: effectiveUserId,
        baseBranch: codebase?.default_branch?.trim() || undefined,
        resolveChildIsolation,
        ...hydrated,
      }
    ).catch((error: unknown) => {
      log.error({ err: error as Error, runId: run.id }, 'workflow_resume_headless_execute_failed');
      void workflowDb
        .failWorkflowRun(run.id, `Headless resume failed: ${(error as Error).message}`)
        .catch((failError: unknown) => {
          log.error(
            { err: failError as Error, runId: run.id },
            'workflow_resume_headless_fail_mark_failed'
          );
        });
    });
    return true;
  } catch (error) {
    log.warn({ err: error as Error, runId: run.id }, 'workflow_resume_headless_unexpected_error');
    return false;
  }
}

export async function scanDueWorkflowContinuations(
  now = new Date(),
  resume: (run: WorkflowRun) => Promise<boolean> = resumeWorkflowRunFromServer
): Promise<number> {
  if (scanInProgress) return 0;
  scanInProgress = true;
  try {
    const due = await workflowDb.listDueWorkflowContinuations(now, CONTINUATION_SCAN_BATCH_SIZE);
    const results = await Promise.allSettled(
      due.map(async run => {
        const resumed = await resume(run);
        if (!resumed) {
          await workflowDb.deferWorkflowContinuation(
            run.id,
            new Date(now.getTime() + CONTINUATION_RETRY_DELAY_MS).toISOString()
          );
        }
        return resumed;
      })
    );
    return results.filter(result => result.status === 'fulfilled' && result.value).length;
  } finally {
    scanInProgress = false;
  }
}

export function startWorkflowContinuationScheduler(
  resolveDestination?: WorkflowResumeDestinationResolver
): void {
  if (continuationScheduler !== undefined) return;
  const resume = async (run: WorkflowRun): Promise<boolean> =>
    resumeWorkflowRunFromServer(run, undefined, await resolveDestination?.(run));
  void scanDueWorkflowContinuations(new Date(), resume).catch((error: unknown) => {
    log.error({ err: error as Error }, 'workflow_continuation_scan_failed');
  });
  continuationScheduler = setInterval(() => {
    void scanDueWorkflowContinuations(new Date(), resume).catch((error: unknown) => {
      log.error({ err: error as Error }, 'workflow_continuation_scan_failed');
    });
  }, CONTINUATION_SCAN_INTERVAL_MS);
  continuationScheduler.unref?.();
}

export function stopWorkflowContinuationScheduler(): void {
  if (continuationScheduler === undefined) return;
  clearInterval(continuationScheduler);
  continuationScheduler = undefined;
}
