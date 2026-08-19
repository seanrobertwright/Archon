import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@archon/paths';
import {
  nodeArtifactSchema,
  type NodeArtifact,
  type NodeArtifactLoopFrame,
} from './schemas/node-artifact';

/** Lazy logger (deferred so test mocks can intercept createLogger). */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('artifacts-index');
  return cachedLog;
}

/** Subdirectory under the artifacts dir holding per-node typed outputs + metadata. */
const NODES_SUBDIR = 'nodes';

/**
 * Restrict a node id to a single safe path segment for use in a filename.
 * Node ids are normally simple identifiers; this guards against a stray
 * separator or `..` escaping the nodes directory.
 */
function safeSegment(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Build the single filename segment that identifies one typed node execution. */
function artifactStem(nodeId: string, loopGroupPath?: NodeArtifactLoopFrame[]): string {
  const nodeSegment = safeSegment(nodeId);
  if (loopGroupPath === undefined) return nodeSegment;

  const loopSegments = loopGroupPath.map(
    frame => `${safeSegment(frame.groupId)}-iteration-${String(frame.iteration)}`
  );
  return `${loopSegments.join('__')}__${nodeSegment}`;
}

type ArtifactOwner = Pick<NodeArtifact, 'nodeId' | 'loopGroupPath'>;

function sameLoopGroupPath(
  left: NodeArtifactLoopFrame[] | undefined,
  right: NodeArtifactLoopFrame[] | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.length === right.length &&
    left.every(
      (frame, index) =>
        frame.groupId === right[index]?.groupId && frame.iteration === right[index]?.iteration
    )
  );
}

function sameArtifactOwner(left: ArtifactOwner, right: ArtifactOwner): boolean {
  return left.nodeId === right.nodeId && sameLoopGroupPath(left.loopGroupPath, right.loopGroupPath);
}

/**
 * Read the owner recorded in an existing `.meta.json`, or `undefined` if the
 * file is missing or unreadable. Used only by the collision guard in
 * `writeNodeArtifact` — a missing or corrupt prior file is treated as "no known
 * owner" so the write proceeds (and overwrites the unusable file).
 */
async function readArtifactOwner(metaPath: string): Promise<ArtifactOwner | undefined> {
  try {
    const parsed = nodeArtifactSchema
      .pick({ nodeId: true, loopGroupPath: true })
      .safeParse(JSON.parse(await readFile(metaPath, 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write a node's typed output artifact: the output text and metadata under
 * `nodes/`. Top-level nodes retain `nodes/<id>.md` + `<id>.meta.json`; a
 * loop_group body execution qualifies that identity with its ordered loop frames.
 * Per-execution files (no shared index): the index is derived on read by globbing,
 * so separate nodes, iterations, and runs never overwrite one another's metadata.
 * Writes are issued sequentially after each layer settles — there is no in-run
 * write contention; the per-node layout is what isolates one node from the next.
 *
 * Returns the written metadata. Throws on fs failure or a sanitized-id collision
 * — callers persist artifacts best-effort and must wrap this in their own
 * try/catch so an artifact write never fails an otherwise-successful node.
 */
export async function writeNodeArtifact(
  artifactsDir: string,
  params: Omit<NodeArtifact, 'path' | 'size'>,
  outputText: string
): Promise<NodeArtifact> {
  const nodesDir = join(artifactsDir, NODES_SUBDIR);
  await mkdir(nodesDir, { recursive: true });
  const stem = artifactStem(params.nodeId, params.loopGroupPath);
  const metaPath = join(nodesDir, `${stem}.meta.json`);

  // Collision guard: safeSegment() can collapse distinct node or group ids (for
  // example `a.b` and `a_b`) onto one filename. Compare the complete producer
  // identity — body node plus ordered loop frames — and fail loudly instead of
  // silently overwriting a different artifact. The best-effort caller logs it;
  // first writer wins.
  const owner: ArtifactOwner = {
    nodeId: params.nodeId,
    ...(params.loopGroupPath !== undefined ? { loopGroupPath: params.loopGroupPath } : {}),
  };
  const priorOwner = await readArtifactOwner(metaPath);
  if (priorOwner !== undefined && !sameArtifactOwner(priorOwner, owner)) {
    throw new Error(
      `node artifact id collision: distinct producers both map to filename segment '${stem}'`
    );
  }

  const relPath = join(NODES_SUBDIR, `${stem}.md`);
  await writeFile(join(artifactsDir, relPath), outputText, 'utf8');
  const meta: NodeArtifact = {
    nodeId: params.nodeId,
    outputType: params.outputType,
    ...(params.loopGroupPath !== undefined ? { loopGroupPath: params.loopGroupPath } : {}),
    path: relPath,
    runId: params.runId,
    producedAt: params.producedAt,
    size: Buffer.byteLength(outputText, 'utf8'),
    ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
  };
  await writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

/**
 * Read all typed-artifact metadata entries from an artifacts dir by globbing
 * the per-node `.meta.json` files (the index is derived on read, never a single
 * shared file). A missing dir yields `[]` (no artifacts yet — not an error);
 * an unreadable/corrupt entry is skipped with a warning, not fatal.
 */
export async function readNodeArtifacts(artifactsDir: string): Promise<NodeArtifact[]> {
  const nodesDir = join(artifactsDir, NODES_SUBDIR);
  let files: string[];
  try {
    files = await readdir(nodesDir);
  } catch (err) {
    // ENOENT = the nodes dir was never created → no artifacts yet, not an error.
    // Any other fault (EACCES/ENOTDIR/EIO) must NOT masquerade as "empty" — a
    // permissions/disk problem should surface, not silently yield no artifacts.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    getLog().warn({ nodesDir, err: err as Error }, 'artifacts.nodes_dir_read_failed');
    throw err;
  }
  const out: NodeArtifact[] = [];
  for (const file of files) {
    if (!file.endsWith('.meta.json')) continue;
    const full = join(nodesDir, file);
    try {
      const parsed = nodeArtifactSchema.safeParse(JSON.parse(await readFile(full, 'utf8')));
      if (parsed.success) {
        out.push(parsed.data);
      } else {
        getLog().warn({ file: full, issues: parsed.error.issues }, 'artifacts.index_entry_invalid');
      }
    } catch (err) {
      getLog().warn({ file: full, err: err as Error }, 'artifacts.index_entry_read_failed');
    }
  }
  return out;
}

/**
 * Return the most-recently-produced artifact of a given `output_type`, or
 * `undefined` if none exists. `producedAt` is a schema-validated ISO-8601 UTC
 * datetime, so the values sort lexicographically.
 */
export async function latestNodeArtifactOfType(
  artifactsDir: string,
  outputType: string
): Promise<NodeArtifact | undefined> {
  const matching = (await readNodeArtifacts(artifactsDir)).filter(e => e.outputType === outputType);
  let latest: NodeArtifact | undefined;
  for (const entry of matching) {
    if (latest === undefined || entry.producedAt > latest.producedAt) {
      latest = entry;
    }
  }
  return latest;
}
