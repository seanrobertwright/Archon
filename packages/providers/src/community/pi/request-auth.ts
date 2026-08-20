interface ProviderEnvAuthStorage {
  get(provider: string): unknown;
  getProviderEnv(provider: string): Record<string, string> | undefined;
}

/**
 * Give one custom provider access to request/project env without exposing values
 * delivered from the acting user's provider credential store.
 *
 * Pi owns config parsing and calls getProviderEnv() for the selected provider.
 * A request-local proxy keeps every other AuthStorage behavior and stored
 * credential on the original instance.
 */
export function withCustomProviderRequestEnv<T extends ProviderEnvAuthStorage>(
  authStorage: T,
  provider: string,
  requestEnv: Readonly<Record<string, string>> | undefined,
  userCredentialEnvKeys: readonly string[] | undefined
): T {
  if (authStorage.get(provider) !== undefined || !requestEnv) {
    return authStorage;
  }

  const credentialKeys = new Set(userCredentialEnvKeys);
  const providerEnv = Object.fromEntries(
    Object.entries(requestEnv).filter(([key]) => !credentialKeys.has(key))
  );
  if (Object.keys(providerEnv).length === 0) {
    return authStorage;
  }

  return new Proxy(authStorage, {
    get(target, property): unknown {
      if (property === 'getProviderEnv') {
        return (requestedProvider: string): Record<string, string> | undefined =>
          requestedProvider === provider
            ? { ...providerEnv }
            : target.getProviderEnv(requestedProvider);
      }

      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') {
        return value;
      }
      return (...args: unknown[]): unknown => {
        const result: unknown = Reflect.apply(value, target, args);
        return result;
      };
    },
  });
}
