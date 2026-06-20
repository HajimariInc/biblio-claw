/**
 * host proxy bootstrap.
 *
 * NanoClaw は元々 host (orchestrator) からの外部 HTTP に認証を載せない —
 * GH token は OneCLI gateway が *agent コンテナ* に MITM 注入するだけで、host
 * 自身は素の経路で github を叩く。仕入れ (acquire.ts) は host から `git`/`gh`
 * を子プロセス実行するため、host にも token を載せる必要がある。
 *
 * そこで host を OneCLI の 1 agent として登録し、gateway proxy 設定
 * (`HTTPS_PROXY` + CA bundle) を取得して、`git`/`gh` 子プロセスの env に注入する。
 * CLI は `HTTPS_PROXY` を尊重するので子プロセスには `undici.ProxyAgent` 不要。一方
 * host 自身の `fetch` (Node) は `setupVertexProxy()` 経由で `undici.ProxyAgent` を
 * global dispatcher に登録する経路で別途配線する (= 検品 / 陳列の host fetch はこちら)。
 *
 * 環境非依存: host プロセスは local (docker compose の公開ポート) でも GKE
 * (同一 Pod の OneCLI Native sidecar) でも proxy を `127.0.0.1` (= localhost) で叩く。
 * SDK の `getContainerConfig` は agent コンテナ向けの Docker ホスト
 * (`host.docker.internal`) を含む proxy URL を返すため、ホスト部だけを `127.0.0.1`
 * へ rewrite する (port や認証部分はそのまま — k8s.ts の rewriteOneCLIEnv が
 * agent Pod 用に cluster DNS へ rewrite するのと対になる host 版)。
 */
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';

import { getSecretProvider } from '../adapters/secret/index.js';
import { DATA_DIR } from '../config.js';
import { log } from '../log.js';

/** host を OneCLI vault 上の 1 agent として表す identifier。 */
export const HOST_AGENT_ID = 'biblio-orchestrator-host';

/** SDK が返す Docker 向け proxy ホスト。host 経路では到達不能なので rewrite する。 */
const ONECLI_DOCKER_HOST = 'host.docker.internal';
/** host プロセスから OneCLI proxy へ到達する先 (local=公開ポート / GKE=同一 Pod sidecar)。 */
const HOST_PROXY_HOST = '127.0.0.1';

/** git=`GIT_SSL_CAINFO` / gh(Go)=`SSL_CERT_FILE` が読む CA bundle の書き出し先。 */
const CA_FILE = path.join(DATA_DIR, '.onecli-host-ca.pem');

interface ProxyState {
  httpsProxy?: string;
  httpProxy?: string;
  caPath?: string;
}

let state: ProxyState = {};

/**
 * SDK の Docker 向け proxy URL を host 到達可能な値に rewrite する。
 * 想定外フォーマット (将来 SDK が localhost を返す等) は warn して素通しする
 * (silent に壊さない)。
 */
function rewriteProxyHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!value.includes(ONECLI_DOCKER_HOST)) {
    log.warn('host proxy: unexpected proxy host format — not rewriting', { value, expected: ONECLI_DOCKER_HOST });
    return value;
  }
  return value.replaceAll(ONECLI_DOCKER_HOST, HOST_PROXY_HOST);
}

/**
 * host を OneCLI agent 登録し、proxy env + CA を解決して保持する。
 *
 * fail-open: OneCLI 未到達 (local で gateway 不在 等) でも host 起動は止めない。
 * proxy なしの env が返り、実際の取得は `acquire()` の spawn status 判定で
 * 失敗検知される (ハングしない)。CLAUDE.md §落とし穴: host agent は agent spawn
 * 前 (= 起動時) に登録されるので、後続の `scripts/onecli-gh-secret.sh` の
 * `set_all_agents_mode_all` が host agent も mode=all に昇格できる。
 */
