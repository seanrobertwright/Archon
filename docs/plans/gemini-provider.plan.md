# Feature: Gemini Community Provider

## Summary
Add a Gemini AI agent provider to Archon as a community provider (`builtIn: false`) at `packages/providers/src/community/gemini/`, mirroring the Pi community provider structure. The provider wraps `@lrilai/gemini-cli-sdk` and uses ambient gemini-cli OAuth login (no API key from Archon).

## Mission
Port the reference adapter from `seanrobertwright/Gemini-CLI-SDK` into Archon's `@archon/providers` package, applying three mandatory port-time fixes, wiring it into the registry, and extending doctor, config, Web UI, docs, and tests with full parity to the Pi community provider.

## Success Criteria
- [ ] `GeminiProvider` implements `IAgentProvider` and is registered with `builtIn: false`
- [ ] `registerCommunityProviders()` includes Gemini alongside Pi
- [ ] `bun run cli doctor` prints a Gemini check (skip when not configured, pass/fail when `DEFAULT_AI_ASSISTANT=gemini`)
- [ ] `SAFE_ASSISTANT_FIELDS` allows `gemini: ['model']`
- [ ] Web UI Settings page has a dedicated Gemini panel with model input
- [ ] Auth: Archon injects NO API key; subprocess inherits HOME so `~/.gemini` resolves
- [ ] Tests: registry, api.providers, config, options-translator, and provider unit tests all pass
- [ ] `bun run validate` passes (type-check, lint, format, tests, check:bundled, check:bundled-skill)
- [ ] No regressions in existing tests

## Scope
### In Scope
- Provider files: `capabilities.ts`, `config.ts`, `options-translator.ts`, `provider.ts`, `registration.ts`, `binary-resolver.ts`, `index.ts`
- `GeminiProviderDefaults` type in `packages/providers/src/types.ts`
- Registry wiring (`registry.ts`, `index.ts`, `package.json` exports + dependency)
- `SAFE_ASSISTANT_FIELDS` update in `config-loader.ts`
- `checkGemini()` in `doctor.ts`
- Gemini panel in `SettingsPage.tsx`
- Unit tests for config, options-translator, provider; registry.test.ts and api.providers.test.ts updates
- Docs (`ai-assistants.md`), `.env.example`, root `CLAUDE.md` provider-list update

### Out of Scope
- MCP translation (Archon `nodeConfig.mcp` string ref → SDK `mcpServers` object is non-trivial; `mcp: false` in v1)
- Structured output via `queryFull()` (`query()` throws `UnsupportedFeatureError` on `outputSchema`; `structuredOutput: false` in v1)
- Skills, hooks, agents, effort/thinking control, sandbox, fallbackModel, costControl (all `false` in v1)
- Docker image changes

## Codebase Context

### Key Files

| File | Role | Action |
|------|------|--------|
| `packages/providers/src/types.ts` | Contract layer; defines `ProviderRegistration`, `IAgentProvider`, `MessageChunk`, provider defaults | UPDATE — add `GeminiProviderDefaults` |
| `packages/providers/src/registry.ts` | Provider registry; `registerCommunityProviders()` calls each community registration | UPDATE — add `registerGeminiProvider()` call |
| `packages/providers/src/index.ts` | Package exports | UPDATE — export Gemini community module |
| `packages/providers/package.json` | Package manifest; test script, exports map, dependencies | UPDATE — add SDK dep, export path, test files |
| `packages/providers/src/community/pi/` | Pattern to mirror exactly | READ-ONLY reference |
| `packages/providers/src/codex/binary-resolver.ts` | Binary resolver pattern (env → config → vendor → autodetect → throw) | READ-ONLY reference |
| `packages/core/src/config/config-loader.ts` | `SAFE_ASSISTANT_FIELDS` allowlist at line 96–102 | UPDATE — add `gemini: ['model']` |
| `packages/cli/src/commands/doctor.ts` | `checkPi()` at line 98 is the pattern to mirror | UPDATE — add `checkGemini()` |
| `packages/web/src/routes/SettingsPage.tsx` | `AssistantConfigSection`; `provider.id === 'claude'` and `'codex'` branches at lines 492–571 | UPDATE — add `'gemini'` branch |
| `packages/providers/src/registry.test.ts` | Registry tests; `registerCommunityProviders` test at line 252 | UPDATE — add Gemini assertions |
| `packages/server/src/routes/api.providers.test.ts` | API providers test; currently only registers built-ins | UPDATE — add community registration test |
| `packages/docs-web/src/content/docs/getting-started/ai-assistants.md` | AI assistants docs; add Gemini section | UPDATE |
| `.env.example` | Auth env var documentation | UPDATE — add Gemini section |
| `CLAUDE.md` | Root codebase instructions | UPDATE — provider list examples |
| `packages/providers/src/community/gemini/capabilities.ts` | Gemini capability flags | CREATE |
| `packages/providers/src/community/gemini/config.ts` | `GeminiProviderDefaults` + `parseGeminiConfig` | CREATE |
| `packages/providers/src/community/gemini/options-translator.ts` | `translateOptions`, `translateChunk`, `warnIgnoredOptions` | CREATE |
| `packages/providers/src/community/gemini/binary-resolver.ts` | `resolveGeminiBinaryPath` | CREATE |
| `packages/providers/src/community/gemini/provider.ts` | `GeminiProvider` class | CREATE |
| `packages/providers/src/community/gemini/registration.ts` | `registerGeminiProvider()` | CREATE |
| `packages/providers/src/community/gemini/index.ts` | Module barrel exports | CREATE |
| `packages/providers/src/community/gemini/config.test.ts` | Unit tests for `parseGeminiConfig` | CREATE |
| `packages/providers/src/community/gemini/options-translator.test.ts` | Unit tests for translateChunk, translateOptions | CREATE |
| `packages/providers/src/community/gemini/provider.test.ts` | Unit tests for GeminiProvider | CREATE |

### Patterns to Follow

**Pi registration (verbatim pattern for Gemini)** — `packages/providers/src/community/pi/registration.ts`:
```typescript
import { isRegisteredProvider, registerProvider } from '../../registry';
import { GEMINI_CAPABILITIES } from './capabilities';
import { GeminiProvider } from './provider';

export function registerGeminiProvider(): void {
  if (isRegisteredProvider('gemini')) return;
  registerProvider({
    id: 'gemini',
    displayName: 'Gemini (community)',
    factory: () => new GeminiProvider(),
    capabilities: GEMINI_CAPABILITIES,
    builtIn: false,
  });
}
```

**Registry aggregator call** — `packages/providers/src/registry.ts` line 154–156:
```typescript
export function registerCommunityProviders(): void {
  registerPiProvider();
  registerGeminiProvider(); // ADD THIS LINE
}
```

**Pi config parser pattern** — `packages/providers/src/community/pi/config.ts`:
```typescript
export function parsePiConfig(raw: Record<string, unknown>): PiProviderDefaults {
  const result: PiProviderDefaults = {};
  if (typeof raw.model === 'string') result.model = raw.model;
  // ... defensive parsing, never throws
  return result;
}
```

**Codex binary resolver pattern** — `packages/providers/src/codex/binary-resolver.ts`:
- Resolution order: env var → config field → vendor dir → autodetect paths → throw with install instructions
- `BUNDLED_IS_BINARY` guard: return `undefined` in dev mode
- Export `fileExists` wrapper for test spying

**SettingsPage community provider branch** — `packages/web/src/routes/SettingsPage.tsx` lines 492–515 (Claude branch pattern):
```tsx
if (provider.id === 'gemini') {
  return (
    <div key={provider.id} className="grid grid-cols-[140px_1fr] items-center gap-2 text-sm">
      <div className="font-medium">{provider.displayName}</div>
      <div className="text-muted-foreground">Community provider settings</div>
      <label htmlFor="gemini-model">Model</label>
      <Input
        id="gemini-model"
        value={(providerSettings.model as string | undefined) ?? ''}
        onChange={e => { updateProviderSettings('gemini', { model: e.target.value }); }}
        placeholder="gemini-2.5-pro"
      />
    </div>
  );
}
```

