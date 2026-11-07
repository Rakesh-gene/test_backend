import { ExportResultCode } from '@opentelemetry/core';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import {
  AggregationTemporality,
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';

export interface SignalHealth {
  queued: number;
  capacity: number;
  dropped: number;
  exportFailed: number;
  exported: number;
}
export interface TelemetryHealth {
  enabled: boolean;
  observedAt: string;
  traces: SignalHealth;
  logs: SignalHealth;
  metricExportFailures: number;
  limits: { queue: number; batch: number; exporterTimeoutMs: number };
}
const empty = (): SignalHealth => ({
  queued: 0,
  capacity: 0,
  dropped: 0,
  exportFailed: 0,
  exported: 0,
});
export function metricDiagnostics(enabled: boolean, url: string) {
  let latest: TelemetryHealth = {
    enabled,
    observedAt: new Date().toISOString(),
    traces: empty(),
    logs: empty(),
    metricExportFailures: 0,
    limits: { queue: 512, batch: 64, exporterTimeoutMs: 500 },
  };
  let failures = 0;
  const observe = (data: ResourceMetrics) => {
    const next = {
      ...latest,
      observedAt: new Date().toISOString(),
      traces: empty(),
      logs: empty(),
      metricExportFailures: failures,
    };
    for (const scope of data.scopeMetrics)
      for (const metric of scope.metrics) {
        const match =
          /^otel\.sdk\.processor\.(span|log)\.(queue\.size|queue\.capacity|processed)$/.exec(
            metric.descriptor.name,
          );
        if (!match) continue;
        const signal = match[1] === 'span' ? next.traces : next.logs;
        for (const point of metric.dataPoints) {
          if (typeof point.value !== 'number') continue;
          if (match[2] === 'queue.size') signal.queued += point.value;
          else if (match[2] === 'queue.capacity') signal.capacity += point.value;
          else if (point.attributes['error.type'] === 'queue_full') signal.dropped += point.value;
          else if (point.attributes['error.type']) signal.exportFailed += point.value;
          else signal.exported += point.value;
        }
      }
    latest = next;
  };
  const remote = enabled ? new OTLPMetricExporter({ url, timeoutMillis: 500 }) : undefined;
  const exporter: PushMetricExporter = {
    selectAggregationTemporality: () => AggregationTemporality.CUMULATIVE,
    export(data, done) {
      observe(data);
      if (!remote) {
        done({ code: ExportResultCode.SUCCESS });
        return;
      }
      remote.export(data, (result) => {
        if (result.code !== ExportResultCode.SUCCESS) failures++;
        done(result);
      });
    },
    forceFlush: async () => {
      await remote?.forceFlush();
    },
    shutdown: async () => {
      await remote?.shutdown();
    },
  };
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 1000,
    exportTimeoutMillis: 700,
  });
  const provider = new MeterProvider({ readers: [reader] });
  return {
    provider,
    async status(): Promise<TelemetryHealth> {
      const collected = await reader.collect();
      observe(collected.resourceMetrics);
      return structuredClone(latest);
    },
  };
}
