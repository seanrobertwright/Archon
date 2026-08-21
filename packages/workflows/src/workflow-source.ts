/**
 * Run-owned capture of a workflow's executable SOURCE.
 *
 * Archon has always had two different directories hiding behind one `cwd`:
 *
 *   - the **source** a workflow, its commands, and its scripts are READ from, and
 *   - the **target** workspace the run ACTS on (provider turns, bash, git, output).
 *
 * Discovery reads the source; everything downstream re-derived it from the target's
 * `cwd`, so a workflow authored in checkout A but executed against worktree B looked
 * for `B/.archon/...` and found nothing. That gap was papered over by copying the
 * whole `.archon` tree into B, which dirtied B's git status, fed B's validators
 * foreign packages, and (because the copy is not scope-aware) carried `.archon/.env`
 * and megabytes of `state/` along with it.
 *
 * This module replaces that copy with a capture the RUN owns: the source directories
 * are frozen once, at run start, into `<run artifacts>/workflow-source/`, and every
 * later lookup resolves against the capture instead of the target. Two consequences
 * matter:
 *
 *   - **The target stays clean.** Nothing is written into B at all.
 *   - **The run stops moving under itself.** Editing or deleting A mid-run no longer
 *     changes the graph a paused run resumes into. That determinism is not new; today
 *     the `.archon` copy provides it accidentally. It is preserved here on purpose,
 *     somewhere it does not contaminate anything.
 *
 * The capture mirrors relative paths exactly, so `captureRoot` is a drop-in
 * replacement for a project root: `join(captureRoot, '.archon', 'workflows')` resolves
 * the same way `join(cwd, '.archon', 'workflows')` always has. That is deliberate —
 * it is what lets every existing resolver keep its shape and take a different root
 * instead of learning a new resource-lookup protocol.
 *
 * SCOPE: only PROJECT-scope source is captured. Global (`~/.archon`) and bundled
 * source are left live, because neither participates in the source/target split that
 * causes the bug: they resolve identically from any cwd. Freezing them would buy only
 * protection against a user editing their own home directory mid-run, at the cost of
 * copying two more trees per run.
 */
import { mkdir, readdir, copyFile, rm, rename, stat, lstat, realpath } from 'fs/promises';
import { dirname, join, relative, sep } from 'path';
import { createLogger } from '@archon/paths';
import * as archonPaths from '@archon/paths';
import { readWorkflowSourceMetadata } from './schemas/workflow-run';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.source');
  return cachedLog;
}

/**
 * Directory names never worth capturing: build caches, virtualenvs, and VCS metadata.
 * No workflow, command, or script reads these, and `__pycache__` alone can be larger
 * than the scripts it belongs to.
 */
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
]);

/**
 * Soft ceiling on a capture, in bytes. Exceeding it is NOT an error — a repo is
 * allowed a large scripts tree, and failing the run over it would be worse than the
 * cost. It logs once so an author who accidentally parks a dataset in
 * `.archon/scripts/` finds out from the run rather than from their disk.
 */
const CAPTURE_WARN_BYTES = 64 * 1024 * 1024;

/** Where a run's executable source came from, and what was frozen. */
export interface WorkflowSourceCapture {
  /** Absolute path usable directly as a project source root. */
  captureRoot: string;
  /** The authoring directory this was captured from. */
  origin: string;
  fileCount: number;
  byteCount: number;
}

/**
 * Project-relative directories that hold executable source.
 *
 * `.archon/commands/defaults` is nested inside `.archon/commands`, and a configured
 * `commands.folder` may nest inside either — {@link dedupeNestedDirs} collapses those
 * so a directory is never copied twice.
 */
function sourceDirectories(commandFolder: string | undefined): string[] {
  return dedupeNestedDirs([
    ...archonPaths.getWorkflowFolderSearchPaths(),
    '.archon/scripts',
    ...archonPaths.getCommandFolderSearchPaths(commandFolder),
  ]);
}