**Doctor check pattern** — `packages/cli/src/commands/doctor.ts` lines 98–126 (checkPi):
```typescript
export async function checkGemini(env: NodeJS.ProcessEnv): Promise<CheckResult> {
  const label = 'Gemini provider';
  const isDefault = env.DEFAULT_AI_ASSISTANT === 'gemini';
  if (!isDefault) {
    return { label, status: 'skip', message: 'Gemini not configured' };
  }
  // Check ~/.gemini/credentials.json (ADC path written by `gemini login`)
  const credsPath = join(homedir(), '.gemini', 'credentials.json');
  if (probeAuthJsonExists(credsPath)) {
    return { label, status: 'pass', message: '~/.gemini/credentials.json found' };
  }
  // Fallback: API key env vars
  const keyVars = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'];
  const found = keyVars.find(v => (env[v] ?? '').trim().length > 0);
  if (found) {
    return { label, status: 'pass', message: `${found} is set` };
  }
  return {
    label, status: 'fail',
    message: 'Gemini is configured as default but no auth found. Run `gemini login` or set GEMINI_API_KEY.',
  };
}
```

## Architecture

### SDK interface
- **`query(options: QueryOptions): AsyncIterable<SdkMessageChunk>`** — streaming API used by `GeminiProvider.sendQuery()`
- **`QueryOptions.cliPath`** — binary path override (enables `resolveGeminiBinaryPath`)
- **`QueryOptions.session`** — session resume by ID string (enables `sessionResume: true`)
- **`QueryOptions.env`** — extra env vars merged into subprocess (subprocess inherits full parent env including HOME; `~/.gemini` resolves automatically without key injection)
- **`QueryOptions.allowedTools`** — tool whitelist (enables `toolRestrictions: true`)
- **NOT USED v1: `outputSchema`** — only works with `queryFull()`, not `query()`; `structuredOutput: false`
- **NOT USED v1: `mcpServers`** — requires object conversion from Archon's string ref; `mcp: false`