export async function initHostProxy(): Promise<void> {
  const secret = getSecretProvider();
  try {
    await secret.ensureAgent({ name: HOST_AGENT_ID, identifier: HOST_AGENT_ID });
    const cfg = await secret.getProxyConfig(HOST_AGENT_ID);

    const httpsProxy = rewriteProxyHost(cfg.env.HTTPS_PROXY ?? cfg.env.https_proxy);
    // OneCLI proxy が HTTP_PROXY を返さない構成 (docker compose は gateway のみ公開) では
    // httpsProxy にフォールバックする — http/https 両方を同一 proxy に向ける。
    const httpProxy = rewriteProxyHost(cfg.env.HTTP_PROXY ?? cfg.env.http_proxy) ?? httpsProxy;

    let caPath: string | undefined;
    if (cfg.caCertificate) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      // OneCLI MITM CA + Mozilla root CA bundle を連結して書き出す。
      //
      // 背景: OneCLI proxy は secret の hostPattern にマッチしない host を `mode=tunnel`
      // で素通しする (= MITM しない)。tunnel 経路では client が **本物の TLS cert** を
      // 受け取るため、OneCLI CA だけでは trust chain が完成しない (例: `git clone https://github.com/...`
      // の host = `github.com` には api.github.com 用 secret しかなくマッチせず tunnel に倒れる)。
      //
      // 対策: `tls.rootCertificates` (Node.js v12.3+ 組み込み Mozilla root CA bundle) を
      // OneCLI CA に append した combined bundle を書き出すことで、MITM 経路でも tunnel 経路でも
      // どちらの cert chain も成立させる。Mozilla root のみで trust が完結する素の HTTPS 経路
      // (proxy 無し fallback) にも効く。
      //
      // 環境非依存: `/etc/ssl/certs/ca-certificates.crt` (Debian) や `/etc/pki/tls/certs/ca-bundle.crt`
      // (RHEL) などの OS バンドルに依存しない。
      const combinedCa = `${cfg.caCertificate.trim()}\n${tls.rootCertificates.join('\n')}\n`;
      fs.writeFileSync(CA_FILE, combinedCa);
      caPath = CA_FILE;
    }

    state = { httpsProxy, httpProxy, caPath };
    log.info('host proxy initialized', { hasProxy: Boolean(httpsProxy), hasCa: Boolean(caPath) });
  } catch (err) {
    // fail-open — 起動は継続。取得時に proxy なしで失敗を検知する。
    state = {};
    log.warn('host proxy init failed — git/gh will run without OneCLI proxy', { err });
  }
}

/**
 * `git`/`gh` 子プロセス用の env を返す。
 *
 * proxy が解決済みなら `HTTPS_PROXY`/`HTTP_PROXY` + CA 経路
 * (`GIT_SSL_CAINFO`=git curl backend, `SSL_CERT_FILE`=gh Go SDK,
 * `NODE_EXTRA_CA_CERTS`=Node fetch) を注入する。未解決なら素の
 * `process.env` のコピーを返す (取得は失敗するが host 自身の env は汚さない)。
 */
export function getChildProcEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (state.httpsProxy) env.HTTPS_PROXY = state.httpsProxy;
  if (state.httpProxy) env.HTTP_PROXY = state.httpProxy;
  if (state.caPath) {
    env.GIT_SSL_CAINFO = state.caPath;
    env.SSL_CERT_FILE = state.caPath;
    env.NODE_EXTRA_CA_CERTS = env.NODE_EXTRA_CA_CERTS ?? state.caPath;
  }
  return env;
}

/**
 * 解決済みの host proxy 状態 (proxy URL + CA file path) を返す。
 *
 * `getChildProcEnv()` が `git`/`gh` 子プロセス向けに env を組むのに対し、本 getter は
 * host 内 Node `fetch` (= undici ProxyAgent) や任意の HTTP クライアントが proxy + CA を
 * 動的に効かせるための値を生で取り出せる窓口 (薄い getter に徹し動的解決ラッパーは
 * 入れない)。Phase 2 検品の Vertex 直接呼び出しが初のクライアントだが、用途は限定しない。
 * CA の読み込みは呼び出し側が `fs.readFileSync(caPath)` で行う。
 *
 * fail-open: `initHostProxy()` で proxy 未解決の場合は両方 `undefined`。
 * 呼び出し側は proxy なしで fetch し、TLS / 認可で失敗を検知する設計を取る。
 */
export function getProxyState(): { httpsProxy?: string; caPath?: string } {
  return { httpsProxy: state.httpsProxy, caPath: state.caPath };
}

/** Test-only: モジュール状態をリセットする。 */
export function _resetHostProxyForTesting(): void {
  state = {};
}
