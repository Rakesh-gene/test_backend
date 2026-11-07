import { trace, SpanStatusCode, type Span, type SpanKind } from '@opentelemetry/api';
import { currentContext, inContext } from './context.js';
export {
  captureTraceContext,
  traceCorrelation,
  withTraceContext,
  type TraceCarrier,
} from './context.js';
export { SpanStatusCode, SpanKind } from '@opentelemetry/api';
import { TracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import pino from 'pino';
import { redact } from '@kode/contracts';

export function telemetry(
  options: { endpoint?: string; logFile?: string; secrets?: string[]; quietLogs?: boolean } = {},
) {
  const endpoint =
    options.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';
  const enabled =
    process.env.OTEL_SDK_DISABLED !== 'true' &&
    Boolean(
      options.endpoint ||
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
      process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ||
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
    );
  const endpointFor = (signal: string) => `${endpoint!.replace(/\/$/, '')}/v1/${signal}`;
  const batch = {
    maxQueueSize: 512,
    maxExportBatchSize: 64,
    scheduledDelayMillis: 1000,
    exportTimeoutMillis: 1000,
  };
  const traceProvider = new TracerProvider({
    spanProcessors: enabled
      ? [
          new BatchSpanProcessor({
            ...batch,
            exporter: new OTLPTraceExporter({
              url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? endpointFor('traces'),
              timeoutMillis: 500,
            }),
          }),
        ]
      : [],
  });
  const logProvider = new LoggerProvider({
    processors: enabled
      ? [
          new BatchLogRecordProcessor({
            ...batch,
            exporter: new OTLPLogExporter({
              url: process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? endpointFor('logs'),
              timeoutMillis: 500,
            }),
          }),
        ]
      : [],
  });
  const meterProvider = new MeterProvider({
    readers: enabled
      ? [
          new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({
              url: process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? endpointFor('metrics'),
              timeoutMillis: 500,
            }),
            exportIntervalMillis: 1000,
            exportTimeoutMillis: 700,
          }),
        ]
      : [],
  });
  const tracer = traceProvider.getTracer('kode', '0.1.0');
  const logs = logProvider.getLogger('kode', '0.1.0');
  const calls = meterProvider.getMeter('kode').createCounter('kode.rpc.requests');
  const logger = pino(
    { level: 'info', base: { service: 'kode' }, enabled: !options.quietLogs },
    pino.destination({ dest: options.logFile ?? 2, sync: true }),
  );
  function log(message: string, fields: Record<string, unknown> = {}, span?: Span) {
    span ??= trace.getSpan(currentContext());
    const spanContext = span?.spanContext();
    const safe = redact(
      {
        ...fields,
        message,
        ...(spanContext ? { trace_id: spanContext.traceId, span_id: spanContext.spanId } : {}),
      },
      options.secrets,
    ) as Record<string, unknown>;
    logger.info(safe);
    logs.emit({
      severityText: 'INFO',
      body: String(safe.message),
      attributes: {
        ...Object.fromEntries(
          Object.entries(safe).filter(
            ([, value]) =>
              typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
          ),
        ),
      } as Record<string, string | number | boolean>,
      context: span ? trace.setSpan(currentContext(), span) : currentContext(),
    });
  }
  return {
    log,
    async operation<T>(
      name: string,
      work: (span: Span) => Promise<T>,
      options: { kind?: SpanKind } = {},
    ): Promise<T> {
      const parent = currentContext();
      const span = tracer.startSpan(name, options, parent);
      calls.add(1, { operation: name });
      return inContext(trace.setSpan(parent, span), async () => {
        try {
          const result = await work(span);
          log('operation.completed', { operation: name }, span);
          return result;
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: 'Operation failed' });
          log('operation.failed', { operation: name }, span);
          throw error;
        } finally {
          span.end();
        }
      });
    },
    async flush() {
      await Promise.allSettled([
        traceProvider.forceFlush(),
        logProvider.forceFlush(),
        meterProvider.forceFlush(),
      ]);
    },
    async close() {
      await Promise.allSettled([
        traceProvider.shutdown(),
        logProvider.shutdown(),
        meterProvider.shutdown(),
      ]);
    },
  };
}
