/**
 * NanoClaw — main entry point.
 *
 * Thin orchestrator: init DB, run migrations, start channel adapters,
 * start delivery polls, start sweep, handle shutdown.
 */
import { getDsnProvider, getSecretProvider } from './adapters/index.js';
import { registerAnthropicVertexLlm } from './adk/llm-registry-setup.js';
import { backfillContainerConfigs } from './backfill-container-configs.js';
import { incrementBootCounter } from './boot-counter.js';
import { enforceStartupBackoff, resetCircuitBreaker } from './circuit-breaker.js';
import { migrateGroupsToClaudeLocal } from './claude-md-compose.js';
import { initDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { getContainerRuntimeProvider } from './adapters/container/index.js';
import { startActiveDeliveryPoll, startSweepDeliveryPoll, setDeliveryAdapter, stopDeliveryPolls } from './delivery.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { routeInbound } from './router.js';
import { startCaSecretSync, stopCaSecretSync } from './sidecar/ca-secret-sync.js';
import { log } from './log.js';

// Response + shutdown registries live in response-registry.ts to break the
// circular import cycle: src/index.ts imports src/modules/index.js for side
// effects, and the modules call registerResponseHandler/onShutdown at top
// level — which would hit a TDZ error if the arrays lived here. Re-exported
// here so existing callers see the same surface.
import {
  registerResponseHandler,
  getResponseHandlers,
  onShutdown,
  getShutdownCallbacks,
  type ResponsePayload,
  type ResponseHandler,
} from './response-registry.js';
export { registerResponseHandler, onShutdown };
export type { ResponsePayload, ResponseHandler };

async function dispatchResponse(payload: ResponsePayload): Promise<void> {
  for (const handler of getResponseHandlers()) {
    try {
      const claimed = await handler(payload);
      if (claimed) return;
    } catch (err) {
      log.error('Response handler threw', { questionId: payload.questionId, err });
    }
  }
  log.warn('Unclaimed response', { questionId: payload.questionId, value: payload.value });
}

// Channel barrel — each enabled channel self-registers on import.
// Channel skills uncomment lines in channels/index.ts to enable them.
import './channels/index.js';

// Modules barrel — default modules (typing, mount-security) ship here; skills
// append registry-based modules. Imported for side effects (registrations).
import './modules/index.js';

// CLI command barrel — populates the `ncl` registry before the CLI server
// accepts connections.
import './cli/commands/index.js';
import './cli/delivery-action.js';
import { startCliServer, stopCliServer } from './cli/socket-server.js';

// biblio delivery actions — `acquire_biblio` (仕入れ) / `inspect_biblio` (検品) /
// `categorize_biblio` (カテゴライズ) / `shelve_biblio` (陳列) / `enkin_biblio` (禁書) /
// `shokyaku_biblio` (焼却) / `list_biblio` (蔵書一覧) / `update_config` (設定変更、個別 PRD Phase 5)
// を registerDeliveryAction で登録する side-effect import。host proxy bootstrap (initHostProxy) と
// Vertex ProxyAgent インストール (setupVertexProxy) は main() 内で呼ぶ — 陳列 / 解除 (enkin /
// shokyaku) / 蔵書一覧 (list) も GitHub Git Data API or Contents API を OneCLI MITM proxy 経由
// で叩くため、Vertex 用に設定する ProxyAgent (= global dispatcher) を共用する。
import './biblio/acquire-action.js';
import './biblio/inspect-action.js';
import './biblio/categorize-action.js';
import './biblio/shelve-action.js';
import './biblio/multi-shelve-action.js';
import './biblio/enkin-action.js';
import './biblio/shokyaku-action.js';
import './biblio/list-biblio-action.js';
import './biblio/config-action.js';
import { initHostProxy } from './biblio/host-proxy.js';
import { setupVertexProxy } from './biblio/vertex-client.js';

import type { ChannelAdapter, ChannelSetup } from './channels/adapter.js';
import { initChannelAdapters, teardownChannelAdapters, getChannelAdapter } from './channels/channel-registry.js';
import { shutdownOtel } from './observability/index.js';

async function main(): Promise<void> {
  log.info('NanoClaw starting');

  // M4-B Phase 0: ADK `LLMRegistry` に `AnthropicVertexLlm` を登録。`LlmAgent({model:
  // 'claude-sonnet-4-6'})` の文字列モデル ID 解決経路を成立させる (Phase 1 sub-agent 化の前提)。
  // OTel init は `--import` 経路で main() より前に完了済 = ここでは register のみ。
  registerAnthropicVertexLlm();

  // 0. Circuit breaker — backoff on rapid restarts
  await enforceStartupBackoff();

  // 0b. Resolve environment-difference adapters used here at boot. The app body
  // uses these factories instead of hard-coded env-dependent code, so Phase 2
  // swaps implementations + env without touching callers. The scheduler is
  // resolved (and logged) inside startHostSweep, not here — resolving it just to
  // read its name would create and discard an unused instance.
  const dsn = getDsnProvider();
  log.info('Adapters resolved', { dsn: dsn.name, secret: getSecretProvider().name });

  // 1. Init central DB (location comes from the DSN adapter)
  const dbPath = dsn.centralDbPath();
  const db = initDb(dbPath);
  runMigrations(db);
  log.info('Central DB ready', { path: dbPath });

  // PVC + SQLite の永続化が機能していることを Pod 再作成跨ぎの boots increment で
  // 確認する (Phase 2 verify-phase-2-wiring.sh §7 = 永続化検証の決定的指紋)。
  // 戻り値 -1 は increment 失敗 (migration016 未適用 等)。host は起動を継続するが
  // PVC 永続化が壊れている兆候として可視化する (silent failure 防止)。
  const bootCount = incrementBootCounter(db);
  if (bootCount === -1) {
    log.warn('Boot counter failed — PVC persistence may be broken, continuing startup', { dbPath });
  }

  // 1b. Backfill container_configs from legacy container.json files.
  // Idempotent — skips groups that already have a config row.
  backfillContainerConfigs();

  // 1c. One-time filesystem cutover — idempotent, no-op after first run.
  migrateGroupsToClaudeLocal();

  // 1d. host proxy bootstrap — host を OneCLI agent 登録し、`git`/`gh` 子プロセス用の
  // proxy env (HTTPS_PROXY + CA) を解決する (M2 PRD B Phase 1 仕入れの基盤)。
  // fail-open: OneCLI 未到達でも起動は止めず、仕入れ実行時に失敗を検知する。
  // agent spawn より前に host agent を登録しておくことで、後続の
  // `scripts/onecli-gh-secret.sh` の mode=all 昇格が host agent にも効く。
  await initHostProxy();

  // 1e. Vertex 用 ProxyAgent (undici) を global dispatcher に登録 (M2 PRD B Phase 2 検品の基盤)。
  // initHostProxy() で解決した proxy URL + CA を host 側 fetch (= 検品 dangerous 軸の
  // Vertex × Gemini 呼び出し、モデルは `INSPECT_DANGEROUS_MODEL` env で指定) に効かせる。
  // proxy 未解決でも warn のみで起動は継続 (vertex-client.callVertexGemini が呼ばれた時点で
  // fetch エラー or AbortSignal.timeout(60s) → inspect() が fail-closed で HOLD に倒す)。
  setupVertexProxy();

  // 2. Container runtime — provider-selected via CONTAINER_PROVIDER env
  // (`docker` for local dev, `k8s` for GKE). Pre-flight check (docker info /
  // K8s API reach) plus orphan sweep run regardless of provider.
  const containerRuntime = getContainerRuntimeProvider();
  await containerRuntime.ensureRuntime();
  await containerRuntime.cleanupOrphans();
  log.info(`container runtime = ${containerRuntime.name}`);

  // 3. Channel adapters
  await initChannelAdapters((adapter: ChannelAdapter): ChannelSetup => {
    return {
      onInbound(platformId, threadId, message) {
        routeInbound({
          channelType: adapter.channelType,
          platformId,
          threadId,
          message: {
            id: message.id,
            kind: message.kind,
            content: JSON.stringify(message.content),
            timestamp: message.timestamp,
            isMention: message.isMention,
            isGroup: message.isGroup,
          },
        }).catch((err) => {
          log.error('Failed to route inbound message', { channelType: adapter.channelType, err });
        });
      },
      onInboundEvent(event) {
        routeInbound(event).catch((err) => {
          log.error('Failed to route inbound event', {
            sourceAdapter: adapter.channelType,
            targetChannelType: event.channelType,
            err,
          });
        });
      },
      onMetadata(platformId, name, isGroup) {
        log.info('Channel metadata discovered', {
          channelType: adapter.channelType,
          platformId,
          name,
          isGroup,
        });
      },
      onAction(questionId, selectedOption, userId) {
        dispatchResponse({
          questionId,
          value: selectedOption,
          userId,
          channelType: adapter.channelType,
          // platformId/threadId aren't surfaced by the current onAction
          // signature — registered handlers look them up from the
          // pending_question / pending_approval row.
          platformId: '',
          threadId: null,
        }).catch((err) => {
          log.error('Failed to handle question response', { questionId, err });
        });
      },
    };
  });

  // 4. Delivery adapter bridge — dispatches to channel adapters
  const deliveryAdapter = {
    async deliver(
      channelType: string,
      platformId: string,
      threadId: string | null,
      kind: string,
      content: string,
      files?: import('./channels/adapter.js').OutboundFile[],
    ): Promise<string | undefined> {
      const adapter = getChannelAdapter(channelType);
      if (!adapter) {
        log.warn('No adapter for channel type', { channelType });
        return;
      }
      return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content), files });
    },
    async setTyping(channelType: string, platformId: string, threadId: string | null): Promise<void> {
      const adapter = getChannelAdapter(channelType);
      await adapter?.setTyping?.(platformId, threadId);
    },
  };
  setDeliveryAdapter(deliveryAdapter);

  // 5. Start delivery polls
  startActiveDeliveryPoll();
  startSweepDeliveryPoll();
  log.info('Delivery polls started');

  // 6. Start host sweep
  startHostSweep();
  log.info('Host sweep started');

  // 6b. Start ca-secret-sync (GKE only) — OneCLI sidecar が emptyDir 経由で生成
  // する CA bundle を K8s Secret `biblio-onecli-ca` に自動 upsert するループ。
  // local docker compose 経路 (DSN_PROVIDER=local) では `scripts/onecli-*-secret.sh`
  // 手叩き経路を維持するため起動しない。M2 PRD A Phase 3 で導入 (旧 `TODO(phase-2.6)`)。
  if (process.env.DSN_PROVIDER === 'gke') {
    await startCaSecretSync();
  }

  // 7. Start the `ncl` CLI socket server (data/ncl.sock).
  await startCliServer();

  log.info('NanoClaw running');
}

/** Graceful shutdown. */
async function shutdown(signal: string): Promise<void> {
  log.info('Shutdown signal received', { signal });
  for (const cb of getShutdownCallbacks()) {
    try {
      await cb();
    } catch (err) {
      log.error('Shutdown callback threw', { err });
    }
  }
  stopDeliveryPolls();
  stopHostSweep();
  stopCaSecretSync();
  await stopCliServer();
  try {
    await teardownChannelAdapters();
  } finally {
    try {
      await shutdownOtel();
    } catch (err) {
      log.error('OTel shutdown failed', { err });
    }
    // Always reset on graceful shutdown — even if teardown threw, we got here
    // via SIGTERM/SIGINT, not a crash, so the next start shouldn't be counted
    // as one.
    resetCircuitBreaker();
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  log.fatal('Startup failed', { err });
  process.exit(1);
});
