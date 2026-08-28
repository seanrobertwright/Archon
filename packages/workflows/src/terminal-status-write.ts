export class TerminalStatusWriteError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(
      `Failed to persist terminal workflow status: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
    this.name = 'TerminalStatusWriteError';
    this.cause = cause;
  }
}

export async function requireTerminalStatusWrite<T>(write: Promise<T>): Promise<T> {
  try {
    return await write;
  } catch (error) {
    throw new TerminalStatusWriteError(error);
  }
}
