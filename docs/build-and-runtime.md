# ビルドとランタイム

NanoClaw は分割スタックで動く:host は Node + pnpm、agent コンテナは Bun。両者はセッションごとの 2 つの SQLite ファイル経由でのみ通信する — 両者の間に共有モジュールは存在しない。これが、異なるランタイムを綺麗に使い分けられる理由である。

## なぜ分割するのか

- **host を Node のままにする** 理由:Baileys(WhatsApp)が `libsignal-node` のネイティブバインディングと長年テストされた WebSocket / HTTP スタックに依存しているため。Bun の Node-API 互換性は改善してきているが、ここはリスクを取りたい場所ではない。
- **コンテナを Bun で動かす** 理由:`bun:sqlite` が組み込みで(イメージ再ビルドごとの `better-sqlite3` のネイティブコンパイル不要)、ソースが直接走り(イメージビルド時にもセッションウェイク時にも tsc ビルドステップが不要)、`bun install` は `npm install` より ~5-10 倍速い。

host とコンテナはそれぞれ独自のパッケージツリーを持つ:

```
/                             pnpm + Node 24
  pnpm-lock.yaml              host の依存 (channels, Chat SDK, Baileys, better-sqlite3, zod 等)
  pnpm-workspace.yaml         minimumReleaseAge + onlyBuiltDependencies ポリシー

/container/agent-runner/      Bun 1.3+
  bun.lock                    agent-runner のランタイム依存 (Claude Agent SDK, MCP SDK, zod 等)
  package.json                @types/bun、型チェック用の typescript devDeps
```

コンテナイメージはグローバル CLI(`@anthropic-ai/claude-code`、`agent-browser`、`vercel`)のために、内部にも pnpm + Node を持つ。これらは agent がランタイムで呼ぶ Node バイナリで、ライブラリ依存ではない。pnpm に置いておくことで、CLI バージョンに対するサプライチェーンポリシーが保たれる。

## Lockfile

| ツリー | Lockfile | マネージャ | 依存変更後の再生成 |
|------|----------|---------|----------------------------|
| Host | `pnpm-lock.yaml` | pnpm 10 | `pnpm install` |
| Agent-runner | `container/agent-runner/bun.lock` | Bun 1.3+ | `cd container/agent-runner && bun install` |

両方とも commit する。CI と Dockerfile は `--frozen-lockfile` 系のコマンドを走らせる — `package.json` と lockfile の間のドリフトがあれば、ビルドが失敗する。

## サプライチェーン

- **Host + グローバル CLI**(pnpm):`minimumReleaseAge: 4320`(新バージョンに対する 3 日間のホールド)、postinstall スクリプト用の `onlyBuiltDependencies` allowlist。`pnpm-workspace.yaml` と `docs/SECURITY.md` を参照。
- **Agent-runner**(Bun):release-age ポリシーはない — Bun には今のところ相当する仕組みがない。防御策は `bun.lock` の pin と、Dockerfile の ARG 経由でバージョン固定された CLI および Bun 自身である。`@anthropic-ai/claude-agent-sdk` やランタイム依存をバンプする際は、npm 上のリリース日を確認し、`bun update` ではなく意図的にバンプすること。

## イメージビルドのサーフェス

`container/Dockerfile` は `node:22-slim` 上のシングルステージビルドである:

- **Pin された ARG** — `BUN_VERSION`、`CLAUDE_CODE_VERSION`、`AGENT_BROWSER_VERSION`、`VERCEL_VERSION`、`GH_CLI_VERSION`、`TAVILY_MCP_VERSION` (M4-F Phase 3、Web 検索 MCP server)。PR で意図的にバンプする。
- **CJK フォント** — `ARG INSTALL_CJK_FONTS=false`。`container/build.sh` は `.env` から `INSTALL_CJK_FONTS` を読み、build-arg として渡す。デフォルトビルドで ~200MB 節約;ユーザが中国語/日本語/韓国語のコンテンツを扱う場合はオプトインする。
- **BuildKit のキャッシュマウント** — `/var/cache/apt`、`/var/lib/apt`、`/root/.bun/install/cache`、`/root/.cache/pnpm`。`package.json` / `bun.lock` が変わっていない再ビルドは速い。BuildKit が必要(Docker 23+ ではデフォルト、Apple Container と互換)。
- **`tini` を init として使う** — Chromium のゾンビプロセスを reap し、SIGTERM を転送して in-flight の `outbound.db` 書き込みを確定させる。
- **`entrypoint.sh`**(切り出し済) — tini の下で `exec bun run /app/src/index.ts`。読みやすく diff も取りやすい。
- **コンパイル済 `/app/dist` を持たない** — Bun が TS を直接走らせる。host はセッション開始時にフレッシュなソースを `/app/src` 上にマウントするので、host の編集はイメージを再ビルドせず反映される。

## セッションウェイク(3 つの経路)

