const DOCS_DIRECTORY = 'packages/docs-web/';
const EMPTY_GIT_SHA = '0000000000000000000000000000000000000000';

/**
 * Paths that read as documentation but are build inputs, so changing one must run the suite.
 * Most Markdown in this repository is executable prompt or skill content rather than prose, and
 * the checks that guard it all live inside the job this decision can skip — so a bare `.md` test
 * would let a bundled-prompt edit skip the very check built to catch that drift.
 *
 * An entry ending in `/` matches a directory, anything else matches one file. Each is here
 * because a named check reads it:
 *   - `.archon/commands/`, `.archon/workflows/` are compiled into
 *     `packages/workflows/src/defaults/bundled-defaults.generated.ts` (`check:bundled`).
 *   - `.claude/skills/` is imported as text by `packages/cli/src/bundled-skill.ts`, so it is
 *     compiled into the CLI itself (`check:bundled-skill`).
 *   - `provider-capabilities.md` is generated from the providers' `capabilities.ts`
 *     (`check:capability-matrix`), and lives under the docs site without being prose.
 *   - The docs manifest is copied by the Docker dependency layer.
 */
const BUILD_INPUTS = [
  '.archon/commands/',
  '.archon/workflows/',
  '.claude/skills/',
  'packages/docs-web/src/content/docs/reference/provider-capabilities.md',
  'packages/docs-web/package.json',
];

const isBuildInput = (file: string): boolean =>
  BUILD_INPUTS.some(input => (input.endsWith('/') ? file.startsWith(input) : file === input));

export function shouldRunTestSuite(changedFiles: Iterable<string>): boolean {
  for (const file of changedFiles) {
    if (isBuildInput(file) || (!file.endsWith('.md') && !file.startsWith(DOCS_DIRECTORY))) {
      return true;
    }
  }
  return false;
}

function changedFiles(base: string, head: string): string[] {
  const result = Bun.spawnSync(['git', 'diff', '--name-only', '--no-renames', base, head], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`Could not read changed files: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().split('\n').filter(Boolean);
}

/**
 * A force-push leaves `github.event.before` naming a commit that is no longer reachable, so the
 * diff fails for a reason that says nothing about what changed. Run the suite rather than guess:
 * an unnecessary run costs minutes, a wrong skip merges unchecked code. The cause goes to stderr
 * so the job log explains why the suite ran.
 *
 * Only the scan is caught. A bad argument is a wiring bug with no safe answer, so it stays a
 * throw and takes the step down with it.
 */
function decideFromDiff(base: string, head: string): boolean {
  try {
    return shouldRunTestSuite(changedFiles(base, head));
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    console.error(`Could not compare ${base}..${head}, so the test suite runs: ${cause}`);
    return true;
  }
}

function main(): void {
  const [eventName, base, head] = process.argv.slice(2);
  if (eventName === 'workflow_dispatch') {
    console.log('true');
    return;
  }
  if ((eventName !== 'push' && eventName !== 'pull_request') || !base || !head) {
    throw new Error(`Unsupported GitHub event: ${eventName ?? '(missing)'}`);
  }
  if (base === EMPTY_GIT_SHA) {
    console.log('true');
    return;
  }
  console.log(decideFromDiff(base, head));
}

if (import.meta.main) main();
