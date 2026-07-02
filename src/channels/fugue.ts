/**
 * Fugue channel adapter (M4-E Phase 1) — Slack と同型の薄いラッパ + `ChannelAdapter` 契約
 * に薄く準拠 + `registerChannelAdapter('fugue', {factory})` の self-registration。
 *
 * Fugue は Cloud Run request-response (同期) で応答するため、Slack の Chat SDK bridge や
 * outbound.db 経路は使わない。`setup()` で独立 HTTP server を start、`teardown()` で stop、
 * `deliver()` は throw (呼ばれた場合は上流バグの表出 = silent no-op 撲滅原則)。
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';

import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { FugueHttpServer } from './fugue-http.js';

function createFugueAdapter(): ChannelAdapter | null {
  const env = readEnvFile(['FUGUE_SHARED_TOKEN', 'FUGUE_HTTP_PORT', 'FUGUE_HTTP_HOST']);
  // Slack と同じく credential 欠落なら null (warn ログのみで adapter 未起動)。
  // half-config で HTTP server を起動すると認証穴になるため、token 空文字も未起動扱い。
  if (!env.FUGUE_SHARED_TOKEN) return null;

  const port = parseInt(env.FUGUE_HTTP_PORT || '8080', 10);
  const host = env.FUGUE_HTTP_HOST || '127.0.0.1';
  const server = new FugueHttpServer({ port, host, expectedToken: env.FUGUE_SHARED_TOKEN });

  const adapter: ChannelAdapter = {
    name: 'fugue',
    channelType: 'fugue',
    // Fugue は Cloud Run request-response で thread 概念なし (router.ts の thread 処理を
    // 経由しない設計)。
    supportsThreads: false,

    async setup(_config: ChannelSetup): Promise<void> {
      // `_config: ChannelSetup` は Phase 1 では使わない (`_` prefix で未使用を明示)。
      // Phase 2/3 で consult/equip endpoint が session 経路に流す設計になれば `config.onInbound`
      // を使う可能性がある (現状 PRD は同期 request-response 想定のため見込み薄)。
      const { port: boundPort } = await server.start();
      log.info('Fugue channel adapter started', {
        event: 'fugue.adapter.started',
        outcome: 'success',
        channel: 'fugue',
        port: boundPort,
        host,
      });
    },

    async teardown(): Promise<void> {
      await server.stop();
      log.info('Fugue channel adapter stopped', {
        event: 'fugue.adapter.stopped',
        outcome: 'success',
        channel: 'fugue',
      });
    },

    isConnected(): boolean {
      return server.isListening();
    },

    async deliver(
      _platformId: string,
      _threadId: string | null,
      _message: OutboundMessage,
    ): Promise<string | undefined> {
      // Fugue は同期 request-response で応答するため、outbound.db 経由の deliver は
      // 呼ばれない設計。呼ばれた場合は上流バグを明示的に表出させる (silent failure 撲滅)。
      throw new Error(
        'FugueChannelAdapter.deliver is not implemented: Fugue uses synchronous HTTP request-response, not outbound.db routing',
      );
    },
  };
  return adapter;
}

registerChannelAdapter('fugue', { factory: createFugueAdapter });