/**
 * Drop any directory contained by another in the list, so nesting cannot produce a
 * duplicate copy. Compares on path segments rather than string prefixes: `.archon/cmd`
 * is not inside `.archon/c` even though one string starts with the other.
 */
function dedupeNestedDirs(dirs: readonly string[]): string[] {
  const normalized = [...new Set(dirs.map(d => d.split(/[\\/]/).filter(Boolean).join(sep)))];
  return normalized.filter(
    candidate =>
      !normalized.some(other => other !== candidate && (candidate + sep).startsWith(other + sep))
  );
}

/**
 * Recursively copy `from` into `to`, skipping cache directories. Returns files+bytes copied.
 *
 * `ancestors` holds the canonical (symlink-resolved) path of every directory currently open
 * above this one. Because directory symlinks are followed rather than preserved, a link
 * pointing at one of its own ancestors would otherwise re-enter the same tree: the walk only
 * stops when the kernel refuses the path with ELOOP, by which point the same files have been
 * copied a dozen-plus times. Comparing canonical paths cuts the cycle at the first repeat.
 */
async function copyTree(
  from: string,
  to: string,
  ancestors: ReadonlySet<string> = new Set()
): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;

  const entries = await readdir(from, { withFileTypes: true });
  await mkdir(to, { recursive: true });

  for (const entry of entries) {
    const src = join(from, entry.name);
    const dest = join(to, entry.name);

    // Symlinks are DEREFERENCED into ordinary files. Preserving the link would keep a
    // live reference to a path outside the capture, which is the exact mutability this
    // module exists to remove. `stat` (not `lstat`) resolves the target; a dangling
    // link throws ENOENT and is skipped below rather than failing the whole capture.
    let info;
    try {
      info = await stat(src);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      getLog().warn({ err, path: src }, 'workflow.source_capture_entry_skipped');
      continue;
    }

    if (info.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      let canonical: string;
      try {
        canonical = await realpath(src);
      } catch (error) {
        getLog().warn({ err: error as Error, path: src }, 'workflow.source_capture_entry_skipped');
        continue;
      }
      if (ancestors.has(canonical)) {
        // A link back into a directory we are already inside. Copying it would duplicate
        // that subtree under itself, so record it and move on.
        getLog().warn({ path: src, canonical }, 'workflow.source_capture_cycle_skipped');
        continue;
      }
      const sub = await copyTree(src, dest, new Set([...ancestors, canonical]));
      files += sub.files;
      bytes += sub.bytes;
      continue;
    }

    if (!info.isFile()) continue; // sockets, fifos, devices — nothing a workflow reads

    await copyFile(src, dest);
    files += 1;
    bytes += info.size;
  }

  return { files, bytes };
}

/** True when `path` exists and is a directory. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Freeze `sourceRoot`'s project-scope executable source into `captureRoot`.
 *
 * Returns `null` when the source root holds no executable source at all — there is
 * nothing to freeze, so the caller keeps resolving live and the run behaves exactly
 * as it did before this feature existed.
 *
 * The capture is built in a sibling `.partial` directory and renamed into place, so a
 * failure part-way through can never leave a half-populated capture that later reads
 * would treat as authoritative.
 */
