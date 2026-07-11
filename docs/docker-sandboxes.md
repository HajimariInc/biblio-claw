# Docker Sandbox 内で NanoClaw を動かす (手動セットアップ)

> **biblio-claw fork note**: 本 doc は NanoClaw v2 上流 (commit `2492259`) の日本語訳。biblio-claw では **GKE Autopilot 上の K8s Job を Prod 主軸**とし、Local 開発では Docker (native、Sandbox 無し) を既定で使う。Docker Sandbox はハイパーバイザレベル分離を求める場合の選択肢として保持。GKE Autopilot Warden 制約への対処は [`SECURITY.md`](SECURITY.md) の §セキュリティ境界 §1 参照。

このガイドは、[Docker Sandbox](https://docs.docker.com/ai/sandboxes/) 内で NanoClaw をゼロからセットアップする手順 — install スクリプトなし、ビルド済 fork なし。Upstream の repo を clone し、必要な patch を当て、agent をフルなハイパーバイザレベルの分離で動かす。

## アーキテクチャ

```
Host (macOS / Windows WSL)
└── Docker Sandbox (隔離されたカーネルを持つマイクロ VM)
    ├── NanoClaw プロセス (Node.js)
    │   ├── Channel adapter (WhatsApp, Telegram 等)
    │   └── Container spawner → ネストされた Docker デーモン
    └── Docker-in-Docker
        └── nanoclaw-agent コンテナ
            └── Claude Agent SDK
```

各 agent は host から完全に分離されたマイクロ VM の中の独自のコンテナで動く。分離は 2 層:agent ごとのコンテナ + VM 境界。

サンドボックスは `host.docker.internal:3128` に MITM proxy を提供し、ネットワークアクセスを扱って Anthropic API キーを自動注入する。

> **Note:** このガイドは macOS(Apple Silicon)+ WhatsApp で検証されたセットアップに基づく。他の channel(Telegram、Slack 等)や環境(Windows WSL)は、それぞれの HTTP / WebSocket クライアントに対する追加 proxy patch が必要かもしれない。コアの patch(container runner、credential proxy、Dockerfile)は普遍的に適用される — channel 固有の proxy 設定は variable する。

## 前提条件

- **Docker Desktop v4.40+** Sandbox サポート付き
- **Anthropic API キー**(サンドボックスの proxy が注入を管理する)
- **Telegram** の場合:[@BotFather](https://t.me/BotFather) からの bot トークンと chat ID
- **WhatsApp** の場合:WhatsApp がインストールされた phone

サンドボックスサポートを確認:
```bash
docker sandbox version
```

## ステップ 1: サンドボックスを作る

Host マシンで:

```bash
# workspace ディレクトリを作成
mkdir -p ~/nanoclaw-workspace

# workspace をマウントした shell サンドボックスを作る
docker sandbox create shell ~/nanoclaw-workspace
```

WhatsApp を使うなら、WhatsApp の Noise プロトコルが MITM 検査されないよう proxy bypass を設定する:

```bash
docker sandbox network proxy shell-nanoclaw-workspace \
  --bypass-host web.whatsapp.com \
  --bypass-host "*.whatsapp.com" \
  --bypass-host "*.whatsapp.net"
```

Telegram は proxy bypass は不要。

サンドボックスに入る:
```bash
docker sandbox run shell-nanoclaw-workspace
```

## ステップ 2: 前提条件をインストール

サンドボックス内で:

```bash
sudo apt-get update && sudo apt-get install -y build-essential python3
npm config set strict-ssl false
```

## ステップ 3: NanoClaw を clone してインストール

NanoClaw は workspace ディレクトリ内に住まなければならない — Docker-in-Docker は共有 workspace パスからしか bind-mount できない。

```bash
# まず home に clone する (virtiofs は clone 中に git pack ファイルを破損しうる)
cd ~
git clone https://github.com/nanocoai/nanoclaw.git

# あなたの workspace パスに置き換える (`docker sandbox create` に渡した host パス)
WORKSPACE=/Users/you/nanoclaw-workspace

# DinD のマウントが効くよう workspace に移動
mv nanoclaw "$WORKSPACE/nanoclaw"
cd "$WORKSPACE/nanoclaw"

# 依存をインストール
pnpm install
pnpm install https-proxy-agent
```

## ステップ 4: Proxy とサンドボックスの patch を当てる

NanoClaw は Docker Sandbox 内で動くためにいくつかの patch を必要とする。これらは proxy ルーティング、CA 証明書、Docker-in-Docker マウント制限を扱う。

### 4a. Dockerfile — コンテナイメージビルド用の proxy 引数

`docker build` 内の `pnpm install` は、サンドボックスの MITM proxy が独自の証明書を提示するため `SELF_SIGNED_CERT_IN_CHAIN` で失敗する。`container/Dockerfile` に proxy ビルド引数を追加する:

`FROM` 行の後に次の行を追加:

```dockerfile
# proxy ビルド引数を受け付ける
ARG http_proxy
ARG https_proxy
ARG no_proxy
ARG NODE_EXTRA_CA_CERTS
ARG npm_config_strict_ssl=true
RUN npm config set strict-ssl ${npm_config_strict_ssl}
```

そして `RUN pnpm install` 行の後に:

```dockerfile
RUN npm config set strict-ssl true
```

### 4b. Build スクリプト — proxy 引数を forward する

`container/build.sh` を patch して proxy env var を `docker build` に渡す:

`docker build` コマンドに次の `--build-arg` フラグを追加:

```bash
--build-arg http_proxy="${http_proxy:-$HTTP_PROXY}" \
--build-arg https_proxy="${https_proxy:-$HTTPS_PROXY}" \
--build-arg no_proxy="${no_proxy:-$NO_PROXY}" \
--build-arg npm_config_strict_ssl=false \
```

### 4c. Container runner — proxy forward、CA 証明書マウント、/dev/null 修正

`src/container-runner.ts` への 3 つの変更:

**`/dev/null` のシャドウマウントを置き換える。** サンドボックスは `/dev/null` の bind マウントを拒否する。`.env` が `/dev/null` にシャドウマウントされている箇所を見つけ、空ファイルで置き換える:

```typescript
// .env をシャドウマウントする空ファイルを作る (Docker Sandbox は /dev/null マウントを拒否する)
const emptyEnvPath = path.join(DATA_DIR, 'empty-env');
if (!fs.existsSync(emptyEnvPath)) fs.writeFileSync(emptyEnvPath, '');
// マウントで '/dev/null' の代わりに emptyEnvPath を使う
```

**Proxy env var を forward する**、spawn される agent コンテナへ。`HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` とその小文字版に対して `-e` フラグを追加する。

**CA 証明書をマウント。** `NODE_EXTRA_CA_CERTS` または `SSL_CERT_FILE` が設定されていれば、証明書をプロジェクトディレクトリにコピーして agent コンテナにマウントする:

```typescript
const caCertSrc = process.env.NODE_EXTRA_CA_CERTS || process.env.SSL_CERT_FILE;
if (caCertSrc) {
  const certDir = path.join(DATA_DIR, 'ca-cert');
  fs.mkdirSync(certDir, { recursive: true });
  fs.copyFileSync(caCertSrc, path.join(certDir, 'proxy-ca.crt'));
  // マウント: certDir -> /workspace/ca-cert (read-only)
  // コンテナで NODE_EXTRA_CA_CERTS=/workspace/ca-cert/proxy-ca.crt を設定
}
```

### 4d. Container runtime — 自己終了を防ぐ

`src/container-runtime.ts` で、`cleanupOrphans()` 関数は `nanoclaw-` プレフィックスでコンテナをマッチする。サンドボックスの中では、サンドボックスコンテナ自身がマッチしうる(例:`nanoclaw-docker-sandbox`)。停止対象のコンテナリストから現在の hostname を除外する:

```typescript
// cleanupOrphans() で、停止すべきコンテナリストから os.hostname() を除外する
```

### 4e. Credential proxy — MITM proxy 経由でルーティング

`src/credential-proxy.ts` で、upstream API リクエストはサンドボックス proxy 経由で行く必要がある。Outbound リクエストに `HttpsProxyAgent` を追加:

```typescript
import { HttpsProxyAgent } from 'https-proxy-agent';

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
const upstreamAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
// upstreamAgent を https.request() の options に渡す
```

### 4f. Setup スクリプト — proxy ビルド引数

`setup/container.ts` を patch して、`build.sh`(ステップ 4b)と同じ proxy `--build-arg` フラグを渡す。

## ステップ 5: ビルド

```bash
pnpm run build
bash container/build.sh
```

## ステップ 6: Channel を追加

### Telegram

```bash
# Telegram skill を適用
pnpm exec tsx scripts/apply-skill.ts .claude/skills/add-telegram

# skill 適用後に再ビルド
pnpm run build

# .env を設定
cat > .env << EOF
TELEGRAM_BOT_TOKEN=<your-token-from-botfather>
ASSISTANT_NAME=nanoclaw
ANTHROPIC_API_KEY=proxy-managed
EOF
mkdir -p data/env && cp .env data/env/env

# chat を登録
pnpm exec tsx setup/index.ts --step register \
  --jid "tg:<your-chat-id>" \
  --name "My Chat" \
  --trigger "@nanoclaw" \
  --folder "telegram_main" \
  --channel telegram \
  --assistant-name "nanoclaw" \
  --is-main \
  --no-trigger-required
```

**chat ID の調べ方:** 自分の bot に何かメッセージを送り、次を実行:
```bash
curl -s --proxy $HTTPS_PROXY "https://api.telegram.org/bot<TOKEN>/getUpdates" | python3 -m json.tool
```

**Telegram の group 利用:** @BotFather で Group Privacy を無効化(`/mybots` > Bot Settings > Group Privacy > Turn off)し、bot を一度削除して再追加する。

**重要:** Telegram skill が `src/channels/telegram.ts` を作る場合、proxy サポート用に patch が必要。`HttpsProxyAgent` を追加し、`baseFetchConfig.agent` 経由で grammy の `Bot` コンストラクタに渡す。その後再ビルド。

### WhatsApp

最初に [ステップ 1](#ステップ-1-サンドボックスを作る) で proxy bypass を設定したことを確認する。

```bash
# WhatsApp skill を適用
pnpm exec tsx scripts/apply-skill.ts .claude/skills/add-whatsapp

# 再ビルド
pnpm run build

# .env を設定
cat > .env << EOF
ASSISTANT_NAME=nanoclaw
ANTHROPIC_API_KEY=proxy-managed
EOF
mkdir -p data/env && cp .env data/env/env

# 認証 (どちらかを選ぶ):

# QR コード — WhatsApp カメラでスキャン:
pnpm exec tsx src/whatsapp-auth.ts

# または ペアリングコード — WhatsApp > Linked Devices > Link with phone number にコードを入力:
pnpm exec tsx src/whatsapp-auth.ts --pairing-code --phone <phone-number-no-plus>

# chat を登録 (JID = 電話番号 + @s.whatsapp.net)
pnpm exec tsx setup/index.ts --step register \
  --jid "<phone>@s.whatsapp.net" \
  --name "My Chat" \
  --trigger "@nanoclaw" \
  --folder "whatsapp_main" \
  --channel whatsapp \
  --assistant-name "nanoclaw" \
  --is-main \
  --no-trigger-required
```

**重要:** WhatsApp skill ファイル(`src/channels/whatsapp.ts` と `src/whatsapp-auth.ts`)も proxy patch が必要 — WebSocket 接続用の `HttpsProxyAgent` と proxy 対応の version fetch を追加する。その後再ビルド。

### 両方の channel

両方の skill を適用し、両方を proxy サポート用に patch し、`.env` 変数を統合し、各 chat を個別に登録する。

## ステップ 7: 起動

```bash
pnpm start
```

`ANTHROPIC_API_KEY` を手動設定する必要はない。サンドボックスの proxy がリクエストをインターセプトし、`proxy-managed` を実キーで自動的に置き換える。

## ネットワーキングの詳細

### Proxy の仕組み

サンドボックスからのすべてのトラフィックは host の proxy(`host.docker.internal:3128`)経由でルーティングされる:

```
Agent コンテナ → DinD bridge → Sandbox VM → host.docker.internal:3128 → Host proxy → api.anthropic.com
```

**「Bypass」はトラフィックが proxy を skip するという意味ではない。** Proxy が MITM 検査なしにトラフィックを通すという意味である。Node.js は `HTTP_PROXY` env var を自動使用しない — 各 HTTP / WebSocket クライアントで明示的な `HttpsProxyAgent` 設定が必要。

### DinD マウントの共有パス

Workspace ディレクトリだけが Docker-in-Docker の bind マウントに使える。Workspace の外のパスは「path not shared」で失敗する:
- `/dev/null` → プロジェクトディレクトリ内の空ファイルで置換
- `/usr/local/share/ca-certificates/` → プロジェクトディレクトリに証明書をコピー
- `/home/agent/` → 代わりに workspace に clone

### Git clone と virtiofs

Workspace は virtiofs 経由でマウントされる。Git の pack ファイル処理は clone 中に virtiofs 越しで破損しうる。回避策:まず `/home/agent` に clone してから workspace に `mv` する。

## トラブルシューティング

### pnpm install が SELF_SIGNED_CERT_IN_CHAIN で失敗
```bash
npm config set strict-ssl false
```

### Container build が proxy エラーで失敗
```bash
docker build \
  --build-arg http_proxy=$http_proxy \
  --build-arg https_proxy=$https_proxy \
  -t nanoclaw-agent:latest container/
```

### Agent コンテナが「path not shared」で失敗
すべての bind マウントパスは workspace ディレクトリ配下にあるべき。確認:
- NanoClaw は workspace に clone されているか?(`/home/agent/` ではない)
- CA 証明書はプロジェクトルートにコピーされているか?
- 空の `.env` シャドウファイルは作られているか?

### Agent コンテナが Anthropic API に到達できない
Proxy env var が agent コンテナに forward されているか確認。コンテナログで `HTTP_PROXY=http://host.docker.internal:3128` を確認する。

### WhatsApp エラー 405
Version fetch が古いバージョンを返している。Proxy 対応 `fetchWaVersionViaProxy` patch が当たっていることを確認する — `HttpsProxyAgent` 経由で `sw.js` を fetch し `client_revision` をパースする。

### WhatsApp が即「Connection failed」
Proxy bypass が設定されていない。**host** で実行する:
```bash
docker sandbox network proxy <sandbox-name> \
  --bypass-host web.whatsapp.com \
  --bypass-host "*.whatsapp.com" \
  --bypass-host "*.whatsapp.net"
```

### Telegram bot がメッセージを受け取らない
1. Grammy の proxy patch が当たっているか確認(`src/channels/telegram.ts` 内の `HttpsProxyAgent` を探す)
2. Group で使うなら @BotFather で Group Privacy が無効化されているか確認

### Git clone が「inflate: data stream error」で失敗
まず非 workspace パスに clone してから移動する:
```bash
cd ~ && git clone https://github.com/nanocoai/nanoclaw.git && mv nanoclaw /path/to/workspace/nanoclaw
```

### WhatsApp QR コードが表示されない
サンドボックスの中で auth コマンドを対話的に実行する(`docker sandbox exec` 経由でパイプしない):
```bash
docker sandbox run shell-nanoclaw-workspace
# その中で:
pnpm exec tsx src/whatsapp-auth.ts
```
