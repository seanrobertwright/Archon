interface ProviderEnvAuthStorage {
  get(provider: string): unknown;
  getProviderEnv(provider: string): Record<string, string> | undefined;
  hasAuth(provider: string): boolean;
}

/**
 * Give one custom provider access to request/project env without exposing values
 * injected by Archon as credentials.
 *
 * Pi owns config parsing and calls these public methods for the selected
 * provider. AuthStorage is created once per request, so narrowing these two
 * methods on that instance cannot leak into another request.
 */
export function withCustomProviderRequestEnv<T extends ProviderEnvAuthStorage>(
  authStorage: T,
  provider: string,
  requestEnv: Readonly<Record<string, string>> | undefined,
  protectedEnvKeys: readonly string[] | undefined
): T {
  if (authStorage.get(provider) !== undefined || !requestEnv) {
    return authStorage;
  }

  const credentialKeys = new Set(protectedEnvKeys);
  const providerEnv = Object.fromEntries(
    Object.entries(requestEnv).filter(([key]) => !credentialKeys.has(key))
  );
  if (Object.keys(requestEnv).length === 0) {
    return authStorage;
  }

  // A non-enumerable throwing property prevents Pi's resolver from falling
  // through to process.env for a protected name, while keeping protected values
  // out of the environment object later passed to the model request.
  for (const key of credentialKeys) {
    Object.defineProperty(providerEnv, key, {
      configurable: false,
      enumerable: false,
      get(): never {
        throw new Error(
          `Custom Pi provider '${provider}' cannot access protected environment variable '${key}'`
        );
      },
    });
  }

  const getProviderEnv = authStorage.getProviderEnv.bind(authStorage);
  const hasAuth = authStorage.hasAuth.bind(authStorage);
  const hasRequestProviderEnv = Object.keys(providerEnv).length > 0;
  authStorage.getProviderEnv = (requestedProvider: string): Record<string, string> | undefined =>
    requestedProvider === provider ? providerEnv : getProviderEnv(requestedProvider);
  authStorage.hasAuth = (requestedProvider: string): boolean =>
    (requestedProvider === provider && hasRequestProviderEnv) || hasAuth(requestedProvider);

  return authStorage;
}
