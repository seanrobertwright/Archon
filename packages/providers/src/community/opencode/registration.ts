import { isRegisteredProvider, registerProvider } from '../../registry';

import { OPENCODE_CAPABILITIES } from './capabilities';
import { parseModelRef, parseOpencodeRunConfig } from './config';
import { OpencodeProvider } from './provider';

/**
 * Register the OpenCode community provider.
 *
 * Idempotent — safe to call multiple times from process entrypoints.
 */
export function registerOpencodeProvider(): void {
  if (isRegisteredProvider('opencode')) return;
  registerProvider({
    id: 'opencode',
    displayName: 'OpenCode (community)',
    factory: () => new OpencodeProvider(),
    capabilities: OPENCODE_CAPABILITIES,
    builtIn: false,
    parseRunConfig: parseOpencodeRunConfig,
    parseModelRef: model => {
      const parsed = parseModelRef(model);
      return parsed === null
        ? { ok: false, reason: "expected '<provider>/<model>'" }
        : { ok: true, model: `${parsed.providerID}/${parsed.modelID}` };
    },
    // OpenCode's backend universe is the models.dev catalog, resolved at
    // runtime by the embedded server — there is no static list to declare.
    // Introspection is exposed via GET /api/providers/opencode/credentials.
    credentials: { kind: 'dynamic' },
  });
}
