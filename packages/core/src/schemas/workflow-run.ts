/**
 * Zod schemas for dashboard workflow run types (enriched JOIN results).
 */
import { z } from '@hono/zod-openapi';
import { workflowRunSchema, workflowRunStatusSchema } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowRunStatus } from '@archon/workflows/schemas/workflow-run';

// ---------------------------------------------------------------------------
// DashboardWorkflowRun
// ---------------------------------------------------------------------------

export const dashboardWorkflowRunSchema = workflowRunSchema.extend({
  codebase_name: z.string().nullable(),
  platform_type: z.string().nullable(),
  worker_platform_id: z.string().nullable(),
  parent_platform_id: z.string().nullable(),
  active_nodes: z.array(z.string().min(1)),
  current_step_name: z.string().nullable(),
  total_steps: z.number().nullable(),
  current_step_status: z.enum(['running', 'completed', 'failed']).nullable(),
  agents_completed: z.number().nullable(),
  agents_failed: z.number().nullable(),
  agents_total: z.number().nullable(),
});

export type DashboardWorkflowRun = z.infer<typeof dashboardWorkflowRunSchema>;

// ---------------------------------------------------------------------------
// ListDashboardRunsOptions
// ---------------------------------------------------------------------------

export const listDashboardRunsOptionsSchema = z.object({
  status: z.union([workflowRunStatusSchema, z.array(workflowRunStatusSchema).min(1)]).optional(),
  codebaseId: z.string().optional(),
  search: z.string().optional(),
  after: z.string().optional(),
  before: z.string().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
});

type ParsedListDashboardRunsOptions = z.infer<typeof listDashboardRunsOptionsSchema>;

export type ListDashboardRunsOptions = Omit<ParsedListDashboardRunsOptions, 'status'> & {
  status?: WorkflowRunStatus | [WorkflowRunStatus, ...WorkflowRunStatus[]];
};

// ---------------------------------------------------------------------------
// DashboardRunsResult
// ---------------------------------------------------------------------------

export const dashboardRunsResultSchema = z.object({
  runs: z.array(dashboardWorkflowRunSchema),
  total: z.number(),
  counts: z.object({
    all: z.number(),
    running: z.number(),
    completed: z.number(),
    failed: z.number(),
    cancelled: z.number(),
    pending: z.number(),
    paused: z.number(),
  }),
});

export type DashboardRunsResult = z.infer<typeof dashboardRunsResultSchema>;
