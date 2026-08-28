import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

const REPO_ROOT = resolve(import.meta.dir, '..');
const SOURCE_FILE = /\.(?:[cm]?ts|[cm]?js|tsx)$/;
const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?ts|[cm]?js|tsx)$/;
const FS_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);
const RM_NAMES = new Set(['rm', 'rmSync']);
const RETRY_OPTIONS = new Set(['maxRetries', 'retryDelay']);

export interface DriftViolation {
  file: string;
  line: number;
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
  return ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
    ? property.name.text
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

interface DetectedViolation extends DriftViolation {
  identity: string;
}

function checkViolations(file: string, source: string): DetectedViolation[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const bindings = fsBindings(sourceFile);
  const teardown = teardownBindings(sourceFile);
  const violations: DetectedViolation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = rmCallName(node, bindings);
      if (name !== undefined) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        if (hasRetryOption(node)) {
          violations.push({
            file,
            line,
            message: `${name} options must not use maxRetries or retryDelay; Bun ignores them`,
            identity: node.getText(sourceFile),
          });
        }
        if (TEST_FILE.test(file) && hasRecursiveOption(node) && isInTeardown(node, teardown)) {
          violations.push({
            file,
            line,
            message: `recursive ${name} test teardown must use removeTempTree or trackTempRoots`,
            identity: node.getText(sourceFile),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

export function checkSource(file: string, source: string): DriftViolation[] {
  return checkViolations(file, source).map(({ identity: _identity, ...violation }) => violation);
}

function sourceViolationKeys(file: string, source: string): Map<string, number> {
  const keys = new Map<string, number>();
  for (const violation of checkViolations(file, source)) {
    const key = `${violation.message}\u0000${violation.identity}`;
    keys.set(key, (keys.get(key) ?? 0) + 1);
  }
  return keys;
}

export function checkChangedSource(
  file: string,
  source: string,
  baseSource: string | undefined
): DriftViolation[] {
  const previous = sourceViolationKeys(file, baseSource ?? '');
  return checkViolations(file, source).filter(violation => {
    const key = `${violation.message}\u0000${violation.identity}`;
    const count = previous.get(key) ?? 0;
    if (count === 0) return true;
    previous.set(key, count - 1);
    return false;
  });
}

export function gitOutput(args: string[]): string;
export function gitOutput(args: string[], allowFailure: true): string | undefined;
export function gitOutput(args: string[], allowFailure = false): string | undefined {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode === 0) return result.stdout.toString();
  if (allowFailure) return undefined;
  throw new Error(`Git command failed: git ${args.join(' ')}\n${result.stderr.toString().trim()}`);
}

export function checkRepository(root = REPO_ROOT): DriftViolation[] {
  const base = gitOutput(['merge-base', 'HEAD', 'origin/dev']).trim();

  const changed = new Set(
    gitOutput(['diff', '--name-only', base, '--'])
      .split('\n')
      .filter(path => SOURCE_FILE.test(path))
  );
  for (const path of gitOutput(['ls-files', '--others', '--exclude-standard']).split('\n')) {
    if (SOURCE_FILE.test(path)) changed.add(path);
  }

  return [...changed].flatMap(file => {
    const path = join(root, file);
    if (!existsSync(path)) return [];
    const baseSource = gitOutput(['show', `${base}:${file}`], true);
    return checkChangedSource(file, readFileSync(path, 'utf8'), baseSource);
  });
}

if (import.meta.main) {
  const violations = checkRepository();
  if (violations.length > 0) {
    console.error(
      [
        'Test-cleanup drift detected:',
        ...violations.map(({ file, line, message }) => `  ${file}:${line} ${message}`),
      ].join('\n')
    );
    process.exit(1);
  }
  console.log('Test-cleanup drift check passed.');
}
