/**
 * MCP server プロセス spawn 時の env overlay (M4-F Phase 3、life-capabilities)。
 *
 * ## なぜ overlay が必要か
 * Claude Agent SDK の公式 troubleshooting は「stdio MCP server の `env` フィールドを
 * 明示せよ、親プロセスからの継承に依存するな」と明記している
 * (`code.claude.com/docs/en/agent-sdk/mcp`)。したがって MCP server 子プロセスに
 * `HTTPS_PROXY` / `NODE_EXTRA_CA_CERTS` 等の proxy 系 env を明示的に渡す必要がある。
 *
 * `container_configs.mcp_servers[*].env` は seed script で desired state を持つが、
 * proxy 値は環境 (local docker vs GKE) で違う (host.docker.internal vs cluster DNS)
 * ため DB に埋めるのは適切ではない。**agent-container 起動時に、container の
 * 実 proxy env (= K8s 経路で既に cluster DNS に書き換わっている値) を各 mcp server
 * の env に overlay する** のが最も無理のない解 (plan §Solution Approach (5) 推奨経路)。
 *
 * ## overlay の順序
 * `{ ...proxyEnv, ...serverConfig.env }` の spread 順で **serverConfig.env が優先**
 * される (= seed 時の意図的な env override を破壊しない)。例えば seed で
 * `TAVILY_API_KEY: 'placeholder'` を書いた entry は overlay 後もそのまま残る。
 *
 * ## unit test 可能性
 * index.ts に inline すると module top-level で `main()` が実行される都合上、
 * import した瞬間に副作用が走って test しにくい。本 module に切り出すと副作用ゼロで
 * import + unit test 可能。
 */

/**
 * MCP server 子プロセスに継承させる host 側 proxy 系 env のキー一覧。
 * order: HTTPS_PROXY / HTTP_PROXY を先に。CA bundle 系は Node と gcloud CLI 両方で
 * 尊重される値のみ (undici は SSL_CERT_FILE を見ないが Node 22 native fetch は見る、
 * gh CLI (Go) は SSL_CERT_FILE を尊重する = container/Dockerfile:100 で設定済)。
 */
export const PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
] as const;

/**
 * host env から PROXY_ENV_KEYS の値だけを抽出する。undefined 値は落とす
 * (= SDK 側で `env: { HTTPS_PROXY: undefined }` を渡すと spawn 時に NaN / error に
 * 化ける可能性がある defensive 経路)。
 */
export function extractProxyEnv(hostEnv: NodeJS.ProcessEnv): Record<string, string> {
  const entries: [string, string][] = [];
  for (const key of PROXY_ENV_KEYS) {
    const val = hostEnv[key];
    if (typeof val === 'string' && val.length > 0) {
      entries.push([key, val]);
    }
  }
  return Object.fromEntries(entries);
}

/**
 * proxy env を server の env に overlay する。順序: proxyEnv → serverConfig.env の
 * spread 順で serverConfig 側が優先 (= 意図的な override を破壊しない)。
 * serverConfig.env が undefined の場合は空 object 扱い (spread は無害だが型明示化)。
 */
export function overlayServerEnv(
  serverConfig: { env?: Record<string, string> },
  proxyEnv: Record<string, string>,
): Record<string, string> {
  return { ...proxyEnv, ...(serverConfig.env ?? {}) };
}
