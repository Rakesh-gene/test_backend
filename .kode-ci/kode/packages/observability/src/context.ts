import { AsyncLocalStorage } from 'node:async_hooks';
import {
  context,
  trace,
  isSpanContextValid,
  ROOT_CONTEXT,
  defaultTextMapGetter,
  defaultTextMapSetter,
  type Context,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

export interface TraceCarrier {
  traceparent?: string;
  tracestate?: string;
}
const active = new AsyncLocalStorage<Context>();
const propagator = new W3CTraceContextPropagator();

// Do not replace a host application's global OTel context manager.
export const currentContext = () => active.getStore() ?? context.active();
export function inContext<T>(value: Context, action: () => T): T {
  return active.run(value, action);
}
export function captureTraceContext(): TraceCarrier {
  const carrier: Record<string, string> = {};
  propagator.inject(currentContext(), carrier, defaultTextMapSetter);
  return carrier;
}
export function traceCorrelation(): Record<string, string> {
  const span = trace.getSpanContext(currentContext());
  return span && isSpanContextValid(span) ? { trace_id: span.traceId, span_id: span.spanId } : {};
}
export function withTraceContext<T>(carrier: TraceCarrier | undefined, action: () => T): T {
  const parent = propagator.extract(ROOT_CONTEXT, carrier ?? {}, defaultTextMapGetter);
  return inContext(parent, action);
}
