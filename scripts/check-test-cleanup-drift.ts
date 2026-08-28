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
  functions: Set<string>;
  namespaces: Set<string>;
}

function fsBindings(sourceFile: ts.SourceFile): FsBindings {
  const functions = new Set<string>();
  const namespaces = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    if (!FS_MODULES.has(statement.moduleSpecifier.text) || statement.importClause === undefined)
      continue;

    const { importClause } = statement;
    if (importClause.name !== undefined) namespaces.add(importClause.name.text);
    const bindings = importClause.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      if (RM_NAMES.has(element.propertyName?.text ?? element.name.text)) {
        functions.add(element.name.text);
      }
    }
  }

  return { functions, namespaces };
}

function rmCallName(call: ts.CallExpression, bindings: FsBindings): string | undefined {
  if (ts.isIdentifier(call.expression)) {
    return bindings.functions.has(call.expression.text) ? call.expression.text : undefined;
  }
  if (
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    bindings.namespaces.has(call.expression.expression.text) &&
    RM_NAMES.has(call.expression.name.text)
  ) {
    return call.expression.name.text;
  }
  return undefined;
}

function hasRecursiveOption(call: ts.CallExpression): boolean {
  const options = call.arguments[1];
  if (options === undefined || !ts.isObjectLiteralExpression(options)) return false;
  return options.properties.some(
    property =>
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === 'recursive' &&
      property.initializer.kind === ts.SyntaxKind.TrueKeyword
  );
}

function hasRetryOption(call: ts.CallExpression): boolean {
  const options = call.arguments[1];
  if (options === undefined || !ts.isObjectLiteralExpression(options)) return false;
  return options.properties.some(
    property =>
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      RETRY_OPTIONS.has(property.name.text)
  );
}

function isTeardownCallback(node: ts.Node): boolean {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;
  const parent = node.parent;
  if (!ts.isCallExpression(parent)) return false;
  return (
    parent.arguments.includes(node) &&
    ts.isIdentifier(parent.expression) &&
    (parent.expression.text === 'afterEach' || parent.expression.text === 'afterAll')
  );
}

function isInTeardown(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (
      ts.isBlock(current) &&
      ts.isTryStatement(current.parent) &&
      current.parent.finallyBlock === current
    ) {
      return true;
    }
    if (isTeardownCallback(current)) return true;
  }
  return false;
}

export function checkSource(file: string, source: string): DriftViolation[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const bindings = fsBindings(sourceFile);
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
            message: `${name} options must not use maxRetries or retryDelay; Bun ignores them`,
          });
        }
        if (TEST_FILE.test(file) && hasRecursiveOption(node) && isInTeardown(node)) {
          violations.push({
            file,
            line,
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

function violationKey(violation: DriftViolation): string {
  return violation.message;
}

function sourceViolationKeys(file: string, source: string): Map<string, number> {
  const keys = new Map<string, number>();
  for (const violation of checkSource(file, source)) {
    const key = violationKey(violation);
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
  return checkSource(file, source).filter(violation => {
    const key = violationKey(violation);
    const count = previous.get(key) ?? 0;
    if (count === 0) return true;
    previous.set(key, count - 1);
    return false;
  });
}

function gitOutput(args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'ignore',
  });
  return result.exitCode === 0 ? result.stdout.toString() : '';
}

export function checkRepository(root = REPO_ROOT): DriftViolation[] {
  const base = gitOutput(['merge-base', 'HEAD', 'origin/dev']).trim();
  if (base === '')
    throw new Error('Could not resolve the merge base with origin/dev for the drift check.');

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
    const baseSource = gitOutput(['show', `${base}:${file}`]);
    return checkChangedSource(
      file,
      readFileSync(path, 'utf8'),
      baseSource === '' ? undefined : baseSource
    );
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
