import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadWorkflowRunConfigFile,
  parseWorkflowRunConfig,
  sealWorkflowRunConfig,
  unsealWorkflowRunConfig,
} from './run-config';

const TEST_KEY = 'ab'.repeat(32);
let previousKey: string | undefined;

beforeEach(() => {
  previousKey = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
});

afterEach(() => {
  if (previousKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
  else process.env.TOKEN_ENCRYPTION_KEY = previousKey;
});

describe('workflow run config', () => {
  it('normalizes the complete runtime-owned sparse surface', () => {
    const parsed = parseWorkflowRunConfig(
      {
        defaultAssistant: 'pi',
        assistants: { pi: { model: 'minimax/MiniMax-M3', apiKey: 'secret' } },
        tiers: { large: { provider: 'codex', model: 'gpt-5.6-sol' } },
        aliases: { '@planner': { provider: 'claude', model: 'opus' } },
        workflows: { quotaMaxAttempts: 3 },
        docs: { path: 'handbook' },
        env: { BENCH_TOKEN: 'top-secret' },
      },
      { kind: 'http', label: 'inline' }
    );

    expect(parsed).toEqual({
      source: { kind: 'http', label: 'inline' },
      layer: {
        assistant: 'pi',
        assistants: { pi: { model: 'minimax/MiniMax-M3', apiKey: 'secret' } },
        tiers: { large: { provider: 'codex', model: 'gpt-5.6-sol' } },
        aliases: { '@planner': { provider: 'claude', model: 'opus' } },
        workflows: { quotaMaxAttempts: 3 },
        docsPath: 'handbook',
        envVars: { BENCH_TOKEN: 'top-secret' },
      },
    });
  });

  it('rejects unknown, ambiguous, and every unavailable top-level key with its name', () => {
    expect(() => parseWorkflowRunConfig(null, { kind: 'http', label: 'inline' })).toThrow(
      "Invalid run config at 'document'"
    );
    expect(() =>
      parseWorkflowRunConfig({ mystery: true }, { kind: 'http', label: 'inline' })
    ).toThrow("Unknown run config key 'mystery'");
    expect(() =>
      parseWorkflowRunConfig(
        { assistant: 'pi', defaultAssistant: 'claude' },
        { kind: 'http', label: 'inline' }
      )
    ).toThrow("both 'assistant' and 'defaultAssistant'");
    expect(() =>
      parseWorkflowRunConfig(
        { workflows: { quotaMaxAttempts: 2, mystery: true } },
        { kind: 'http', label: 'inline' }
      )
    ).toThrow("Invalid run config at 'workflows'");

    for (const key of [
      'commands',
      'defaults',
      'worktree',
      'container',
      'botName',
      'streaming',
      'paths',
      'concurrency',
      'recommendedWorkflows',
    ]) {
      expect(() =>
        parseWorkflowRunConfig({ [key]: {} }, { kind: 'http', label: 'inline' })
      ).toThrow(`Run config key '${key}' cannot apply`);
    }
  });

  it('seals secrets for replay while exposing only attribution and key paths', () => {
    const input = parseWorkflowRunConfig(
      {
        assistants: { pi: { apiKey: 'provider-secret' } },
        env: { TOKEN: 'env-secret' },
      },
      { kind: 'cli', label: 'config.minimax.yaml' }
    );
    const metadata = sealWorkflowRunConfig(input.layer, input.source);
    const serialized = JSON.stringify(metadata);

    expect(serialized).not.toContain('provider-secret');
    expect(serialized).not.toContain('env-secret');
    expect(metadata.keys).toEqual(['assistants.pi.apiKey', 'env.TOKEN']);
    expect(unsealWorkflowRunConfig(metadata)).toEqual(input.layer);
  });

  it('fails explicitly when persisted ciphertext is tampered with', () => {
    const input = parseWorkflowRunConfig(
      { env: { TOKEN: 'env-secret' } },
      { kind: 'http', label: 'inline' }
    );
    const metadata = sealWorkflowRunConfig(input.layer, input.source);
    expect(() =>
      unsealWorkflowRunConfig({ ...metadata, ciphertext: `${metadata.ciphertext.slice(0, -2)}xx` })
    ).toThrow('could not be decrypted');
  });

  it('loads a CLI YAML file through the strict parser', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'archon-run-config-'));
    const fixture = join(dir, 'config.minimax.yaml');
    try {
      await writeFile(
        fixture,
        'tiers:\n  small: { provider: pi, model: minimax/MiniMax-M3 }\ndocs:\n  path: handbook\n'
      );
      await expect(loadWorkflowRunConfigFile(fixture)).resolves.toMatchObject({
        source: { kind: 'cli', label: 'config.minimax.yaml' },
        layer: {
          tiers: { small: { provider: 'pi', model: 'minimax/MiniMax-M3' } },
          docsPath: 'handbook',
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
