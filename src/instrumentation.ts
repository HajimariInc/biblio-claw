// node --import ./dist/instrumentation.js dist/index.js
// tsx --import ./src/instrumentation.ts src/index.ts
// 経由でアプリの他モジュールより先に load される
import { startOtel } from './observability/otel.js';

await startOtel();
