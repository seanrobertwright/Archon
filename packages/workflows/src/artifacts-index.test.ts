import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeNodeArtifact, readNodeArtifacts, latestNodeArtifactOfType } from './artifacts-index';

describe('artifacts-index', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `artifacts-index-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('writeNodeArtifact writes the output file + metadata and returns the entry', async () => {
    const meta = await writeNodeArtifact(
      dir,
      {
        nodeId: 'planner',
        outputType: 'plan',
        runId: 'run-1',
        producedAt: '2026-06-03T00:00:00.000Z',
        sessionId: 'sess-1',
      },
      'the plan body'
    );

    expect(meta).toMatchObject({
      nodeId: 'planner',
      outputType: 'plan',
      path: join('nodes', 'planner.md'),
      runId: 'run-1',
      producedAt: '2026-06-03T00:00:00.000Z',
      sessionId: 'sess-1',
    });
    expect(meta.size).toBe(Buffer.byteLength('the plan body', 'utf8'));
    expect(await readFile(join(dir, 'nodes', 'planner.md'), 'utf8')).toBe('the plan body');
    const onDisk = JSON.parse(
      await readFile(join(dir, 'nodes', 'planner.meta.json'), 'utf8')
    ) as Record<string, unknown>;
    expect(onDisk.outputType).toBe('plan');
  });

  test('writeNodeArtifact omits sessionId when not provided', async () => {
    const meta = await writeNodeArtifact(
      dir,
      { nodeId: 'n', outputType: 'findings', runId: 'r', producedAt: '2026-06-03T00:00:00.000Z' },
      'x'
    );
    expect('sessionId' in meta).toBe(false);
  });

  test('loop_group lineages produce distinct readable artifact identities', async () => {
    const first = await writeNodeArtifact(
      dir,
      {
        nodeId: 'review',
        outputType: 'findings',
        loopGroupPath: [
          { groupId: 'outer', iteration: 1 },
          { groupId: 'inner', iteration: 1 },
        ],
        runId: 'r',
        producedAt: '2026-06-03T00:00:00.000Z',
      },
      'first'
    );
    const second = await writeNodeArtifact(
      dir,
      {
        nodeId: 'review',
        outputType: 'findings',
        loopGroupPath: [
          { groupId: 'outer', iteration: 2 },
          { groupId: 'inner', iteration: 1 },
        ],
        runId: 'r',
        producedAt: '2026-06-03T01:00:00.000Z',
      },
      'second'
    );

    expect(first.path).toBe(join('nodes', 'outer-iteration-1__inner-iteration-1__review.md'));
    expect(second.path).toBe(join('nodes', 'outer-iteration-2__inner-iteration-1__review.md'));
    expect(await readFile(join(dir, first.path), 'utf8')).toBe('first');
    expect(await readFile(join(dir, second.path), 'utf8')).toBe('second');
    const artifacts = (await readNodeArtifacts(dir)).sort((left, right) =>
      left.path.localeCompare(right.path)
    );
    expect(artifacts.map(entry => entry.loopGroupPath)).toEqual([
      [
        { groupId: 'outer', iteration: 1 },
        { groupId: 'inner', iteration: 1 },
      ],
      [
        { groupId: 'outer', iteration: 2 },
        { groupId: 'inner', iteration: 1 },
      ],
    ]);
  });

  test('readNodeArtifacts returns [] for a dir with no artifacts yet', async () => {
    expect(await readNodeArtifacts(dir)).toEqual([]);
  });

  test('readNodeArtifacts skips corrupt meta files (non-fatal)', async () => {
    await writeNodeArtifact(
      dir,
      { nodeId: 'good', outputType: 'plan', runId: 'r', producedAt: '2026-06-03T00:00:00.000Z' },
      'ok'
    );
    await writeFile(join(dir, 'nodes', 'bad.meta.json'), '{ not valid json', 'utf8');

    const entries = await readNodeArtifacts(dir);
    expect(entries.map(e => e.nodeId)).toEqual(['good']);
  });

  test('latestNodeArtifactOfType returns the newest of a given type', async () => {
    await writeNodeArtifact(
      dir,
      { nodeId: 'a', outputType: 'plan', runId: 'r', producedAt: '2026-06-03T00:00:00.000Z' },
      'older'
    );
    await writeNodeArtifact(
      dir,
      { nodeId: 'b', outputType: 'plan', runId: 'r', producedAt: '2026-06-03T01:00:00.000Z' },
      'newer'
    );
    await writeNodeArtifact(
      dir,
      { nodeId: 'c', outputType: 'code', runId: 'r', producedAt: '2026-06-03T02:00:00.000Z' },
      'other'
    );

    const latest = await latestNodeArtifactOfType(dir, 'plan');
    expect(latest?.nodeId).toBe('b');
    expect(await latestNodeArtifactOfType(dir, 'missing')).toBeUndefined();
  });

  test('a node id with path separators is sanitized to a single safe segment', async () => {
    const meta = await writeNodeArtifact(
      dir,
      { nodeId: '../evil', outputType: 'plan', runId: 'r', producedAt: '2026-06-03T00:00:00.000Z' },
      'x'
    );
    expect(meta.path).toBe(join('nodes', '___evil.md'));
    expect(meta.path).not.toContain('..');
    // The original id is preserved in metadata even though the filename is sanitized.
    expect(meta.nodeId).toBe('../evil');
  });

  test('two distinct node ids that collide on the same safe segment fail loudly (no silent overwrite)', async () => {
    await writeNodeArtifact(
      dir,
      { nodeId: 'a.b', outputType: 'plan', runId: 'r', producedAt: '2026-06-03T00:00:00.000Z' },
      'first'
    );
    // `a.b` and `a_b` both sanitize to `a_b` — the second write must throw rather
    // than silently clobber the first node's artifact.
    await expect(
      writeNodeArtifact(
        dir,
        { nodeId: 'a_b', outputType: 'plan', runId: 'r', producedAt: '2026-06-03T00:01:00.000Z' },
        'second'
      )
    ).rejects.toThrow(/collision/);
    // First writer wins; its artifact is intact.
    expect(await readFile(join(dir, 'nodes', 'a_b.md'), 'utf8')).toBe('first');
    const entries = await readNodeArtifacts(dir);
    expect(entries.map(e => e.nodeId)).toEqual(['a.b']);
  });

  test('distinct loop_group owners that sanitize to one stem fail loudly', async () => {
    await writeNodeArtifact(
      dir,
      {
        nodeId: 'review',
        outputType: 'findings',
        loopGroupPath: [{ groupId: 'a.b', iteration: 1 }],
        runId: 'r',
        producedAt: '2026-06-03T00:00:00.000Z',
      },
      'first'
    );

    await expect(
      writeNodeArtifact(
        dir,
        {
          nodeId: 'review',
          outputType: 'findings',
          loopGroupPath: [{ groupId: 'a_b', iteration: 1 }],
          runId: 'r',
          producedAt: '2026-06-03T01:00:00.000Z',
        },
        'second'
      )
    ).rejects.toThrow(/collision/);

    expect(await readFile(join(dir, 'nodes', 'a_b-iteration-1__review.md'), 'utf8')).toBe('first');
  });

  test('readNodeArtifacts rejects invalid loop_group frame metadata', async () => {
    await writeNodeArtifact(
      dir,
      { nodeId: 'good', outputType: 'plan', runId: 'r', producedAt: '2026-06-03T00:00:00.000Z' },
      'ok'
    );
    await writeFile(
      join(dir, 'nodes', 'empty-loop.meta.json'),
      JSON.stringify({
        nodeId: 'empty-loop',
        outputType: 'plan',
        loopGroupPath: [],
        path: 'nodes/empty-loop.md',
        runId: 'r',
        producedAt: '2026-06-03T00:00:00.000Z',
        size: 1,
      }),
      'utf8'
    );
    await writeFile(
      join(dir, 'nodes', 'zero-iteration.meta.json'),
      JSON.stringify({
        nodeId: 'zero-iteration',
        outputType: 'plan',
        loopGroupPath: [{ groupId: 'group', iteration: 0 }],
        path: 'nodes/zero-iteration.md',
        runId: 'r',
        producedAt: '2026-06-03T00:00:00.000Z',
        size: 1,
      }),
      'utf8'
    );

    expect((await readNodeArtifacts(dir)).map(entry => entry.nodeId)).toEqual(['good']);
  });

  test('re-writing the SAME node id (e.g. on resume) overwrites without a collision error', async () => {
    await writeNodeArtifact(
      dir,
      { nodeId: 'planner', outputType: 'plan', runId: 'r', producedAt: '2026-06-03T00:00:00.000Z' },
      'v1'
    );
    await writeNodeArtifact(
      dir,
      { nodeId: 'planner', outputType: 'plan', runId: 'r', producedAt: '2026-06-03T01:00:00.000Z' },
      'v2'
    );
    expect(await readFile(join(dir, 'nodes', 'planner.md'), 'utf8')).toBe('v2');
  });

  test('readNodeArtifacts skips schema-invalid meta files (valid JSON, wrong shape)', async () => {
    await writeNodeArtifact(
      dir,
      { nodeId: 'good', outputType: 'plan', runId: 'r', producedAt: '2026-06-03T00:00:00.000Z' },
      'ok'
    );
    // Parseable JSON but missing required fields → safeParse fails → skipped, not fatal.
    await writeFile(join(dir, 'nodes', 'wrong.meta.json'), JSON.stringify({ foo: 'bar' }), 'utf8');

    const entries = await readNodeArtifacts(dir);
    expect(entries.map(e => e.nodeId)).toEqual(['good']);
  });
});
