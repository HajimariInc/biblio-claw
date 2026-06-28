// node --import ./dist/instrumentation.js dist/index.js
// tsx --import ./src/instrumentation.ts src/index.ts
// 経由でアプリの他モジュールより先に load される
import { ensureHostNoProxy } from './observability/no-proxy.js';
import { startOtel } from './observability/otel.js';
import { log } from './log.js';

// host 自身の NO_PROXY に telemetry.googleapis.com を追加する (= startOtel 前必須)。
// 詳細は src/observability/no-proxy.ts:ensureHostNoProxy の JSDoc 参照。
ensureHostNoProxy();

// init failure (= projectId 未設定 / ADC 取得失敗 / network) で host 本体を止めない。
// agent-runner 側 (container/agent-runner/src/observability/otel-init.ts) と同じ
// degraded fallback 方針 — telemetry なしでも biblio actions / Slack 経路は生かす。
await startOtel().catch((err: unknown) => {
  log.warn('OTel init failed, continuing without telemetry', { error: String(err) });
});
