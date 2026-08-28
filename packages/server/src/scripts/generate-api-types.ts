import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { OpenAPIHono } from '@hono/zod-openapi';
import { format, resolveConfig } from 'prettier';
import { registerApiRoutes } from '../routes/api';

const OUTPUT_PATH = resolve(import.meta.dir, '../../../web/src/lib/api.generated.d.ts');
const GENERATOR_PATH = resolve(
  import.meta.dir,
  '../../../web/node_modules/openapi-typescript/bin/cli.js'
);
const CHECK_ONLY = process.argv.includes('--check');

async function generateApiTypes(): Promise<string> {
  const app = new OpenAPIHono();
  registerApiRoutes(app, {} as never, {} as never);

  const response = await app.request('/api/openapi.json');
  if (!response.ok) {
    throw new Error(`OpenAPI route returned ${response.status}.`);
  }

  const generator = Bun.spawn([process.execPath, GENERATOR_PATH], {
    stdin: new TextEncoder().encode(JSON.stringify(await response.json())),
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const output = await new Response(generator.stdout).text();
  if ((await generator.exited) !== 0) {
    throw new Error('openapi-typescript failed.');
  }
  return format(output, { ...(await resolveConfig(OUTPUT_PATH)), parser: 'typescript' });
}

async function main(): Promise<void> {
  const types = await generateApiTypes();

  if (CHECK_ONLY) {
    const existing = await readFile(OUTPUT_PATH, 'utf8');
    if (existing.replace(/\r\n/g, '\n') !== types) {
      console.error('api.generated.d.ts is stale.\nRun: bun run generate:api-types');
      process.exit(2);
    }
    console.log('check:api-types OK');
    return;
  }

  await writeFile(OUTPUT_PATH, types);
  console.log(`Generated ${OUTPUT_PATH}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
