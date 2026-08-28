const DOCS_MANIFEST = 'packages/docs-web/package.json';
const DOCS_DIRECTORY = 'packages/docs-web/';
const EMPTY_GIT_SHA = '0000000000000000000000000000000000000000';

export function shouldRunTestSuite(changedFiles: Iterable<string>): boolean {
  for (const file of changedFiles) {
    if (file === DOCS_MANIFEST || (!file.endsWith('.md') && !file.startsWith(DOCS_DIRECTORY))) {
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
  console.log(shouldRunTestSuite(changedFiles(base, head)));
}

if (import.meta.main) main();
