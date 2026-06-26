import { context, propagation, ROOT_CONTEXT, type Context } from '@opentelemetry/api';
import { upperCaseEnvSetter, upperCaseEnvGetter } from './env-propagation.js';

export { startOtel, shutdownOtel, getTracer } from './otel.js';
export { upperCaseEnvSetter, upperCaseEnvGetter } from './env-propagation.js';

export function injectTraceContextToEnv(carrier: Record<string, string>): void {
  propagation.inject(context.active(), carrier, upperCaseEnvSetter);
}

export function extractTraceContextFromEnv(carrier: NodeJS.ProcessEnv | Record<string, string | undefined>): Context {
  return propagation.extract(ROOT_CONTEXT, carrier, upperCaseEnvGetter);
}