export async function captureWorkflowSource(opts: {
  sourceRoot: string;
  captureRoot: string;
  commandFolder?: string;
}): Promise<WorkflowSourceCapture | null> {
  const { sourceRoot, captureRoot, commandFolder } = opts;

  const present: string[] = [];
  for (const dir of sourceDirectories(commandFolder)) {
    if (await isDirectory(join(sourceRoot, dir))) present.push(dir);
  }
  if (present.length === 0) {
    getLog().debug({ sourceRoot }, 'workflow.source_capture_skipped_empty');
    return null;
  }

  const staging = `${captureRoot}.partial`;
  await rm(staging, { recursive: true, force: true });

  let fileCount = 0;
  let byteCount = 0;
  try {
    for (const dir of present) {
      const target = join(staging, dir);
      await mkdir(dirname(target), { recursive: true });
      const origin = join(sourceRoot, dir);
      // Seed the cycle guard with this root's canonical path so a link straight back to
      // the top of the tree is caught at depth one.
      const rootCanonical = await realpath(origin).catch(() => origin);
      const copied = await copyTree(origin, target, new Set([rootCanonical]));
      fileCount += copied.files;
      byteCount += copied.bytes;
    }
    // Replace rather than merge: a stale capture at this path would silently mix two
    // vintages of source, which is the failure this module exists to prevent.
    await rm(captureRoot, { recursive: true, force: true });
    await mkdir(dirname(captureRoot), { recursive: true });
    await rename(staging, captureRoot);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {
      /* best-effort: the partial directory is inert, and the original error matters more */
    });
    throw error;
  }

  if (byteCount > CAPTURE_WARN_BYTES) {
    getLog().warn(
      { sourceRoot, captureRoot, fileCount, byteCount, limitBytes: CAPTURE_WARN_BYTES },
      'workflow.source_capture_large'
    );
  }
  getLog().debug(
    { sourceRoot, captureRoot, fileCount, byteCount, dirs: present },
    'workflow.source_captured'
  );

  return { captureRoot, origin: sourceRoot, fileCount, byteCount };
}

/** Canonical location of a run's captured source, under that run's artifacts. */
export function getRunSourceCapturePath(artifactsDir: string): string {
  return join(artifactsDir, 'workflow-source');
}

/**
 * True when `capturePath` still holds a usable capture.
 *
 * Resume calls this before trusting recorded source. A capture that was removed (an
 * artifact-retention sweep, a hand-deleted run directory) must fall back to live
 * discovery with a warning rather than resolve every command to "not found".
 */
export async function isCaptureUsable(capturePath: string): Promise<boolean> {
  return isDirectory(capturePath);
}

/**
 * The frozen source a run recorded at start, if still on disk.
 *
 * This is what a run reloads its OWN graph and resources from. Returns `undefined` when
 * the run predates capture or its capture is gone — both mean "resolve live", the
 * pre-capture behavior.
 */
export async function resolveRunSourceRoot(
  metadata: Record<string, unknown> | undefined
): Promise<string | undefined> {
  const recorded = readWorkflowSourceMetadata(metadata);
  if (!recorded) return undefined;
  return (await isDirectory(recorded.root)) ? recorded.root : undefined;
}

/**
 * The AUTHORING directory a run was captured from, if it still exists.
 *
 * Deliberately different from {@link resolveRunSourceRoot}, and the difference is the
 * whole contract for sub-runs: a run freezes its own source, but a `workflow:` child
 * that has not started yet is not a run, so it must not be frozen into its parent.
 *
 * Two behaviors depend on reading the live origin here rather than the parent's capture:
 * a parent may author a workflow mid-flight and then execute it as a child, and — the
 * case with a test on it — a fan-out child cancelled at a gate is recovered by removing
 * the gate from the child workflow and resuming the parent. Resolving that child from
 * the parent's frozen copy would re-drive the OLD gated definition forever, so the fix
 * could never take. The child's own run captures at its own start, which is where its
 * determinism begins.
 */
export async function resolveChildDiscoveryRoot(
  metadata: Record<string, unknown> | undefined
): Promise<string | undefined> {
  const recorded = readWorkflowSourceMetadata(metadata);
  if (!recorded) return undefined;
  return (await isDirectory(recorded.origin)) ? recorded.origin : undefined;
}

/** Describe a capture path relative to a run's artifacts, for log/event payloads. */
export function describeCapture(artifactsDir: string, capturePath: string): string {
  const rel = relative(artifactsDir, capturePath);
  return rel === '' || rel.startsWith('..') ? capturePath : rel;
}
