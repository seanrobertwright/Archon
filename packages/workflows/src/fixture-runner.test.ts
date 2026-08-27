/** Tests for the declared-data dry-run fixture runner (#2772). */
import { describe, it, expect, afterEach } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileAsync } from '@archon/git';
import { parseWorkflow } from './loader';
import { expandWorkflowIncludes } from './include-expander';
import type { WorkflowWithSource } from './schemas/workflow';
import { liveSourceRoots, type WorkflowSourceRoots } from './workflow-source';

/** Load the temp project's on-disk workflows so targets match discovery's output shape. */
function workflowsOnDisk(cwd: string, names: string[], pack = 'pack'): WorkflowWithSource[] {
  return names.map(name => {
    const path = join(cwd, '.archon', 'workflows', pack, `${name}.yaml`);
    const parsed = parseWorkflow(readFileSync(path, 'utf8'), `${name}.yaml`);
    if (!parsed.workflow) throw new Error(parsed.error.error);
    const raw = new Map([[parsed.workflow.name, parsed.workflow]]);
    const expanded = expandWorkflowIncludes(raw);
    return {
      workflow: expanded.workflows.get(name) ?? parsed.workflow,
      source: 'project' as const,
    };
  });
}
import {
  formatFixtureReport,
  parseFixtureFile,
  runFixtures as runFixturesFromSource,
  type FixtureReport,
  type RunFixturesOptions,
} from './fixture-runner';

function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), 'fixture-runner-'));
}

function isolatedSourceRoots(cwd: string): WorkflowSourceRoots {
  const roots = liveSourceRoots(cwd);
  return {
    ...roots,
    globalWorkflows: join(cwd, '.empty', 'global-workflows'),
    bundledWorkflows: join(cwd, '.empty', 'bundled-workflows'),
  };
}

async function runFixtures(options: RunFixturesOptions): Promise<FixtureReport> {
  return runFixturesFromSource({
    ...options,
    sourceRoots: isolatedSourceRoots(options.cwd),
  });
}

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface TempFixtureOptions {
  workflowName?: string;
  fixtureName?: string;
  body: string;
  /** Workflow yaml written next to fixtures/ — defaults to a one-node stub target. */
  workflowYaml?: string;
}

function writeTempProject(options: TempFixtureOptions): { cwd: string; fixturePath: string } {
  const cwd = makeTempProject();
  cleanups.push(cwd);
  const packDir = join(cwd, '.archon', 'workflows', 'pack');
  const fixturesDir = join(packDir, 'fixtures');
  mkdirSync(fixturesDir, { recursive: true });
  const name = options.workflowName ?? 'test-wf';
  writeFileSync(
    join(packDir, `${name}.yaml`),
    options.workflowYaml ??
      `name: ${name}\ndescription: test\nnodes:\n  - id: node-a\n    prompt: hello\n`
  );
  const fixturePath = join(fixturesDir, `${options.fixtureName ?? 'happy'}.stubs.yaml`);
  writeFileSync(fixturePath, options.body);
  return { cwd, fixturePath };
}

describe('parseFixtureFile', () => {
  it('splits reserved keys from node stubs and applies defaults', () => {
    const parsed = parseFixtureFile(
      ['fixture:', '  expect: completed', 'node-a: "stub"', 'exec-code: false'].join('\n'),
      'x.stubs.yaml'
    );
    expect(parsed.declaration.expect).toBe('completed');
    expect(parsed.execCode).toBe(false);
    expect(parsed.stubs).toEqual({ 'node-a': 'stub' });
  });

  it('requires fail-node when expect is failed', () => {
    expect(() =>
      parseFixtureFile(['fixture:', '  expect: failed', 'node-a: "stub"'].join('\n'), 'x')
    ).toThrow('fail-node is required');
  });

  it('rejects non-boolean exec-code loudly (reserved-key collision guard)', () => {
    expect(() =>
      parseFixtureFile(['exec-code: yes-please', 'node-a: "stub"'].join('\n'), 'x')
    ).toThrow("'exec-code' must be true or false");
  });

  it('accepts every dry-run outcome the producer can emit (#2772)', () => {
    for (const outcome of ['completed', 'failed', 'paused', 'cancelled'] as const) {
      const body =
        outcome === 'failed'
          ? ['fixture:', '  expect: failed', '  fail-node: node-a'].join('\n')
          : ['fixture:', `  expect: ${outcome}`].join('\n');
      expect(parseFixtureFile(body, 'x').declaration.expect).toBe(outcome);
    }
  });
});

