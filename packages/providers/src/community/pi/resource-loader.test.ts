import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'bun:test';

import { createPiResourceLoader } from './resource-loader';

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let scratchDir: string | undefined;

afterEach(() => {
  if (originalAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
  if (scratchDir) {
    rmSync(scratchDir, { recursive: true, force: true });
    scratchDir = undefined;
  }
});

test('uses Pi native user and project context-file discovery', async () => {
  scratchDir = mkdtempSync(join(tmpdir(), 'archon-pi-context-'));
  const agentDir = join(scratchDir, 'agent');
  const projectRoot = join(scratchDir, 'project');
  const cwd = join(projectRoot, 'nested');
  const globalContextPath = join(agentDir, 'AGENTS.md');
  const projectContextPath = join(projectRoot, 'AGENTS.md');

  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(globalContextPath, '# User rules\n');
  writeFileSync(projectContextPath, '# Project rules\n');
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const loader = createPiResourceLoader(cwd, { enableExtensions: false });
  await loader.reload();

  expect(loader.getAgentsFiles().agentsFiles).toEqual(
    expect.arrayContaining([
      { path: globalContextPath, content: '# User rules\n' },
      { path: projectContextPath, content: '# Project rules\n' },
    ])
  );
});