1. **ベースイメージの ENTRYPOINT** — `container/build.sh` のサンプルのような、stdin を流す test invocation に使う:`tini --> entrypoint.sh` が stdin を `/tmp/input.json` にキャプチャし、`exec bun run src/index.ts` する。
2. **Host から Docker spawn したセッション** (`CONTAINER_PROVIDER=docker`、local 開発) — `src/adapters/container/docker.ts` が `--entrypoint bash` を `-c '/app/install-biblios.sh && exec bun run /app/src/index.ts'` で使う (M3 Phase 2 以降、`/app/install-biblios.sh` が装備済 biblio の spawn-time install wrapper として bun の前に走る — 装備 0 件なら早期 exit で no-op)。tini をバイパスする(Docker のデフォルト PID 1 ハンドリングが効く)。stdin は使われない;すべての IO はマウントされたセッション DB を流れる。
3. **Host から K8s Job spawn したセッション** (`CONTAINER_PROVIDER=k8s`、GKE) — `src/adapters/container/k8s.ts` が Batch v1 Job を `createNamespacedJob` で発行し、`containers[0].command = ['bash']` + `args = ['-c', '/app/install-biblios.sh && exec bun run /app/src/index.ts']` を設定する (M3 Phase 2 以降、同上)。同じく tini はバイパスし、K8s が Pod の PID 1 ハンドリングを担う。`/data` 配下のセッション DB は **orchestrator の RWO PVC (`data-biblio-orchestrator-0`) を podAffinity で同ノード共有し、subPath volumeMount で個別 view としてマウント** する (M2 PRD A Phase 2.5 で移行)。OneCLI proxy CA bundle は K8s Secret (`biblio-onecli-ca`) からマウントし、agent Pod の `securityContext.fsGroup` を `1000` に設定して `node` ユーザ (UID/GID 1000) がそれを読み書きできるようにする。`translateSpec` は OneCLI SDK が返す Docker 由来 env (`HTTPS_PROXY=...@host.docker.internal:10255`、`NODE_EXTRA_CA_CERTS=/tmp/onecli-gateway-ca.pem`) を K8s 用 (`biblio-onecli.biblio-claw.svc.cluster.local:10255`、`/etc/ssl/certs/onecli/onecli-combined-ca.pem`) に post-process する。Secret の中身は M2 PRD A Phase 3 で **orchestrator Pod 内の OneCLI Native sidecar が emptyDir 経由で生成した CA bundle を `src/sidecar/ca-secret-sync.ts` が起動時 + 60s 周期で自動 upsert** する (Phase 2.5 までは `kubectl create secret` の手動投入だったが、本 Phase で廃止)。hostPath は GKE Autopilot Warden (`autogke-no-write-mode-hostpath`) に deny されるため使わない。

3 経路とも、`/app/src/index.ts` の同じソースファイルを Bun が走らせて終わる。

## CI の形

`.github/workflows/ci.yml` は Node(pnpm キャッシュ付き)と Bun の両方をインストールし、順に実行する:

1. `pnpm install --frozen-lockfile`(host)
2. `container/agent-runner/` で `bun install --frozen-lockfile`(コンテナ)
3. `pnpm run format:check`
4. `pnpm exec tsc --noEmit`(host の型チェック)
5. `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`(コンテナの型チェック)
6. `pnpm exec vitest run`(host のテスト)
7. `container/agent-runner/` で `bun test`(コンテナのテスト)

いずれかが失敗すれば PR は fail する。

## 主要な不変条件

- **セッション DB は `journal_mode=DELETE` を使う必要がある。** WAL の `-shm` メモリマップは host とゲストの間で VirtioFS を越えられない。`container/agent-runner/src/db/connection.ts` 先頭のドキュメントコメントと `src/session-manager.ts` を参照。
- **コンテナ側の named SQL パラメータは、JS オブジェクトのキーにプレフィックスを必要とする。** `bun:sqlite` は host 側の `better-sqlite3` のように `@` / `$` / `:` を自動で剥がさない。SQL とキーの両方で `$name` を使う:`.run({ $id: msg.id })`。位置パラメータ `?` は通常通り動く。
- **Agent-runner のテストは vitest ではなく `bun:test` で走る。** `vitest.config.ts` は `container/agent-runner/` ツリーを除外している(vitest は Node 上で動き、`bun:sqlite` をロードできないため)。
- **コンテナイメージに tsc ビルドステップを置かない。** 再導入するとセッションウェイクごとに ~200-500ms のコストが復活する(取り除いた当のコスト)。
- **コンテナのグローバル CLI は Bun ではなく pnpm に置く。** `agent-browser`、`@anthropic-ai/claude-code`、`vercel`、その他将来 agent が呼び出す Node CLI は、Dockerfile の pnpm グローバルインストールブロックの下にバージョン pin して置くべきである。`bun install -g` は pnpm のサプライチェーンポリシーをバイパスする。

## マイグレーション履歴

この構造は、host とコンテナの両方をまたぐ均一な npm-on-Node スタックを置き換えたものである。まず pnpm マイグレーションがランディングして(PR #1771)、host をサプライチェーンポリシーの下に置き、次にコンテナが Bun に移行して、ネイティブモジュールのコンパイルとウェイクごとの tsc ステップを排除した。完全 Bun 化ではなく分割を選んだ理由は、Baileys のネイティブ依存が host 側のメインリスク面だから — コンテナにそうした依存はないので、リスクを取らずに Bun の恩恵を得られる。
