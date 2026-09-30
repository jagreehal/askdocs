import { metrics, SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';

/**
 * Traces and metrics through the OpenTelemetry API only. With no SDK registered, every call here
 * is a no-op and nothing leaves the process. `serve --otel` registers one (autotel).
 *
 * Attributes carry library ids, counts, outcomes and timings: never query text, paths asked for,
 * or who asked. People paste secrets into questions; the audit log holds those, under its
 * retention limit, and a trace backend should not become a second copy with none.
 */
const tracer = trace.getTracer('askdocs');

// Looked up per call: unlike tracers, the metrics API hands out no proxy, so an instrument made
// before `--otel` registers the SDK would stay a no-op. The SDK returns the same instrument each time.
// Durations need nothing here: autotel-mcp-instrumentation records mcp.server.operation.duration.
const searches = () =>
  metrics.getMeter('askdocs').createCounter('askdocs.searches', {
    description: 'search_docs calls, by whether a top result covered most of the question',
  });

/** Run `work` in a span named `name`, recording a thrown error on the span before rethrowing it. */
export function traced<T>(
  name: string,
  attributes: Attributes,
  work: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await work(span);
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** What one tool call did, on its span (the one autotel-mcp-instrumentation opened for it). */
export function recordToolCall(call: {
  tool: string;
  library?: string;
  results: number;
  answered?: boolean;
}) {
  const span = trace.getActiveSpan();
  span?.setAttributes({ 'askdocs.tool': call.tool, 'askdocs.results': call.results });

  if (call.library) span?.setAttribute('askdocs.library', call.library);

  if (call.answered === undefined) return;
  span?.setAttribute('askdocs.answered', call.answered);
  searches().add(1, { 'askdocs.answered': call.answered });
}

/**
 * Register autotel as the OpenTelemetry SDK, exporting over OTLP to OTEL_EXPORTER_OTLP_ENDPOINT
 * (autotel's default is http://localhost:4318). Loaded only when asked for. Returns the
 * flush-and-stop to run before exiting.
 */
export async function startTelemetry(): Promise<() => Promise<void>> {
  const autotel = await import('autotel');

  autotel.init({
    service: process.env.OTEL_SERVICE_NAME ?? 'askdocs',
    endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    headers: process.env.OTEL_EXPORTER_OTLP_HEADERS,
  });

  return autotel.shutdown;
}
