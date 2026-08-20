export type ErrorReporter = {
  capture: (error: unknown, context?: Record<string, unknown>) => void;
};

type ErrorLogger = {
  error: (context: Record<string, unknown>, message: string) => void;
};

export function createErrorReporter(
  service: string,
  logger: ErrorLogger,
): ErrorReporter {
  return {
    capture(error, context = {}) {
      const normalized = error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { name: "UnknownError", message: String(error) };

      logger.error(
        { service, error: normalized, ...context },
        "Unhandled application error",
      );
    },
  };
}