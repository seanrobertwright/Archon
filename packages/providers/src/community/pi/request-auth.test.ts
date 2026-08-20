import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AuthStorage, ModelRegistry } from '@earendil-works/pi-coding-agent';

import { withCustomProviderRequestEnv } from './request-auth';

const createdDirs: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
const originalOpenAiKey = process.env.OPENAI_API_KEY;

function createAgentDir(apiKey?: string, headers?: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'archon-pi-models-'));
  const provider: Record<string, unknown> = {
    baseUrl: 'https://gateway.example/v1',
    api: 'openai-completions',
    models: [{ id: 'demo' }],
  };
  if (apiKey !== undefined) provider.apiKey = apiKey;
  if (headers !== undefined) provider.headers = headers;
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: { mygw: provider } }));
  createdDirs.push(dir);
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe('withCustomProviderRequestEnv', () => {
  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    restoreEnv('PI_CODING_AGENT_DIR', originalAgentDir);
    restoreEnv('ANTHROPIC_API_KEY', originalAnthropicKey);
    restoreEnv('OPENAI_API_KEY', originalOpenAiKey);
  });

  test('lets Pi resolve custom provider config from request/project env', async () => {
    createAgentDir('prefix-${MYGW_API_KEY}', { 'X-Project': '$MYGW_PROJECT' });
    const authStorage = withCustomProviderRequestEnv(
      AuthStorage.inMemory(),
      'mygw',
      {
        MYGW_API_KEY: 'request-secret',
        MYGW_PROJECT: 'project-123',
      },
      []
    );

    const registry = ModelRegistry.create(authStorage);
    const model = registry.find('mygw', 'demo');
    expect(model).toBeDefined();
    const resolved = await registry.getApiKeyAndHeaders(model!);

    expect(resolved).toEqual({
      ok: true,
      apiKey: 'prefix-request-secret',
      headers: { 'X-Project': 'project-123' },
      env: {
        MYGW_API_KEY: 'request-secret',
        MYGW_PROJECT: 'project-123',
      },
    });
  });

  test.each(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'])(
    'does not expose acting-user %s to custom provider config',
    async credentialEnvKey => {
      delete process.env[credentialEnvKey];
      createAgentDir(`$${credentialEnvKey}`);
      const authStorage = withCustomProviderRequestEnv(
        AuthStorage.inMemory(),
        'mygw',
        { [credentialEnvKey]: 'acting-user-secret' },
        [credentialEnvKey]
      );

      const registry = ModelRegistry.create(authStorage);
      const model = registry.find('mygw', 'demo');
      expect(model).toBeDefined();
      expect(await registry.getApiKeyAndHeaders(model!)).toEqual({
        ok: false,
        error: `Failed to resolve API key for provider "mygw" from environment variable: ${credentialEnvKey}`,
      });
    }
  );

  test('does not replace stored custom-provider auth or its provider env', async () => {
    createAgentDir('$MYGW_API_KEY');
    const stored = AuthStorage.inMemory({
      mygw: {
        type: 'api_key',
        key: '$MYGW_API_KEY',
        env: { MYGW_API_KEY: 'stored-secret' },
      },
    });
    const authStorage = withCustomProviderRequestEnv(
      stored,
      'mygw',
      { MYGW_API_KEY: 'request-secret' },
      []
    );

    expect(authStorage).toBe(stored);
    const registry = ModelRegistry.create(authStorage);
    const model = registry.find('mygw', 'demo');
    expect(model).toBeDefined();
    expect(await registry.getApiKeyAndHeaders(model!)).toEqual({
      ok: true,
      apiKey: 'stored-secret',
      env: { MYGW_API_KEY: 'stored-secret' },
    });
  });

  test('keeps credentialless custom providers valid', async () => {
    createAgentDir();
    const authStorage = withCustomProviderRequestEnv(
      AuthStorage.inMemory(),
      'mygw',
      { PROJECT_SETTING: 'value' },
      []
    );

    const registry = ModelRegistry.create(authStorage);
    const model = registry.find('mygw', 'demo');
    expect(model).toBeDefined();
    expect(await registry.getApiKeyAndHeaders(model!)).toEqual({
      ok: true,
      apiKey: undefined,
      env: { PROJECT_SETTING: 'value' },
    });
  });
});
