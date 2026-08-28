import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from 'bun:test';

const serverPath = resolve(import.meta.dir, '../..');
const outputPath = resolve(import.meta.dir, '../../../web/src/lib/api.generated.d.ts');

test('check rejects stale API types without rewriting them', async () => {
  const original = await readFile(outputPath);
  const stale = Buffer.concat([original, Buffer.from('\n// stale test declaration\n')]);

  await writeFile(outputPath, stale);
  try {
    const check = Bun.spawn(['bun', 'src/scripts/generate-api-types.ts', '--check'], {
      cwd: serverPath,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      check.exited,
      new Response(check.stdout).text(),
      new Response(check.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(`${stdout}${stderr}`).toContain('api.generated.d.ts is stale.');
    expect(await readFile(outputPath)).toEqual(stale);
  } finally {
    await writeFile(outputPath, original);
  }
});