describe('runFixtures', () => {
  const passingBody = ['fixture:', '  expect: completed', 'node-a: "stub output"', ''].join('\n');

  it('passes a fixture whose declared outcome matches the dry-run outcome', async () => {
    const { cwd } = writeTempProject({ body: passingBody });
    const report = await runFixtures({
      workflows: [workflowsOnDisk(cwd, ['test-wf'])[0]],
      cwd,
    });
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.results[0].outcome).toBe('completed');
  });

  it('passes an expected failure that fails on exactly the declared node', async () => {
    // A `when:` referencing a missing producer makes node-b fail deterministically.
    const { cwd } = writeTempProject({
      workflowYaml:
        'name: test-wf\ndescription: test\nnodes:\n' +
        '  - id: node-a\n    prompt: hello\n' +
        '  - id: node-b\n    prompt: $NODE_OUTPUT.node-a.missing\n    depends_on: [node-a]\n',
      body: ['fixture:', '  expect: failed', '  fail-node: node-b', 'node-a: "stub"'].join('\n'),
    });
    const report = await runFixtures({
      workflows: [workflowsOnDisk(cwd, ['test-wf'])[0]],
      cwd,
    });
    expect(report.passed).toBe(1);
    expect(report.results[0].outcome).toBe('failed');
  });

  it('fails a fixture whose declared outcome diverges from the dry run', async () => {
    const { cwd } = writeTempProject({
      workflowYaml:
        'name: test-wf\ndescription: test\nnodes:\n' +
        '  - id: node-a\n    prompt: hello\n' +
        '  - id: node-b\n    prompt: $NODE_OUTPUT.node-a.missing\n    depends_on: [node-a]\n',
      body: 'node-a: "stub"\n',
    });
    const report = await runFixtures({
      workflows: [workflowsOnDisk(cwd, ['test-wf'])[0]],
      cwd,
    });
    expect(report.failed).toBe(1);
    expect(report.results[0].failureReason).toContain(
      'expected completed, dry-run reported failed'
    );
  });

  it('rejects a completing fixture that reached nodes without stubs', async () => {
    const { cwd } = writeTempProject({
      workflowYaml:
        'name: test-wf\ndescription: test\nnodes:\n' +
        '  - id: node-a\n    prompt: hi\n' +
        '  - id: node-b\n    prompt: there\n    depends_on: [node-a]\n',
      body: 'node-a: "stub"\n',
    });
    const report = await runFixtures({
      workflows: [workflowsOnDisk(cwd, ['test-wf'])[0]],
      cwd,
    });
    expect(report.failed).toBe(1);
    expect(report.results[0].missingStubs).toEqual(['node-b']);
  });

  it('warns on unused stubs without failing', async () => {
    const { cwd } = writeTempProject({
      body: ['node-a: "stub"', 'unused-node: "never reached"'].join('\n'),
    });
    const report = await runFixtures({
      workflows: [workflowsOnDisk(cwd, ['test-wf'])[0]],
      cwd,
    });
    expect(report.passed).toBe(1);
    expect(report.results[0].unusedStubs).toEqual(['unused-node']);
    expect(formatFixtureReport(report)).toContain('warning: unused stubs');
  });

  it('passes declaration inputs through to the dry run', async () => {
    const { cwd } = writeTempProject({
      workflowYaml:
        'name: test-wf\ndescription: test\ninputs:\n  branch:\n    required: true\nnodes:\n' +
        '  - id: node-a\n    prompt: branch=$INPUTS.branch\n',
      body: ['fixture:', '  inputs:', '    branch: task-42', 'node-a: "branch=task-42"'].join('\n'),
    });
    const report = await runFixtures({
      workflows: [workflowsOnDisk(cwd, ['test-wf'])[0]],
      cwd,
    });
    expect(report.passed).toBe(1);
  });

  it('reports a malformed fixture as a failure, not a crash', async () => {
    const { cwd } = writeTempProject({ body: ['fixture:', '  expect: bogus'].join('\n') });
    const report = await runFixtures({
      workflows: [workflowsOnDisk(cwd, ['test-wf'])[0]],
      cwd,
    });
    expect(report.failed).toBe(1);
    expect(report.results[0].failureReason).toContain('expect');
  });

  it('returns zero results and no failure when nothing is declared', async () => {
    const cwd = makeTempProject();
    cleanups.push(cwd);
    const report = await runFixtures({ workflows: [], cwd });
    expect(report.results).toHaveLength(0);
    expect(report.passed).toBe(0);
    expect(report.failed).toBe(0);
  });

  it('throws for an explicit target that matches no fixtures', async () => {
    const { cwd } = writeTempProject({ body: passingBody });
    await expect(runFixtures({ workflows: [], cwd, target: 'no-such-pack' })).rejects.toThrow(
      'No fixtures found'
    );
  });

  it('suggests only workflows that carry fixtures when a target has none', async () => {
    const { cwd } = writeTempProject({ body: passingBody });
    const bareDir = join(cwd, '.archon', 'workflows', 'bare');
    mkdirSync(bareDir, { recursive: true });
    writeFileSync(
      join(bareDir, 'bare-wf.yaml'),
      'name: bare-wf\ndescription: test\nnodes:\n  - id: node-a\n    prompt: hi\n'
    );
    const err = await runFixtures({
      workflows: [
        ...workflowsOnDisk(cwd, ['test-wf']),
        ...workflowsOnDisk(cwd, ['bare-wf'], 'bare'),
      ],
      cwd,
      target: 'bare-wf',
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const suggested = /fixtures \(([^)]*)\)/.exec((err as Error).message)?.[1] ?? '';
    expect(suggested.split(', ')).toEqual(['test-wf']);
  });

  it('excludes fixture-targeted workflows the catalog cannot load from suggestions', async () => {
    const { cwd } = writeTempProject({ body: passingBody });
    // A name-only YAML passes workflowNamesBeside but fails parseWorkflow, so the fixture
    // beside it targets a workflow the command can never resolve (#2850).
    const brokenDir = join(cwd, '.archon', 'workflows', 'broken');
    mkdirSync(join(brokenDir, 'fixtures'), { recursive: true });
    writeFileSync(join(brokenDir, 'broken-wf.yaml'), 'name: broken-wf\n');
    writeFileSync(join(brokenDir, 'fixtures', 'orphan.stubs.yaml'), passingBody);
    const err = await runFixtures({
      workflows: workflowsOnDisk(cwd, ['test-wf']),
      cwd,
      target: 'nope',
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const suggested = /fixtures \(([^)]*)\)/.exec((err as Error).message)?.[1] ?? '';
    expect(suggested.split(', ')).toEqual(['test-wf']);
  });

  it('reports the divergence hint when discovered fixtures target no catalog workflow', async () => {
    const { cwd } = writeTempProject({ body: passingBody });
    const err = await runFixtures({
      workflows: [],
      cwd,
      target: 'nope',
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(
      /Discovered fixtures target no workflow in the discovery catalog/
    );
    expect((err as Error).message).not.toMatch(/declares fixtures/);
  });

  it('says no workflow declares fixtures when discovery found no fixtures at all', async () => {
    const cwd = makeTempProject();
    cleanups.push(cwd);
    const packDir = join(cwd, '.archon', 'workflows', 'pack');
    mkdirSync(packDir, { recursive: true });
    writeFileSync(
      join(packDir, 'test-wf.yaml'),
      'name: test-wf\ndescription: test\nnodes:\n  - id: node-a\n    prompt: hello\n'
    );
    const err = await runFixtures({
      workflows: workflowsOnDisk(cwd, ['test-wf']),
      cwd,
      target: 'test-wf',
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/No workflow in any discovery scope declares fixtures/);
    expect((err as Error).message).not.toContain('()');
  });

  it('restricts to fixtures of the named workflow via target', async () => {
    const { cwd } = writeTempProject({
      workflowName: 'target-wf',
      fixtureName: 'only-target',
      body: passingBody,
    });
    const workflowsRoot = join(cwd, '.archon', 'workflows');
    const otherDir = join(workflowsRoot, 'other');
    mkdirSync(join(otherDir, 'fixtures'), { recursive: true });
    writeFileSync(
      join(otherDir, 'other-wf.yaml'),
      'name: other-wf\ndescription: test\nnodes:\n  - id: node-a\n    prompt: hi\n'
    );
    writeFileSync(
      join(otherDir, 'fixtures', 'other-fixture.stubs.yaml'),
      ['fixture:', '  expect: failed', '  fail-node: node-a', 'node-a: x'].join('\n')
    );
    const report = await runFixtures({
      workflows: [
        ...workflowsOnDisk(cwd, ['target-wf']),
        ...workflowsOnDisk(cwd, ['other-wf'], 'other'),
      ],
      cwd,
      target: 'target-wf',
    });
    expect(report.results.map(r => r.fixture)).toEqual([
      expect.stringContaining('only-target.stubs.yaml'),
    ]);
    expect(report.passed).toBe(1);
  });

  it('filters by pack name when the target is not a workflow name', async () => {
    const { cwd } = writeTempProject({ body: passingBody });
    const report = await runFixtures({
      workflows: workflowsOnDisk(cwd, ['test-wf']),
      cwd,
      target: 'pack',
    });
    expect(report.passed).toBe(1);
  });
});

describe('runFixtures exec-code isolation (#2851)', () => {
  const COMMITTED_YAML = 'committed-file\n';

  /** A bash node whose success depends ONLY on the cleanliness of the checkout it executes in. */
  const GUARD_YAML = [
    'name: test-wf',
    'description: probe the checkout it executes in',
    'nodes:',
    '  - id: probe',
    '    bash: |',
    '      [ -z "$(git status --porcelain)" ]',
  ].join('\n');

  const WRITER_YAML = [
    'name: writer-wf',
    'description: writes a relative-path file where it executes',
    'nodes:',
    '  - id: writer',
    '    bash: echo executed > leak.txt',
  ].join('\n');

  const execFixtureBody = ['fixture:', '  expect: completed', '', 'exec-code: true'].join('\n');

  const git = (cwd: string, ...args: string[]): Promise<unknown> =>
    execFileAsync('git', args, { cwd });

  /** Turn a plain temp project into a git repo with one committed file besides the project's own. */
  async function initGitWithCommittedFile(cwd: string): Promise<void> {
    await git(cwd, 'init', '-q');
    await git(cwd, 'config', 'user.email', 't@t');
    await git(cwd, 'config', 'user.name', 't');
    writeFileSync(join(cwd, 'tracked.txt'), COMMITTED_YAML);
    await git(cwd, 'add', '-A');
    await git(cwd, 'commit', '-qm', 'init');
  }

  it('gives clean and pre-dirtied callers the same verdict (#2851)', async () => {
    const clean = writeTempProject({ workflowYaml: GUARD_YAML, body: execFixtureBody });
    await initGitWithCommittedFile(clean.cwd);
    const cleanReport = await runFixtures({
      workflows: [workflowsOnDisk(clean.cwd, ['test-wf'])[0]],
      cwd: clean.cwd,
    });
    expect(cleanReport.failed).toBe(0);

    const dirty = writeTempProject({ workflowYaml: GUARD_YAML, body: execFixtureBody });
    await initGitWithCommittedFile(dirty.cwd);
    // Exactly the operator-tree state the issue reports: one modified tracked file,
    // one untracked stray.
    writeFileSync(join(dirty.cwd, 'tracked.txt'), `${COMMITTED_YAML}edited\n`);
    writeFileSync(join(dirty.cwd, 'scratch.txt'), 'untracked stray\n');
    const dirtyReport = await runFixtures({
      workflows: [workflowsOnDisk(dirty.cwd, ['test-wf'])[0]],
      cwd: dirty.cwd,
    });
    expect(dirtyReport.passed).toBe(1);
  });

  it('keeps executed writes out of the caller checkout (#2851)', async () => {
    const { cwd } = writeTempProject({
      workflowName: 'writer-wf',
      workflowYaml: WRITER_YAML,
      body: execFixtureBody,
    });
    await initGitWithCommittedFile(cwd);
    const report = await runFixtures({
      workflows: [workflowsOnDisk(cwd, ['writer-wf'])[0]],
      cwd,
    });
    // The node genuinely executed (passing would fail if it had errored); its write
    // landed somewhere that is not the caller's working tree.
    expect(report.results[0].outcome).toBe('completed');
    expect(existsSync(join(cwd, 'leak.txt'))).toBe(false);
    expect(readFileSync(join(cwd, 'tracked.txt'), 'utf8')).toBe(COMMITTED_YAML);
  });

  it('resolves named scripts from the caller tree, not the scratch worktree (#2851)', async () => {
    const { cwd } = writeTempProject({
      workflowName: 'script-wf',
      workflowYaml: [
        'name: script-wf',
        'description: runs a named script',
        'nodes:',
        '  - id: run-script',
        '    script: greet-script',
        '    runtime: bun',
      ].join('\n'),
      body: execFixtureBody,
    });
    await initGitWithCommittedFile(cwd);
    // Written after the commit, so the scratch worktree of HEAD cannot contain it:
    // only caller-tree (`cwd`) source resolution can find this script.
    mkdirSync(join(cwd, '.archon', 'scripts'), { recursive: true });
    writeFileSync(join(cwd, '.archon', 'scripts', 'greet-script.ts'), 'console.log("ok")\n');
    const report = await runFixtures({
      workflows: [workflowsOnDisk(cwd, ['script-wf'])[0]],
      cwd,
    });
    expect(report.failed).toBe(0);
    expect(report.results[0].outcome).toBe('completed');
  });

  it('disposes the scratch worktree after each fixture (#2851)', async () => {
    const { cwd } = writeTempProject({ workflowYaml: GUARD_YAML, body: execFixtureBody });
    await initGitWithCommittedFile(cwd);
    const home = mkdtempSync(join(tmpdir(), 'fixture-runner-home-'));
    cleanups.push(home);
    const previousHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = home;
    try {
      const report = await runFixtures({
        workflows: [workflowsOnDisk(cwd, ['test-wf'])[0]],
        cwd,
      });
      expect(report.failed).toBe(0);
    } finally {
      if (previousHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = previousHome;
    }
    // `git worktree add` records metadata in the caller's .git, so a leaked
    // workspace would show up here as a stale entry.
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd });
    expect(stdout).not.toContain('fixture-exec-');
    expect(stdout.split('\n').filter(line => line.startsWith('worktree '))).toHaveLength(1);
    expect(
      readdirSync(join(home, 'temp')).filter(entry => entry.startsWith('fixture-exec-'))
    ).toEqual([]);
  });

  it('fails an exec-code fixture in a directory outside any git repository', async () => {
    const { cwd } = writeTempProject({
      workflowName: 'writer-wf',
      workflowYaml: WRITER_YAML,
      body: execFixtureBody,
    });
    const report = await runFixtures({
      workflows: [workflowsOnDisk(cwd, ['writer-wf'])[0]],
      cwd,
    });
    expect(report.failed).toBe(1);
    expect(report.results[0].failureReason).toContain('not inside a git repository');
  });
});
