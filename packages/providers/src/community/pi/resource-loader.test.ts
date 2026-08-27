import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'bun:test';

import {
  createPiResourceLoader,
  createPiSessionResourceLoader,
  getOrCreateReloadedExtensionLoader,
  resetReloadedExtensionLoaderCache,
} from './resource-loader';

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let scratchDir: string | undefined;

afterEach(() => {
  resetReloadedExtensionLoaderCache();
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

test('keeps native context current while extension initialization remains cached', async () => {
  scratchDir = mkdtempSync(join(tmpdir(), 'archon-pi-session-context-'));
  const agentDir = join(scratchDir, 'agent');
  const extensionsDir = join(agentDir, 'extensions');
  const cwd = join(scratchDir, 'project');
  const contextPath = join(cwd, 'CLAUDE.md');
  const extensionLoadPath = join(scratchDir, 'extension-loads.txt');

  mkdirSync(extensionsDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(extensionsDir, 'counter.ts'),
    [
      "import { appendFileSync } from 'node:fs';",
      'export default function (): void {',
      `  appendFileSync(${JSON.stringify(extensionLoadPath)}, 'loaded\\n');`,
      '}',
      '',
    ].join('\n')
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const first = await getOrCreateReloadedExtensionLoader(cwd);
  expect(
    createPiSessionResourceLoader(first.loader, cwd).getAgentsFiles().agentsFiles
  ).not.toContainEqual(expect.objectContaining({ path: contextPath }));

  writeFileSync(contextPath, '# First project rules\n');
  const second = await getOrCreateReloadedExtensionLoader(cwd);
  expect(second.loader).toBe(first.loader);
  expect(
    createPiSessionResourceLoader(second.loader, cwd).getAgentsFiles().agentsFiles
  ).toContainEqual({
    path: contextPath,
    content: '# First project rules\n',
  });

  writeFileSync(contextPath, '# Updated project rules\n');
  const third = await getOrCreateReloadedExtensionLoader(cwd);
  expect(
    createPiSessionResourceLoader(third.loader, cwd).getAgentsFiles().agentsFiles
  ).toContainEqual({
    path: contextPath,
    content: '# Updated project rules\n',
  });

  rmSync(contextPath);
  const fourth = await getOrCreateReloadedExtensionLoader(cwd);
  expect(
    createPiSessionResourceLoader(fourth.loader, cwd).getAgentsFiles().agentsFiles
  ).not.toContainEqual(expect.objectContaining({ path: contextPath }));
  expect(readFileSync(extensionLoadPath, 'utf8')).toBe('loaded\n');
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
