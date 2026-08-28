import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

const REPO_ROOT = resolve(import.meta.dir, '..');
const SOURCE_FILE = /\.(?:[cm]?ts|[cm]?js|tsx)$/;
const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?ts|[cm]?js|tsx)$/;
const FS_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);
const RM_NAMES = new Set(['rm', 'rmSync']);
const RETRY_OPTIONS = new Set(['maxRetries', 'retryDelay']);

/**
 * `retry-options` is repo-wide law: Bun parses and ignores `maxRetries`/`retryDelay`, so any
 * occurrence is inert code. `recursive-teardown` predates the shared helpers and still has a
 * frozen inventory, so it is scoped per file against `LEGACY_RECURSIVE_TEARDOWN`.
 */
export type DriftRule = 'retry-options' | 'recursive-teardown';

export interface DriftViolation {
  file: string;
  line: number;
  rule: DriftRule;
  message: string;
}

interface FsBindings {
  functions: Map<string, string>;
  namespaces: Set<string>;
  promiseNamespaces: Set<string>;
}

function fsBindings(sourceFile: ts.SourceFile): FsBindings {
  const functions = new Map<string, string>();
  const namespaces = new Set<string>();
  const promiseNamespaces = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const module = statement.moduleSpecifier.text;
    if (!FS_MODULES.has(module) || statement.importClause === undefined) continue;

    const { importClause } = statement;
    const isPromiseModule = module === 'fs/promises' || module === 'node:fs/promises';
    if (importClause.name !== undefined) {
      (isPromiseModule ? promiseNamespaces : namespaces).add(importClause.name.text);
    }
    const bindings = importClause.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      (isPromiseModule ? promiseNamespaces : namespaces).add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (importedName === 'promises' && !isPromiseModule) {
        promiseNamespaces.add(element.name.text);
      } else if (RM_NAMES.has(importedName) && (!isPromiseModule || importedName === 'rm')) {
        functions.set(element.name.text, importedName);
      }
    }
  }

  return { functions, namespaces, promiseNamespaces };
}

function rmCallName(call: ts.CallExpression, bindings: FsBindings): string | undefined {
  if (ts.isIdentifier(call.expression)) {
    return bindings.functions.get(call.expression.text);
  }
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;

  const { expression, name } = call.expression;
  if (ts.isIdentifier(expression)) {
    if (bindings.namespaces.has(expression.text) && RM_NAMES.has(name.text)) return name.text;
    if (bindings.promiseNamespaces.has(expression.text) && name.text === 'rm') return 'rm';
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    bindings.namespaces.has(expression.expression.text) &&
    expression.name.text === 'promises' &&
    name.text === 'rm'
  ) {
    return 'rm';
  }
  return undefined;
}

function propertyName(property: ts.PropertyAssignment): string | undefined {
  const { name } = property;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression)
    ? name.expression.text
    : undefined;
}

function hasRecursiveOption(call: ts.CallExpression): boolean {
  const options = call.arguments[1];
  if (options === undefined || !ts.isObjectLiteralExpression(options)) return false;
  return options.properties.some(
    property =>
      ts.isPropertyAssignment(property) &&
      propertyName(property) === 'recursive' &&
      property.initializer.kind === ts.SyntaxKind.TrueKeyword
  );
}

function hasRetryOption(call: ts.CallExpression): boolean {
  const options = call.arguments[1];
  if (options === undefined || !ts.isObjectLiteralExpression(options)) return false;
  return options.properties.some(
    property => ts.isPropertyAssignment(property) && RETRY_OPTIONS.has(propertyName(property) ?? '')
  );
}

interface TeardownBindings {
  hooks: Set<string>;
  namespaces: Set<string>;
}

function teardownBindings(sourceFile: ts.SourceFile): TeardownBindings {
  const hooks = new Set(['afterEach', 'afterAll']);
  const namespaces = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== 'bun:test' ||
      statement.importClause === undefined
    ) {
      continue;
    }

    const bindings = statement.importClause.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (importedName === 'afterEach' || importedName === 'afterAll') hooks.add(element.name.text);
    }
  }

  return { hooks, namespaces };
}

