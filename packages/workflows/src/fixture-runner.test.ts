/** Tests for the declared-data dry-run fixture runner (#2772). */
import { describe, it, expect, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  /** Pack layout like the bundled SDLC pack: `<pack>/<workflow-folder>/fixtures/`, plus a sibling pack whose name extends `sdlc` so the path-containment anchor cannot drift. */
  function writeNestedPackProject(): { cwd: string } {
    const cwd = makeTempProject();
    cleanups.push(cwd);
    for (const folder of ['plan', 'ship']) {
      const workflowDir = join(cwd, '.archon', 'workflows', 'sdlc', folder);
      mkdirSync(join(workflowDir, 'fixtures'), { recursive: true });
      writeFileSync(
        join(workflowDir, `${folder}-wf.yaml`),
        `name: ${folder}-wf\ndescription: test\nnodes:\n  - id: node-a\n    prompt: hello\n`
      );
      writeFileSync(
        join(workflowDir, 'fixtures', `${folder}.stubs.yaml`),
        ['fixture:', '  expect: completed', 'node-a: "stub output"', ''].join('\n')
      );
    }
    const extDir = join(cwd, '.archon', 'workflows', 'sdlc-ext', 'ext');
    mkdirSync(join(extDir, 'fixtures'), { recursive: true });
    writeFileSync(
      join(extDir, 'ext-wf.yaml'),
      'name: ext-wf\ndescription: test\nnodes:\n  - id: node-a\n    prompt: hello\n'
    );
    writeFileSync(
      join(extDir, 'fixtures', 'ext.stubs.yaml'),
      ['fixture:', '  expect: completed', 'node-a: "stub output"', ''].join('\n')
    );
    return { cwd };
  }

  it('resolves a nested pack by name, workflow folder, and pack directory path', async () => {
    const { cwd } = writeNestedPackProject();
    const workflows = [
      ...workflowsOnDisk(cwd, ['plan-wf'], 'sdlc/plan'),
      ...workflowsOnDisk(cwd, ['ship-wf'], 'sdlc/ship'),
      ...workflowsOnDisk(cwd, ['ext-wf'], 'sdlc-ext/ext'),
    ];
    const fixtureLabels = (target: string | undefined) =>
      runFixtures({ workflows, cwd, ...(target !== undefined ? { target } : {}) }).then(report =>
        report.results.map(r => r.fixture)
      );

    const packPath = join(cwd, '.archon', 'workflows', 'sdlc');
    // Exact labels pin both the scope-root-relative shape and the boundary against the
    // prefix-named `sdlc-ext` sibling: the `dir + sep` containment anchor must never match it.
    await expect(fixtureLabels('sdlc')).resolves.toEqual([
      'sdlc/plan/fixtures/plan.stubs.yaml',
      'sdlc/ship/fixtures/ship.stubs.yaml',
    ]);
    await expect(fixtureLabels('ship')).resolves.toEqual(['sdlc/ship/fixtures/ship.stubs.yaml']);
    await expect(fixtureLabels('sdlc-ext')).resolves.toEqual([
      'sdlc-ext/ext/fixtures/ext.stubs.yaml',
    ]);
    await expect(fixtureLabels('.archon/workflows/sdlc')).resolves.toHaveLength(2);
    await expect(fixtureLabels(packPath)).resolves.toHaveLength(2);
    await expect(fixtureLabels(undefined)).resolves.toHaveLength(3);
  });

  // Junctions would also resolve on Windows, but fs.realpath's junction handling is
  // platform-dependent; ubuntu CI already runs this, and that is where the tmpdir
  // realpath is the identity and the symlink spelling is the only protection.
  it.skipIf(process.platform === 'win32')(
    'resolves a target spelled through a symlink to the pack directory',
    async () => {
      const { cwd } = writeNestedPackProject();
      const linkPath = join(cwd, 'sdlc-link');
      symlinkSync(join(cwd, '.archon', 'workflows', 'sdlc'), linkPath, 'dir');
      const workflows = [
        ...workflowsOnDisk(cwd, ['plan-wf'], 'sdlc/plan'),
        ...workflowsOnDisk(cwd, ['ship-wf'], 'sdlc/ship'),
        ...workflowsOnDisk(cwd, ['ext-wf'], 'sdlc-ext/ext'),
      ];
      const report = await runFixtures({ workflows, cwd, target: linkPath });
      // Selection outcomes, not implementation details: drops both the containment
      // anchor and the discovery-side realpath, so a revert cannot pass silently.
      expect(report.results.map(r => r.fixture)).toEqual([
        'sdlc/plan/fixtures/plan.stubs.yaml',
        'sdlc/ship/fixtures/ship.stubs.yaml',
      ]);
    }
  );

  it('selects by the union of workflow name and folder: a target that is both picks both', async () => {
    const cwd = makeTempProject();
    cleanups.push(cwd);
    // Workflow `ship` inside folder `plan`: its fixture matches by name only.
    const planDir = join(cwd, '.archon', 'workflows', 'sdlc', 'plan');
    mkdirSync(join(planDir, 'fixtures'), { recursive: true });
    writeFileSync(
      join(planDir, 'ship.yaml'),
      'name: ship\ndescription: test\nnodes:\n  - id: node-a\n    prompt: hello\n'
    );
    writeFileSync(
      join(planDir, 'fixtures', 'ship.stubs.yaml'),
      ['fixture:', '  expect: completed', 'node-a: "stub output"', ''].join('\n')
    );
    // Folder `ship` with a differently-named workflow: its fixture matches by folder only.
    const shipDir = join(cwd, '.archon', 'workflows', 'sdlc', 'ship');
    mkdirSync(join(shipDir, 'fixtures'), { recursive: true });
    writeFileSync(
      join(shipDir, 'ship-wf.yaml'),
      'name: ship-wf\ndescription: test\nnodes:\n  - id: node-a\n    prompt: hello\n'
    );
    writeFileSync(
      join(shipDir, 'fixtures', 'ship.stubs.yaml'),
      ['fixture:', '  expect: completed', 'node-a: "stub output"', ''].join('\n')
    );
    const report = await runFixtures({
      workflows: [
        ...workflowsOnDisk(cwd, ['ship'], 'sdlc/plan'),
        ...workflowsOnDisk(cwd, ['ship-wf'], 'sdlc/ship'),
      ],
      cwd,
      target: 'ship',
    });
    // Name-first precedence would drop the ship-folder fixture; dir-first would drop the plan one.
    expect(report.results.map(r => r.fixture).sort()).toEqual([
      'sdlc/plan/fixtures/ship.stubs.yaml',
      'sdlc/ship/fixtures/ship.stubs.yaml',
    ]);
  });
});
