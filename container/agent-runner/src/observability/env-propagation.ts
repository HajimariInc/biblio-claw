// NOTE: host (src/observability/env-propagation.ts) と agent
// (container/agent-runner/src/observability/env-propagation.ts) で同一実装を維持するファイル。
// 片方を編集したら必ずもう一方にも同じ変更を適用すること (= Phase 1 auth.ts / trace-fields.ts と同流儀、
// scripts/verify-m4-a.sh §7 で `diff -q` による drift 検知あり、byte-for-byte 一致が前提)。
//
// W3C Env Carriers Specification: 環境変数経由での trace context 伝搬では
// キーを UPPERCASE に正規化する (= K8s env 慣習)。OTel propagator は lowercase
// (`traceparent` / `tracestate`) で carrier を inject/extract するため、本 Setter/
// Getter で大文字化を仲介する。詳細: https://opentelemetry.io/docs/specs/otel/context/env-carriers/
//
// 役割分担:
//   - upperCaseEnvSetter: 新規 carrier 用 (Record<string, string>, undefined 不許可)
//     = host が container spawn 時に env 配列を作る経路
//   - upperCaseEnvGetter: process.env 用 (string | undefined 許可)
//     = agent-runner 起動時に process.env から復元する経路
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
