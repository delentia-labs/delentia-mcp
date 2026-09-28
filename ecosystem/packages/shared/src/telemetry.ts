/**
 * Delentia Resilience & Sentry Telemetry System
 * Provides 24/7 crash capture, performance timing, and audit tracking across Edge Workers
 */

export interface TelemetryContext {
  serverName: string;
  requestId?: string;
  actionName?: string;
  environment?: string;
  url?: string;
}

export interface TelemetryReport {
  timestamp: string;
  status: "OK" | "ERROR";
  server: string;
  message: string;
  stack?: string;
  context: Record<string, unknown>;
  sentToSentry: boolean;
}

/**
 * Captures an exception and dispatches telemetry to Sentry DSN if configured
 */
export async function captureException(
  error: unknown,
  context: TelemetryContext,
  sentryDsn?: string
): Promise<TelemetryReport> {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  let sentToSentry = false;

  if (sentryDsn && sentryDsn.startsWith("http")) {
    try {
      // Dispatch payload to Sentry Envelope API asynchronously without blocking
      await fetch(sentryDsn, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: errorMessage,
          level: "error",
          server_name: context.serverName,
          environment: context.environment || "production",
          extra: {
            url: context.url,
            action: context.actionName,
            requestId: context.requestId,
            stack,
          },
        }),
      }).catch(() => {});
      sentToSentry = true;
    } catch {
      // Non-blocking resilience
    }
  }

  return {
    timestamp: new Date().toISOString(),
    status: "ERROR",
    server: context.serverName,
    message: errorMessage,
    stack,
    context: { ...context },
    sentToSentry,
  };
}

/**
 * Measures execution time of an operation
 */
export async function measureLatency<T>(
  fn: () => Promise<T>
): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  const result = await fn();
  const durationMs = Math.round((performance.now() - start) * 100) / 100;
  return { result, durationMs };
}
