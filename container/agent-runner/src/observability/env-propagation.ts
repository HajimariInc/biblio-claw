// NOTE: src/observability/env-propagation.ts (host) と対になるファイル。
// 実装は完全に一致させること (Bun/Node の型差なし)。host を編集したら必ず本ファイルも同じ変更を入れる。
//
// W3C Env Carriers Specification: 環境変数経由での trace context 伝搬では
// キーを UPPERCASE に正規化する (= K8s env 慣習)。OTel propagator は lowercase
// (`traceparent` / `tracestate`) で carrier を inject/extract するため、本 Setter/
// Getter で大文字化を仲介する。詳細: https://opentelemetry.io/docs/specs/otel/context/env-carriers/
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
