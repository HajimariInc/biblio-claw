import type { TextMapGetter, TextMapSetter } from '@opentelemetry/api';

export const upperCaseEnvSetter: TextMapSetter<Record<string, string>> = {
  set(carrier, key, value) {
    carrier[key.toUpperCase()] = value;
  },
};

type EnvCarrier = NodeJS.ProcessEnv | Record<string, string | undefined>;

export const upperCaseEnvGetter: TextMapGetter<EnvCarrier> = {
  get(carrier, key) {
    return carrier[key.toUpperCase()];
  },
  keys(carrier) {
    return Object.keys(carrier);
  },
};
