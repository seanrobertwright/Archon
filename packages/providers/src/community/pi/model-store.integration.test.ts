/**
 * Real-SDK acceptance test for the dynamic model catalog (#2682).
 *
 * pi-coding-agent 0.84's `ModelRuntime.create()` builds its model collection
 * store-aware: models the user's Pi TUI learned dynamically land in
 * `~/.pi/agent/models-store.json` and resolve in Archon without any Archon
 * configuration — model availability derives from the user's Pi, not from a
 * frozen snapshot baked into whichever SDK version Archon pins.
 *
 * The acceptance criterion (maintainer direction on #2682): a model present
 * in the user's `models-store.json` and absent from the baked catalog
 * resolves through the exact construction `provider.ts` performs —
 * `new ModelRegistry(await ModelRuntime.create(...))` followed by
 * `registry.find(provider, modelId)`.
 *
 * Mock-isolation note: `provider.test.ts` mocks
 * `@earendil-works/pi-coding-agent` at module scope, and Bun's
 * `mock.module()` is process-global, irreversible, and matches subpath
 * imports of the mocked package too. This file therefore loads the SDK by
 * filesystem deep path and probes the result; when the mock is in effect
 * (multiple files bundled into one `bun test` process) the test self-skips
 * with a pointer at the right invocation. The package.json test script runs
 * this file in its own process, so it always exercises the real SDK in CI —
 * same pattern as request-auth.integration.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

interface RealPiSdk {
  ModelRuntime: {
    create(options?: { authPath?: string }): Promise<object>;
  };
  ModelRegistry: new (runtime: object) => {
    find(provider: string, modelId: string): { provider: string; id: string } | undefined;
  };
}

async function loadRealSdk(): Promise<RealPiSdk> {
  const sdkIndexPath = fileURLToPath(await import.meta.resolve('@earendil-works/pi-coding-agent'));
  const load = async <T>(file: string): Promise<T> =>
    (await import(pathToFileURL(join(dirname(sdkIndexPath), 'core', file)).href)) as T;
  const { ModelRuntime } = await load<Pick<RealPiSdk, 'ModelRuntime'>>('model-runtime.js');
  const { ModelRegistry } = await load<Pick<RealPiSdk, 'ModelRegistry'>>('model-registry.js');
  return { ModelRuntime, ModelRegistry };
}

/** True iff the deep-path load yields the real SDK (vs provider.test.ts's mock). */
async function probeRealSdkAvailable(): Promise<boolean> {
  try {
    const { ModelRuntime, ModelRegistry } = await loadRealSdk();
    return typeof ModelRuntime.create === 'function' && typeof ModelRegistry === 'function';
  } catch {
    return false;
  }
}

const realSdkAvailable = await probeRealSdkAvailable();
if (!realSdkAvailable) {
  console.warn(
    '\n⚠️  model-store.integration.test.ts: skipping — the real pi-coding-agent SDK\n' +
      '   is not loadable in this bun process (mock.module contamination). Run:\n' +
      '     bun test src/community/pi/model-store.integration.test.ts\n'
  );
}

/** A model ref that exists ONLY in the scratch models-store.json below. */
const STORE_ONLY_MODEL = { provider: 'openrouter', id: 'archon-test/store-only-model' };

describe('dynamic model catalog (models-store.json)', () => {
  let scratchDir: string | undefined;
  let originalAgentDir: string | undefined;
  let originalOffline: string | undefined;

  beforeEach(() => {
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    originalOffline = process.env.PI_OFFLINE;
    scratchDir = mkdtempSync(join(tmpdir(), 'archon-pi-model-store-'));
    process.env.PI_CODING_AGENT_DIR = scratchDir;
    // Belt and braces: create() defaults to no network refresh, and
    // PI_OFFLINE gates any runtime network path the SDK might add.
    process.env.PI_OFFLINE = '1';
  });

  afterEach(() => {
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = originalOffline;
  });

  test.skipIf(!realSdkAvailable)(
    'a model present only in models-store.json resolves via ModelRegistry.find',
    async () => {
      // The store shape the Pi TUI writes: per-provider model lists learned
      // from the provider's live catalog.
      writeFileSync(
        join(scratchDir as string, 'models-store.json'),
        JSON.stringify({
          openrouter: {
            models: [
              {
                id: STORE_ONLY_MODEL.id,
                name: 'Archon store-only test model',
                api: 'openai-completions',
                baseUrl: 'https://openrouter.ai/api/v1',
                provider: STORE_ONLY_MODEL.provider,
                reasoning: false,
                input: ['text'],
                cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 131072,
                maxTokens: 32768,
              },
            ],
            checkedAt: Date.now(),
            lastModified: Date.now(),
          },
        })
      );

      const { ModelRuntime, ModelRegistry } = await loadRealSdk();
      // Same construction as provider.ts step 2 (authPath undefined here —
      // auth is irrelevant to catalog resolution).
      const runtime = await ModelRuntime.create({});
      const registry = new ModelRegistry(runtime);

      const model = registry.find(STORE_ONLY_MODEL.provider, STORE_ONLY_MODEL.id);
      expect(model).toBeDefined();
      expect(model?.provider).toBe(STORE_ONLY_MODEL.provider);
      expect(model?.id).toBe(STORE_ONLY_MODEL.id);
    }
  );
});