function isTeardownCallback(node: ts.Node, bindings: TeardownBindings): boolean {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;
  const parent = node.parent;
  if (!ts.isCallExpression(parent)) return false;
  if (!parent.arguments.includes(node)) return false;
  if (ts.isIdentifier(parent.expression)) return bindings.hooks.has(parent.expression.text);
  return (
    ts.isPropertyAccessExpression(parent.expression) &&
    ts.isIdentifier(parent.expression.expression) &&
    bindings.namespaces.has(parent.expression.expression.text) &&
    (parent.expression.name.text === 'afterEach' || parent.expression.name.text === 'afterAll')
  );
}

function isInTeardown(node: ts.Node, bindings: TeardownBindings): boolean {
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (
      ts.isBlock(current) &&
      ts.isTryStatement(current.parent) &&
      current.parent.finallyBlock === current
    ) {
      return true;
    }
    if (isTeardownCallback(current, bindings)) return true;
  }
  return false;
}

export function checkSource(file: string, source: string): DriftViolation[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const bindings = fsBindings(sourceFile);
  const teardown = teardownBindings(sourceFile);
  const violations: DriftViolation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = rmCallName(node, bindings);
      if (name !== undefined) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        if (hasRetryOption(node)) {
          violations.push({
            file,
            line,
            rule: 'retry-options',
            message: `${name} options must not use maxRetries or retryDelay; Bun ignores them`,
          });
        }
        if (TEST_FILE.test(file) && hasRecursiveOption(node) && isInTeardown(node, teardown)) {
          violations.push({
            file,
            line,
            rule: 'recursive-teardown',
            message: `recursive ${name} test teardown must use removeTempTree or trackTempRoots`,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

/**
 * Recursive test teardown that predates the shared helpers from PR #2874. Rewriting this
 * inventory is out of scope for #2885, so these counts freeze it: a file may not gain a site,
 * and an entry must be lowered or deleted once a file is cleaned up. The counts are exact
 * rather than a ceiling so the ledger cannot rot high after a cleanup and quietly reopen the
 * hole it was recording.
 */
export const LEGACY_RECURSIVE_TEARDOWN: ReadonlyMap<string, number> = new Map([
  ['.archon/scripts/__tests__/marketplace-fetch-source.test.ts', 2],
  ['.archon/scripts/maintainer-standup-persist.test.ts', 1],
  ['packages/cli/src/commands/doctor.test.ts', 2],
  ['packages/cli/src/commands/serve.test.ts', 1],
  ['packages/cli/src/commands/setup.test.ts', 4],
  ['packages/cli/src/commands/skill.test.ts', 2],
  ['packages/cli/src/commands/telemetry.test.ts', 2],
  ['packages/cli/src/commands/validate.test.ts', 1],
  ['packages/cli/src/commands/workflow.test.ts', 5],
  ['packages/cli/src/utils/safe-console.test.ts', 1],
  ['packages/cli/src/utils/stdout.test.ts', 1],
  ['packages/core/src/config/run-config.test.ts', 1],
  ['packages/core/src/credentials/config.test.ts', 1],
  ['packages/core/src/db/workflow-events.test.ts', 1],
  ['packages/core/src/github-auth/auth.test.ts', 3],
  ['packages/core/src/github-auth/credential-helper-install.test.ts', 1],
  ['packages/core/src/utils/token-crypto.test.ts', 2],
  ['packages/git/src/git.test.ts', 2],
  ['packages/paths/src/archon-paths.test.ts', 7],
  ['packages/paths/src/env-integration.test.ts', 2],
  ['packages/paths/src/env-loader.test.ts', 1],
  ['packages/paths/src/strip-cwd-env.test.ts', 3],
  ['packages/paths/src/telemetry.test.ts', 5],
  ['packages/paths/src/tier-notice.test.ts', 1],
  ['packages/paths/src/update-check.test.ts', 2],
  ['packages/providers/src/claude/provider.test.ts', 1],
  ['packages/providers/src/codex/provider.test.ts', 5],
  ['packages/providers/src/community/opencode/provider.test.ts', 1],
  ['packages/providers/src/community/pi/model-store.integration.test.ts', 1],
  ['packages/providers/src/community/pi/options-translator.test.ts', 1],
  ['packages/providers/src/community/pi/provider.test.ts', 6],
  ['packages/providers/src/community/pi/request-auth.integration.test.ts', 1],
  ['packages/providers/src/community/pi/request-auth.test.ts', 1],
  ['packages/providers/src/community/pi/resource-loader.test.ts', 1],
  ['packages/providers/src/shared/skills.test.ts', 2],
  ['packages/server/src/routes/api.workflow-runs.test.ts', 2],
  ['packages/server/src/routes/api.workflows.test.ts', 29],
  ['packages/workflows/src/artifacts-index.test.ts', 1],
  ['packages/workflows/src/dag-executor.test.ts', 57],
  ['packages/workflows/src/defaults/generate-bundled-defaults.test.ts', 6],
  ['packages/workflows/src/dry-run.test.ts', 1],
  ['packages/workflows/src/executor-preamble.test.ts', 1],
  ['packages/workflows/src/executor.test.ts', 3],
  ['packages/workflows/src/fixture-runner.test.ts', 2],
  ['packages/workflows/src/load-command-prompt.test.ts', 3],
  ['packages/workflows/src/loader.test.ts', 7],
  ['packages/workflows/src/logger.test.ts', 1],
  ['packages/workflows/src/script-node-deps.test.ts', 1],
  ['packages/workflows/src/state-migration.test.ts', 2],
  ['packages/workflows/src/subrun.test.ts', 8],
  ['packages/workflows/src/validator.test.ts', 5],
  ['packages/workflows/src/workflow-discovery-command-scan.test.ts', 1],
  ['packages/workflows/src/workflow-source-binary.test.ts', 1],
  ['packages/workflows/src/workflow-source.test.ts', 1],
]);

export function gitOutput(args: string[], cwd = REPO_ROOT): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode === 0) return result.stdout.toString();
  throw new Error(`Git command failed: git ${args.join(' ')}\n${result.stderr.toString().trim()}`);
}

/** Working-tree sources, tracked and untracked, excluding ignored paths. */
function repositorySources(root: string): Set<string> {
  const listed = [
    ...gitOutput(['ls-files'], root).split('\n'),
    ...gitOutput(['ls-files', '--others', '--exclude-standard'], root).split('\n'),
  ];
  return new Set(listed.filter(path => SOURCE_FILE.test(path)));
}

/**
 * Scans the whole working tree rather than the changed files: both rules are repository law, and
 * a diff-scoped check would accept drift that an earlier merge already introduced.
 */
export function checkRepository(root = REPO_ROOT, baseline = LEGACY_RECURSIVE_TEARDOWN): string[] {
  const failures: string[] = [];
  const teardown = new Map<string, DriftViolation[]>();

  for (const file of repositorySources(root)) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    for (const violation of checkSource(file, readFileSync(path, 'utf8'))) {
      if (violation.rule === 'retry-options') {
        failures.push(`${file}:${violation.line} ${violation.message}`);
        continue;
      }
      teardown.set(file, [...(teardown.get(file) ?? []), violation]);
    }
  }

  for (const file of new Set([...teardown.keys(), ...baseline.keys()])) {
    const found = teardown.get(file) ?? [];
    const recorded = baseline.get(file) ?? 0;
    if (found.length === recorded) continue;

    if (found.length < recorded) {
      const correction =
        found.length === 0
          ? 'delete its LEGACY_RECURSIVE_TEARDOWN entry'
          : `lower its LEGACY_RECURSIVE_TEARDOWN entry to ${found.length}`;
      failures.push(
        `${file}: ${found.length} recursive teardown sites, recorded ${recorded}; ${correction}`
      );
    } else if (recorded === 0) {
      // Nothing recorded, so every site is new and its line is the actionable detail.
      failures.push(...found.map(({ line, message }) => `${file}:${line} ${message}`));
    } else {
      // Listing every line of a legacy file buries the new one; the author's diff has it.
      failures.push(
        `${file}: ${found.length} recursive teardown sites exceed the recorded ${recorded}; new recursive teardown must use removeTempTree or trackTempRoots`
      );
    }
  }

  return failures;
}

if (import.meta.main) {
  const failures = checkRepository();
  if (failures.length > 0) {
    console.error(
      ['Test-cleanup drift detected:', ...failures.map(failure => `  ${failure}`)].join('\n')
    );
    process.exit(1);
  }
  console.log('Test-cleanup drift check passed.');
}
