import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { DashboardRunResponse } from '@/lib/api';
import { WorkflowRunCard } from './WorkflowRunCard';

const parallelRun: DashboardRunResponse = {
  id: 'run-parallel',
  workflow_name: 'implement',
  conversation_id: 'conv-1',
  parent_conversation_id: null,
  codebase_id: 'codebase-1',
  status: 'running',
  outcome: null,
  user_message: 'Implement the change',
  metadata: {},
  started_at: '2026-09-01T10:00:00.000Z',
  completed_at: null,
  last_activity_at: '2026-09-01T10:01:00.000Z',
  working_path: '/workspace/archon',
  user_id: null,
  parent_run_id: null,
  adopted_from_run_id: null,
  output_root: null,
  codebase_name: 'Archon',
  platform_type: 'cli',
  worker_platform_id: null,
  parent_platform_id: null,
  active_nodes: ['parallel-a', 'parallel-b'],
  current_step_name: null,
  total_steps: null,
  current_step_status: null,
  agents_completed: null,
  agents_failed: null,
  agents_total: null,
};

describe('WorkflowRunCard', () => {
  test('renders every active node from the initial dashboard response', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <WorkflowRunCard run={parallelRun} onCancel={() => undefined} />
      </MemoryRouter>
    );

    expect(html).toContain('Active nodes:');
    expect(html).toContain('parallel-a, parallel-b');
  });
});