### Three mandatory port-time fixes (from task spec)
1. **Drop `isModelCompatible`** — field does not exist on current `ProviderRegistration`; reference's `registration.ts` had it on an older Archon version
2. **Remove `workflow_dispatch` before tool chunks** — reference `provider.ts` emits `workflow_dispatch` before every tool chunk; neither Claude nor Codex does this; just `yield translateChunk(sdkChunk)` without the sentinel
3. **Import from `../../types` not local mirror** — reference used `./types.js` (a local copy); Archon port imports from `../../types`; `toolName: ''` in `tool_result` is kept (Gemini SDK tool_result chunks don't carry the tool name; required field must have a value)

### Zod version conflict resolution
The `@lrilai/gemini-cli-sdk` uses zod 4 internally. Archon uses zod 3 via `@hono/zod-openapi`. Steps:
1. Run `bun add @lrilai/gemini-cli-sdk@^1.0.0 --cwd packages/providers`
2. Check if zod 4 is a `peerDependency` or a bundled `dependency`
3. If it's a `dependency` (internal), Bun's resolver will deduplicate but coexist — no action needed
4. If it's a `peerDependency` requiring zod@^4, add to workspace root `package.json`:
   ```json
   "overrides": { "@lrilai/gemini-cli-sdk>zod": "^3" }
   ```
   and verify the SDK's schema validation still works (it uses zod for outputSchema which is v1-disabled anyway)
5. Run `bun run type-check` to confirm no zod-3/4 interface collisions

### Capability decisions (v1, conservative)
```
sessionResume: true   // QueryOptions.session? accepts bare session ID string
mcp: false            // Archon nodeConfig.mcp is a file path string; SDK wants object map — translation not implemented
hooks: false
skills: false
agents: false
toolRestrictions: true  // QueryOptions.allowedTools
structuredOutput: false // query() throws UnsupportedFeatureError on outputSchema
envInjection: true    // QueryOptions.env merged into subprocess; HOME inherited from parent
costControl: false
effortControl: false
thinkingControl: false
fallbackModel: false
sandbox: false
```

## Task List

Execute in order. Each task is independently verifiable.

---

### Task 1: ADD `GeminiProviderDefaults` to `packages/providers/src/types.ts`
**Action**: UPDATE
**Details**: Add the following interface after `PiProviderDefaults` (around line 99), before the `ProviderDefaults` type alias. This is the canonical definition; `config.ts` will re-export it.

```typescript
/**
 * Community provider defaults for Gemini (@lrilai/gemini-cli-sdk).
 * Auth is ambient: gemini-cli OAuth login writes credentials to ~/.gemini/;
 * the subprocess picks them up automatically. Archon injects NO key.
 */
export interface GeminiProviderDefaults {
  [key: string]: unknown;
  /** Default model string forwarded verbatim to gemini-cli (e.g. 'gemini-2.5-pro'). */
  model?: string;
  /** Absolute path to the gemini-cli binary. Overrides auto-detection in compiled Archon builds. */
  geminiBinaryPath?: string;
}
```

**Pattern**: Follow `PiProviderDefaults` at `packages/providers/src/types.ts:42–98`
**Validate**: `bun run type-check` from repo root (zero errors)

---

### Task 2: CREATE `packages/providers/src/community/gemini/capabilities.ts`
**Action**: CREATE
**Details**: Conservative v1 capability set. Commented rationale for each `false`.

```typescript
import type { ProviderCapabilities } from '../../types';

/**
 * Gemini v1 capabilities — conservative. Only wire what the SDK actually delivers.
 *
 * sessionResume: true — QueryOptions.session accepts a bare session ID string.
 * toolRestrictions: true — QueryOptions.allowedTools is supported.
 * envInjection: true — QueryOptions.env is merged into the subprocess;
 *   parent HOME is inherited so ~/.gemini resolves without key injection.
 *
 * mcp: false — Archon's nodeConfig.mcp is a file-path string ref;
 *   SDK wants a mcpServers object map. Translation not implemented in v1.
 * structuredOutput: false — query() throws UnsupportedFeatureError on
 *   outputSchema; queryFull() (buffered, non-streaming) is required but
 *   incompatible with Archon's AsyncGenerator streaming contract in v1.
 */
export const GEMINI_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  mcp: false,
  hooks: false,
  skills: false,
  agents: false,
  toolRestrictions: true,
  structuredOutput: false,
  envInjection: true,
  costControl: false,
  effortControl: false,
  thinkingControl: false,
  fallbackModel: false,
  sandbox: false,
};
```

**Validate**: `bun run type-check` (no errors on capabilities shape)

---

### Task 3: CREATE `packages/providers/src/community/gemini/config.ts`
**Action**: CREATE
**Details**: Parse raw YAML-derived config into typed Gemini defaults. Defensive — never throws. Import `GeminiProviderDefaults` from `../../types` and re-export it (same pattern as `pi/config.ts`).

```typescript
import type { GeminiProviderDefaults } from '../../types';

export type { GeminiProviderDefaults };

/**
 * Parse raw YAML-derived config into typed Gemini defaults.
 * Defensive: invalid fields are dropped silently (matches parseClaudeConfig
 * and parseCodexConfig — never throws).
 */
export function parseGeminiConfig(raw: Record<string, unknown>): GeminiProviderDefaults {
  const result: GeminiProviderDefaults = {};

  if (typeof raw.model === 'string') {
    result.model = raw.model;
  }

  if (typeof raw.geminiBinaryPath === 'string') {
    result.geminiBinaryPath = raw.geminiBinaryPath;
  }

  return result;
}
```

**Pattern**: Follow `packages/providers/src/community/pi/config.ts`
**Validate**: `bun run type-check`

---

### Task 4: CREATE `packages/providers/src/community/gemini/config.test.ts`
**Action**: CREATE
**Details**: Unit tests for `parseGeminiConfig`. Mirror `pi/config.test.ts` structure.

```typescript
import { describe, expect, test } from 'bun:test';
import { parseGeminiConfig } from './config';

describe('parseGeminiConfig', () => {
  test('parses valid model string', () => {
    expect(parseGeminiConfig({ model: 'gemini-2.5-pro' })).toEqual({ model: 'gemini-2.5-pro' });
  });

  test('drops invalid model type silently', () => {
    expect(parseGeminiConfig({ model: 123 })).toEqual({});
  });

  test('ignores unknown keys', () => {
    expect(parseGeminiConfig({ futureField: 'x', model: 'gemini-2.5-pro' })).toEqual({
      model: 'gemini-2.5-pro',
    });
  });

  test('returns empty object for empty input', () => {
    expect(parseGeminiConfig({})).toEqual({});
  });

  test('does not throw on malformed input', () => {
    expect(() => parseGeminiConfig({ model: null })).not.toThrow();
    expect(() => parseGeminiConfig({ model: [] })).not.toThrow();
  });

  test('parses geminiBinaryPath', () => {
    expect(parseGeminiConfig({ geminiBinaryPath: '/usr/local/bin/gemini' })).toEqual({
      geminiBinaryPath: '/usr/local/bin/gemini',
    });
  });

  test('drops non-string geminiBinaryPath silently', () => {
    expect(parseGeminiConfig({ geminiBinaryPath: 42 })).toEqual({});
    expect(parseGeminiConfig({ geminiBinaryPath: null })).toEqual({});
  });

  test('parses model and geminiBinaryPath together', () => {
    expect(
      parseGeminiConfig({ model: 'gemini-2.5-flash', geminiBinaryPath: '/usr/bin/gemini' })
    ).toEqual({ model: 'gemini-2.5-flash', geminiBinaryPath: '/usr/bin/gemini' });
  });
});
```

**Validate**: `bun test packages/providers/src/community/gemini/config.test.ts` (all pass)

---

### Task 5: CREATE `packages/providers/src/community/gemini/options-translator.ts`
**Action**: CREATE
**Details**: Translates `SendQueryOptions` → `QueryOptions` (SDK format). Translates SDK chunks → Archon `MessageChunk`. Three port-time fixes applied here:
- Import from `../../types` not a local mirror
- `toolName: ''` in tool_result is kept (SDK doesn't carry it)
- No `workflow_dispatch` sentinel emitted (that happens in provider.ts; options-translator doesn't emit chunks)

The SDK chunk types (from reference adapter mapping):
- `assistant` → `{ type: 'assistant', content: string }`
- `system` → `{ type: 'system', content: string }` (subtype/sessionId/model in content)
- `tool` → `{ type: 'tool', toolName, toolInput: Record<string,unknown>, toolCallId: string }`
- `tool_result` → `{ type: 'tool_result', toolName: '', toolOutput: string, toolCallId?: string }`
- `rate_limit` → `{ type: 'rate_limit', rateLimitInfo: Record<string,unknown> }`
- `result` → `{ type: 'result', sessionId?, stopReason?, ... }`

```typescript
import type { MessageChunk, SendQueryOptions } from '../../types';

/**
 * SDK chunk shape — minimal structural type derived from @lrilai/gemini-cli-sdk
 * chunk variants. Using `Record<string, unknown>` intersection avoids importing
 * SDK types at the module boundary (SDK types are only needed inside sendQuery).
 */
export interface SdkChunk {
  type: string;
  [key: string]: unknown;
}

/** Translate a raw SDK chunk to an Archon MessageChunk. */
export function translateChunk(chunk: SdkChunk): MessageChunk {
  switch (chunk.type) {
    case 'assistant':
      return { type: 'assistant', content: (chunk.content as string) ?? '' };

    case 'thinking':
      return { type: 'thinking', content: (chunk.content as string) ?? '' };

    case 'system': {
      // SDK system chunks carry subtype, sessionId, model, and optional content.
      // Flatten to a readable string so adapters can display it.
      const parts: string[] = [];
      if (chunk.subtype) parts.push(String(chunk.subtype));
      if (chunk.sessionId) parts.push(`session=${String(chunk.sessionId)}`);
      if (chunk.model) parts.push(`model=${String(chunk.model)}`);
      if (chunk.content) parts.push(String(chunk.content));
      return { type: 'system', content: parts.join(' ') || 'system' };
    }

    case 'tool':
      return {
        type: 'tool',
        toolName: (chunk.toolName as string) ?? '',
        toolInput: (chunk.parameters as Record<string, unknown>) ?? {},
        toolCallId: (chunk.toolId as string) ?? '',
      };

    case 'tool_result':
      // SDK tool_result does not carry toolName — use empty string.
      // toolCallId matches the originating tool chunk's toolId.
      return {
        type: 'tool_result',
        toolName: '',
        toolOutput: (chunk.output as string) ?? (chunk.error as string) ?? '',
        toolCallId: (chunk.toolId as string) ?? undefined,
      };

    case 'rate_limit':
      return {
        type: 'rate_limit',
        rateLimitInfo: {
          code: chunk.code,
          message: chunk.message,
          status: chunk.status,
        },
      };

    case 'result':
      return {
        type: 'result',
        sessionId: chunk.sessionId as string | undefined,
        stopReason: chunk.stopReason as string | undefined,
      };

    default:
      // Unknown chunk type — surface as system message so it isn't silently swallowed.
      return { type: 'system', content: `[gemini:unknown-chunk:${chunk.type}]` };
  }
}

/**
 * Build QueryOptions from Archon's SendQueryOptions.
 * Only fields with SDK equivalents are mapped; unrecognized fields are silently dropped.
 */
export function translateOptions(
  prompt: string,
  cwd: string,
  resumeSessionId: string | undefined,
  options: SendQueryOptions | undefined,
  resolvedCliPath: string | undefined
): Record<string, unknown> {
  const nodeConfig = options?.nodeConfig;

  // System prompt: top-level wins over nodeConfig fallback.
  // Pi only accepts string system prompts; Gemini SDK likewise.
  const rawSystemPrompt = options?.systemPrompt ?? nodeConfig?.systemPrompt;
  const systemPrompt = typeof rawSystemPrompt === 'string' ? rawSystemPrompt : undefined;

  // Tool restrictions: allowed_tools → allowedTools.
  // denied_tools has no SDK equivalent — warn once if set.
  const allowedTools =
    nodeConfig?.allowed_tools !== undefined ? nodeConfig.allowed_tools : undefined;

  return {
    prompt,
    cwd,
    ...(options?.model !== undefined ? { model: options.model } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(resumeSessionId !== undefined ? { session: resumeSessionId } : {}),
    ...(options?.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(options?.env !== undefined ? { env: options.env } : {}),
    ...(resolvedCliPath !== undefined ? { cliPath: resolvedCliPath } : {}),
    // approvalMode: 'yolo' — required for headless/non-interactive usage.
    approvalMode: 'yolo',
  };
}

/** Tracks warned option keys to avoid duplicate console.warn calls. */
const warnedKeys = new Set<string>();

/** @internal Test-only reset. */
export function resetWarnedKeys(): void {
  warnedKeys.clear();
}

/**
 * Emit one-time dev-mode warnings for ignored/partial options.
 * Silent in production. Never throws.
 */
export function warnIgnoredOptions(options: SendQueryOptions | undefined): void {
  if (!options) return;
  const isDev = process.env.NODE_ENV === 'development' || process.env.DEBUG?.includes('gemini');
  if (!isDev) return;

  const nodeConfig = options.nodeConfig;
  const ignored: string[] = [];

  if (options.maxBudgetUsd !== undefined) ignored.push('maxBudgetUsd');
  if (options.fallbackModel !== undefined) ignored.push('fallbackModel');
  if (options.forkSession !== undefined) ignored.push('forkSession');
  if (options.persistSession !== undefined) ignored.push('persistSession');
  if (options.outputFormat !== undefined) ignored.push('outputFormat (structuredOutput not supported in v1)');
  if (nodeConfig?.mcp !== undefined) ignored.push('nodeConfig.mcp (MCP translation not implemented in v1)');
  if (nodeConfig?.denied_tools !== undefined) ignored.push('nodeConfig.denied_tools (no SDK equivalent)');
  if (nodeConfig?.hooks !== undefined) ignored.push('nodeConfig.hooks');
  if (nodeConfig?.skills !== undefined) ignored.push('nodeConfig.skills');
  if (nodeConfig?.agents !== undefined) ignored.push('nodeConfig.agents');
  if (nodeConfig?.effort !== undefined) ignored.push('nodeConfig.effort');
  if (nodeConfig?.thinking !== undefined) ignored.push('nodeConfig.thinking');
  if (nodeConfig?.betas !== undefined) ignored.push('nodeConfig.betas');
  if (nodeConfig?.sandbox !== undefined) ignored.push('nodeConfig.sandbox');

  for (const key of ignored) {
    if (!warnedKeys.has(key)) {
      warnedKeys.add(key);
      console.warn(`[gemini-provider] Ignored option: ${key}`);
    }
  }
}
```

**Pattern**: Reference adapter `adapter-archon/src/options-translator.ts` (with port-time fixes)
**Validate**: `bun run type-check`

---

### Task 6: CREATE `packages/providers/src/community/gemini/options-translator.test.ts`
**Action**: CREATE
**Details**: Test `translateChunk` and `translateOptions`. No mock.module needed — pure functions.

```typescript
import { describe, expect, test, beforeEach } from 'bun:test';
import { translateChunk, translateOptions, resetWarnedKeys, type SdkChunk } from './options-translator';

describe('translateChunk', () => {
  test('translates assistant chunk', () => {
    const chunk: SdkChunk = { type: 'assistant', content: 'Hello' };
    expect(translateChunk(chunk)).toEqual({ type: 'assistant', content: 'Hello' });
  });

  test('translates tool chunk — maps toolId→toolCallId, parameters→toolInput', () => {
    const chunk: SdkChunk = {
      type: 'tool',
      toolName: 'bash',
      parameters: { command: 'ls' },
      toolId: 'call-abc',
    };
    expect(translateChunk(chunk)).toEqual({
      type: 'tool',
      toolName: 'bash',
      toolInput: { command: 'ls' },
      toolCallId: 'call-abc',
    });
  });

  test('translates tool_result chunk — toolName is empty string (SDK omits it)', () => {
    const chunk: SdkChunk = { type: 'tool_result', output: 'file1.ts', toolId: 'call-abc' };
    const result = translateChunk(chunk);
    expect(result.type).toBe('tool_result');
    if (result.type === 'tool_result') {
      expect(result.toolName).toBe('');
      expect(result.toolOutput).toBe('file1.ts');
      expect(result.toolCallId).toBe('call-abc');
    }
  });

  test('tool_result with error field uses error as toolOutput', () => {
    const chunk: SdkChunk = { type: 'tool_result', error: 'Permission denied', toolId: 'call-x' };
    const result = translateChunk(chunk);
    if (result.type === 'tool_result') {
      expect(result.toolOutput).toBe('Permission denied');
    }
  });

  test('translates rate_limit chunk', () => {
    const chunk: SdkChunk = { type: 'rate_limit', code: 429, message: 'quota exceeded', status: 'RESOURCE_EXHAUSTED' };
    expect(translateChunk(chunk)).toEqual({
      type: 'rate_limit',
      rateLimitInfo: { code: 429, message: 'quota exceeded', status: 'RESOURCE_EXHAUSTED' },
    });
  });

  test('translates result chunk', () => {
    const chunk: SdkChunk = { type: 'result', sessionId: 'ses-123', stopReason: 'end_turn' };
    expect(translateChunk(chunk)).toEqual({ type: 'result', sessionId: 'ses-123', stopReason: 'end_turn' });
  });

  test('unknown chunk type becomes system message', () => {
    const result = translateChunk({ type: 'future_chunk_type' });
    expect(result.type).toBe('system');
    if (result.type === 'system') {
      expect(result.content).toContain('future_chunk_type');
    }
  });
});

describe('translateOptions', () => {
  test('sets approvalMode to yolo', () => {
    const opts = translateOptions('hello', '/cwd', undefined, undefined, undefined);
    expect(opts.approvalMode).toBe('yolo');
  });

  test('passes model through', () => {
    const opts = translateOptions('hi', '/cwd', undefined, { model: 'gemini-2.5-pro' }, undefined);
    expect(opts.model).toBe('gemini-2.5-pro');
  });

  test('passes resumeSessionId as session', () => {
    const opts = translateOptions('hi', '/cwd', 'ses-999', undefined, undefined);
    expect(opts.session).toBe('ses-999');
  });

  test('passes env through — HOME is NOT overridden (subprocess inherits parent HOME)', () => {
    const opts = translateOptions('hi', '/cwd', undefined, { env: { MY_VAR: 'value' } }, undefined);
    // env passed through; HOME key is absent — subprocess inherits parent process HOME
    expect((opts.env as Record<string, string>).MY_VAR).toBe('value');
    expect((opts.env as Record<string, string>).HOME).toBeUndefined();
  });

  test('passes cliPath from resolver', () => {
    const opts = translateOptions('hi', '/cwd', undefined, undefined, '/usr/local/bin/gemini');
    expect(opts.cliPath).toBe('/usr/local/bin/gemini');
  });

  test('omits cliPath when undefined', () => {
    const opts = translateOptions('hi', '/cwd', undefined, undefined, undefined);
    expect(opts.cliPath).toBeUndefined();
  });

  test('omits session when resumeSessionId undefined', () => {
    const opts = translateOptions('hi', '/cwd', undefined, undefined, undefined);
    expect(opts.session).toBeUndefined();
  });

  test('passes allowedTools from nodeConfig.allowed_tools', () => {
    const opts = translateOptions('hi', '/cwd', undefined, {
      nodeConfig: { allowed_tools: ['bash', 'read'] },
    }, undefined);
    expect(opts.allowedTools).toEqual(['bash', 'read']);
  });

  test('systemPrompt: top-level wins over nodeConfig', () => {
    const opts = translateOptions('hi', '/cwd', undefined, {
      systemPrompt: 'top-level',
      nodeConfig: { systemPrompt: 'node-level' },
    }, undefined);
    expect(opts.systemPrompt).toBe('top-level');
  });

  test('systemPrompt falls back to nodeConfig when top-level absent', () => {
    const opts = translateOptions('hi', '/cwd', undefined, {
      nodeConfig: { systemPrompt: 'node-level' },
    }, undefined);
    expect(opts.systemPrompt).toBe('node-level');
  });

  test('non-string systemPrompt (preset object) is dropped', () => {
    const opts = translateOptions('hi', '/cwd', undefined, {
      systemPrompt: { type: 'preset', preset: 'claude_code' } as unknown as string,
    }, undefined);
    expect(opts.systemPrompt).toBeUndefined();
  });
});

describe('warnIgnoredOptions', () => {
  beforeEach(() => resetWarnedKeys());

  test('does not throw', () => {
    expect(() => {
      const { warnIgnoredOptions } = require('./options-translator');
      warnIgnoredOptions({ maxBudgetUsd: 5 });
    }).not.toThrow();
  });
});
```

**Validate**: `bun test packages/providers/src/community/gemini/options-translator.test.ts`

---

### Task 7: CREATE `packages/providers/src/community/gemini/binary-resolver.ts`
**Action**: CREATE
**Details**: Resolves the gemini-cli binary path for compiled Archon binaries. Mirrors `codex/binary-resolver.ts` structure. The SDK's `QueryOptions.cliPath` accepts the resolved path.

In dev mode (`BUNDLED_IS_BINARY=false`), return `undefined` — SDK uses PATH resolution (gemini on PATH from npm global install).

Resolution order:
1. `GEMINI_BIN_PATH` env var
2. `assistants.gemini.geminiBinaryPath` in config (passed as argument)
3. `~/.archon/vendor/gemini/<binary>` (user-placed)
4. Autodetect canonical install paths (`~/.npm-global/bin/gemini`, `/opt/homebrew/bin/gemini`, `/usr/local/bin/gemini`, Windows `%AppData%\npm\gemini.cmd`)
5. Throw with install instructions

```typescript
import { existsSync as _existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BUNDLED_IS_BINARY, getArchonHome, createLogger } from '@archon/paths';

/** Wrapper for existsSync — enables spyOn in tests. */
export function fileExists(path: string): boolean {
  return _existsSync(path);
}

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('gemini-binary');
  return cachedLog;
}

const GEMINI_VENDOR_DIR = 'vendor/gemini';

/**
 * Resolve the path to the gemini-cli binary.
 *
 * In dev mode: returns undefined (SDK uses PATH resolution).
 * In binary mode: resolves from env/config/vendor/autodetect, or throws.
 */
export async function resolveGeminiBinaryPath(
  configGeminiBinaryPath?: string
): Promise<string | undefined> {
  if (!BUNDLED_IS_BINARY) return undefined;

  // 1. Environment variable
  const envPath = process.env.GEMINI_BIN_PATH;
  if (envPath) {
    if (!fileExists(envPath)) {
      throw new Error(
        `GEMINI_BIN_PATH is set to "${envPath}" but the file does not exist.\n` +
          'Please verify the path points to the gemini-cli binary.'
      );
    }
    getLog().info({ binaryPath: envPath, source: 'env' }, 'gemini.binary_resolved');
    return envPath;
  }

  // 2. Config file override
  if (configGeminiBinaryPath) {
    if (!fileExists(configGeminiBinaryPath)) {
      throw new Error(
        `assistants.gemini.geminiBinaryPath is set to "${configGeminiBinaryPath}" but the file does not exist.\n` +
          'Please verify the path in .archon/config.yaml.'
      );
    }
    getLog().info({ binaryPath: configGeminiBinaryPath, source: 'config' }, 'gemini.binary_resolved');
    return configGeminiBinaryPath;
  }

  // 3. Vendor directory (user-placed binary)
  const binaryName = process.platform === 'win32' ? 'gemini.cmd' : 'gemini';
  const vendorBinaryPath = join(getArchonHome(), GEMINI_VENDOR_DIR, binaryName);
  if (fileExists(vendorBinaryPath)) {
    getLog().info({ binaryPath: vendorBinaryPath, source: 'vendor' }, 'gemini.binary_resolved');
    return vendorBinaryPath;
  }

  // 4. Autodetect canonical install paths
  for (const probePath of getAutodetectPaths()) {
    if (fileExists(probePath)) {
      getLog().info({ binaryPath: probePath, source: 'autodetect' }, 'gemini.binary_resolved');
      return probePath;
    }
  }

  // 5. Not found
  throw new Error(
    'gemini-cli binary not found. Install it with:\n' +
      '  npm install -g @google/gemini-cli\n' +
      'Then either:\n' +
      '  1. Ensure `gemini` is on PATH (GEMINI_BIN_PATH will auto-resolve)\n' +
      `  2. Place the binary at: ~/.archon/${GEMINI_VENDOR_DIR}/\n` +
      '  3. Set in config:\n' +
      '     assistants:\n' +
      '       gemini:\n' +
      '         geminiBinaryPath: /path/to/gemini\n'
  );
}

function getAutodetectPaths(): string[] {
  const paths: string[] = [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) paths.push(join(appData, 'npm', 'gemini.cmd'));
    paths.push(join(homedir(), '.npm-global', 'gemini.cmd'));
    return paths;
  }
  paths.push(join(homedir(), '.npm-global', 'bin', 'gemini'));
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    paths.push('/opt/homebrew/bin/gemini');
  }
  paths.push('/usr/local/bin/gemini');
  return paths;
}
```

**Pattern**: Follow `packages/providers/src/codex/binary-resolver.ts`
**Validate**: `bun run type-check`

---

### Task 8: CREATE `packages/providers/src/community/gemini/provider.ts`
**Action**: CREATE
**Details**: `GeminiProvider` implements `IAgentProvider`. Uses lazy dynamic import of `@lrilai/gemini-cli-sdk` to avoid any module-load side effects in compiled binaries. Does NOT lazy-load its own sibling files (they have no runtime side effects unlike Pi). Does NOT emit `workflow_dispatch` before tool chunks.

```typescript
import { createLogger } from '@archon/paths';

import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../../types';

import { GEMINI_CAPABILITIES } from './capabilities';
import { parseGeminiConfig } from './config';
import { translateChunk, translateOptions, warnIgnoredOptions } from './options-translator';
import { resolveGeminiBinaryPath } from './binary-resolver';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.gemini');
  return cachedLog;
}

/**
 * Gemini community provider — wraps @lrilai/gemini-cli-sdk.
 *
 * Auth: ambient gemini-cli OAuth login. Credentials live in ~/.gemini/
 * and are picked up automatically by the subprocess. Archon injects NO key.
 * The subprocess inherits the full parent process environment including HOME,
 * so ~/.gemini resolves without any env manipulation.
 *
 * Port-time fixes applied (vs reference adapter):
 *   1. No workflow_dispatch sentinel before tool chunks.
 *   2. Import from ../../types, not a local mirror.
 *   3. No isModelCompatible in registration.
 */
export class GeminiProvider implements IAgentProvider {
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    // Lazy-import SDK — defers any startup-time issues to invocation time.
    const { query } = await import('@lrilai/gemini-cli-sdk');

    const assistantConfig = requestOptions?.assistantConfig ?? {};
    const geminiConfig = parseGeminiConfig(assistantConfig);

    // Resolve binary path (env → config → vendor → autodetect → undefined in dev mode)
    const resolvedCliPath = await resolveGeminiBinaryPath(geminiConfig.geminiBinaryPath);

    // Warn about ignored/partial options (dev-mode only, never throws)
    warnIgnoredOptions(requestOptions);

    // Translate Archon options → SDK QueryOptions
    const sdkOptions = translateOptions(prompt, cwd, resumeSessionId, requestOptions, resolvedCliPath);

    getLog().info(
      {
        cwd,
        model: sdkOptions.model,
        hasSession: sdkOptions.session !== undefined,
        hasAllowedTools: Array.isArray(sdkOptions.allowedTools),
        hasEnv: sdkOptions.env !== undefined,
        hasCliPath: sdkOptions.cliPath !== undefined,
      },
      'gemini.query_started'
    );

    try {
      // PORT-TIME FIX: do NOT yield workflow_dispatch before tool chunks.
      // Neither Claude nor Codex emits this sentinel; Gemini should not either.
      for await (const sdkChunk of query(sdkOptions as Parameters<typeof query>[0])) {
        yield translateChunk(sdkChunk as { type: string; [key: string]: unknown });
      }
      getLog().info({ cwd }, 'gemini.query_completed');
    } catch (err) {
      getLog().error({ err, cwd }, 'gemini.query_failed');
      throw err;
    }
  }

  getType(): string {
    return 'gemini';
  }

  getCapabilities(): ProviderCapabilities {
    return GEMINI_CAPABILITIES;
  }
}
```

**Pattern**: Compare with `pi/provider.ts` — Gemini is simpler (no Pi shim, no semaphore, no session-resolver, no extension binding)
**Validate**: `bun run type-check`

---

### Task 9: CREATE `packages/providers/src/community/gemini/provider.test.ts`
**Action**: CREATE
**Details**: Unit tests for GeminiProvider. Mock `@lrilai/gemini-cli-sdk` to avoid needing the binary. Mock `@archon/paths` for logger. Test: assistant chunk passes through, tool chunk does NOT emit workflow_dispatch, tool_result toolName is empty, error propagates, env does not strip HOME.

```typescript
import { describe, expect, mock, test, beforeEach } from 'bun:test';
import { createMockLogger } from '../../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  BUNDLED_IS_BINARY: false,
  getArchonHome: () => '/tmp/.archon-test',
}));

// Mock SDK — returns scripted chunks
const scriptedChunks: Array<{ type: string; [key: string]: unknown }> = [];
const mockQuery = mock(async function* () {
  for (const chunk of scriptedChunks) yield chunk;
});

mock.module('@lrilai/gemini-cli-sdk', () => ({
  query: mockQuery,
}));

import { GeminiProvider } from './provider';

async function collect(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const results: unknown[] = [];
  for await (const chunk of gen) results.push(chunk);
  return results;
}

describe('GeminiProvider', () => {
  let provider: GeminiProvider;

  beforeEach(() => {
    provider = new GeminiProvider();
    scriptedChunks.length = 0;
    mockQuery.mockClear();
  });

  test('getType() returns gemini', () => {
    expect(provider.getType()).toBe('gemini');
  });

  test('getCapabilities() returns GEMINI_CAPABILITIES', () => {
    const caps = provider.getCapabilities();
    expect(caps.sessionResume).toBe(true);
    expect(caps.envInjection).toBe(true);
    expect(caps.toolRestrictions).toBe(true);
    expect(caps.mcp).toBe(false);
    expect(caps.structuredOutput).toBe(false);
    expect(caps.builtIn).toBeUndefined(); // not on ProviderCapabilities
  });

  test('translates assistant chunk', async () => {
    scriptedChunks.push({ type: 'assistant', content: 'Hello world' });
    const chunks = await collect(provider.sendQuery('hi', '/cwd'));
    expect(chunks).toContainEqual({ type: 'assistant', content: 'Hello world' });
  });

  test('does NOT emit workflow_dispatch before tool chunks (port-time fix)', async () => {
    scriptedChunks.push({ type: 'tool', toolName: 'bash', parameters: {}, toolId: 'id-1' });
    const chunks = await collect(provider.sendQuery('hi', '/cwd'));
    const dispatchChunks = chunks.filter((c) => (c as { type: string }).type === 'workflow_dispatch');
    expect(dispatchChunks).toHaveLength(0);
    // The tool chunk itself should still pass through
    const toolChunks = chunks.filter((c) => (c as { type: string }).type === 'tool');
    expect(toolChunks).toHaveLength(1);
  });

  test('tool_result has empty toolName (SDK omits it — port-time note)', async () => {
    scriptedChunks.push({ type: 'tool_result', output: 'ok', toolId: 'id-1' });
    const chunks = await collect(provider.sendQuery('hi', '/cwd'));
    const toolResult = chunks.find((c) => (c as { type: string }).type === 'tool_result') as {
      type: string;
      toolName: string;
    };
    expect(toolResult).toBeDefined();
    expect(toolResult.toolName).toBe('');
  });

  test('env is passed to SDK — HOME is not injected (subprocess inherits it)', async () => {
    scriptedChunks.push({ type: 'result' });
    await collect(provider.sendQuery('hi', '/cwd', undefined, { env: { MY_SECRET: 'x' } }));
    const callArg = mockQuery.mock.calls[0][0] as { env?: Record<string, string> };
    expect(callArg.env?.MY_SECRET).toBe('x');
    // HOME must NOT be in the passed env (it inherits from parent process)
    expect(callArg.env?.HOME).toBeUndefined();
  });

  test('passes resumeSessionId as session', async () => {
    scriptedChunks.push({ type: 'result' });
    await collect(provider.sendQuery('hi', '/cwd', 'ses-abc'));
    const callArg = mockQuery.mock.calls[0][0] as { session?: string };
    expect(callArg.session).toBe('ses-abc');
  });

  test('propagates SDK errors', async () => {
    mockQuery.mockImplementationOnce(async function* () {
      throw new Error('gemini-cli crashed');
    });
    await expect(collect(provider.sendQuery('hi', '/cwd'))).rejects.toThrow('gemini-cli crashed');
  });
});
```

**Validate**: `bun test packages/providers/src/community/gemini/provider.test.ts`

---

### Task 10: CREATE `packages/providers/src/community/gemini/registration.ts`
**Action**: CREATE

```typescript
import { isRegisteredProvider, registerProvider } from '../../registry';
import { GEMINI_CAPABILITIES } from './capabilities';
import { GeminiProvider } from './provider';

/**
 * Register the Gemini community provider.
 * Idempotent — safe to call multiple times.
 */
export function registerGeminiProvider(): void {
  if (isRegisteredProvider('gemini')) return;
  registerProvider({
    id: 'gemini',
    displayName: 'Gemini (community)',
    factory: () => new GeminiProvider(),
    capabilities: GEMINI_CAPABILITIES,
    builtIn: false,
  });
}
```

**Validate**: `bun run type-check`

---

### Task 11: CREATE `packages/providers/src/community/gemini/index.ts`
**Action**: CREATE

```typescript
export { GEMINI_CAPABILITIES } from './capabilities';
export { parseGeminiConfig, type GeminiProviderDefaults } from './config';
export { GeminiProvider } from './provider';
export { registerGeminiProvider } from './registration';
```

**Validate**: `bun run type-check`

---

### Task 12: INSTALL SDK and UPDATE `packages/providers/package.json`
**Action**: UPDATE
**Details**:

1. Install the dependency:
   ```bash
   bun add @lrilai/gemini-cli-sdk@^1.0.0 --cwd packages/providers
   ```
2. After install, check for zod version conflict:
   ```bash
   cat packages/providers/node_modules/@lrilai/gemini-cli-sdk/package.json | grep -A5 '"zod"'
   ```
   - If zod is a `dependency` (not `peerDependency`): no action needed; Bun coexists
   - If zod is a `peerDependency` at `^4.x`: add to root `package.json` `overrides`:
     ```json
     "@lrilai/gemini-cli-sdk>zod": "^3"
     ```
3. Add export path to `packages/providers/package.json` exports:
   ```json
   "./community/gemini": "./src/community/gemini/index.ts"
   ```
4. Add test files to the `test` script (append to the existing chain):
   ```
   && bun test src/community/gemini/config.test.ts && bun test src/community/gemini/options-translator.test.ts && bun test src/community/gemini/provider.test.ts
   ```
5. Run `bun run type-check` to confirm zod compatibility

**Validate**: `bun run type-check`, `bun test src/community/gemini/config.test.ts`

---

### Task 13: UPDATE `packages/providers/src/registry.ts`
**Action**: UPDATE
**Details**: Add import and call at lines 20–21 and 154–156.

At the top of the file, add after `import { registerPiProvider } from './community/pi/registration';`:
```typescript
import { registerGeminiProvider } from './community/gemini/registration';
```

In `registerCommunityProviders()` (line 154–156), add the Gemini call:
```typescript
export function registerCommunityProviders(): void {
  registerPiProvider();
  registerGeminiProvider();
}
```

**Validate**: `bun run type-check`

---

### Task 14: UPDATE `packages/providers/src/index.ts`
**Action**: UPDATE
**Details**: Add after the Pi community export block (line 51–56):
```typescript
// Community providers
export {
  PiProvider,
  parsePiConfig,
  registerPiProvider,
  type PiProviderDefaults,
} from './community/pi';

export {
  GeminiProvider,
  parseGeminiConfig,
  registerGeminiProvider,
  type GeminiProviderDefaults,
} from './community/gemini';
```

**Validate**: `bun run type-check`

---

### Task 15: UPDATE `packages/core/src/config/config-loader.ts`
**Action**: UPDATE
**Details**: In `SAFE_ASSISTANT_FIELDS` at line 96–102, add the Gemini entry:
```typescript
const SAFE_ASSISTANT_FIELDS: Record<string, readonly string[]> = {
  claude: ['model'],
  codex: ['model', 'modelReasoningEffort', 'webSearchMode'],
  pi: ['model'],
  gemini: ['model'],  // ADD THIS LINE
};
```

**Validate**: `bun run type-check`

---

### Task 16: UPDATE `packages/cli/src/commands/doctor.ts`
**Action**: UPDATE
**Details**:

1. Add `checkGemini` function after `checkPi` (around line 126). The function already imports `join`, `homedir`, and `probeAuthJsonExists` — no new imports needed.

```typescript
export async function checkGemini(env: NodeJS.ProcessEnv): Promise<CheckResult> {
  const label = 'Gemini provider';
  const isDefault = env.DEFAULT_AI_ASSISTANT === 'gemini';

  if (!isDefault) {
    return { label, status: 'skip', message: 'Gemini not configured' };
  }

  // Gemini OAuth credentials written by `gemini login`
  const credsPath = join(homedir(), '.gemini', 'credentials.json');
  if (probeAuthJsonExists(credsPath)) {
    return { label, status: 'pass', message: '~/.gemini/credentials.json found' };
  }

  // Fallback: explicit API key env vars (ADC precedence order)
  const keyVars = ['GEMINI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_API_KEY'] as const;
  const foundKey = keyVars.find(v => (env[v] ?? '').trim().length > 0);
  if (foundKey) {
    return { label, status: 'pass', message: `${foundKey} is set` };
  }

  return {
    label,
    status: 'fail',
    message:
      'Gemini is configured as default but no auth found. ' +
      'Run `gemini login` to sign in with Google (writes ~/.gemini/credentials.json), ' +
      'or set GEMINI_API_KEY.',
  };
}
```

2. Add `checkGemini(env)` to the `promises` array in `doctorCommand` after `checkPi(env)`:
```typescript
const promises = checks
  ? checks.map(fn => fn())
  : [
      checkClaudeBinary(env),
      checkGhAuth(env),
      checkPi(env),
      checkGemini(env),  // ADD THIS LINE
      checkDatabase(),
      checkWorkspaceWritable(),
      checkBundledDefaults(),
      checkSlack(env),
      checkTelegram(env),
    ];
```

**Pattern**: Follow `checkPi` at `packages/cli/src/commands/doctor.ts:98–126`
**Validate**: `bun run type-check`

---

### Task 17: UPDATE `packages/web/src/routes/SettingsPage.tsx`
**Action**: UPDATE
**Details**: Insert a new `provider.id === 'gemini'` branch between the `codex` branch and the generic fallback, at line 572 (after the closing brace of the codex if-block):

```tsx
if (provider.id === 'gemini') {
  return (
    <div
      key={provider.id}
      className="grid grid-cols-[140px_1fr] items-center gap-2 text-sm"
    >
      <div className="font-medium">{provider.displayName}</div>
      <div className="text-muted-foreground">Community provider settings</div>

      <label htmlFor="gemini-model">Model</label>
      <Input
        id="gemini-model"
        value={(providerSettings.model as string | undefined) ?? ''}
        onChange={e => {
          updateProviderSettings('gemini', { model: e.target.value });
        }}
        placeholder="gemini-2.5-pro"
      />
    </div>
  );
}
```

Insert this block at line 572, before the generic `return (` fallback block.
**Pattern**: Claude branch at `SettingsPage.tsx:492–515`; Codex model uses `Input` not `select` (line 528)
**Validate**: `bun run type-check`

---

### Task 18: UPDATE `packages/providers/src/registry.test.ts`
**Action**: UPDATE
**Details**: Three changes:

1. Add import for `registerGeminiProvider`:
```typescript
import { registerGeminiProvider } from './community/gemini/registration';
```

2. In `registerCommunityProviders (aggregator)` describe block (line 252), update the comment and add Gemini assertion:
```typescript
test('registers all bundled community providers', () => {
  registerCommunityProviders();
  expect(isRegisteredProvider('pi')).toBe(true);
  expect(isRegisteredProvider('gemini')).toBe(true);  // ADD
});
```

3. Add a new describe block for Gemini after the Pi block (line 267), mirroring it:
```typescript
describe('registerGeminiProvider (community provider)', () => {
  test('registers gemini with builtIn: false', () => {
    registerGeminiProvider();
    const reg = getRegistration('gemini');
    expect(reg.id).toBe('gemini');
    expect(reg.displayName).toBe('Gemini (community)');
    expect(reg.builtIn).toBe(false);
  });

  test('is idempotent', () => {
    registerGeminiProvider();
    expect(() => registerGeminiProvider()).not.toThrow();
    const entries = getRegisteredProviders().filter(p => p.id === 'gemini');
    expect(entries).toHaveLength(1);
  });

  test('declares v1 capabilities', () => {
    registerGeminiProvider();
    const caps = getProviderCapabilities('gemini');
    expect(caps.sessionResume).toBe(true);
    expect(caps.envInjection).toBe(true);
    expect(caps.toolRestrictions).toBe(true);
    expect(caps.mcp).toBe(false);
    expect(caps.structuredOutput).toBe(false);
    expect(caps.hooks).toBe(false);
  });

  test('appears in getProviderInfoList with builtIn: false', () => {
    registerGeminiProvider();
    const info = getProviderInfoList().find(p => p.id === 'gemini');
    expect(info).toBeDefined();
    expect(info?.builtIn).toBe(false);
  });

  test('does not collide with built-ins or Pi', () => {
    registerGeminiProvider();
    registerPiProvider();
    const ids = getRegisteredProviders().map(p => p.id).sort();
    expect(ids).toEqual(['claude', 'codex', 'gemini', 'pi']);
  });
});
```

**Validate**: `bun test packages/providers/src/registry.test.ts`

---

### Task 19: UPDATE `packages/server/src/routes/api.providers.test.ts`
**Action**: UPDATE
**Details**: The test currently only calls `registerBuiltinProviders()`. Add a test that also registers community providers and verifies Gemini appears with `builtIn: false`.

Add imports at the top:
```typescript
import { registerCommunityProviders } from '@archon/providers';
```

Add a new describe block after the existing tests (around line 224):
```typescript
describe('GET /api/providers — community providers', () => {
  let app: Hono;

  beforeEach(() => {
    clearRegistry();
    registerBuiltinProviders();
    registerCommunityProviders();
    app = makeApp();
  });

  test('includes gemini as a community provider', async () => {
    const response = await app.request('/api/providers');
    const body = (await response.json()) as {
      providers: { id: string; builtIn: boolean }[];
    };
    const gemini = body.providers.find(p => p.id === 'gemini');
    expect(gemini).toBeDefined();
    expect(gemini?.builtIn).toBe(false);
  });

  test('includes pi as a community provider', async () => {
    const response = await app.request('/api/providers');
    const body = (await response.json()) as {
      providers: { id: string; builtIn: boolean }[];
    };
    const pi = body.providers.find(p => p.id === 'pi');
    expect(pi).toBeDefined();
    expect(pi?.builtIn).toBe(false);
  });
});
```

Note: The existing tests' `beforeEach` calls `clearRegistry(); registerBuiltinProviders()` so they are isolated and unaffected.

Wait — the existing test does NOT have a `beforeEach` for clearRegistry. Check: at line 135–137 it does `clearRegistry(); registerBuiltinProviders();` at module level (not in beforeEach). To avoid interference, wrap the existing tests in their own `beforeEach` that re-registers only built-ins. Actually, looking at the file more carefully — clearRegistry and registerBuiltinProviders are called at module load (line 135-137), not in beforeEach. The new community provider tests need their own describe block with beforeEach that calls clearRegistry + both register calls. The existing tests may see both providers if community providers are registered globally. Add `afterEach(() => { clearRegistry(); registerBuiltinProviders(); })` to the new describe block to restore state.

**Validate**: `bun test packages/server/src/routes/api.providers.test.ts`

---

### Task 20: UPDATE `packages/docs-web/src/content/docs/getting-started/ai-assistants.md`
**Action**: UPDATE
**Details**: Add a `## Gemini` section before or after the Pi section (not before Claude/Codex which are built-ins). Follow the Pi section's structure.

Append after the Pi section:

```markdown
## Gemini

**Community provider** (`builtIn: false`) — wraps [`@lrilai/gemini-cli-sdk`](https://www.npmjs.com/package/@lrilai/gemini-cli-sdk), which delegates to a locally-installed `gemini-cli` binary (≥0.37.1).

### Authentication

Gemini uses **ambient OAuth credentials** from `gemini login`. No API key is stored in Archon.

```bash
# Sign in with Google — writes ~/.gemini/credentials.json
gemini login
```

Alternatively, set one of these env vars (ADC precedence order):
- `GEMINI_API_KEY` — Gemini AI Studio API key
- `GOOGLE_APPLICATION_CREDENTIALS` — path to a service account JSON file
- `GOOGLE_API_KEY` — Google Cloud API key

### Binary requirement

`gemini-cli` must be installed separately (≥0.37.1):

```bash
npm install -g @google/gemini-cli
```

In compiled Archon binaries, if `gemini` is not on PATH, supply the path via:

1. **Environment variable**: `GEMINI_BIN_PATH=/absolute/path/to/gemini`
2. **Config file** (`~/.archon/config.yaml`):
   ```yaml
   assistants:
     gemini:
       geminiBinaryPath: /absolute/path/to/gemini
   ```

### Model naming

Pass model strings verbatim from the [Gemini model list](https://ai.google.dev/gemini-api/docs/models). Examples:

| Model string | Notes |
|---|---|
| `gemini-2.5-pro` | Most capable |
| `gemini-2.5-flash` | Faster, lower cost |
| `gemini-2.0-flash` | Previous generation |

### Sample config

```yaml
# ~/.archon/config.yaml
defaultAssistant: gemini

assistants:
  gemini:
    model: gemini-2.5-pro
```

### Capabilities (v1)

| Capability | Supported |
|---|---|
| Session resume | Yes |
| Tool restrictions (allowed_tools) | Yes |
| Env injection | Yes (subprocess inherits HOME, ~/.gemini resolves automatically) |
| MCP | No (v2 planned) |
| Structured output | No (requires queryFull, incompatible with streaming in v1) |
| Skills, hooks, agents | No |
```

**Validate**: Docs site builds (`bun run dev` in `packages/docs-web`)

---

### Task 21: UPDATE `.env.example`
**Action**: UPDATE
**Details**: Add a Gemini section after the Pi section (around line 65), before the `DEFAULT_AI_ASSISTANT` line:

```ini
# Gemini (community provider — @lrilai/gemini-cli-sdk → gemini-cli binary)
# Auth: run `gemini login` to sign in with Google.
# Credentials land in ~/.gemini/credentials.json and are picked up
# automatically — Archon injects NO key into the subprocess.
# The subprocess inherits HOME so ~/.gemini resolves without config.
#
# Alternatively, set one of (ADC precedence: ADC > GEMINI_API_KEY > GOOGLE_APPLICATION_CREDENTIALS > GOOGLE_API_KEY):
# GEMINI_API_KEY=           # Gemini AI Studio API key
# GOOGLE_APPLICATION_CREDENTIALS=  # path to service account JSON
# GOOGLE_API_KEY=           # Google Cloud API key
#
# Binary path (compiled Archon builds only; dev mode resolves via PATH):
# GEMINI_BIN_PATH=          # e.g. /usr/local/bin/gemini
```

**Validate**: No syntax errors, section is readable

---

### Task 22: UPDATE root `CLAUDE.md`
**Action**: UPDATE
**Details**: Find all references to the provider list `claude, codex, pi` in CLAUDE.md (the Archon Assistant Defaults config.yaml example and the Model Validation section that says `Registered: claude, codex, pi`) and update them to include `gemini`:
- Change `Available providers: claude, codex, pi` → `Available providers: claude, codex, pi, gemini`
- Update the `assistants:` config example if it lists only `claude`/`codex`/`pi` to add a `gemini:` example entry

Find the exact lines using Grep before editing.

**Validate**: Read through CLAUDE.md to confirm consistency

---

### Task 23: RUN FULL VALIDATION
**Action**: Execute
**Command**:
```bash
bun run validate
```

This runs: `check:bundled`, `check:bundled-skill`, `type-check`, `lint`, `format:check`, tests.

**Expected**: All six checks pass, zero warnings (ESLint is `--max-warnings 0`).

If any lint errors arise in new files:
- No `any` without justification comment
- Explicit return types on all functions
- No unused imports

## Testing Strategy

| Test File | Test Cases | Validates |
|-----------|-----------|-----------|
| `packages/providers/src/community/gemini/config.test.ts` | parseGeminiConfig: valid model, invalid type, geminiBinaryPath, combined fields, does-not-throw | Config parsing is defensive |
| `packages/providers/src/community/gemini/options-translator.test.ts` | translateChunk: all 7 chunk types; translateOptions: approvalMode=yolo, model, session, env (HOME not injected), cliPath, allowedTools, systemPrompt precedence | Translation correctness; HOME inheritance |
| `packages/providers/src/community/gemini/provider.test.ts` | getType, getCapabilities, assistant chunk pass-through, no workflow_dispatch, tool_result toolName='', env forwarded without HOME, resumeSessionId→session, error propagation | Port-time fixes; IAgentProvider contract |
| `packages/providers/src/registry.test.ts` | registerGeminiProvider: builtIn=false, idempotent, v1 capabilities, no collision with built-ins/Pi; registerCommunityProviders includes gemini | Registry wiring |
| `packages/server/src/routes/api.providers.test.ts` | Community providers: gemini builtIn=false, pi builtIn=false | API surface for community providers |

## Validation Commands

1. Type check: `bun run type-check`
2. Lint: `bun run lint`
3. Format check: `bun run format:check`
4. Gemini config tests: `bun test packages/providers/src/community/gemini/config.test.ts`
5. Gemini options tests: `bun test packages/providers/src/community/gemini/options-translator.test.ts`
6. Gemini provider tests: `bun test packages/providers/src/community/gemini/provider.test.ts`
7. Registry tests: `bun test packages/providers/src/registry.test.ts`
8. API providers tests: `bun test packages/server/src/routes/api.providers.test.ts`
9. Full: `bun run validate`

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| `@lrilai/gemini-cli-sdk` declares zod 4 as peer dep | HIGH — breaks Archon's zod 3 import | Check at install time; use workspace override `"@lrilai/gemini-cli-sdk>zod": "^3"` if needed; the only zod usage is in outputSchema which is v1-disabled |
| SDK `query()` type not assignable to `sdkOptions` | MED — TS error on the call site | Use `as Parameters<typeof query>[0]` cast (documented: SDK types evolve faster than Archon can track) |
| Pi's `mock.module` pollution affects Gemini provider tests | MED — false pass/fail | Gemini test files go in separate `bun test` invocations in package.json (already the pattern for all community providers) |
| gemini-cli binary not on PATH in CI | LOW — binary-resolver throws | Binary resolver returns `undefined` in dev mode (`BUNDLED_IS_BINARY=false`); CI runs dev mode; tests mock the SDK entirely |
| `translateChunk` for unknown chunk types breaks Archon type | LOW — compile error | Unknown types mapped to `{ type: 'system', content: '...' }` as safe fallback |
