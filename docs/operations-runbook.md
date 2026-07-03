# 運用 Runbook — ログ・状態確認・管理コマンド(ローカル / GCP)

最終更新:2026-07-03

orchestrator / agent container / OneCLI それぞれを「どこから・どのコマンドで」操作するかの早見表。ローカルと GCP で**叩く場所が根本的に違う**ので、まず大原則を押さえる。

## 大原則:どこから叩くか

| | ローカル(開発) | GCP(本番相当) |
| :--- | :--- | :--- |
| 基本操作 | **repo ルートで直接**(`docker` / `pnpm`) | **すべて `kubectl` 越し**(`biblio-claw` ns) |
| host(orchestrator) | `pnpm run dev` で起動した 1 プロセス | StatefulSet の Pod **`biblio-orchestrator-0`** |
| OneCLI / 各 sidecar | **独立した docker コンテナ**(`biblio-onecli` 等) | **`biblio-orchestrator-0` Pod の中のコンテナ**(`-c <name>` で指定) |
| agent | docker コンテナ(`nanoclaw-v2-…`) | K8s Job の Pod(`biblio-agent-…`) |

> **GCP の最重要ポイント**:OneCLI も token rotator も**独立 Pod ではなく `biblio-orchestrator-0` の中**にいる(Native sidecar)。だから「OneCLI のログ」は別 Pod を探すのではなく `kubectl logs biblio-orchestrator-0 -c onecli` で見る。Pod 内コンテナ構成:
> - **init**:`fetch-pem`(PEM 取得)/ `cloud-sql-proxy` / `onecli`(gateway 本体、`restartPolicy: Always` の常駐 sidecar)
> - **main**:`orchestrator`(host 本体)/ `gh-token-rotator` / `vertex-token-rotator`

### サブコマンドカタログ (= local / GCP 対称)

各環境の「初期化 / 起動 / 動作確認」は slash command 1 発で完結する。生コマンドの正本は本 runbook 各セクションに残置 (= slash command はその wrapper)。

| サブコマンド | ローカル (`/init-project`) | GCP (`/init-project-gcp`) |
| :--- | :--- | :--- |
| (引数なし) | 新規 setup / 初期化 (= clone 直後の第一選択) | 状態確認 + up (= 入室直後の第一選択、healthy なら no-op) |
| `up` | ensure running (= 不足分だけ起動) | ensure running (= 不足分だけ起動、Pod 落ちなら再 ready、Secret 未投入なら案内) |
| `reset` | factory reset (= docker compose 全消し + image 再 build、`.env` だけ守る) | factory reset (= teardown --dry-run → --confirm → 再構築 + Bootstrap GRANT) |
| `refresh` | 全 token クリーン refresh (Vertex + GH + mode=all) | token 強制再投入 (debug 用途、port-forward 経由で OneCLI に直叩き、通常は sidecar 自動 rotate) |
| `verify` | 全 verify (= インフラ + 外部認証 + サービス + チャネル) | 全 verify (= resource + GKE wiring + 構造化ログ + Phase 4 deploy-verify + Slack E2E、5 段順次) |
| `image-sync --tag <tag>` | — | 4 image を本番反映 (AR push + manifest bump + rollout、副作用大、詳細は §「/init-project-gcp サブコマンド利用ガイド」§§§ `image-sync` 参照) |

slash command 本体は `.claude/commands/init-project.md` (ローカル) と `.claude/commands/init-project-gcp.md` (GCP) を参照。

---

## コンポーネント別 早見表

### 1. orchestrator(host / NanoClaw 本体)

| 操作 | ローカル | GCP |
| :--- | :--- | :--- |
| **ログ** | `pnpm run dev` の stdout(背景起動なら `logs/dev.out` 等にリダイレクト) | `kubectl logs biblio-orchestrator-0 -n biblio-claw -c orchestrator -f` |
| **状態** | `ps aux \| grep 'tsx src/index'` | `kubectl get pod biblio-orchestrator-0 -n biblio-claw` |
| **起動** | `pnpm run dev` | StatefulSet が自動(`kubectl apply -f k8s/`) |
| **停止** | foreground は `Ctrl+C` / 背景起動なら `pkill -f 'tsx src/index'`(PID 特定は `ps aux \| grep 'tsx src/index'`) | `kubectl scale statefulset biblio-orchestrator --replicas=0 -n biblio-claw`(再開は `--replicas=1`) |
| **再起動** | プロセス kill → `pnpm run dev` | `kubectl rollout restart statefulset biblio-orchestrator -n biblio-claw` |
| Slack 接続確認 | 上記ログで `Slack socket mode connected` / `botUserId` | 同左(`--since=3m \| grep -iE 'auth completed\|socket'`) |

> **Phase 2 ログを読む**: §Phase 2 JSON ログの読み方 参照(フィルタ:`LOG_COMPONENT=host-orchestrator`)。

### 2. agent container(agent-runner)

| 操作 | ローカル | GCP |
| :--- | :--- | :--- |
| **ログ** | `docker logs <container> -f` | `kubectl logs <agent-pod> -n biblio-claw -f` |
| **一覧** | `docker ps --filter name=nanoclaw` | `kubectl get pods -l app.kubernetes.io/component=agent -n biblio-claw` |
| **再起動/kill** | `pnpm run ncl groups restart --id <AGENT_GROUP_ID>` | `kubectl exec biblio-orchestrator-0 -n biblio-claw -c orchestrator -- sh -c "cd /app && pnpm run ncl groups restart --id <AGENT_GROUP_ID>"` |
| **孤児の強制削除** | `docker rm -f <container>` | `kubectl delete job <job-name> -n biblio-claw`(host 台帳外の孤児用) |

> ⚠️ **agent ログはコンテナ終了で消える**(ローカルは `--rm`、GCP も Job 完了後 pod が剥がれる)。silent fail を追うなら**生きているうちに**採取する。再起動は host 経由(`ncl groups restart`)が基本で、`kubectl delete job` は host が見失った孤児専用。

> **Phase 2 ログを読む**: §Phase 2 JSON ログの読み方 参照(フィルタ:`LOG_COMPONENT=agent-runner`、host orchestrator の `LOG_FORMAT` を伝搬)。

> **patron 通知消失のシグナル**: agent-runner から `severity=ERROR` で `writeMessageOut: patron notification lost after all retries` が出た場合、outbound.db への INSERT が SQLITE_BUSY 等で 3 回 retry 後も失敗したことを示す。MCP tool handler から throw が伝播し `dispatchTool` 経由で `mcp tool handler threw` ERROR が続いて出る (= agent reply 経由で patron に間接通知される救済経路はあるが、host delivery poll 経由の system action 通知は失われている)。発生時は同 session の `inbound.db` / `outbound.db` のロック競合状況を採取する (issue #51 で導入)。

### 3. OneCLI gateway

| 操作 | ローカル | GCP |
| :--- | :--- | :--- |
| **ログ** | `docker logs biblio-onecli -f` | `kubectl logs biblio-orchestrator-0 -n biblio-claw -c onecli -f` |
| **状態 / agent 一覧** | `curl -s http://127.0.0.1:10254/v1/agents` | Pod 内から:`kubectl exec biblio-orchestrator-0 -n biblio-claw -c orchestrator -- node -e "fetch(process.env.ONECLI_URL+'/v1/agents').then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,0)))"` |
| **secret 一覧** | `curl -s http://127.0.0.1:10254/v1/secrets` | port-forward 経由 or 上記 fetch を `/v1/secrets` に |
| **Web UI** | http://127.0.0.1:10254 | `kubectl port-forward svc/biblio-onecli -n biblio-claw 20254:10254` → http://127.0.0.1:20254 |
| **token 再投入** | `bash scripts/onecli-vertex-secret.sh` / `bash scripts/onecli-gh-secret.sh` | **不要**(sidecar が自動更新。下記) |

> GCP の `/v1/agents` は **orchestrator Pod 内から叩く**こと。ローカル端末から port-forward 経由で叩くと auth context が違い別 view になる(CLAUDE.md の罠参照)。

> **Phase 2 ログ視点**: OneCLI gateway は **OneCLI 自前ログ形式**(= Phase 2 JSON 形式と異なる、`severity` / `message` / `time` / `component` 規約は適用されない)。§Phase 2 JSON ログの読み方の `jq` クエリは effective でない。OneCLI ログは plain text or OneCLI 独自の構造化形式で出力(= `host=... mode="mitm"` 形式等、§「落とし穴: OneCLI MITM が `tunnel` mode で素通しになる」も参照)。

### 4. token rotator(GCP のみ、自動更新)

| | コマンド |
| :--- | :--- |
| GH token rotator ログ | `kubectl logs biblio-orchestrator-0 -n biblio-claw -c gh-token-rotator -f` |
| Vertex token rotator ログ | `kubectl logs biblio-orchestrator-0 -n biblio-claw -c vertex-token-rotator -f` |

ローカルには rotator がない → **Vertex token は ~1h で失効**するので `bash scripts/onecli-vertex-secret.sh` を手動再実行(401 が出たら)。

> **Phase 2 ログを読む**: §Phase 2 JSON ログの読み方 参照(フィルタ:`LOG_COMPONENT=gh-token-rotator` / `LOG_COMPONENT=vertex-token-rotator`、rotation event は `event=rotation.ok` / `event=rotation.failed`)。

---

## Phase 2 JSON ログの読み方

> Phase 5 (runbook-extension) で正本化済。LOG_FORMAT / LOG_LEVEL / LOG_COMPONENT の合意とフィルタ方針を本セクションに集約する。

### 切り替え

| env | 値 | 効果 |
| :--- | :--- | :--- |
| `LOG_FORMAT` | `json` | Cloud Logging が `jsonPayload` として自動解析する形式で出力 |
| `LOG_FORMAT` | `text`(既定)| ANSI カラー付きプレーンテキスト(ローカル開発向け) |
| `LOG_COMPONENT` | `host-orchestrator` / `agent-runner` / `gh-token-rotator` / `vertex-token-rotator` | Cloud Logging で絞り込みに使う component 名 |
| `LOG_LEVEL` | `debug` / `info`(既定) / `warn` / `error` / `fatal` | 出力 threshold |

GKE 側は `k8s/10-orchestrator-statefulset.yaml` の 3 container (`orchestrator` / `gh-token-rotator` / `vertex-token-rotator`) に `LOG_FORMAT=json` + 適切な `LOG_COMPONENT` を投入済。agent Pod は `src/container-runner.ts` の `buildContainerSpec()` が host orchestrator の `LOG_FORMAT` を伝搬する。

### 共通フィールド(Cloud Logging 解析の特別キー含む)

| フィールド | 種別 | 例 | 用途 |
| :--- | :--- | :--- | :--- |
| `severity` | Cloud Logging 特別 | `INFO` / `WARNING` / `ERROR` / `CRITICAL` / `DEBUG` | severity フィルタ |
| `message` | Cloud Logging 特別 | `shelve_biblio from agent` | 人間可読の 1 行サマリ |
| `time` | Cloud Logging 特別 | `2026-06-22T12:34:56.789Z` | timestamp |
| `component` | biblio-claw 規約 | `host-orchestrator` / `agent-runner` | コンポーネント絞り込み |
| `event` | biblio-claw 規約 | `biblio.shelve` / `github.fetch` / `vertex.call` / `rotation.ok` | event 種別 (= 集計の主軸) |
| `outcome` | biblio-claw 規約 | `success` / `failure` | 成否分類 |
| `request_id` | biblio-claw 規約 | `550e8400-e29b-41d4-a716-446655440000` (= `crypto.randomUUID()` 形式、prefix なし) | patron 依頼 1 件を BQ で串刺し追跡 |
| `session_id` / `agent_group_id` | biblio-claw 規約 | NanoClaw entity ID | session 単位の絞り込み |
| `latency_ms` | biblio-claw 規約 | `234` | API 呼び出し所要時間 |
| `tokens_in` / `tokens_out` / `model` | biblio-claw 規約 (Vertex) | `1234` / `claude-sonnet-4-6` | cost 集計の基盤 |
| `err` | biblio-claw 規約 | `{ error_name, error_message, stack }` | Error 型は自動展開 |

予約語 `severity` / `message` / `time` / `stream` を `data` に渡すと **drop される**(top-level を上書きしない)。

### 読み方の例

**Local (host orchestrator は `pnpm run dev` で起動、docker compose には含まれない):**
```bash
# host orchestrator は pnpm run dev で起動 → stdout を jq で絞る
LOG_FORMAT=json LOG_COMPONENT=host-orchestrator pnpm run dev | jq 'select(.outcome=="failure")'

# CLI ハーネス (= scripts/biblio-*.ts) を JSON モードで叩く例
LOG_FORMAT=json LOG_LEVEL=debug pnpm exec tsx scripts/biblio-acquire.ts example-org/test-biblio-minimal 2>&1 | jq 'select(.event)'
```

**GKE:**
```bash
# orchestrator container
kubectl logs biblio-orchestrator-0 -c orchestrator -n biblio-claw --tail 200 | jq 'select(.severity=="ERROR" or .severity=="WARNING")'

# gh-token-rotator sidecar (rotation 経路の集計)
kubectl logs biblio-orchestrator-0 -c gh-token-rotator -n biblio-claw | jq 'select(.event=="rotation.failed")'

# Vertex 呼び出し only
kubectl logs biblio-orchestrator-0 -c orchestrator -n biblio-claw | jq 'select(.event=="vertex.call") | {model, tokens_in, tokens_out, latency_ms, outcome}'
```

**Cloud Logging Logs Explorer クエリ:**
```
resource.type="k8s_container"
resource.labels.namespace_name="biblio-claw"
jsonPayload.component="host-orchestrator"
jsonPayload.outcome="failure"
```

```
# 特定 request_id を全 component / 全 API call で串刺し
jsonPayload.request_id="550e8400-e29b-41d4-a716-446655440000"
```

### Smoke 検証

```bash
bash scripts/verify-phase-2-log.sh    # Phase 2 log JSON PASS — 5/5 assertion
```

---

## DB / 配線の管理(ncl・q.ts)

host のある場所で動く。**ローカルは直接、GCP は orchestrator Pod 内に `kubectl exec`**。

```bash
# --- ncl(agent group / wiring / role / destination の CRUD)---
# ローカル:
pnpm run ncl <resource> <verb> [--flags]          # 例: pnpm run ncl groups list
# GCP:
kubectl exec biblio-orchestrator-0 -n biblio-claw -c orchestrator -- \
  sh -c "cd /app && pnpm run ncl <resource> <verb> [--flags]"

# --- q.ts(中央 DB のアドホッククエリ。sqlite3 ではなくこれを使う)---
# ローカル(DB= data/v2.db):
pnpm exec tsx scripts/q.ts data/v2.db "SELECT * FROM agent_groups"
# GCP(DB= /data/v2.db):
kubectl exec biblio-orchestrator-0 -n biblio-claw -c orchestrator -- \
  sh -c "cd /app && pnpm exec tsx scripts/q.ts /data/v2.db \"SELECT * FROM agent_groups\""
```

よく使う ncl:`groups list/get/restart`、`wirings list/create/delete`、`roles list/grant/revoke`、`destinations list/add/remove`、`sessions list`。`ncl <resource> help` で各構文。**`delete`/`update` 系は positional ではなく `--id` フラグ**。

## 現在の主要 ID(`ncl groups list` で最新確認)

| 環境 | agent group | id | DM messaging_group |
| :--- | :--- | :--- | :--- |
| GCP | `biblio-first` | `ag-1781346069567-9lf1tz` | `mg-1781698627442-otav7g` |
| ローカル | `biblio-local` | `ag-1781337728347-top6zx` | `mg-1781102994021-2u8d3d` |

## 補助コンテナ(参考)

| | ローカル | GCP |
| :--- | :--- | :--- |
| Postgres | `docker logs biblio-postgres`(compose 管理) | (使わない。中央 DB は SQLite + Cloud SQL proxy) |
| Cloud SQL proxy | — | `kubectl logs biblio-orchestrator-0 -n biblio-claw -c cloud-sql-proxy` |

## 落とし穴: OneCLI MITM が `tunnel` mode で素通しになる

OneCLI Gateway (1.30.0) は secret の `hostPattern` にマッチしない宛先 host を **`mode=tunnel`** で素通し転送する(= MITM しない)。tunnel 経路では client が **本物の TLS cert** を受信するため、`GIT_SSL_CAINFO` / `SSL_CERT_FILE` / `NODE_EXTRA_CA_CERTS` に OneCLI CA だけを渡していると trust chain が完成せず SSL 検証で落ちる。

### 症状

```
fatal: unable to access 'https://github.com/<owner>/<repo>.git/':
  SSL certificate problem: unable to get local issuer certificate
```

`git clone https://github.com/...` などで発生(host が `github.com` 側、登録 secret は `api.github.com` のみだと該当)。OneCLI proxy log:

```
host=github.com mode="tunnel"  ← MITM ではなく素通し
```

### なぜ起きるか

- biblio-claw は仕入れ経路で **2 経路** の GitHub アクセスを持つ: 存在確認は `ghFetch`(`api.github.com`、undici fetch + OneCLI proxy 経由)、ソース取得は `git clone https://github.com/...`(`github.com`、子プロセス)。`ghFetch` 化以降は子プロセス経由の `gh api` は使わない。
- OneCLI に投入している GH secret は `hostPattern=api.github.com` のみ → `github.com` への接続には MITM 用 leaf cert が発行されない → `mode=tunnel` で fail-open。
- tunnel 経路で client が受け取るのは **DigiCert で署名された実 GitHub の cert chain**。OneCLI 自家 CA では trust できない。

### 対処(現状の biblio-claw 採用済)

`src/biblio/host-proxy.ts:initHostProxy()` で書き出す CA file に **Node.js 組み込みの Mozilla root CA**(`tls.rootCertificates`)を append している。

```typescript
const combinedCa = `${cfg.caCertificate.trim()}\n${tls.rootCertificates.join('\n')}\n`;
fs.writeFileSync(CA_FILE, combinedCa);
```

これで MITM 経路は OneCLI CA で、tunnel 経路は Mozilla root で、それぞれ trust chain が成立する。combined CA bundle は子プロセス env(`GIT_SSL_CAINFO` / `SSL_CERT_FILE` / `NODE_EXTRA_CA_CERTS`)に同じパスで渡すだけで全 client が乗る。

### 切り分けデバッグ手順

OneCLI proxy が現在どの mode で動作しているかを確認する方法:

```bash
# (1) OneCLI proxy ログで mode を見る(直近)
docker logs biblio-onecli --since 5m 2>&1 | grep 'mode='
# → mode="mitm" なら MITM 動作、mode="tunnel" なら素通し

# (2) 該当 agent の HTTPS_PROXY URL(aoc_ token 入り)で curl 検証
FULL_PROXY="$(curl -sS 'http://localhost:10254/v1/container-config?agent=biblio-orchestrator-host' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["env"]["HTTPS_PROXY"])')"
LOCAL_PROXY="$(echo "$FULL_PROXY" | sed 's|host.docker.internal|127.0.0.1|')"

# MITM 経路(api.github.com)
curl -sS --cacert data/.onecli-host-ca.pem -x "$LOCAL_PROXY" https://api.github.com/ \
  -o /dev/null -w 'api.github.com http=%{http_code} verify=%{ssl_verify_result}\n'

# tunnel 経路(github.com)
curl -sS --cacert data/.onecli-host-ca.pem -x "$LOCAL_PROXY" https://github.com/ \
  -o /dev/null -w 'github.com     http=%{http_code} verify=%{ssl_verify_result}\n'

# 両方 http=200 verify=0 なら combined CA は正しく動作
```

### 実 cert chain の実測(原因の確定的切り分け)

`curl -v` で `unknown CA (560)` が出たとき、**OneCLI が今返している cert chain の実体を直接見る**ことで「MITM (= OneCLI 偽 cert)」か「tunnel (= 本物 cert 素通し)」を 1 発で確定できる。

```bash
# OneCLI proxy 経由で cert chain を openssl で実測(grep で subject/issuer のみ抽出)
echo | openssl s_client -connect api.github.com:443 -proxy 127.0.0.1:10255 \
  -servername api.github.com -showcerts 2>&1 | grep -E '^(depth|verify|---|s:|i:)' | head -30
```

判別:

| chain の見え方 | 意味 | 対処 |
| :--- | :--- | :--- |
| `i:CN=OneCLI Local Gateway CA, O=OneCLI` が出る | **MITM 動作中** = OneCLI が偽 cert を発行 | OneCLI CA bundle で trust 成立(combined CA で OK) |
| `i:CN=Sectigo ECC Domain ... DigiCert ...` 等 | **tunnel 素通し** = 本物の GitHub cert chain が透過 | Mozilla root が CA bundle に入っていれば trust 成立(本リポは [host-proxy.ts](../src/biblio/host-proxy.ts) の `tls.rootCertificates` append で対応済) |
| chain 全く出ない(空) | proxy 経由の TLS handshake が成立していない | OneCLI gateway 自体 / proxy URL / agent token を疑う |

> **注意**: `openssl s_client` の `-proxy` は HTTP CONNECT を発行するだけで OneCLI の agent token(`aoc_<hex>`)を載せないため、**openssl 単体テストでは OneCLI が agent 識別に失敗して tunnel mode に倒れる**ことがある。「本物の biblio-claw 経路で MITM が動いているか」を見たいときは、上の (2) curl 検証(token 入り HTTPS_PROXY URL を使う)を優先する。openssl s_client は「proxy 経由でとにかく chain を見たい」debug 用途。

### 最後の手段: TLS 検証 OFF で原因を分離

cert 起因か proxy 経路起因か 1 発で見極めたいときの最後の手段(原因確定後は必ず外す):

```bash
# git だけ TLS 検証を切って clone を試す(他の env はそのまま)
GIT_SSL_NO_VERIFY=true git clone --depth 1 https://github.com/<owner>/<repo>.git /tmp/probe
# 通る  → cert 起因(OneCLI CA bundle 不整合 or tunnel passthrough)
# 落ちる → proxy 経路自体が壊れている(OneCLI / HTTPS_PROXY / agent 識別)
```

**絶対に常設しないこと** — `GIT_SSL_NO_VERIFY` は MITM 検出を完全に潰すため、本番経路 / `verify-m2*.sh` 等の自動検証では使わない。原因確定後すぐ `unset` する。

### 注意点 / 罠

- **proxy URL に `aoc_<token>` を含めずに叩くと OneCLI は agent 識別失敗で `mode=tunnel` に倒れる**。デバッグ用に直接 `curl -x http://127.0.0.1:10255` で叩くときは MITM にならないので注意(本物の biblio-claw 経路は SDK が token 入り URL を組むので問題ない)。
- OneCLI container を `docker restart` しても **CA は永続化されている**(`/app/data/gateway/ca.pem`)ので `data/.onecli-host-ca.pem` の再生成は不要。MITM が tunnel に倒れている場合の対処は cert 問題ではなく secret/agent 設定問題。
- system CA bundle のパスは環境依存(Debian=`/etc/ssl/certs/ca-certificates.crt` / RHEL=`/etc/pki/tls/certs/ca-bundle.crt`)。`tls.rootCertificates` を使えば OS 依存しない。
- 検品(Vertex × Gemini)は `aiplatform.googleapis.com` の secret に、陳列(GitHub Git Data API)+ 仕入れの存在確認(`ghFetch`)は `api.github.com` の secret にそれぞれ hostPattern マッチして MITM 経路で動く。`git clone`(`github.com`)だけが secret 不在で tunnel 経路。`api.github.com` の secret は **pathPattern を省略** (= 全パスマッチ、issue #36 経緯) しているため、外部 public biblio への `ghFetch`(`api.github.com/repos/<外部>/...`)にも GH App installation token が wire 上載る。scope 最小化は GH App installation の repo 限定 (= biblio-shelf + biblio-claw の 2 repo のみ install 済) で担保 (= token scope を超えた WRITE は GitHub 側で拒否、rate limit が authenticated 5000/h 扱いに上がるだけ、観察可能な漏洩リスクなし)。

---

## 落とし穴: OneCLI pathPattern を string で明示すると GKE で injection skip(issue #36)

OneCLI v1.30.0 では secret に `pathPattern` を string で指定すると(例 `/repos/HajimariInc/*`)、secret 投入自体は 2xx で通るが **GKE 環境で MITM Authorization injection logic が呼ばれない**。`Authorization: 'Bearer placeholder'` がそのまま GitHub に届いて `401 Bad credentials` + `x-ratelimit-limit=null`。ローカル docker compose 経路では同じ pathPattern 明示版が動く(2026-06-24 実測)ため、**ローカル / GKE で OneCLI 挙動差が存在する**(WHY 3 = 環境差分の根本原因は未解明、修復候補 B の別 issue 候補)。

### 症状

```bash
# GKE orchestrator Pod 内で wire test
kubectl exec biblio-orchestrator-0 -c orchestrator -n biblio-claw -- node -e "
  process.chdir('/app');
  require('./dist/biblio/host-proxy.js').initHostProxy().then(() => {
    return fetch('https://api.github.com/repos/HajimariInc/biblio-shelf', {
      headers: { Authorization: 'Bearer placeholder', Accept: 'application/vnd.github+json' },
    });
  }).then(r => console.log('status=' + r.status + ' x-ratelimit-limit=' + r.headers.get('x-ratelimit-limit')));
"
# 期待: status=200 x-ratelimit-limit=6800
# 不発: status=401 x-ratelimit-limit=null
```

`x-ratelimit-limit=null` は GitHub が **認証失敗時 (401) にレート制限ヘッダを返さない** ことによるシグナル。`Bearer placeholder` が wire 上そのまま GitHub に届いている (= OneCLI が installation token への置換を skip した) ことの確定証拠で、injection logic が呼ばれていないことを示す (= OneCLI proxy 経路自体は通っており、proxy bypass ではない)。

### 対処(本リポ採用済)

`scripts/onecli-gh-secret.sh` の POST / PATCH 両経路で **pathPattern を payload から省略**(= 全パスマッチ、issue #36 で 2026-06-24 確定)。`pathPattern: null` も v1.30.0 は 400 reject(= `expected string, received null`、PoC-2 で実測)するため、**省略以外の選択肢はない**。scope 最小化は GH App installation scope(= biblio-shelf + biblio-claw の 2 repo のみ install 済)で別経路担保する。

### 既存環境の修復

既に `pathPattern: "/repos/..."` が投入済の secret は、PATCH partial update では pathPattern を消す API が v1.30.0 観察上存在しない:

```bash
# 確認
curl -fsS http://127.0.0.1:10254/v1/secrets | jq '.[] | select(.name=="biblio-claw-gh-token") | {name, pathPattern}'
# pathPattern が null になっていれば修正反映済、文字列が残っていれば DELETE + POST が必要

# DELETE + POST 再作成(GKE 経路ならローカル port-forward 経由)
ID=$(curl -fsS http://127.0.0.1:10254/v1/secrets | jq -r '.[] | select(.name=="biblio-claw-gh-token") | .id')
curl -fsS -X DELETE "http://127.0.0.1:10254/v1/secrets/$ID"
bash scripts/onecli-gh-secret.sh   # = 修正版で再投入 (POST 経路、pathPattern なし)
```

---

## GKE リセット手順

GKE 環境にトラブルが起きたとき / 完全再構築したいとき / ハッカソンデモ前の動作確認 に叩く手順を 1 箇所に集約する。本セクションは Phase 5 (runbook-extension) で拡張済。

> **1 発実行**: 本セクションの手順は `/init-project-gcp reset` (= 完全 teardown + 再構築) と `/init-project-gcp up` (= 不足リソースの起動・再 ready 確認、§手順 2 の `kubectl delete pod` とは別) に集約済。本セクションは **生コマンドの正本** として残置 (= slash command は wrapper)。手で再現する場合 / トラブル切り分けで個別コマンドを叩きたい場合はそのまま参照する。

### トリガ

次のいずれかが見えたら本手順に降りる:

- Slack で `@bot` 応答が来ない (orchestrator Pod は Running だが処理が回っていない)
- `kubectl rollout status statefulset/biblio-orchestrator -n biblio-claw` がタイムアウト
- 仕入れ / 検品 / 陳列 が `401 Unauthorized` で失敗 (= GH or Vertex token 期限切れ)
- (50 h 以上連続稼働時) 仕入れ / list_biblio 等の LLM 呼出が `401 Unauthorized` になり、同時に Cloud Trace に span が 0 件になる (= SDK 内部 auth caching + BatchSpanProcessor buffer の残存状態、手順 2 の Pod restart で回復。2026-07-03 PR #121 verify 過程で観察、1 サンプルのため恒常性未確認)
- Cloud SQL 接続失敗 (= `psql: connection to server ... failed`)
- `permission denied for schema public` (= Bootstrap GRANT 未実行、再構築直後)

### 手順 1: 現状確認 (= 何が壊れているかを最短で切り分ける)

```bash
# GCP リソース側 (cluster / Cloud SQL / Secret Manager / Artifact Registry)
bash scripts/init-project-gcp-resource-check.sh

# GKE 内 (StatefulSet / PVC / Sidecar / OneCLI REST / Slack adapter)
bash scripts/verify-phase-2-wiring.sh
```

両方 OK なのにトラブルが続く場合は orchestrator 本体ログ (`kubectl logs biblio-orchestrator-0 -c orchestrator -n biblio-claw --since=5m`) を見て個別対処。

### 手順 2: 部分 reset (= Pod のみ再起動、cluster は残す)

GH / Vertex token 期限切れや orchestrator 内部状態の不整合が疑われるとき:

```bash
kubectl delete pod biblio-orchestrator-0 -n biblio-claw
kubectl wait --for=condition=Ready pod/biblio-orchestrator-0 -n biblio-claw --timeout=180s
bash scripts/verify-phase-2-wiring.sh   # 復旧確認
```

PVC は維持されるため SQLite データ + boots カウンタは引き継がれる (= `verify-phase-2-wiring.sh` §7 boots assertion で確認)。

### 手順 3: 完全 teardown + 再構築

部分 reset で復旧しないとき、または setup を最初からやり直したいとき:

```bash
# 1. 削除予定リソースを dry-run で確認
bash scripts/teardown-phase-2.sh --dry-run

# 2. 確認後に実行 (10 秒カウントダウン後に削除開始)
bash scripts/teardown-phase-2.sh --confirm

# 3. GKE / Cloud SQL / VPC / Artifact Registry を再作成
#    (= `/init-project-gcp reset` で完結。詳細手順は §/init-project-gcp サブコマンド利用ガイド §reset 参照)

# 4. K8s manifest 再適用
kubectl apply -f k8s/

# 5. K8s Secret 投入 (= 既存手順、README §GKE 運用メモ + docs/slack-environments-setup.md を参照)
#    - biblio-gh-app (GH App ID + installation ID)
#    - biblio-slack-tokens (SLACK_BOT_TOKEN + SLACK_APP_TOKEN、本番 / 開発 ws の使い分けは slack-environments-setup.md)

# 6. Cloud SQL Bootstrap GRANT (Postgres 15+ で IAM user に必須、再構築のたびに必要)
bash scripts/init-project-gcp-pgsql-grant.sh

# 7. リソース現状確認 + GKE wiring 確認
bash scripts/init-project-gcp-resource-check.sh
bash scripts/verify-phase-2-wiring.sh
```

Secret Manager `biblio-gh-app-pem` は teardown でも残置するため、再投入不要 (= `teardown-phase-2.sh` 冒頭コメント参照)。

### トラブルシューティング

| 症状 | 原因 | 対処 |
| :--- | :--- | :--- |
| orchestrator log に `permission denied for schema public` | Bootstrap GRANT 未実行 (= 再構築直後) | `bash scripts/init-project-gcp-pgsql-grant.sh` |
| StatefulSet `readyReplicas=0` のまま | initContainer (fetch-pem / cloud-sql-proxy) のいずれかが失敗 | `kubectl describe statefulset biblio-orchestrator -n biblio-claw` で initContainer 状態を確認 |
| `cloud-sql-proxy` が CrashLoopBackOff | Cloud SQL 起動前 / IAM 権限不足 / private IP route 不通 | `kubectl logs biblio-orchestrator-0 -c cloud-sql-proxy --previous -n biblio-claw` |
| `gh-token-rotator` が token 投入できない | GH App PEM 不在 / installation ID 不一致 | `kubectl logs biblio-orchestrator-0 -c gh-token-rotator -n biblio-claw` + GH App settings 画面で installation を確認 |
| Slack adapter の "credentials missing" log | `biblio-slack-tokens` 未投入 or 値違い | `kubectl get secret biblio-slack-tokens -n biblio-claw -o jsonpath='{.data}' \| base64 -d` で値確認 |

OneCLI MITM が tunnel に倒れているケースの切り分けは [§OneCLI MITM が `tunnel` mode で素通しになる](#落とし穴-onecli-mitm-が-tunnel-mode-で素通しになる) も参照。

---

## M2 完成判定 verify(`scripts/verify-m2.sh`)

M2 PRD B Phase 3 で導入した E2E 検証スクリプト。Slack 入力 → 仕入れ → 検品 → カテゴライズ → 陳列(棚リポへ draft PR 作成) → 重複検知 の 6 段を 1 度に流す。host process は起動不要 — 各段の CLI ハーネス(`scripts/biblio-{acquire,inspect,categorize,shelve}.ts`)が `initHostProxy()` / `setupVertexProxy()` を自前で呼ぶ。

### 前提セットアップ(Phase 1+2+3 合算)

> **推奨**: 個別 step を叩く代わりに、claude code から **`/init-project`** を 1 発実行すれば下記 1-5 が完了する(`/init-project refresh` で 3-4 のみ再実行可、トラブル時は `/init-project verify` で全段確認)。Step 6 (GH App installation) と Step 7 (Vertex Marketplace enable) は **`/init-project` の対象外** (= 初回 1 回だけの外部設定、claude code から自動化不可)。手動で個別に叩きたい場合のみ下表を参照。詳細は `.claude/commands/init-project.md` を参照。

| # | 項目 | コマンド/確認 |
| :---: | :--- | :--- |
| 1 | docker compose 起動 | `docker compose up -d --wait`(OneCLI gateway = localhost:10254 / proxy = :10255) |
| 2 | `.env` 設定 — Vertex / GH / SHELF / Model | `ANTHROPIC_VERTEX_PROJECT_ID` / `CLOUD_ML_REGION` / `INSPECT_DANGEROUS_MODEL` / `CATEGORIZE_MODEL` / `GH_APP_ID` / `GH_INSTALLATION_ID` / `GH_APP_PEM_PATH` / `SHELF_REPO_OWNER` / `SHELF_REPO_NAME` / `SHELF_PR_AUTHOR_NAME` / `SHELF_PR_AUTHOR_EMAIL`(全て non-empty) / `ACQUIRE_SKILL_THRESHOLD`(省略可、既定 10 — 個別 PRD Phase 5 で **DB → env → DEFAULT の 3 層 fallback** に拡張済。Slack 経由の動的変更は `@bot 設定 ACQUIRE_SKILL_THRESHOLD <value>` で agent 自律発火、設定は次の `@bot 仕入れて` から即時反映 = 再起動不要。`verify-m2.sh` の対象 repo `example-org/test-biblio-minimal` は 3 skill = 既定で通る) |
| 3 | OneCLI Vertex secret 投入 + mode=all 昇格 | `bash scripts/onecli-vertex-secret.sh` |
| 4 | OneCLI GH secret 投入 + mode=all 昇格 (pathPattern 省略経路) | `bash scripts/onecli-gh-secret.sh`(`hj-biblio-github-app` の installation token を投入。pathPattern は省略 = 全パスマッチ、issue #36 経緯) |
| 5 | host agent (`biblio-orchestrator-host`) が mode=all で登録済 | `curl -s http://127.0.0.1:10254/v1/agents | jq '.[] | select(.identifier=="biblio-orchestrator-host") | .secretMode'` で `"all"` |
| 6 | GH App `hj-biblio-github-app` が棚リポに installation 済 | App settings 画面 / `curl -s -H "Authorization: token $INST" https://api.github.com/installation/repositories`(token は Phase 3 Task 0 の手順で取得) |
| 7 | Vertex × `claude-sonnet-4-6` が project enable 済 | Phase 3 Task 0 で実機 ping 済(Vertex AI Console > Model Garden で `claude-sonnet-4-6` の "Enable" 状態) |

### 実行

```bash
# 引数 = 仕入れ対象 repo(必須)。EXPECTED_CATEGORY は省略可(既定 biblio-dev、不一致は warn のみ)。
bash scripts/verify-m2.sh HajimariInc/biblio-shelf

# 別カテゴリ期待:
EXPECTED_CATEGORY=biblio-ai bash scripts/verify-m2.sh nanocoai/some-skill
```

全 6 assertion 緑 → `M2 PASS` を stdout に出して exit 0。`trap` で作成した draft PR を `gh pr close --delete-branch` で auto-close + 一時 quarantine/shelf dir を rm -rf。

### 後始末(verify 中断時)

- **draft PR が残った**: `gh pr list --repo HajimariInc/biblio-shelf --state open --search 'in:title shelve(biblio-' | head -20` で `shelve(biblio-*): ...` 形式のタイトルを目視 → `gh pr close --repo HajimariInc/biblio-shelf --delete-branch <PR#>` で個別 close
- **shelf 内の biblio が残った**: `ls data/shelf/` で確認 → 不要なら `rm -rf data/shelf/<category>/<owner--name>` (個別 skill 仕入れ経路の場合は `<owner--name--skill>` 形式、= `DATA_DIR` 既定値 `./data` 配下、`.env` で `DATA_DIR=` を上書きしている場合はそのパス)
- **`marketplace.json` への entry は draft PR を close = branch 削除すれば消える**(main は更新されていない)

### GKE 経路で実行する場合(将来運用、現状は local のみ)

orchestrator Pod 内から実行する。GKE では sidecar が GH/Vertex token を自動 rotate するため、ステップ 3-5 は不要(steps 1-2 は `.env` ではなく Secret 経由)。

```bash
kubectl exec biblio-orchestrator-0 -n biblio-claw -c orchestrator -- \
  sh -c 'cd /app && bash scripts/verify-m2.sh HajimariInc/biblio-shelf'
```

---

## M3 完成判定 verify(`scripts/verify-m3.sh`)

M3 Phase 5 で導入した E2E 検証スクリプト。装備機構 + 蔵書一覧の **6 assertion** を 1 度に流す:

| # | assertion | 担当 phase |
| :---: | :--- | :--- |
| 1 | 装備マーカー検出 | Phase 2 (= `spawn-verify` で SKILL `fire-marker` 発火) |
| 2 | ephemeral 解除(装備源残置) | Phase 2 |
| 3 | 禁書(clone 残置で再装備可) | Phase 3 destructive |
| 4 | 焼却(clone 物理削除で装備不可) | Phase 3 destructive |
| 5 | 全件 list-biblio | Phase 5 新規 |
| 6 | カテゴリ別 list-biblio(shelve 済 only) | Phase 5 新規 |

内部は `verify-m3-phase-3.sh "${@}"` を **regression chain** として呼び出し、その後 `biblio-list.ts` CLI を直接叩いて assertion 5/6 を上乗せする構造。Phase 3 destructive で残る draft PR は `trap` で自動 close(= 旧 `verify-m3-phase-3.sh` の手動 cleanup 負荷を巻き取り)。

### 前提セットアップ

M2 verify の前提セットアップ(上記 1-7)に加えて:

| # | 項目 | コマンド/確認 |
| :---: | :--- | :--- |
| M3-a | `nanoclaw-agent:latest` image が build 済 | `./container/build.sh` 実行後、`docker image inspect nanoclaw-agent:latest` で確認。`build.sh` は install-slug 付き tag(= `nanoclaw-agent-v2-<hash>:latest`)を打つため、`verify-m3-phase-2.sh` が固定参照する `nanoclaw-agent:latest` への alias 貼りが必要な場合は `docker tag <slug>:latest nanoclaw-agent:latest` |
| M3-b | shelf に biblio が 1 件以上 main merge 済(推奨) | `pnpm exec tsx scripts/biblio-list.ts` で `total > 0` を確認。0 件の場合は list-biblio assertion (5/6) が fail するため 1 件は必要。**Phase 3 destructive の対象 biblio (`VERIFY_M3_P3_BIBLIO`) が shelf に merge 済でない場合は verify 側で warn 継続 PASS 経路が発火する** (= issue #98 対応、`verify-m3-phase-3.sh` で enkin 側が `not_shelved` を許容)。ただし fixture 経路が実行されないため実装変更後の regression 網羅性は下がる = 定期的に fixture 復活 (`acquire → inspect → categorize → shelve` の 4 段 CLI で投入 → GitHub UI で draft PR を merge) が推奨。 |
| M3-c | OneCLI token が両方フレッシュ | `bash scripts/onecli-vertex-secret.sh && bash scripts/onecli-gh-secret.sh`(= verify-m3 は Vertex(spawn-verify が container 内で claude CLI 経由)+ GitHub(fetchMarketplace / unshelve PR 作成)の両方を叩く。token 失効 ~60min で `401 Bad credentials` / `model not available` に倒れるため、verify-m3 実行直前に refresh するのが安全) |

### 実行

```bash
# 必須 env: destructive E2E 対象 biblio(= main merged + category 指定)
VERIFY_M3_P3_BIBLIO=example-org--test-biblio-minimal \
VERIFY_M3_P3_CATEGORY=biblio-ai \
  bash scripts/verify-m3.sh --local-only

# 引数省略 = both(local + GKE)、--gke-only = GKE 経路のみ。ただし assertion 5/6(list-biblio)
# は常に local 実行のため、`M3 PASS (gke)` は「Phase 2 GKE assertion 通過 + assertion 5/6 が
# local で通った」を意味する。完全 GKE-native 検証は将来 phase で別途。
#
# 注: 指定した fixture が shelf に main merge 済でない場合、verify-m3.sh は warn 継続で
# `M3 PASS` を出す(= issue #98 対応、destructive 経路 skip)。完全 destructive 網羅には
# 上の 4 段 CLI + GitHub UI merge で fixture を復活させておくこと。
```

全 6 assertion 緑 → `M3 PASS (local|gke|both)` を stdout に出して exit 0。実時間 ~36 秒(= 全段順次)。`trap cleanup EXIT INT TERM` で:

- enkin/shokyaku draft PR を `gh pr list --search 'is:pr is:open draft:true (head:enkin/ OR head:shokyaku/)'` で検索 → `gh pr close --delete-branch` で auto-close
- `$STDERR_DIR` を rm -rf

### 後始末(verify 中断時)

- **draft PR が残った(= trap 走らず)**: `gh pr list --repo HajimariInc/biblio-shelf --state open --search 'in:title enkin OR in:title shokyaku' | head -10` で目視 → `gh pr close --repo HajimariInc/biblio-shelf --delete-branch <PR#>` で個別 close
- **shelve 済 biblio が消えた(= destructive 経路で焼却された)**: verify-m3.sh 実行は成功する(= issue #98 対応で enkin 側も `not_shelved` を許容、warn 継続 PASS 経路)。ただし destructive 経路の実質検証は skip されるため、下記いずれかで復活推奨:
  - (推奨) `pnpm exec tsx scripts/biblio-acquire.ts <owner>/<biblio> → biblio-inspect → biblio-categorize → biblio-shelve` の 4 段 CLI で新規 shelve → GitHub UI で **draft PR を非 draft 化 + squash merge** → shelf main の marketplace.json に entry 復活
  - `total > 0`(= assertion 5/6 の list-biblio 前提)は他の shelve 済 biblio が 1 件でもあれば維持されるため、fixture 復活自体は destructive 網羅性のためだけの作業
- **agent_shared session の cross-run 干渉**: `pnpm exec tsx scripts/q.ts data/v2.db "DELETE FROM sessions WHERE agent_group_id = 'ag-biblio-equip-verify'; DELETE FROM agent_groups WHERE id = 'ag-biblio-equip-verify';"` + `rm -rf data/v2-sessions/ag-biblio-equip-verify groups/biblio-equip-verify` + container 残存があれば `docker ps -a --filter 'name=nanoclaw-v2-biblio-equip-verify' --format '{{.ID}}' | xargs -r docker rm -f`

### トラブルシューティング

- **`exit 125 / Container exited unexpectedly`(host log)**: docker run の引数 reject。PR #20 以降は `DockerAgentHandle` が exit !=0 / signal 終了時に stderr buffer(64 KiB tail)を warn で吐くため、host stderr に root cause が出る(= `LOG_LEVEL=debug` で line-by-line tail も得られる)
- **`401 Bad credentials`(verify 中の `enkin smoke`)**: GH installation token 期限切れ → `bash scripts/onecli-gh-secret.sh` で再投入(~60min ごと)
- **`marker not found ...`**: spawn-verify が outbound.db + コンテナログ (Docker: `docker logs` / K8s: `@kubernetes/client-node` の `readNamespacedPodLog`) の 2 経路で marker を polling、両方で見つからない場合は container 内で SKILL が fire していない可能性
  - **local 経路**: `docker logs $(docker ps --filter 'name=nanoclaw-v2-biblio-equip-verify' --format '{{.Names}}' | head -1)` で内部状態確認 (= `model is not available` 等の Vertex 側 enable 漏れが典型)
  - **GKE 経路**: `kubectl logs -n biblio-claw -l app.kubernetes.io/component=agent --tail=200` で agent Pod ログを確認 (= 古い agent Pod が複数 Running の場合は \"GKE 経路の罠\" §参照)

### GKE 経路で実行する場合

orchestrator Pod 内から実行する。GKE では sidecar が GH/Vertex token を自動 rotate するため、ステップ M3-c は不要。`/data/biblio-equipped/` の fixture 投入は別途 PVC 経由(= `verify-m3-phase-2.sh` の Phase B 参照)。

> **Note**: 2026-06-23 Phase 4 実走で顕在化した M3 GKE 経路 bug 3 件 (= `spawn-verify ensureRuntime` 未呼出 / `readShelveEnv` 必須 env 過剰 + manifest 未投入 / OneCLI agent selective mode) + Level 7 実走で顕在化した bug 3 件 (= `.env` 必須 fail-fast / `curl` 必須 / scratchpad fallback の docker logs 専用) は init-project-gcp PRD Phase 4.6 (PR #29) で修正済、`verify-m3.sh --gke-only` で `M3 PASS (gke)` 取得済。Phase 2 構造化ログの GKE 実機 verify は Phase 4 で完了済 (= `scripts/verify-phase-4-deploy.sh` 参照)。

```bash
kubectl exec biblio-orchestrator-0 -n biblio-claw -c orchestrator -- \
  sh -c 'cd /app && VERIFY_M3_P3_BIBLIO=<owner>--<name> VERIFY_M3_P3_CATEGORY=biblio-ai bash scripts/verify-m3.sh --gke-only'
```

#### GKE 経路の罠: 古い agent Pod 残存による race condition

`verify-m3.sh --gke-only` を **連続実行 / 失敗試行直後の再実行** で発生する罠。spawn-verify は `ag-biblio-equip-verify` agent group の agent-shared session を使うため、過去 verify の agent Pod が `ttlSecondsAfterFinished: 120` 内で Running 状態のまま残存していると、新 verify が spawn する Pod と並列で同 session を resume する race condition に陥り、新 Pod が message を処理しない (= MARKER 出力されない、120s polling timeout で fail)。

**対処**: 残存 Pod を強制削除してから再実行する。

```bash
# 残存 Pod 確認
kubectl get pods -n biblio-claw -l app.kubernetes.io/component=agent

# 複数 Running なら Job ごと削除 (= TTL 待たずに即時削除)
kubectl get jobs -n biblio-claw -l app.kubernetes.io/component=agent -o name | \
  xargs -r kubectl delete -n biblio-claw

# Pod 完全削除を待ってから再実行
kubectl get pods -n biblio-claw -l app.kubernetes.io/component=agent --watch
```

---

## M3 Slack 経路の運用(= 装備 / 蔵書一覧 / 仕入れ)

M3 で patron が Slack から `@bot` mention で叩く 3 種の経路を 1 § にまとめる。**verify は assert 中心**(= `verify-m3.sh`、上記)**、本 § は patron 動線中心**(= 「`@bot ...` を打った後何が起きるか」+ 「動かない時どこを見るか」)で役割分担。各経路の詳細仕様は cross-link 先(= [equip-physical.md](equip-physical.md) / ルート `CLAUDE.md` §src/biblio)を参照。

### `@bot 装備して <biblio-name>` 経路(装備機構)

| 項目 | 内容 |
| :--- | :--- |
| patron 動線 | Slack で `@bot 装備して example-org--test-biblio-minimal` → host が `session_equipped_biblios` に upsert → **次回 spawn で `install-biblios.sh` が PVC / `data/shelf/` 上の biblio 実体を agent コンテナに mount** |
| 反映タイミング | **次回 session 起動時**(= 同セッションでは反映されない。即時反映したい場合は `ncl groups restart`) |
| host ログ(local) | `pnpm run dev` の stdout に `event=biblio.equip` 系 |
| host ログ(GKE) | `kubectl logs biblio-orchestrator-0 -c orchestrator -n biblio-claw \| jq 'select(.event=="biblio.equip")'` |
| 装備リスト確認 | `pnpm exec tsx scripts/q.ts data/v2.db "SELECT biblio_name, order_index FROM session_equipped_biblios WHERE session_id='<id>' ORDER BY order_index"`(GKE は orchestrator Pod 内に `kubectl exec`、DB パスは `/data/v2.db`) |
| 動かない時 | (1) 装備対象 biblio が PVC / `data/shelf/` に物理存在するか(= **焼却済だと装備不可**)/ (2) `install-biblios.sh` が agent コンテナに COPY されているか(= Dockerfile で `chmod 755`、CLAUDE.md §コンテナランタイム参照) |
| verify との接続 | `verify-m3.sh` assertion 1(マーカー検出)/ 2(ephemeral 解除)が同経路を独立 assert |

詳細は [equip-physical.md](equip-physical.md)(= 物理配置規約 + Docker/K8s 両 runtime 透過 + spawn-time install lifecycle)を参照。

### `@bot 蔵書` / `@bot 蔵書一覧` 経路(蔵書一覧)

| 項目 | 内容 |
| :--- | :--- |
| patron 動線 | Slack で `@bot 蔵書` → agent が `list_biblio` MCP tool を **自律発火**(= host 側 keyword parser を持たない)→ host `listBiblio()` が `fetchMarketplace`(GitHub Contents API)→ source split(= 棚 author 由来 only)→ category filter → patron へ JSON 返却 |
| category 指定 | `@bot 蔵書 biblio-ai` 形式で絞り込み。**不正 category は silent fallback で全件 + 注記**(= UX 寄せ) |
| host ログ(local) | `event=biblio.list` |
| host ログ(GKE) | `kubectl logs biblio-orchestrator-0 -c orchestrator -n biblio-claw \| jq 'select(.event=="biblio.list")'` |
| 動かない時 | (1) `SHELF_REPO_OWNER` / `SHELF_REPO_NAME` env が host に投入されているか(= GKE は `k8s/10-orchestrator-statefulset.yaml` の orchestrator container env、Phase 4.6 で投入確定)/ (2) GH installation token が valid か(= `kubectl logs biblio-orchestrator-0 -c gh-token-rotator` で rotation 状況確認、~50min 周期) |
| verify との接続 | `verify-m3.sh` assertion 5(全件)/ 6(カテゴリ別)が同経路を独立 assert |

### `@bot 仕入れて <owner>/<repo>` 経路(仕入れ → 検品 → カテゴライズ → 陳列)

| 項目 | 内容 |
| :--- | :--- |
| patron 動線 | Slack で `@bot 仕入れて example-org/test-biblio-minimal` → agent が `acquire_biblio` MCP tool 発火 → host が **4 段** を順次実行:(1) `acquire`(= GitHub Contents API + clone、host-proxy 経由)→ (2) `inspect`(= Vertex × Gemini 3 軸)→ (3) `categorize`(= Vertex × Claude Sonnet-4.6)→ (4) `shelve`(= 棚リポへ draft PR 作成、Git Data API) |
| 完了通知 | patron に **draft PR URL** が返る(= 棚 main への merge は patron の手動操作、merge 後に `@bot 蔵書` で見える) |
| host ログ(local) | `event=biblio.acquire` / `biblio.inspect` / `biblio.categorize` / `biblio.shelve`(= 4 段それぞれ独立 event) |
| host ログ(GKE) | `kubectl logs biblio-orchestrator-0 -c orchestrator -n biblio-claw \| jq 'select(.event \| startswith("biblio."))'` で 4 段串刺し |
| 動かない時 | (1) Vertex token / GH token が valid か(= **401 retry-loop に陥った agent は `/init-project-gcp refresh` の Section 4 で clean restart**)/ (2) OneCLI MITM が tunnel に倒れていないか(= §「落とし穴: OneCLI MITM が `tunnel` mode で素通しになる」)/ (3) Vertex Marketplace で対象 model が enable されているか(= `claude-sonnet-4-6` / Gemini) |
| verify との接続 | `verify-m2.sh`(= M2 完成判定)が 4 段全部を 1 周 + 重複検知 + cleanup を assert(= 本経路の主たる回帰検証) |

> **禁書 / 焼却**(= 破壊操作 HITL):`@bot 禁書 <biblio-name>` / `@bot 焼却 <biblio-name>` は **admin 承認を経由**(= owner / scoped admin に DM、CLAUDE.md §シークレット / クレデンシャル / OneCLI §「クレデンシャル使用時の承認要求」と同経路)。承認後に削除方向 draft PR(= 棚から marketplace entry 削除)+ 焼却は agent からの装備対象も物理削除する。詳細は [equip-physical.md](equip-physical.md) §破壊操作 + ルート `CLAUDE.md` §src/biblio。verify との接続は `verify-m3.sh` assertion 3(禁書 = clone 残置で再装備可)/ 4(焼却 = clone 物理削除で装備不可)。

---

## /init-project-gcp サブコマンド利用ガイド

GKE 環境の初期化 / 起動 / 動作確認は `/init-project-gcp` 1 発で完結する設計(= local 経路の `/init-project` と対称)。**サブコマンド本体の詳細実装は `.claude/commands/init-project-gcp.md`(= 421 行)が正本**。本 § は patron 視点の「いつ叩くか / 期待結果 / 主要ログ確認経路」のサマリ。生コマンドは本 runbook 既存 §(= 大原則 / 早見表 / GKE リセット手順)に残置。

### `/init-project-gcp`(引数なし、= 状態確認 + up)

| 項目 | 内容 |
| :--- | :--- |
| いつ叩くか | **入室直後の第一選択**。GKE 環境の現状を診断 → healthy なら no-op、不足分があれば自動で `up` に進む |
| 期待結果 | resource-check + GKE wiring 確認(= `verify-phase-2-wiring.sh`)の両 PASS → 「GKE 環境 ready」 |
| 主要ログ | `kubectl logs biblio-orchestrator-0 -c orchestrator -n biblio-claw --since=5m`(= `Channel adapter started` 観測) |
| 副作用 | なし(= 純粋な状態確認) |

### `/init-project-gcp up`(= ensure running、不足分だけ起動)

| 項目 | 内容 |
| :--- | :--- |
| いつ叩くか | Pod 落ち / Secret 未投入 / token 期限切れ後の復帰用 |
| 期待結果 | `kubectl apply -f k8s/` 冪等適用 → StatefulSet ready → `verify-phase-2-wiring.sh` 全 9 assertions PASS |
| 主要ログ | `kubectl rollout status statefulset/biblio-orchestrator` 出力 + 上記 orchestrator log |
| 副作用 | manifest 適用のみ(= 冪等)。**deps install / image build は触らない**(= `image-sync` の責務) |

### `/init-project-gcp reset`(= factory reset、副作用大)

> ⚠️ **DEN さん確認後に実行**:本サブコマンドは GKE / Cloud SQL / VPC を **teardown(= 既存 cluster の初期化)** する。実行前に必ず `--dry-run` で削除予定リソースを確認すること。Secret Manager `biblio-gh-app-pem` は teardown でも残置するため再投入不要。

| 項目 | 内容 |
| :--- | :--- |
| いつ叩くか | 部分 reset(= Pod 再起動)で復旧しないとき、または setup を最初からやり直したいとき |
| 期待結果 | `teardown-phase-2.sh --confirm` → 再構築 → Bootstrap GRANT → `verify-phase-2-wiring.sh` 全 PASS |
| 主要ログ | teardown スクリプトの 6 段階出力(= K8s manifest / GKE cluster / Cloud SQL / AR / GSA / VPC) |
| 副作用 | **大**(= GKE cluster / Cloud SQL を実削除、再作成は手作業)。詳細手順は本 runbook §GKE リセット手順 §手順 3 |

### `/init-project-gcp refresh`(= token 強制再投入、debug 用途)

| 項目 | 内容 |
| :--- | :--- |
| いつ叩くか | **通常運用では不要**(= `gh-token-rotator` sidecar が ~50min 周期、`vertex-token-rotator` sidecar が ~40min 周期で自動 rotate)。即座に token を入れ替えたい debug 場面のみ |
| 期待結果 | port-forward 経由で OneCLI に `PATCH /v1/secrets/<id>` 直叩き → Vertex / GH token 即時反映 |
| 主要ログ | OneCLI sidecar の `kubectl logs biblio-orchestrator-0 -c onecli` で secret 更新観測 |
| 副作用 | 中(= 既存 token 即時失効。稼働中 agent が 401 retry-loop に陥った場合は Section 4 で `ncl groups restart` 経由 clean restart) |
| 罠 | **`.env` の `ONECLI_URL` 上書き罠**(= `scripts/onecli-*-secret.sh` は `.env` を `set -a; . .env; set +a` で読み込むため、ローカル用 `ONECLI_URL=http://localhost:10254` が居ると外部指定が上書きされる)。本サブコマンドは `.env` を読まない経路(= 直接 curl + ADC token)を案内 |

### `/init-project-gcp verify`(= 全 verify、5 Section 順次)

| 項目 | 内容 |
| :--- | :--- |
| いつ叩くか | ハッカソンデモ前の動作確認 / トラブル復旧後の最終確認 |
| 期待結果 | Section 1 resource-check + 2 wiring(`verify-phase-2-wiring.sh`)+ 3 log(`verify-phase-2-log.sh`)+ 4 Phase 4 deploy-verify(`verify-phase-4-deploy.sh`)+ 5 Slack E2E(`verify-slack-e2e-gke.sh`、半自動)を順次実行 |
| 主要ログ | 各 verify スクリプトの ok/fail 出力 + 失敗時の orchestrator log 個別確認 |
| 副作用 | 読み取り中心(= `kubectl logs` / `curl` ベース、書き込みなし) |

### `/init-project-gcp image-sync --tag <tag>`(= 4 image を本番反映、副作用大)

> ⚠️ **DEN さん確認後に実行**:本サブコマンドは AR に新 image を push + manifest tag bump + rollout する。**dry-run(= 既定)で空打ち確認した後に `--confirm` で実行**。実行時間 ~10 min。

| 項目 | 内容 |
| :--- | :--- |
| いつ叩くか | local repo のコード変更を GKE に反映したいとき(= Phase 4 verify を成立させる前提セットアップ、`m2-pN` / `m3-hotfix-N` 等の新 tag を打って実行。Phase 4.5 / 4.6 は `m2-pN-N` 系、Phase 6 完了後の hotfix からは `m3-hotfix-N` 系を導入) |
| 期待結果 | 4 image rebuild(`biblio-claw` orchestrator + `nanoclaw-agent` + `biblio-sidecar-gh` + `biblio-sidecar-vertex`)→ AR push → `k8s/10-orchestrator-statefulset.yaml` の image tag bump → `kubectl apply -f k8s/` → rollout 完了 → `Image sync PASS` |
| 前提 | `gcloud auth configure-docker asia-northeast1-docker.pkg.dev` 済(= 初回のみ)+ kubectl context = `biblio-prod` + GSA に `roles/artifactregistry.writer` 付与済 |
| 主要ログ | スクリプトの 6 Block 出力(= pre-flight / build / push / manifest sed -i / kubectl apply + rollout / 状況確認) |
| 副作用 | **大**(= AR への image push + manifest 書き換え + StatefulSet rollout、git tracked file 変更で別 commit 要) |

詳細は `.claude/commands/init-project-gcp.md` を参照(= 各サブコマンドの実装本体 + Open Questions A-G の GCP 版確定内容 + トラブルシューティング)。

---

## Phase 4(GKE deploy-verify)verify(`scripts/verify-phase-4-deploy.sh`)

`init-project-gcp` PRD Phase 4 で導入した GKE 専用 verify スクリプト。Phase 4.5 image-sync で本番反映された image が **構造化ログ(Phase 2)** を期待どおり吐いているかを `kubectl logs` 経由で独立に assert する。

### 前提

| # | 項目 | 確認 |
| :---: | :--- | :--- |
| P4-a | kubectl context = `gke_*_biblio-prod` | `kubectl config current-context` で確認 |
| P4-b | orchestrator StatefulSet `readyReplicas=1` + Pod phase=Running | `kubectl get pod biblio-orchestrator-0 -n biblio-claw` |
| P4-c | `gh-token-rotator` container が Pod spec に含まれる | `k8s/10-orchestrator-statefulset.yaml` apply 済 |
| P4-d | `LOG_FORMAT=json` + `LOG_COMPONENT=host-orchestrator` env が StatefulSet で投入済 | Phase 2 で manifest 追加、Phase 4.5 image-sync で GKE に反映済 |

### 実行

```bash
bash scripts/verify-phase-4-deploy.sh
```

期待出力:`Phase 4 PASS (GKE deploy-verify) — Block 1 (Phase 2 ログ観測) all OK`

### 観点(= 1 ブロック構成)

- orchestrator container の直近 300s から JSON ログ 1 行以上観測 + `severity / message / time / component=host-orchestrator` 4 field の整合
- gh-token-rotator container の直近 600s から JSON ログを取得(= 50min 周期のためなくても WARN)、出ていれば `component=gh-token-rotator` 整合

> **Note**: 当初 plan は Block 2(M3 装備機構 GKE)+ Block 3(M3 蔵書リスト GKE)を含む 3 ブロック構成だったが、2026-06-23 実走で M3 PRD GKE 経路 bug 群 5 件が顕在化したため、Z+δ 案で Block 1 のみに縮小した経緯がある。後続の Phase 4.6 (PR #29) で全 bug 解消 + `M3 PASS (gke)` 取得済。装備機構 + 蔵書リストの GKE E2E は完了し、Phase 6 verify (`verify-slack-e2e-gke.sh`) に統合されている。

---

## Phase 6(Slack E2E verify)(`scripts/verify-slack-e2e-gke.sh`)

`init-project-gcp` PRD Phase 6 で導入した本番 Slack ws + GKE 両 E2E verify スクリプト。本番 Slack ws(`biblio-slack-app`)で patron が **手で 2 回投稿**し、その合間を `kubectl exec node -e` の inbound.db 直読み polling で acquire → categorize → shelve まで assert する **半自動 verify**。完全自動化(Bot/User Token 経由 chat.postMessage)は Slack 制約のため将来 Phase 6.5 or 別 PRD で扱う(= 自分の post に bot が反応しない問題)。

### 前提

| # | 項目 | 確認 |
| :---: | :--- | :--- |
| P6-a | kubectl context = `gke_*_biblio-prod` + StatefulSet ready | `kubectl get statefulset biblio-orchestrator -n biblio-claw` |
| P6-b | 本番 Slack ws token が K8s Secret に投入済 | `kubectl get secret biblio-slack-tokens -n biblio-claw`(詳細は [slack-environments-setup.md](slack-environments-setup.md)) |
| P6-c | first-agent の Slack channel wiring 済 | `scripts/init-first-agent-gke.sh` 実行済(= `messaging_group_agents` row が central DB にある) |
| P6-d | gh CLI 認証済 | `gh auth status`(= cleanup の `gh pr close` で使用) |
| P6-e | env: `SHELF_REPO_OWNER` + `SHELF_REPO_NAME` 投入済 | shell env or `.env`(= cleanup の対象棚 repo 解決) |

### 実行

```bash
bash scripts/verify-slack-e2e-gke.sh                  # 本番 ws full E2E
bash scripts/verify-slack-e2e-gke.sh --dry-run        # pre-flight のみで exit 0
bash scripts/verify-slack-e2e-gke.sh --skip-slack-check  # Section F(配信補助確認)skip
```

任意 env:`TARGET_REPO`(default `example-org/test-biblio-minimal`)で仕入れ対象を切替。

### patron の操作(= 半自動)

1. script 実行 → pre-flight 通過後、Section A で「Slack ws で `@biblio 仕入れて owner/repo` を投稿してください」と促される
2. patron が Slack ws に投稿 → script 側で Enter 押下
3. script が inbound.db を polling して acquire → categorize 完了を検出
4. Section D で「`@biblio はい` を同 thread に投稿してください」と促される
5. patron が投稿 → Enter
6. script が shelve 完了を polling、PR URL を抽出
7. cleanup trap が draft PR を `gh pr close --delete-branch` + shelf 物理ファイルを `kubectl exec rm` で削除

### 期待出力

```
Phase 6 PASS (Slack E2E GKE) — PR URL=https://github.com/<owner>/<repo>/pull/<N>
```

### 観点 / cleanup

- `messages_in.id LIKE 'acquire-resp%' / 'categorize-resp%' / 'shelve-resp%'` の content text から `仕入れ完了` / `カテゴリ判定 + 陳列を進めますか` / `陳列完了: PR URL =` を検出
- `BIBLIO_NAME` は acquire-resp の `data/quarantine/<owner>--<name>` から regex 抽出、PR URL + `CREATED_PR_NUMBER` は shelve-resp の GitHub URL から regex 抽出
- cleanup は trap で EXIT/INT/TERM をフック、draft PR close 失敗は warn 継続(= 本体 exit code には影響させない)
- 失敗時の原因切り分けは各 fail メッセージに `kubectl logs ... | grep biblio.<action>` を案内(= Phase 2 構造化ログ参照)

> **Note**: Section F(= outbound + delivered の Slack 配信補助確認)は Section E で PR URL を取得した時点で E2E が実質成立しているため補助位置付け。配信側の問題がある場合は warn 継続で本体 PASS は維持される(= `--skip-slack-check` で skip 可)。

---

## M4-A Phase 1: OTel foundation 運用

### 前提

- GCP IAM:GSA `biblio-orchestrator@hajimari-ai-hackathon-2026.iam.gserviceaccount.com` に `roles/cloudtrace.agent`、DEN さん (`f.takematsu@hajimari.inc`) に `roles/cloudtrace.user`(2026-06-26 付与済)
- Cloud Trace API は project default で有効。未有効なら `gcloud services enable cloudtrace.googleapis.com --project=hajimari-ai-hackathon-2026`
- ローカル実行は `gcloud auth application-default login` 済前提(ADC)

### 疎通確認(local)

Phase 4 で導入した `scripts/emit-test-span.ts` を流用する (= zero-traceId guard + verify-m4-a.sh と同 fixture)。

```bash
GOOGLE_CLOUD_PROJECT=hajimari-ai-hackathon-2026 \
  pnpm exec tsx --import ./src/instrumentation.ts scripts/emit-test-span.ts
# 出力 (3 行):
#   TRACE_ID=<32hex>
#   REQUEST_ID=<uuid>
#   SESSION_ID=verify-m4a-<unix>-<pid>

TRACE_ID=<上記 TRACE_ID 行の値>
sleep 30
# `gcloud trace` CLI は廃止済 (= "Invalid choice: 'trace'")。Cloud Trace v1 REST API を直叩き。
TOKEN=$(gcloud auth application-default print-access-token)
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://cloudtrace.googleapis.com/v1/projects/hajimari-ai-hackathon-2026/traces/${TRACE_ID}" \
  | jq '{traceId, spans: [.spans[] | {name, labels}]}'
# 同 TRACE_ID と root span 名 = `biblio.acquire` + labels[biblio.request_id] が REQUEST_ID と
# 一致すれば PASS
```

UI 確認は <https://console.cloud.google.com/traces/list?project=hajimari-ai-hackathon-2026>

### shutdown 挙動

- host は SIGTERM/SIGINT で `shutdownOtel()` 経由で BatchSpanProcessor を flush(`scheduledDelayMillis: 2000`、`exportTimeoutMillis: 10000`)
- K8s grace period(30s)内に flush 完了する設計

### Bun + OTLP HTTP 既知挙動

- agent-runner(Bun)で `[otel] Request timed out` の warn が出ることがある([opentelemetry-js#5260](https://github.com/open-telemetry/opentelemetry-js/issues/5260))
- **span 自体は届く**。warn は無視可能
- 詳細診断が必要なら manifest env に `OTEL_DIAG=true` を一時投入

### trace が届かない場合の切り分け順

1. **fixture 起動時のログ**:`OTel init failed` warn が出ているか → init 段階の失敗(projectId 不在 / ADC 不在 / network)
2. **stdout の `TRACE_ID=...` 行**:32-hex が `0...0` (all-zero) で出ていないか (= NodeSDK が degraded fallback に倒れている)。`emit-test-span.ts` 自体が zero-traceId なら exit 1 で fail させる
3. **`OTEL_DIAG=true` で再実行**:「Request timed out」が大量に出るか
4. **30s 待って Cloud Trace v1 REST API を直叩き** (`gcloud trace` CLI は廃止):`curl -s -H "Authorization: Bearer $(gcloud auth application-default print-access-token)" "https://cloudtrace.googleapis.com/v1/projects/<project>/traces/<traceId>"` で span が返れば成功
5. **IAM 確認**:`gcloud projects get-iam-policy hajimari-ai-hackathon-2026 --flatten="bindings[].members" --filter="bindings.members:biblio-orchestrator"` で `roles/cloudtrace.agent` 存在
6. **API enable 確認**:`gcloud services list --enabled --filter=cloudtrace --project=hajimari-ai-hackathon-2026`
7. **agent 側のみ届かない場合**:`kubectl exec biblio-orchestrator-0 -c orchestrator -- printenv | grep -i otel` で env 確認、`NO_PROXY` に `telemetry.googleapis.com` が入っているか
8. **HTTPS_PROXY 経由を疑う**:agent Pod 内で `bun -e "fetch('https://telemetry.googleapis.com/v1/traces')"` で直接接続テスト
9. **Fallback 候補**:(a) `@google-cloud/opentelemetry-cloud-trace-exporter` (gRPC、Cloud Trace 専用 SDK) に host 側だけ切り替え(agent 側は Bun gRPC silent freeze のため不可)/(b) agent 側 export を諦め、span を `outbound.db` の新規テーブル経由で host に送って一元 export する architecture に変更

### 関連

- `src/instrumentation.ts` / `src/observability/{otel,auth,env-propagation,index}.ts`(host)
- `container/agent-runner/src/observability/{otel-init,auth,env-propagation,index}.ts`(agent)
- `scripts/emit-test-span.ts`(疎通確認 + Phase 4 verify fixture 兼用、host 単独実行 + zero-traceId guard)
- 起動コマンド:host = `node --import ./dist/instrumentation.js dist/index.js`(`Dockerfile` で配線済)

---

## M4-A Phase 2: GenAI semconv + boundary spans + log↔trace 連携

### 観測体験

Phase 2 で 1 patron リクエストの **全境界** に手動 span が立ち、Cloud Trace UI で親子関係つきで開ける。Cloud Logging UI からは「Trace を表示」リンクで 1-click 遷移できる。

- **Slack inbound** (= `chat-sdk-bridge.ts` の各 callback) → `slack.event` span (`messaging.system='slack'` / `slack.event.type` / `slack.channel.id` / `slack.thread.ts`)
- **9 action handler** (acquire / inspect / categorize / shelve / shelve_multi / list / enkin / shokyaku / config) → `biblio.${action}` span (`biblio.request_id` / `biblio.session_id` / `biblio.action` / `biblio.outcome`)
- **LLM 呼び出し** (= `vertex-client.ts:callVertexGemini` / `callVertexAnthropic`) → `chat ${modelId}` span (GenAI semconv: `gen_ai.provider.name='gcp.vertex_ai'` / `gen_ai.request.model` / `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` / `gen_ai.usage.cache_read.input_tokens` / `server.address`)
- **K8s Job spawn** (= `container-runner.ts:spawnContainer`) → `agent.spawn` span (`agent.session_id` / `agent.group_id` / `agent.group_name` / `agent.container_name` / `agent.runtime` / `k8s.job.name` / `k8s.namespace.name`)

### log↔trace 連携 (Preferred Format)

`src/log.ts` / `container/agent-runner/src/log.ts` の `emitJson` が active span から自動注入する:

- `logging.googleapis.com/trace`: trace_id (32-hex そのまま、Preferred Format)
- `logging.googleapis.com/spanId`: span_id (16-hex)
- `logging.googleapis.com/trace_sampled`: boolean

projectId 解決ロジックは持たない (= Cloud Logging UI が現在の project context で resolve する設計、`projects/<project>/traces/<id>` の Legacy full path 経路は採用していない。**実機検証 2026-07-03 / issue #81 で "View trace" UI 遷移動作を確認済**、次節参照。将来仕様変更で UI 遷移が立たない事象が出たら plan §Fallback Option G に切替判断)。

#### 実機検証済 (2026-07-03, issue #81)

GKE `biblio-claw` namespace で Cloud Logging Console UI の "View trace" リンク動作を目視確認 (issue #81 実機検証成果)。

- **確認経路**: 過去 24h の biblio.\* action 由来 log entry を `gcloud logging read 'resource.type="k8s_container" AND resource.labels.namespace_name="biblio-claw" AND jsonPayload.event=~"biblio\\."' --limit=5 --freshness=24h --project=hajimari-ai-hackathon-2026 --format=json` で引き出し、`trace` 列が `projects/hajimari-ai-hackathon-2026/traces/<32hex>` 形式に自動昇格されていることを確認 → 該当 entry を Cloud Logging Console (`https://console.cloud.google.com/logs/query?project=hajimari-ai-hackathon-2026`) で開いて "Trace を表示 / View trace" リンクをクリック → Cloud Trace UI に該当 span (`biblio.<action>`) が表示されることを目視
- **BQ sink 側の証跡**: `SELECT trace FROM \`hajimari-ai-hackathon-2026.llm_observability.stdout\` WHERE jsonPayload.event LIKE 'biblio.%' AND trace IS NOT NULL LIMIT 1` で top-level `trace` 列が resource name 形式で観測される (= Fluent Bit / Cloud Logging 取り込み層が projectId を自動補完)。`scripts/verify-m4-a.sh` Section 5.5 で shape assertion 化済 (regression 検知)
- **判断**: 「Preferred Format = trace_id alone」実装 (`trace-fields.ts` の bare 32-hex 出力) はそのまま維持。Option G (full path 送出) への切替は不要
- **失敗時の対処**: 将来 Fluent Bit / Cloud Logging 側の仕様変更で自動補完が壊れた場合、`trace-fields.ts` を `projects/${projectId}/traces/${ctx.traceId}` 形式に変更 (`otel.ts:24` の `GOOGLE_CLOUD_PROJECT ?? ANTHROPIC_VERTEX_PROJECT_ID` fallback 経路を再利用)
- **既知の非適用 fixture**: `scripts/emit-test-span.ts` は Cloud Trace への span 到達検証専用 (verify-m4-a.sh Section 3-4) で、**Cloud Logging には structured log を emit しない** (`emitJson` 呼出なし)。"View trace" リンク動作を新規発火で試したいときは実 biblio action (agent 経由の chat, `@bot 蔵書` 等の read-only action) を使うか、既存の biblio.\* log entry (過去 24h 分) で代替する

#### 実運用の Cloud Logging 到達経路 (3 + 1)

日常 debug で Cloud Logging に到達する経路は用途別に 4 種類 (UI 経由 3 + CLI 経由 1) ある。**経路 2 (Console 直行 + Saved Query) をベース**にして、状況で他経路を使い分ける。

| # | 用途 | 経路 | 手順 | 向き不向き |
|---|------|------|------|-----------|
| 1 | 特定 request 追跡 | **Cloud Trace ← → Cloud Logging 往復** | Cloud Trace UI で span を開く → 右上「関連ログを表示 / View logs」で trace_id フィルタ済 Cloud Logging に遷移 (本節 "View trace" の逆方向) | request 単位で全 log 揃うので debug 最適 |
| 2 | **日常監視 / error 洗い** | **Cloud Logging Console 直行 + Saved Query** | `https://console.cloud.google.com/logs/query?project=hajimari-ai-hackathon-2026` を開いて頻用 query を「保存済みクエリ」に登録、以後 1 クリック | **常時使いのベース** |
| 3 | Pod 単位のログ確認 | GKE Workloads → Pod → ログ | GKE Console で該当 Pod を選んで「ログ」タブ = 該当 Pod で auto-filter された Cloud Logging に遷移 | orchestrator (永続 Pod) 向き / agent Pod (Job 起動でスポット) は Pod 消失後は空 |
| 4 | 一括抽出 / 自動化 | `gcloud logging read` | CLI (verify script / Crane と同じ経路) | 対話 debug より dump 向け |

**推奨 Saved Query** (Cloud Logging Console 右ペイン「保存済みクエリ」に登録)

```
# biblio-claw 全 log (Pod 横断)
resource.type="k8s_container"
resource.labels.namespace_name="biblio-claw"

# biblio.* event のみ (action handler 経路)
resource.type="k8s_container"
resource.labels.namespace_name="biblio-claw"
jsonPayload.event=~"biblio\."

# error / warn だけ (定常監視)
resource.type="k8s_container"
resource.labels.namespace_name="biblio-claw"
severity>=WARNING

# 特定 trace_id (request 追跡、TRACE_ID を差し替えて使う)
trace="projects/hajimari-ai-hackathon-2026/traces/<TRACE_ID>"
```

### GenAI semconv の Development ステータス

`gen_ai.*` 属性は OTel 仕様で **Development** ステータス。将来の変更を受容するため manifest env で明示している:

```yaml
- { name: OTEL_SEMCONV_STABILITY_OPT_IN, value: gen_ai_latest_experimental }
```

WARNING: `gen_ai.system` を見ているクライアント (旧仕様) は **`gen_ai.provider.name`** を見るよう更新が必要 (Vertex 経由 = `gcp.vertex_ai`、直接 Anthropic API = `anthropic`)。

### Cloud Trace UI 検索フィルタ例

```
gen_ai.provider.name="gcp.vertex_ai"
gen_ai.usage.input_tokens>1000
biblio.action="acquire"
biblio.outcome="failure"
agent.runtime="k8s"
```

### debug 切り分け — Phase 2 追加分

trace は届くが gen_ai 属性が空 / 期待外れの場合:

1. `OTEL_SEMCONV_STABILITY_OPT_IN` env が manifest に投入されているか確認 (= `kubectl exec biblio-orchestrator-0 -c orchestrator -- env | grep OTEL_SEMCONV`)
2. dummy `gen_ai` span を smoke-test で送出 → Cloud Trace REST API で取得し `labels.["gen_ai.provider.name"]` を目視
   ```bash
   gcloud auth application-default print-access-token | \
     xargs -I{} curl -H "Authorization: Bearer {}" \
       "https://cloudtrace.googleapis.com/v1/projects/<proj>/traces/<traceId>" | \
     jq '.spans[].labels'
   ```
3. log↔trace UI 遷移が立たない場合: `gcloud logging read 'jsonPayload."logging.googleapis.com/trace"=*'` で jsonPayload に trace_id が乗っているか確認。空なら active span 不在経路 (= span ラップの外で log が出ている、bug)

### Phase 2 で実装しなかったもの (= Out of Scope)

- LLM prompt / completion 全文の span attribute / event 記録 (PII リスク、Phase 5+ で別途検討)
- BigQuery sink (Phase 3 専任)
- `scripts/verify-m4-a.sh` 統合 verify (Phase 4 専任)
- `agent.lifecycle.{pending,ready,first_response}` の span (Phase 5+ で寄り道予定、plan §補足参照)

### 関連

- `src/observability/{genai,trace-fields}.ts` (host 側 Phase 2 追加 = GenAI semconv 定数 + Cloud Logging reserved field 生成)
- `container/agent-runner/src/observability/trace-fields.ts` (agent 側 Phase 2 追加、host と実装同一を維持 = ファイル先頭の同期義務コメント参照)
- `src/biblio/action-helpers.ts` (`withBiblioActionSpan` ヘルパ + `BiblioActionName` closed union)
- `src/channels/chat-sdk-bridge.ts` (4 callback を `${adapter.name}.event` span 起点に)
- `src/container-runner.ts` (`spawnContainer` を `agent.spawn` span でラップ)
- `src/adapters/container/k8s.ts` (`k8s.job.name` / `k8s.namespace.name` 属性追加)
- `src/biblio/vertex-client.ts` (`callVertexGemini` / `callVertexAnthropic` を `chat ${modelId}` span でラップ + `gen_ai.*` 属性)
- `container/agent-runner/src/mcp-tools/biblio.ts` (9 tool の log を structured form = `mcp.biblio.*` event に)

---

## M4-A Phase 3: Cloud Logging → BigQuery sink

### 概要

biblio-claw の構造化ログ (GKE Fluent Bit 経由で Cloud Logging に到達済) を BigQuery dataset `llm_observability` に sink し、`request_id` 1 つで SQL 集計可能にする。Terraform で sink + dataset + IAM を宣言的に管理 (`terraform/m4-a-observability/`)。clustering は sink 経由作成テーブルへの後追い `bq update` で適用 — `CREATE OR REPLACE TABLE ... CLUSTER BY` は全ログ消滅の罠なので使わない。

### 前提

- DEN account に `roles/logging.configWriter` + `roles/bigquery.admin` 付与済 (memory `gcp_iam_secret_manager_pattern` 参照)
- GKE cluster `biblio-prod` (region `asia-northeast1`) で biblio-claw が稼働中 (= Phase 1+2 完了)
- keyless: `gcloud auth application-default login` 済 (ADC)、SA key を使わない
- **terraform CLI (v1.5+ 推奨)** — biblio-claw が管理する 2 module (`terraform/m4-a-observability/` + `terraform/fugue-channel/`) の apply に必要。本 §前提 が repo 内の terraform CLI install 経路の集約点 (issue #70)。OS 別 install 手順:

  ```bash
  # AlmaLinux / RHEL / Rocky Linux (DEN さん環境実績: v1.15.7)
  sudo dnf config-manager --add-repo https://rpm.releases.hashicorp.com/RHEL/hashicorp.repo
  sudo dnf install -y terraform

  # Ubuntu / Debian (WSL2 Ubuntu も同じ)
  wget -O- https://apt.releases.hashicorp.com/gpg | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/hashicorp.list
  sudo apt update && sudo apt install -y terraform

  # macOS
  brew tap hashicorp/tap && brew install hashicorp/tap/terraform
  ```

  Install 済確認: `terraform version` が v1.5 以上を返せば OK。不在時は `pnpm exec tsx setup/index.ts --step verify` の `TERRAFORM: missing` で気付ける (fail はしない = optional guard)。M4-E Phase 5 (`terraform/fugue-channel/`) など今後追加される module も本 §前提 を install 経路の source of truth として参照する。

### Apply

```bash
cd terraform/m4-a-observability
terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

作成リソース (5 個):

- `google_bigquery_dataset.logs` (`llm_observability`、location `asia-northeast1`、90 日 expiration)
- `google_logging_project_sink.biblio` (`biblio-claw-to-bq`、filter = `k8s_container` + namespace `biblio-claw`)
- `google_bigquery_dataset_iam_member.sink_writer` (sink writer identity → `roles/bigquery.dataEditor`)
- `google_project_service.{bigquery,logging}` (API 有効化、`disable_on_destroy=false` で API は destroy 時も残置)

### Verify(手動 1 回確認)

1. biblio-claw で任意の biblio action を 1 回実行 (Slack で `@bot 蔵書` 等)
2. ~5 分待ち、`bq ls hajimari-ai-hackathon-2026:llm_observability` でテーブル materialize 確認
3. 実テーブル名は GKE container の logName 直接由来で **`stdout` / `stderr` の 2 テーブル** (2026-06-28 Phase 3 apply 時に実測確認)
4. 以下を実行 (`sql/summary.sql` は M4-A Phase 4 で placeholder 化済 = `sed` 置換が必要):
   ```bash
   sed -e "s/<PROJECT_ID>/hajimari-ai-hackathon-2026/g" \
       -e "s/<DATASET_ID>/llm_observability/g" \
       terraform/m4-a-observability/sql/summary.sql | \
     bq query --project_id=hajimari-ai-hackathon-2026 --use_legacy_sql=false
   ```
   1 行返却で `hit_count >= 1` かつ `marker = M4A_OK` が出れば OK。event/outcome 別集計が欲しい場合は SQL ファイル末尾のコメントブロックを参照
5. `request_id` 1 つを取り出し、`SELECT * WHERE jsonPayload.request_id='<UUID>'` で全境界ログが取得できることを確認

> **TZ bug 回避**: `WHERE DATE(timestamp) = CURRENT_DATE('Asia/Tokyo')` は UTC 評価 vs JST date 比較で時差ズレ (= 朝の時間帯に 0 件症状)。`DATE(timestamp, 'Asia/Tokyo')` を使う。`summary.sql` は対応済

### Clustering 後追い(初回 emit 後に 1 回)

sink 経由作成テーブルは Terraform 管理外 (sink writer SA に `tables.delete` 権限なし、`CREATE OR REPLACE` 罠回避)。`bq update` で後追い適用:

```bash
bq update \
  --clustering_fields=severity \
  hajimari-ai-hackathon-2026:llm_observability.stdout

bq show --format=json \
  hajimari-ai-hackathon-2026:llm_observability.stdout \
  | jq .clustering
# → {"fields": ["severity"]}
```

- **BQ 仕様: clustering は top-level column のみ**。`jsonPayload.event` 等の nested field は `Fields specified for clustering can only be top-level fields` で reject される。`severity` 単独で WHERE 句頻出ケースをカバー
- 新規行のみ clustering 対象 (既存行は再クラスタなし)。biblio-claw の運用量 (~100 req/day) では DML UPDATE 再クラスタは不要
- 罠: `CREATE OR REPLACE TABLE ... CLUSTER BY` は全ログ消滅。絶対に使わない

### Teardown

`delete_contents_on_destroy = false` のため、`terraform destroy` 単独では dataset 削除に失敗する。順序固定:

```bash
cd terraform/m4-a-observability
terraform plan -destroy                                       # dry-run
bq rm -r -f -d hajimari-ai-hackathon-2026:llm_observability   # dataset + 全テーブル削除
terraform destroy -auto-approve                                # sink + IAM 削除
```

`google_project_service` は `disable_on_destroy=false` で API 残置 (他リソース影響回避)。

### 既知の罠 / gotcha

- **BQ location ≠ GKE region で無音 drop**: `variables.tf` default で `asia-northeast1` 固定。GKE cluster region と一致必須
- **`_iam_binding` 罠**: 他 principal を退出させる authoritative。`_iam_member` (additive) を使う
- **`unique_writer_identity = true` 必須**: `bigquery_options` 使用時。v5+ デフォルト true だが明示
- **テーブル名 (GKE)**: `stdout` / `stderr` (logName 直接由来)。Cloud Run などの別環境では `run_googleapis_com_stdout` 系になる
- **`DATE(timestamp)` の TZ bug**: デフォルト UTC 評価。JST date と比較する SQL は `DATE(timestamp, 'Asia/Tokyo')` を使う。PoC-10 写経起点で同 bug 継承していたため Phase 3 で修正済
- **clustering は top-level column のみ**: `jsonPayload.event` 等 nested は reject。`severity` 単独運用
- **log には latency/tokens が載らない**: span attribute としてのみ記録 (Cloud Trace 側で見る設計)。BQ サマリは event/outcome/component/action の境界集計に絞る
- **`default_table_expiration_ms` 単位はミリ秒**: 7776000000 = 90 日

### Phase 3 で実装しなかったもの (= Out of Scope)

- `scripts/verify-m4-a.sh` 自動化 (Phase 4 任意で扱う、Phase 3 は手動 1 回確認)
- BQ Dashboard / Looker Studio 連携 (M4-C 責務)
- log filter の細分化 (`namespace_name="biblio-claw"` で十分、BQ 側で `component` 列 WHERE 絞り込み)
- multi-environment (dev/prod 分離) 対応 (現状 ハッカソン GCP 1 project のみ)

### 関連

- `terraform/m4-a-observability/{versions,providers,variables,main,outputs}.tf` (sink + dataset + IAM 宣言)
- `terraform/m4-a-observability/sql/summary.sql` (request_id 集計 SQL 雛形)
- `terraform/m4-a-observability/README.md` (Terraform dir ローカルの apply / clustering / teardown 詳細)

---

## M4-A Phase 4: verify-m4-a.sh 統合検証

### 概要

1 リクエストの観測経路全体 (test fixture span → Cloud Trace → BQ sink → summary SQL) を 1 コマンドで E2E 確認する。M4-A PRD の最終判定 + M4-B ADK 移行時の回帰検出基盤。

### Run

```bash
bash scripts/verify-m4-a.sh
```

所要時間 ~2-6 min (BQ 到達待ち = 通常 ~30s、最悪 5 min)。終了時に `M4-A PASS` が出れば exit 0。

### 必須 env

| 変数 | 例 | 用途 |
| :--- | :--- | :--- |
| `GCP_PROJECT_ID` | `hajimari-ai-hackathon-2026` | Cloud Trace + BQ query 対象 |
| `BQ_DATASET_ID` | `llm_observability` | sink 先 dataset (terraform default) |

`.env` 不在は warn 継続 (= GKE / CI 経路想定)。

### 設計判断 — 案 C 採用 (= TRACE_ID 個別マッチ諦め)

Phase 4 当初は「emit-test-span の TRACE_ID と BQ row を個別マッチ」設計だったが、PR #75 実機 verify で **host stdout は Cloud Logging に流れない = BQ sink に永久に届かない** plan 欠陥が判明 (= host = WSL 上に logging agent なし、sink filter は `k8s_container` 専用)。案 A (kubectl exec で orchestrator Pod 内で fixture 実行) / 案 B (Slack 経由 read-only action) は将来 phase で別途検討、Phase 4 では:

- **Section 4 (Cloud Trace)**: emit-test-span は host → 直接 OTLP HTTP export → Cloud Trace に到達するため **TRACE_ID 個別マッチを assert** (元設計通り)
- **Section 4.5 (CLI 経由 pre-invoke、issue #97 対応)**: `kubectl exec $POD -c orchestrator -- pnpm run chat "@bot 蔵書"` で ADK 経路の list_biblio (read-only) を deterministic に発火。M4-B Phase 3 で `provider='adk'` 分岐が delivery action handler (`biblio.*` event の唯一の発火点) を bypass するようになったため、time-window 型 assert である Section 5 を「直近 1h に Slack で誰かが叩いたかどうか」に依存させないための pre-invoke ステージ
- **Section 5-6 (BQ sink)**: TRACE_ID 個別マッチを諦め、**「過去 1h に GKE 起源の `biblio.%` / `adk.tool.%.invoke` event log が >= 1 件 BQ 到達」だけ assert** (= sink 疎通の証跡、M4-A Phase 3 deliverable の動作確認として value 十分、本番副作用なし)。ADK tool 側の event namespace 追加は issue #97 対応
- **Section 7 (静的反証)**: 動的ネガティブ対照は TRACE_ID 個別マッチ前提のため案 C ではスコープ外、sink filter の `k8s_container` + `namespace` 縛り保持の静的 grep + Section 5 BQ query filter に `biblio.%` / `adk.tool.%.invoke` 両方が pin されているかの静的 grep (Phase 間ドリフト再発防止、issue #97 対応)

### 内部フロー (7 セクション + Section 4.5 pre-invoke + Section 5.5 shape 確認)

1. **preflight** — `.env` 読み + 必須 env (`GCP_PROJECT_ID` / `BQ_DATASET_ID`) + CLI 存在 (gcloud / bq / jq / node)
2. **keyless 4 面** — `GOOGLE_APPLICATION_CREDENTIALS` 未設定 / ADC type が authorized_user|external_account|impersonated_service_account / repo 内に SA key json 不在 / TF に `google_service_account_key` resource 不在
3. **emit-test-span** — `OTEL_DIAG=true pnpm exec tsx --import ./src/instrumentation.ts scripts/emit-test-span.ts` 実行、stdout から `TRACE_ID` / `REQUEST_ID` / `SESSION_ID` 抽出 (`--import` は NodeSDK を main より前にロードする唯一の経路、`OTEL_DIAG=true` は OTLP export 失敗を stderr に流すための強制 diag)
4. **Cloud Trace poll** — `https://cloudtrace.googleapis.com/v1/projects/.../traces/<TRACE_ID>` を sleep 3 × 30 (90s) ポーリング、span >= 1 で break、root span 名 = `biblio.acquire` + `labels[biblio.request_id]` 一致を assert (= TRACE_ID 個別マッチ)
4.5. **CLI 経由 biblio activity pre-invoke** (issue #97 対応) — `kubectl exec $POD_PREINVOKE -c orchestrator -n $PREINVOKE_NAMESPACE -- pnpm run chat "@bot 蔵書"` で ADK 経路の list_biblio を発火 (read-only、副作用ゼロ)。`event: 'adk.tool.list.invoke'` が Cloud Logging に流れることで Section 5 の time-window 型 assert を deterministic 化する。pre-invoke 失敗は warn (fail ではない、Section 5 polling でリカバリ猶予)。Pod 名は verify-m4-b.sh の `VERIFY_M4B_ORCHESTRATOR_POD` と対称の `VERIFY_M4A_ORCHESTRATOR_POD` env で上書き可 (default = `biblio-orchestrator-0`、StatefulSet の pod 名決定則 `<sts-name>-<ordinal>`)、namespace は `VERIFY_M4A_NAMESPACE` env (default = `biblio-claw`)
5. **BQ sink 疎通確認** — `stdout` / `stderr` テーブル (= sink の `use_partitioned_tables=true` で生成される単独形、`timestamp` 列で DAY partition) を `bq ls` で動的列挙、各テーブルに `WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR) AND (jsonPayload.event LIKE 'biblio.%' OR jsonPayload.event LIKE 'adk.tool.%.invoke')` で sleep 10 × 6 (1 min) ポーリング、count >= 1 で break (= 過去 1h に biblio action 由来 log が sink 到達している証跡、ADK 経路の event namespace は issue #97 対応で追加)
5.5. **BQ sink trace 列 shape 確認** (issue #81 実機検証の後段証跡) — `stdout` + `stderr` UNION の trace 付き `biblio.%` OR `adk.tool.%.invoke` event 1 件を SELECT、`trace` 列が `projects/<PROJECT_ID>/traces/<32-hex>` 形式か assert。fail ではなく warn (regression の early warning、M4-A PASS 全体をブロックしない意図的判断)。BQ query 失敗は sentinel `BQ_SHAPE_QUERY_FAIL` で 0 件不在と区別 (Section 5 と同じ pattern、event 網羅も Section 5 と対称)
6. **summary SQL** — `sed` で `<PROJECT_ID>` / `<DATASET_ID>` を置換した `terraform/m4-a-observability/sql/summary.sql` を実行、`hit_count >= 1` + `marker = 'M4A_OK'` を assert
7. **静的反証** — `main.tf` の sink filter に `k8s_container` / `namespace_name=` の両方が残っていることを grep で確認 (= sink の責任範囲縛りが消失していないことの証跡) + Section 5 BQ query filter に `biblio.%` / `adk.tool.%.invoke` が両方 pin されているかを `$0` 自己参照 grep で確認 (Phase 間ドリフト再発防止、issue #97 対応)

### 既知の罠 / 解釈

- **Cloud Trace 90s timeout で偽 fail** — 多くは下記 2 つの原因。fail メッセージ内の "対処" 案内も同じ順で参照する:
  1. **`roles/cloudtrace.user` 不足** — 30 回 retry でほぼ全て 403 を返す。Section 4 の poll ループは attempt 3 で warn を 1 度出す設計
  2. **OTLP export 失敗** — `BatchSpanProcessor` が export エラーを内部 catch して `shutdownOtel()` が resolve する OTel SDK 仕様の限界。verify は `OTEL_DIAG=true` を emit-test-span に渡して export エラーを stderr に流し、`LAST_HARNESS_STDERR` 経由で fail 時に展開する
  3. それ以外: ネットワーク不調 / `BatchSpanProcessor` flush 遅延 — 再実行で多くは解決
- **Section 5 で「過去 1h に biblio.* / adk.tool.*.invoke event 0 件」fail** — 多くは下記 3 つ:
  1. **Section 4.5 pre-invoke が exit != 0 だった** — verify 出力の上流 warn を確認。ADK agent group 未初期化 (`kubectl exec $POD -c orchestrator -- pnpm exec tsx scripts/init-adk-agent.ts`) が典型
  2. **GKE orchestrator Pod が停止中** — `kubectl get pods -n biblio-claw` で確認
  3. **Cloud Logging → BQ export lag** (通常数秒-30s、稀に 1-2min) — 少し待って再実行 (`sleep 60 && bash scripts/verify-m4-a.sh`)
- **BQ poll の auth-fail early abort** — outer 反復 3 連続で全テーブル query 失敗時 (= persistent な auth 切れ / 権限不足 / SQL 型エラー / network 障害) は 1 min 待たず 30s で fail する設計。fail メッセージで `gcloud auth application-default print-access-token` と `roles/bigquery.dataViewer` 付与 + SQL 型エラーの可能性を案内
- **BQ poll の partition pruning** — verify は `WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)` で過去 1h に絞った partition のみ scan する設計 (sink の `use_partitioned_tables=true` で生成される DAY partition を効かせ、cost + 性能を担保)
- **`stdout` / `stderr` テーブル不在** — Phase 3 sink がまだ初動していない可能性。biblio action を 1 回実行して 5 分待ってから再実行 (= テーブルは sink が最初の log 流入時に自動生成、`terraform apply` 単独では作られない)
- **BQ スキーマ仕様** (PR #75 実機 verify で判明) — Cloud Logging → BQ export は以下のスキーマ:
  - **`trace` / `spanId` / `traceSampled`** はトップレベル STRING / STRING / BOOL カラム (= `WHERE trace = 'projects/PROJECT/traces/TRACE_ID'` で個別 trace 検索)
  - **`jsonPayload`** は RECORD (STRUCT) 型 → **ドット記法 `jsonPayload.event`** でアクセス、`JSON_VALUE(jsonPayload, ...)` は型エラーで失敗
- **冪等性** — 連続実行可。各実行で新規 trace_id を Cloud Trace に発射 (= 過去 30 日で別 trace として保持)、BQ sink 側は過去 1h 集計のため 1 件以上 hit 状態が続く限り PASS 継続

### test fixture (`scripts/emit-test-span.ts`)

`withBiblioActionSpan('acquire', requestId, sessionId, fn)` を直接呼ぶ test fixture。本番 `acquire()` ロジック (GitHub clone 等) は起こさない = 外部依存を Cloud Trace export 経路のみに絞り、verify を deterministic に保つ。span 属性は `biblio.request_id` / `biblio.session_id` / `biblio.action='acquire'` + `biblio.test_fixture=true` + event `verify-m4-a.fixture.emitted`。

**注**: 案 C 設計では fixture span は **Section 4 (Cloud Trace) でのみ assert** される。host stdout は Cloud Logging に流れないため Section 5 (BQ) には届かない (= sink filter は `k8s_container` 専用、host = WSL は対象外)。BQ 経路の E2E は GKE 上で稼働する本番 biblio action 由来の log で代替確認する。

### Teardown

verify は副作用なし (= shelf / DB / 既存リソース変更なし)。残存リソースは Cloud Trace span と BQ row のみで、Cloud Trace は 30 日 / BQ は dataset の `default_table_expiration_ms` (= 90 日) で自動失効。明示削除不要。

### 関連

- `scripts/verify-m4-a.sh` (本体)
- `scripts/emit-test-span.ts` (test fixture)
- `scripts/verify-m3-helpers.sh` (info/warn/fail 等 source 元)
- `terraform/m4-a-observability/sql/summary.sql` (summary SQL、`<PROJECT_ID>` / `<DATASET_ID>` placeholder)

---

## M4-B Phase 2: ADK orchestrator deploy + tool routing 拡張

### 概要

`@google/adk@1.3.0` + `@anthropic-ai/vertex-sdk@0.18.0` 経路の `AnthropicVertexLlm` を tool routing 対応 (= `config.tools` → `messages.create({tools})` 変換 / `tool_use` block → `functionCall` part 変換 / Schema UPPERCASE → JSON Schema lowercase + 数値メタフィールド coerce / `functionCall`・`functionResponse` part → Anthropic `tool_use`・`tool_result` block 変換) させ、`buildRootAgent` + `InMemoryRunner` 配下で **LLM 自律 tool 呼出 + multi-turn round-trip** を成立させる Phase。orchestrator + sidecar 3 種を `m4b-p2` tag に bump して GKE Autopilot `biblio-prod` に deploy する。

### Deploy 手順 (= 4 image atomic 反映)

```bash
# 1. dry-run で空打ち確認
bash scripts/init-project-gcp-image-sync.sh --tag m4b-p2-test --dry-run

# 2. 本番実行 (= 4 image build + AR push + manifest tag bump + kubectl apply + rollout)
bash scripts/init-project-gcp-image-sync.sh --tag m4b-p2-test --confirm

# 3. PR レビュー前に -test suffix を外して再 sync (= 確定 tag)
bash scripts/init-project-gcp-image-sync.sh --tag m4b-p2 --confirm
```

完了後、image tag は `k8s/10-orchestrator-statefulset.yaml` の 4 行 (135 / 153 / 231 / 277) に反映される (= Pod 内 `kubectl get pod biblio-orchestrator-0 -o jsonpath='{.spec.containers[*].image}'` で確認)。

### Verify 手順 (= GKE 経路 + 既存 chain regression)

```bash
# (a) GKE 上で ADK Runner hierarchy + tool routing 確認 (= Phase 2 完了判定)
bash scripts/verify-phase-2-adk-gke.sh
# 期待: 末尾に "M4-B Phase 2 PASS"、TOOL_CALLED=true + FINAL_TEXT 非空

# (b) 既存 GKE wiring regression (= 9 assertion)
bash scripts/verify-phase-2-wiring.sh

# (c) M4-A 観測経路 regression (= 7 セクション + Section 4.5 pre-invoke + Section 5.5 shape 確認、CLI pre-invoke で BQ sink 疎通を deterministic に確認 + 5.5 で trace 列 shape の regression 検知)
bash scripts/verify-m4-a.sh

# (d) ローカル経路 regression (= M2 / M3 完成判定)
bash scripts/verify-m2.sh example-org/test-biblio-minimal
bash scripts/verify-m3.sh
```

### Local 経路 verify (= TOOL_CALLED=true 遷移確認)

```bash
# 前提: ANTHROPIC_VERTEX_PROJECT_ID 設定 + ADC 済 + scripts/onecli-gh-secret.sh 投入済
set -a; . .env; set +a
export NO_PROXY="aiplatform.googleapis.com,${NO_PROXY:-}"
pnpm exec tsx --import ./src/instrumentation.ts scripts/verify-phase-1-adk-local.ts
# 期待: TOOL_CALLED=true / EVENT_COUNT>=3 / FINAL_TEXT 非空 ("仕入れ完了" 等の司書日本語応答)
```

### Cloud Trace 観察ガイド (= 任意観察、Phase 2 PASS 条件外)

Cloud Trace UI で TRACE_ID を検索すると ADK span hierarchy と M4-A 計装 span が同一 trace で串刺し:

```
invocation (ADK root)
 └─ invoke_agent biblio_root_agent
     ├─ call_llm
     │   └─ chat claude-sonnet-4-6  (= M4-A 計装、gen_ai.provider.name='gcp.vertex_ai')
     └─ execute_tool acquire_biblio  (= ADK 自動 span)
```

### 既知の罠 / gotcha

- **`HTTPS_PROXY` が `aiplatform.googleapis.com` に乗ると keyless ADC が壊れる経路あり** — local verify で `NO_PROXY=aiplatform.googleapis.com` を入れる (= OneCLI proxy 経由は `api.github.com` のみ通すように制限)
- **scripts/verify-phase-1-adk-local.ts は dist に含まれない** — GKE 経路 verify では tsx で実行する (`pnpm exec tsx --import ./src/instrumentation.ts scripts/verify-phase-1-adk-local.ts`)。`verify-phase-2-adk-gke.sh` は tsx 経路で固定済
- **ADK の `simple_zod_to_json.ts` が `minLength` / `maxLength` を string で出力する bug** — `schema-conversion.ts:normalizeSchema` で `Number()` coerce する経路を実装済 (= Anthropic API の draft 2020-12 validator が `tools.N.custom.input_schema: JSON schema is invalid` で 400 reject するのを防ぐ)
- **`verify-phase-1-adk-local.ts` の `TRACE_ID=undefined`** — verify script の `trace.getActiveSpan()` が ADK runner 配下の active span を取得できない (= active span getter の経路不一致、Phase 2 PASS 条件外)。Cloud Trace UI で TRACE_ID 観察は別経路 (= GCP 上の log entry から trace_id を逆引き)
- **multi-turn round-trip が成立しないとき LLM 無限ループ retry** — `convertContentsToAnthropicMessages` で `functionResponse` part を `tool_result` block に変換する経路が必須 (= Phase 2 で実装済、unit test で固定)。これがないと LLM は前回 tool 結果を読まずに同じ tool を呼び続ける

### 関連

- `src/adk/AnthropicVertexLlm.ts` (= tool routing + tool_use / tool_result 変換)
- `src/adk/schema-conversion.ts` (= normalizeSchema / toAnthropicTools)
- `scripts/verify-phase-1-adk-local.ts` (= local 経路 verify)
- `scripts/verify-phase-2-adk-gke.sh` (= GKE 経路 verify)
- `scripts/init-project-gcp-image-sync.sh` (= 4 image atomic 反映)

---

## M4-B Phase 3: slack-e2e + verify-m4-b (CLI 経由 verify + Slack 経路温存)

### 概要

`router.ts:deliverToAgent` に `container_configs.provider === 'adk'` 分岐を追加し、orchestrator 内 in-process ADK Runner (`src/adk/dispatcher.ts`) に patron 命令 (CLI or Slack) を直接流す。**agent-runner container 経路 (= K8s Job spawn) を経由しない**。channel adapter agnostic な dispatcher が `channelType` を parameter で受け、`getChannelAdapter(...).deliver(...)` で patron に応答返却する。

`inspect-tool.ts` に `BIBLIO_NAME_RE` guard を追加 (path-traversal 防御、Phase 3 で CLI/Slack 経由 LLM 自律呼出が本番化した以降の攻撃面閉塞)。

verify は **CLI channel (`pnpm run chat`) 経由で完結** させ、Slack workspace 設定 (channel 作成 / bot 招待 / user token scope) を Phase 3 完成判定から除外。Slack 経路は `init-adk-agent.ts` の optional flag (env `SLACK_WIRE_CHANNEL_ID`) で wire 可能状態まで整備し、実 Slack channel wire は Phase 3 完了後の DEN さん任意操作 (= プレゼン素材録画用の手動デモ経路) として温存。

### Deploy 手順 (= orchestrator only、sidecar 無改変)

```bash
# 1. dry-run で空打ち確認
bash scripts/init-project-gcp-image-sync.sh --tag m4b-p3 --dry-run

# 2. 本番実行 (= 4 image build + AR push + manifest tag bump + kubectl apply + rollout)
bash scripts/init-project-gcp-image-sync.sh --tag m4b-p3 --confirm

# 3. Pod 実 image tag 確認
kubectl get pod biblio-orchestrator-0 -c orchestrator -n biblio-claw \
  -o jsonpath='{.spec.containers[?(@.name=="orchestrator")].image}'
# 期待: ...biblio-claw:m4b-p3
```

`k8s/10-orchestrator-statefulset.yaml` の image tag は **4 箇所全て** (orchestrator container `image` (line 135) + agent container の `CONTAINER_IMAGE` env (line 153) + `gh-token-rotator` sidecar `image` (line 231) + `vertex-token-rotator` sidecar `image` (line 277)) を `m4b-p3` に更新される。`init-project-gcp-image-sync.sh` が 4 image を単一 `--tag` で一括 build/push + manifest 同期する仕様のため、sidecar 2 image (biblio-sidecar-gh / biblio-sidecar-vertex) の実装内容自体に Phase 3 の変更はないが、tag はまとめて bump される (= sidecar image が `m4b-p2` タグのまま残ることはない、`m4b-p3` タグが Artifact Registry に build/push 済)。

### ADK agent group + CLI channel wire (deploy 後 1 回)

```bash
# Pod 内で init-adk-agent.ts を実行 (= ADK agent group を central DB に upsert + CLI 自動 wire)
kubectl exec biblio-orchestrator-0 -c orchestrator -n biblio-claw -- \
  pnpm exec tsx scripts/init-adk-agent.ts

# 期待: container_configs.provider='adk' が central DB に登録される
kubectl exec biblio-orchestrator-0 -c orchestrator -n biblio-claw -- \
  pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT ag.id, cc.provider, mg.channel_type, mg.platform_id FROM agent_groups ag \
   JOIN container_configs cc ON ag.id = cc.agent_group_id \
   JOIN messaging_group_agents mga ON ag.id = mga.agent_group_id \
   JOIN messaging_groups mg ON mga.messaging_group_id = mg.id \
   WHERE cc.provider='adk'"
# 期待: 1 行 (ag-... / adk / cli / local)
```

冪等 — 既存 ADK agent group がある場合は再作成せず reuse する。

### Verify 手順 (= Phase 3 完成判定、CLI 経由)

**(Phase 4 で 9 section に拡張済、詳細は §M4-B Phase 4 参照)**

```bash
# (a) Phase 3 完成判定 (= M4-B PASS marker、Phase 3 時点は 7 section、Phase 4 で 9 section 化 + 冪等)
bash scripts/verify-m4-b.sh
# 期待: 末尾に "M4-B PASS"、exit 0

# (b) 2 連続実行冪等 (副作用は draft PR + dummy pending row のみ = 毎回別 branch + cleanup で無害)
bash scripts/verify-m4-b.sh && bash scripts/verify-m4-b.sh
# 期待: 両方 M4-B PASS + exit 0

# (c) 既存 regression chain
bash scripts/verify-phase-2-adk-gke.sh   # M4-B Phase 2 継続 PASS
bash scripts/verify-m4-a.sh              # M4-A 観測経路 継続 PASS
bash scripts/verify-m3.sh                # M3 装備機構 継続 PASS

# (d) opt-in で verify-slack-e2e-gke.sh を verify-m4-b.sh Section 7 に組み込む
VERIFY_M4B_INCLUDE_REGRESSION=1 bash scripts/verify-m4-b.sh
```

所要時間: `verify-m4-b.sh` 単体 ~5-10 分 (LLM 応答 8-15s + Cloud Trace 到達 30-90s)。

### CLI 経由 patron 命令のテスト手順 (DEN さん手動確認用)

```bash
# 前提: init-adk-agent.ts 済 + m4b-p3 image deploy 済
kubectl exec biblio-orchestrator-0 -c orchestrator -n biblio-claw -- \
  sh -c "cd /app && pnpm run chat '@bot 仕入れて example-org/test-biblio-minimal'"
# 期待: LLM が acquire_biblio を呼び、日本語で「仕入れ完了です!📦」等の応答を返す
#       (SILENCE_MS=2000ms で自然終了、120s HARD_TIMEOUT)
```

`pnpm run chat` は `data/cli.sock` (Unix socket) 経由で router.ts に inbound event を投げる。router が provider='adk' を検知 → dispatcher が in-process ADK Runner を呼ぶ経路。

### ADK 用 Slack channel wire 手順 (プレゼン用手動デモ、Phase 3 完了後の任意作業)

Phase 3 完成判定 (verify-m4-b.sh PASS) には含めない DEN さん任意操作:

```bash
# 1. Slack App 側で channel 作成 + Bot 招待 (Workspace UI 操作)
#    - channel 名: 任意 (例: #biblio-adk-demo)
#    - Bot user に channel:write scope 付与済であること (既存の Slack app 設定を継承)

# 2. Pod 内で init-adk-agent.ts を env 指定で再実行 (= Slack channel wire 追加)
kubectl exec biblio-orchestrator-0 -c orchestrator -n biblio-claw -- \
  sh -c "SLACK_WIRE_CHANNEL_ID='C0XXXXXX' pnpm exec tsx scripts/init-adk-agent.ts"

# 3. Slack で `@bot 仕入れて example-org/test-biblio-minimal` 打鍵 → 応答確認
```

wire 済 Slack channel での応答は `dispatchToAdk` が `getChannelAdapter('slack').deliver(...)` を呼ぶ経路で自動的に配信される (= CLI 経路と code path 同一)。

### Cloud Trace 観察ガイド

`verify-m4-b.sh` Section 5-6 で自動確認しているが、UI 目視でも観察できる。実 GKE verify (M4-B PASS 取得時、~20 spans/trace) で観測された top-level span 群:

```
call_llm                          (= ADK 1.3.0 自動 span、gen_ai.operation.name=invoke_agent 付き)
chat claude-sonnet-4-6            (= AnthropicVertexLlm 自前 span、gen_ai.* 完全 set + usage 付き)
execute_tool acquire_biblio       (= ADK 1.3.0 自動 span)
GET / POST / tcp.connect × 多数   (= undici HTTP client の自動計装、acquire の GH API 呼出)
```

**invoke_agent (named span) は ADK 1.3.0 InMemoryRunner では立たない** — plan 起草時の adk-js docs 想定と異なり、`call_llm` が top-level に位置する。`gen_ai.operation.name=invoke_agent` は `call_llm` span の label として付与される (span 名ではない)。verify-m4-b.sh Section 5 の assertion は `execute_tool acquire_biblio` + `chat claude-*` の 2 種存在で判定する形にしてある。

**`gen_ai.*` 完全 set (provider.name / request.model / usage.input_tokens / usage.output_tokens 等) を持つのは AnthropicVertexLlm 自前 span (`chat claude-*`) のみ** — ADK 内部 span (`invoke_agent` / `call_llm` / `execute_tool`) にも `gen_ai.operation.name` は付くが、provider/model/usage は付かない。Section 6 の assertion は `.name | startswith("chat ")` で明示的に狙う。

Cloud Trace UI で trace_id 検索:

```
https://console.cloud.google.com/traces/list?tid=<TRACE_ID>&project=hajimari-ai-hackathon-2026
```

trace_id は Pod ログの JSON structured log の `logging.googleapis.com/trace` field (bare 32hex、`projects/.../traces/` prefix なし) から拾える。**単純に `tail -n1` で拾うと rotator sidecar の trace_id を掴む race がある**ため、`event=adk.tool.acquire.invoke` / `event=adk.anthropic_vertex_llm.init` 等の ADK 経路 event に絞って抽出する (`verify-m4-b.sh` Section 5 参照):

```bash
kubectl logs biblio-orchestrator-0 -c orchestrator --since=3m \
  | grep '"event":"adk.tool.acquire.invoke"' \
  | grep -oE '"logging\.googleapis\.com/trace":"[a-f0-9]{32}"' \
  | tail -n1
```

### 既知の罠 / gotcha (5 件)

- **`HTTPS_PROXY` が `aiplatform.googleapis.com` に乗ると keyless ADC が壊れる** — Phase 2 と共通。local verify では `NO_PROXY=aiplatform.googleapis.com` を入れる。GKE 経路では manifest env で NO_PROXY を明示済のため通常発火しないが、agent Pod 再構築時等に env drift すると発症する
- **`InMemoryRunner` module-level singleton は Pod 再起動でロスト** — Phase 3 時点は `runEphemeral` が都度 ephemeral session を作る仕様で session 永続化なし = 無害。**(Phase 4 で状況変化)** HITL 承認 (enkin/shokyaku) の pause/resume に session 保持が必要になったため、Phase 4 で `sessionService.createSession + runner.runAsync + 明示 deleteSession` に切替済。Pod 再起動時は pause 中の全 ADK session が消失し、`resolveAdkApproval` が失効通知を patron に deliver する経路が実装されている (詳細は §M4-B Phase 4 §Pod 再起動時の対処 参照)
- **`pnpm run chat` の TOTAL_TIMEOUT_MS=120s を超える LLM 応答は verify-m4-b.sh Section 4 fail** — Phase 2 実測で 8-15s、120s 内に余裕あり。超過時は Vertex 負荷 or ADK Runner ハング疑い → Pod ログ (`kubectl logs biblio-orchestrator-0 -c orchestrator --since=5m`) で `adk.dispatcher.invoke` event 以降の trace を確認
- **verify-slack-e2e-gke.sh と verify-m4-b.sh は別 channel を対象** — 誤って同じ agent_group を両経路で使うと race。運用上は claude CLI 経路 agent group と ADK 経路 agent group を **別 folder** (= 別 agent_group_id) で分離する (init-cli-agent.ts vs init-adk-agent.ts の folder 引数が別値になっている前提)
- **inspect-tool.ts guard の REJECT + schema_invalid は LLM 応答経路で正しく伝わる** — silent failure ではない。LLM は tool 応答の `verdict=REJECT + reason=schema_invalid + detail=...` を受けて patron に理由 (例: "検品で REJECT: biblioName の形式が不正です") を伝達する。structured log `adk.tool.inspect.schema_invalid` が warn として出力される (Cloud Logging で filterable)

### GKE 実機 verify で判明した罠 (8 件)

M4-B PASS 取得 (2026-07-01、PR #101) 時、`verify-m4-b.sh` 初回実装から実 GKE でしか判明しない不具合が 8 件発見された。同 verify script + Cloud Trace API の後続利用時のリファレンスとして残す (fix commit `44a66ba`)。

- **`kubectl get pod -c orchestrator` の `-c` は `get` で効かない** — `-c` は `exec` / `logs` 専用の container 指定。`get` に渡すと silent に無視されて `.spec.containers[*].image` 相当が空になる。正しくは jsonpath 側で container 名を絞る (`{.spec.containers[?(@.name=="orchestrator")].image}`)。同様に `kubectl exec` / `kubectl logs` の `-c` は valid なので混同しない
- **`scripts/q.ts data/v2.db` (相対パス) は GKE 経路で ENOENT** — orchestrator container の Dockerfile WORKDIR は `/app`、相対 `data/v2.db` は `/app/data/v2.db` に解決される。しかし GKE では PVC mount で `/data/v2.db` (`DATA_DIR=/data` env) が実体。**q.ts / init-adk-agent.ts 等の Pod 内 DB 直叩き script は必ず絶対パス `/data/v2.db` で叩く**
- **trace_id は `logging.googleapis.com/trace` field に bare 32hex で出る** — `projects/<PROJECT>/traces/<32hex>` 形式ではない。biblio-claw の `trace-fields.ts` が bare 32hex で出力し、Cloud Logging 側で GCP 標準形式に自動昇格される (Preferred Format、実機検証 2026-07-03 / issue #81 で "View trace" リンク動作確認済、詳細 §M4-A Phase 2 log↔trace 連携)。正規表現で拾うときは `"logging\.googleapis\.com/trace":"[a-f0-9]{32}"` を狙う
- **Pod ログの単純 `tail -n1` は rotator sidecar の trace_id を掴む race** — gh-token-rotator / vertex-token-rotator が周期的に独自の trace を発火するため、Section 4 の chat 実行に対応する trace を狙いたい場合は `event=adk.tool.acquire.invoke` (実 acquire 経由) や `event=adk.anthropic_vertex_llm.init` (LLM 呼出、active span 配下確定) 等の ADK 経路 event に必ず絞る
- **ADK 1.3.0 に `invoke_agent` named span は存在しない** — `call_llm` が top-level に立つ。plan 起草時の adk-js docs 想定と乖離。`invoke_agent` は `call_llm` span の `gen_ai.operation.name` label としてのみ観測される。Cloud Trace assertion は `execute_tool acquire_biblio` + `chat claude-*` の 2 種で判定するのが実装挙動と一致
- **`gen_ai.*` 完全 set (provider / model / usage) は AnthropicVertexLlm 自前 span のみ** — ADK 内部 span (`invoke_agent` / `call_llm` / `execute_tool`) にも `gen_ai.operation.name` は付くが `provider.name` / `request.model` / `usage.*` は不在。「`gen_ai.*` を持つ最初の span」で filter すると ADK 内部 span が先に当たって assertion が壊れる。`.name | startswith("chat ")` で明示的に AnthropicVertexLlm 自前 span を狙う
- **`jq ... | head -n1` は `set -o pipefail` の下で exit 141 = SIGPIPE** — head が先に close して jq が SIGPIPE 受けると全体が非ゼロ終了、script が silent に途中終了する。jq 側で slice する (`[.spans[] | select(...)] | .[0] // empty`) 経路に統一。同様の pattern は他 verify script (verify-m4-a.sh 等) でも要注意
- **BatchSpanProcessor 非同期 export で「spans >= 1」の retry break は早すぎる** — Cloud Trace への span export は非同期で、初回到達時点では HTTP client (undici) の span のみで ADK / AnthropicVertexLlm span がまだ到達していないことがある。verify-m4-b.sh は break 条件を「`execute_tool acquire_biblio` + `chat claude-*` の 2 種が両方存在するまで retry (最大 90s)」に変更した

### 症状: Pod 長時間稼働後 OTLP export が失敗 (真因は issue #104 で解消済)

Pod 稼働 ~1.5 時間以上経過後、Cloud Trace への OTLP export が継続的に失敗し始める現象。**issue #104 で真の root cause を特定 + fix 済** (旧記述の「BatchSpanProcessor 経路の Premature close 由来」は誤診だった)。

**真の root cause (issue #104)**:

- `src/observability/otel.ts` (旧 line 83-110) + `container/agent-runner/src/observability/otel-init.ts` (旧 line 47-64) の `startHeaderRefresh` — 60s タイマーで `exporter._headers.Authorization` を書き換える hack が、**`@opentelemetry/otlp-exporter-base@0.219.0` で silent no-op** に退化していた (`_headers` field が同 SDK build source に 0 hit)
- 結果として Authorization ヘッダは `startOtel()` 実行時の初回 Bearer token に**プロセス生存中ずっと固定**され、GCP access token TTL (~1h) 経過後は 401 で全 span が drop される
- BatchSpanProcessor は export 失敗時に batch を再キュー化しないため、drop は不可逆 (`export/BatchSpanProcessorBase.js:140-150`)
- `OTEL_DIAG` 未設定 (本番マニフェスト既定) では完全に無音で drop する

**Premature close は無関係な副次現象**:

- Pod ログの `K8s informer error, restarting` + `Premature close` (`node-fetch/lib/index.js:1748`) は **`@kubernetes/client-node@1.4.0` の watch stream 経路** 由来で、5s backoff で自動復旧する既存挙動 = OTLP export 経路とは別スタック
- スタックトレースに `@opentelemetry/context-async-hooks/AbstractAsyncHooksContextManager.js:35` が混入するのは、`AsyncLocalStorageContextManager` がプロセス全体で `EventEmitter.prototype` を patch しているため = OTLP export の関与を意味するシグナルではない

**Fix (issue #104)**:

- host / agent 両ファイルの `OTLPTraceExporter` に **`HeadersFactory` (= `() => Promise<Record<string, string>>`)** を渡す方式に切替。`@opentelemetry/otlp-exporter-base@0.219.0` の `OTLPExporterConfigBase.headers` が `Record | HeadersFactory` の union を公式サポートしており、SDK 内部の `HttpExporterTransport.send` が毎リクエスト `await this._parameters.headers()` で fresh 値を取得する
- `_headers` hack / 60s タイマー / `headerRefreshSkipCount` warn 経路は全削除。`getCachedToken()` (auth.ts の 45min refresh loop で更新) が毎リクエスト評価されるため、token refresh が exporter に自動反映される
- 静的 object を渡す実装に revert しないこと (grep 検知: `Authorization: \`Bearer \${initialToken}\`` は絶対 anti-pattern)。unit test (`src/observability/__tests__/otel.test.ts` + `auth.test.ts`) で HeadersFactory 契約を固定済

**歴史的な対症手順** (fix 前に運用していたもの、fix 後は不要):

```bash
# fix 前は Pod 再起動で ~1.5h 分の稼働を延命していた。fix 後は数十時間の長期稼働でも
# 401 drop は発生しない。以下のコマンドは historical 記録として残す。
# kubectl delete pod biblio-orchestrator-0 -n biblio-claw
# kubectl wait --for=condition=Ready pod/biblio-orchestrator-0 -n biblio-claw --timeout=300s
```

**fix 後の確認手順**:

```bash
# 1. Pod ログで token refresh が 45min 毎に走ることを確認
kubectl logs biblio-orchestrator-0 -c orchestrator -n biblio-claw --since=3h | grep 'Bearer token refreshed'

# 2. Pod ログで otel.header_refresh.skipped warn が 0 件 (関数削除により発火不能) を確認
kubectl logs biblio-orchestrator-0 -c orchestrator -n biblio-claw --since=3h | grep 'otel.header_refresh'
# → 0 hit

# 3. Pod を 2h+ 稼働させた状態で verify-m4-b.sh が引き続き PASS を取ることを確認
bash scripts/verify-m4-b.sh
```

**注意**:

- 稼働中の in-process ADK Runner セッション (`getSharedRunner()` の singleton) は Pod 再起動でリセットされるが、fix 後は再起動そのものが不要になった
- Premature close (K8s Informer) は本 fix 後も継続する既存挙動 = 実害なし、`kubectl logs` grep 時に見えても混同しないこと

### 関連

- `src/adk/dispatcher.ts` (= channel adapter agnostic dispatcher、event stream → deliver)
- `src/adk/dispatcher.test.ts` (= 10 case、mock runner + adapter で網羅)
- `src/router.ts:deliverToAgent` (= provider 分岐、~397 行)
- `src/adk/tools/inspect-tool.ts` (= BIBLIO_NAME_RE guard、Phase 3 で追加)
- `scripts/init-adk-agent.ts` (= ADK 用 agent group + CLI 自動 wire + Slack optional wire)
- `scripts/verify-m4-b.sh` (= 7 section、CLI 経由 E2E、M4-B PASS marker。**Phase 4 で 9 section 拡張済 = Section 4.5 拡張 tool smoke + Section 6.5 HITL flow smoke を追加、詳細は §M4-B Phase 4 参照**)

---

## M4-B Phase 4: remaining-host-actions + HITL 統合 (9 tool + 承認カード)

### 概要

Phase 3 で確立した ADK Runner 経路 (root `LlmAgent` + 3 FunctionTool) に、**残 host action 6 tool** を追加して 9 tool 化 + **破壊操作の HITL 承認機構** を統合する:

- **追加 tool (6 種)**:
  - `categorize_biblio` (Vertex × Anthropic による 4 namespace 分類)
  - `list_biblio` (棚 marketplace.json からの蔵書一覧、category filter)
  - `shelve_biblio_multi` (複数 skill を複数 category 跨ぎで 1 PR に陳列、原子性維持)
  - `update_config` (`ACQUIRE_SKILL_THRESHOLD` allowlist 動的変更)
  - `enkin_biblio` (禁書 = 棚除去 + 装備源残置、**admin 承認必須**)
  - `shokyaku_biblio` (焼却 = 棚除去 + 装備源物理削除、**admin 承認必須**、再装備不可)

- **HITL 統合**: adk-js@1.3.0 `Context.requestConfirmation` API を活用し、破壊 tool 呼出時に **runner が自動 pause**。dispatcher (`src/adk/dispatcher.ts`) が `event.longRunningToolIds` を検知して `requestAdkApproval` を発火、既存 delivery adapter 経由で **Slack DM Approve/Reject カード**を admin に配信。admin 押下 → `response-handler.ts` の `adk_confirm` 分岐 → `resolveAdkApproval` (`src/adk/approval-dispatcher.ts`) → 同 sessionId で `runner.runAsync` 再呼出 → tool.execute 再実行の pause/resume パターン。

- **dispatcher 経路の切替**: Phase 3 の `runEphemeral` (= ephemeral session 使い捨て) を **`sessionService.createSession + runner.runAsync + 明示 deleteSession`** に切替 (HITL pause で session 保持が必要になったため)。通常経路は最後に `deleteSession`、pending 経路は resume 側 (approval-dispatcher.ts) が cleanup する分業。

### HITL 承認 flow の全体図

```
patron 「@bot 禁書 wf--test biblio-dev」
   ↓ (Slack / CLI channel adapter)
router.ts:deliverToAgent (provider='adk' 分岐)
   ↓
dispatcher.ts:dispatchToAdk
   sessionService.createSession → runner.runAsync
   ↓
LLM (Claude Sonnet 4.6 on Vertex) が enkin_biblio 自律呼出
   ↓
enkin-tool.ts:execute (初回 = toolConfirmation 不在)
   → tool_context.requestConfirmation({hint, payload: {biblioName, category, action: 'enkin'}})
   ↓
ADK runner が event に longRunningToolIds + requestedToolConfirmations を populate
   ↓
dispatcher.ts が event.longRunningToolIds 検知
   → requestAdkApproval({...}) 呼出
      (session 保持、deleteSession skip、break で event stream 消費打切り)
   → patron に中間応答「承認を admin にお願いしました」deliver
   ↓
adk-approvals.ts:requestAdkApproval
   pickApprover(agentGroupId) → pickApprovalDelivery(approvers, channelType)
   → chat-sdk bridge で ask_question card を admin DM (Slack) に配信
   → createPendingApproval({session_id: null, action: 'adk_confirm', payload})
   ↓
[待機: admin 操作待ち = 数秒〜数分]
   ↓
admin が Slack DM で ✅ Approve or ❌ Reject 押下
   ↓
response-handler.ts:handleApprovalsResponse
   getPendingApproval → action='adk_confirm' 分岐
   → resolveAdkApproval(payload, selectedOption)
   ↓
approval-dispatcher.ts:resolveAdkApproval
   sessionService.getSession (Pod 再起動なら undefined → patron に「失効」通知)
   → runner.runAsync({sessionId, newMessage: functionResponse(confirmed)})
   ↓
enkin-tool.ts:execute (resume = toolConfirmation.confirmed で分岐)
   → confirmed=true: 実 enkin() 呼出 (Git Data API で削除 PR 作成)
   → confirmed=false: {ok: false, reason: 'config_error', detail: 'admin 拒否'} return
   ↓
LLM が結果を日本語整形
   → adapter.deliver で patron に最終応答
   → sessionService.deleteSession で session cleanup
```

### Deploy 手順 (= orchestrator only、sidecar 無改変)

```bash
# 1. dry-run で空打ち確認
bash scripts/init-project-gcp-image-sync.sh --tag m4b-p4 --dry-run

# 2. 本番実行 (= 4 image build + AR push + manifest tag bump + kubectl apply + rollout)
bash scripts/init-project-gcp-image-sync.sh --tag m4b-p4 --confirm

# 3. Pod 実 image tag 確認
kubectl get pod biblio-orchestrator-0 -c orchestrator -n biblio-claw \
  -o jsonpath='{.spec.containers[?(@.name=="orchestrator")].image}'
# 期待: ...biblio-claw:m4b-p4
```

Phase 3 と同流儀で 4 image (orchestrator + agent + gh-token-rotator + vertex-token-rotator) を単一 `--tag` で一括更新。sidecar 2 image の実装は無変更だが tag はまとめて bump される。

### Verify 手順 (= Phase 4 完成判定、CLI 経由)

Phase 3 の `verify-m4-b.sh` を 7 section → 9 section に拡張:

- **Section 4.5**: 拡張 tool smoke (`list_biblio` + `update_config` を chat 経由発火して stdout 検証)
- **Section 6.5**: HITL flow smoke (`enkin` を dummy biblio 名で発火 → dispatcher の pending 経路 event 発火 + `pending_approvals` row 作成の 2 point を assert + cleanup DELETE)

```bash
# 1. deploy 済 (m4b-p4 tag) 前提で verify 実行
bash scripts/verify-m4-b.sh

# 期待: 全 9 section 通過 + 末尾に "M4-B PASS" 出力 + exit 0
# 2 連続実行で両方 exit 0 (= 冪等、副作用は draft PR + dummy pending row のみ = 毎回別 branch or cleanup)
bash scripts/verify-m4-b.sh  # 2 回目 = 同 PASS
```

**必須 env**: `GCP_PROJECT_ID` / `BQ_DATASET_ID` (Phase 3 と同じ)。
**任意 env**: `VERIFY_M4B_BIBLIO` (acquire 対象 repo)、`VERIFY_M4B_INCLUDE_REGRESSION=1` (Section 7 有効化)。

### Pod 再起動 / admin 未応答時の対処 (issue #106 で自動化)

`InMemorySessionService` は Pod 内メモリ保持のため、**Pod 再起動時に pause 中の全 ADK session が消失**する。既に Slack DM に配信済の pending_approvals row から admin が承認カードを押下しても、`resolveAdkApproval` が `sessionService.getSession(...)` で `undefined` を検知して patron に「Pod 再起動により承認セッションが失効しました。もう一度 tool 呼出をお願いします。」通知を deliver する (= silent 失敗しない)。

**通常の admin 未応答 (無反応で放置) 時のタイムアウト** も issue #106 で自動化済:

- **Layer 1 (expires_at 設定)**: `pending_approvals.expires_at = now + 30 min` を書き込む (`src/modules/approvals/adk-approvals.ts` の Layer 1)。env `ADK_APPROVAL_TIMEOUT_MS` (単位 ms) で override 可能 (= 短縮 verify や運用短縮に活用)
- **Layer 2 (setTimeout expiry)**: 呼出時に `setTimeout` で expiry timer を仕込み、時間切れで `expireAdkApproval` が「row status='expired' + Slack card 'Expired (no response)' 化 + patron に「承認がタイムアウトしました」通知 + `sessionService.deleteSession` (session leak 解消) + row 削除」を実行
- **Layer 3 (起動時 sweep)**: `startAdkApprovalHandler` が `onDeliveryAdapterReady` で発火し、Pod 再起動で残った stale row を「Expired (host restarted)」で edit + patron 通知 + row 削除で cleanup (= sessionService は Pod 再起動後空なので `deleteSession` は skip)

Admin が timer 発火直前に応答したケースは `response-handler.ts:adk_confirm` 分岐冒頭で `clearAdkApprovalTimer(approvalId)` を呼び、二重処理を防ぐ。

通常は手動介入不要。**緊急時のフォールバック** (sweep 失敗 / hook 未配線での起動失敗 / stale row の手動確認) として下記の手動 SQL 手順を保持する:

```bash
# 停留している adk_confirm row の一覧
kubectl exec biblio-orchestrator-0 -c orchestrator -n biblio-claw -- \
  pnpm exec tsx scripts/q.ts /data/v2.db \
  "SELECT approval_id, agent_group_id, title, created_at, expires_at, status FROM pending_approvals WHERE action='adk_confirm'"

# 全削除 (= Pod 再起動後は resume できないため無効化)
kubectl exec biblio-orchestrator-0 -c orchestrator -n biblio-claw -- \
  pnpm exec tsx scripts/q.ts /data/v2.db \
  "DELETE FROM pending_approvals WHERE action='adk_confirm' AND status='pending'"
```

**タイムアウト値の短縮 (verify / demo 用)**:

```bash
# StatefulSet env で override (30 秒に短縮する例)
kubectl set env statefulset/biblio-orchestrator -n biblio-claw ADK_APPROVAL_TIMEOUT_MS=30000
# 元に戻す (= env 削除で default 30 min)
kubectl set env statefulset/biblio-orchestrator -n biblio-claw ADK_APPROVAL_TIMEOUT_MS-
```

### issue #106 の実機検証手順 (DEN さん実施)

Layer 1 (`expires_at` Set) は `scripts/verify-m4-b.sh` Section 6.5 の追加 assertion (`expires_at IS NULL` の count=0 を要求) で自動確認できるため、GKE 経路の re-deploy 後に `bash scripts/verify-m4-b.sh` を回せば実装の生死は即判定される。**Layer 2 (実 timer 発火) と Layer 3 (Pod 再起動 sweep) は実 HITL 操作 + Pod ライフサイクル操作を伴うため verify script に組み込まず、以下の 4 case を手動で確認する**。

#### Case L2-Local: Local docker compose で timer expire → patron タイムアウト通知

**目的**: Layer 2 (`setTimeout` + `expireAdkApproval`) が local docker compose 経路で成立することを確認。

**前提**: `docker compose up -d --wait` が済んでいる + `.env` に Slack workspace (biblio-local) の bot token 投入済 + admin ユーザ (DEN さんの biblio-local user) の Slack DM 経路が wire 済。

**操作**:

1. **`.env` に `ADK_APPROVAL_TIMEOUT_MS=30000` (= 30 秒) を追加**:
   ```bash
   grep -q '^ADK_APPROVAL_TIMEOUT_MS=' .env && sed -i.bak 's/^ADK_APPROVAL_TIMEOUT_MS=.*/ADK_APPROVAL_TIMEOUT_MS=30000/' .env && rm -f .env.bak || echo 'ADK_APPROVAL_TIMEOUT_MS=30000' >> .env
   ```
2. **host を再起動して env を反映**:
   ```bash
   # macOS
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw
   # Linux
   # systemctl --user restart nanoclaw
   ```
3. **Slack biblio-local workspace の biblio bot に DM で `@bot 禁書 wf/dummy-nonexistent-biblio biblio-dev` を送る**。
4. **Slack DM (admin=DEN さんの biblio-local user) にカード配信されるので、あえて何も押さず 40 秒待つ**。

**期待結果**:
- Slack カード本文が **"Expired (no response)"** に自動 edit される (~30 秒後)
- 元 patron (Slack 発話元) に **「承認がタイムアウトしました。もう一度お試しください。」** の日本語通知が届く
- host ログ (`logs/nanoclaw.log`) に `"event":"adk.approval.expired","approval_id":...,"reason":"no response"` の 1 行が出る
- DB row 消滅を SQL で確認:
  ```bash
  pnpm exec tsx scripts/q.ts data/v2.db \
    "SELECT COUNT(*) FROM pending_approvals WHERE action='adk_confirm' AND payload LIKE '%dummy-nonexistent%'"
  # 期待: 0
  ```

**判定**: 上記 4 point すべて OK → **Layer 2 (local) PASS**。1 つでも欠けたら fail。

**cleanup**: `.env` から `ADK_APPROVAL_TIMEOUT_MS=30000` 行を削除 (or `=1800000` にリセット) → host 再起動で default 30 min に戻す。

#### Case L1-Local: Local docker compose で admin が Approve → 正常 resume + patron に応答

**目的**: race 防止の要 = `clearAdkApprovalTimer` の boolean 経路で「admin 応答が timer より先勝ちすると 1 通のみ届く」ことを確認 (二重通知 regression 防止)。

**前提**: 上記 Case L2-Local と同じ。ただし `ADK_APPROVAL_TIMEOUT_MS=180000` (= 3 分) に緩めておくと押しやすい。

**操作**:

1. `.env` の `ADK_APPROVAL_TIMEOUT_MS=180000` に切替 + host 再起動。
2. Slack DM で `@bot 禁書 wf/dummy-nonexistent-biblio biblio-dev` (or **実在の dummy 用 biblio 名で試すなら要注意** = 本番 shelf の PR が作られる)。
3. **タイムアウトより十分前 (= 数秒以内) に Slack カードで Approve を押す**。

**期待結果**:
- patron に **1 通のみ** 応答が届く (= 実 resume の結果 = 「(実装成功時) 禁書処理が完了しました」or「(dummy biblio のため) 該当 skill が存在しません」等の 1 メッセージ)
- 「承認がタイムアウトしました」通知は **届かない**
- host ログに `"event":"adk.approval.resolve"` は出るが `"event":"adk.approval.expired"` は出ない
- pending_approvals の該当 row が消滅

**判定**: 「1 通のみ」+ 「expired event 不在」+ 「row 消滅」の 3 point → **Layer 1 (race 防止) PASS**。

#### Case L3-GKE: GKE Pod 再起動 sweep → patron に「Pod 再起動で失効しました」通知

**目的**: Layer 3 (`sweepStaleAdkApprovals`) が Pod 再起動時に stale row を自動 cleanup することを確認。

**前提**: `kubectl` auth + `biblio-orchestrator-0` Pod 生存 + Slack biblio-slack-app workspace 経由の admin DM 経路 wire 済 + 本 PR の image が deploy 済。

**操作**:

1. **短時間 timeout で pending row を作る** (これは動作担保のため + 短時間で再起動する必要がある):
   ```bash
   kubectl set env statefulset/biblio-orchestrator -n biblio-claw ADK_APPROVAL_TIMEOUT_MS=1800000  # 30 min にしておく (= sweep 前に timer 発火させないため)
   kubectl rollout status statefulset/biblio-orchestrator -n biblio-claw --timeout=5m
   ```
2. **Slack biblio-slack-app workspace で `@bot 禁書 wf/dummy-nonexistent-biblio biblio-dev` を送る** → admin カード配信されるので押さずに放置。
3. **pending row が作られたことを確認**:
   ```bash
   kubectl exec biblio-orchestrator-0 -c orchestrator -n biblio-claw -- \
     pnpm exec tsx scripts/q.ts /data/v2.db \
     "SELECT COUNT(*) FROM pending_approvals WHERE action='adk_confirm' AND payload LIKE '%dummy-nonexistent%'"
   # 期待: 1 (or それ以上)
   ```
4. **Pod を強制再起動**:
   ```bash
   kubectl delete pod biblio-orchestrator-0 -n biblio-claw
   kubectl wait --for=condition=ready pod/biblio-orchestrator-0 -n biblio-claw --timeout=5m
   ```
5. **起動完了後、以下の 3 point を確認**:
   ```bash
   # (a) orchestrator log に sweep event が出ている
   kubectl logs biblio-orchestrator-0 -c orchestrator -n biblio-claw --since=5m \
     | grep -E '"event":"adk\.approval\.(sweep_start|sweep_done|expired)"'
   # 期待:
   #   "event":"adk.approval.sweep_start","count":1
   #   "event":"adk.approval.expired","reason":"host restarted"
   #   "event":"adk.approval.sweep_done","count":1,"failed":0

   # (b) row 消滅
   kubectl exec biblio-orchestrator-0 -c orchestrator -n biblio-claw -- \
     pnpm exec tsx scripts/q.ts /data/v2.db \
     "SELECT COUNT(*) FROM pending_approvals WHERE action='adk_confirm' AND payload LIKE '%dummy-nonexistent%'"
   # 期待: 0
   ```
6. **Slack で確認**:
   - **admin DM のカードが "Expired (host restarted)" に自動 edit されている**
   - **patron (元発話者) に「エラー: Pod 再起動により承認セッションが失効しました。もう一度 tool 呼出をお願いします。」通知が届いている**

**判定**: 上記 (a)/(b) の 2 SQL/log point + Slack 2 UI point = **合計 4 point** OK → **Layer 3 (GKE sweep) PASS**。

#### Case V-GKE: `verify-m4-b.sh` Section 6.5 で Layer 1 regression 確認 + 冪等性

**目的**: 本 PR で追加した Section 6.5 の `expires_at IS NOT NULL` assertion が pass することを確認 (= Layer 1 の自動 regression 網)。

**前提**: 本 PR の image が deploy 済 + `GCP_PROJECT_ID` / `BQ_DATASET_ID` env 設定済。

**操作**:

```bash
bash scripts/verify-m4-b.sh
# 期待: 全 9 section 通過 + 末尾 "M4-B PASS" + exit 0
# 特に Section 6.5 の以下 info line が出ること:
#   "HITL Layer 1 smoke: 全 adk_confirm row の expires_at が設定済 (NULL count=0)"

# 冪等性確認
bash scripts/verify-m4-b.sh
# 期待: 2 回目も PASS (Section 6.5 の cleanup DELETE が効いている)
```

**判定**: 2 連続 `M4-B PASS` + Layer 1 smoke line 出現 → **Section 6.5 regression 網 PASS**。

**上記 4 case を全て PASS で issue #106 の real-world 動作担保が完了する**。プレゼン前に最小限で確認するなら Case L2-Local + Case V-GKE の 2 件で「30 秒後に patron 通知が届く経路 + 自動 regression 網」の担保になる (Case L1-Local と L3-GKE は「動作の別 branch を追加確認」の意味)。

### 既知の罠 / gotcha

1. **`update_config` の admin check が ADK 経路で省略されている**: delivery 経路の `config-action.ts` は `isConfigChangeAllowed(session)` で agent_group スコープの admin check を持つが、ADK 経路には session がないため実装省略 (plan §Out of Scope)。実運用では `dispatchToAdk` に到達する時点で `agent_group_members` 経由 routing check 済のため二重防御はしないが、Phase 90 の routing 一本化時に再検討する
2. **`Context.requestConfirmation` が adk-js@1.3.0 `@experimental`**: minor version bump で breaking change の可能性。`package.json` は `@google/adk@^1.3.0` に pin (major 手動レビュー)、シグネチャ変更検知は `src/adk/tools/enkin-tool.test.ts` の requestConfirmation mock 引数 shape assert で担保
3. **admin 拒否 (`confirmed=false`) 時の reason 分類**: 既存 `UnshelveFailureReason` に `user_rejected` 相当がないため `config_error` に集約 (= detail 文字列で patron 認知)。将来 Phase 90 で型追加検討
4. **container_config.model 二重管理**: `src/adk/root-agent.ts` の `model: 'claude-sonnet-4-6'` hardcode を Phase 4 でも維持。`init-adk-agent.ts` の container_config.model 削除は Phase 90 で解消
5. **HITL flow の unit test は完全 integration ではない**: `dispatcher.test.ts` + `approval-dispatcher.test.ts` + `adk-approvals.test.ts` で分離した単体経路の cover。tool.execute → runner pause → dispatcher pending 検知 → resolveAdkApproval → runAsync resume の完全 end-to-end は verify-m4-b.sh Section 6.5 と Level 7 (実 Slack 手動確認) が担う

### CLI 経由 patron 命令のテスト手順 (DEN さん手動確認用、9 tool 網羅)

```bash
kubectl exec biblio-orchestrator-0 -c orchestrator -n biblio-claw -- \
  sh -c "cd /app && pnpm run chat \"@bot 仕入れて wf/test-biblio-minimal\""
# → acquire_biblio 発火 + patron 応答

# 蔵書一覧
kubectl exec biblio-orchestrator-0 -c orchestrator -n biblio-claw -- \
  sh -c "cd /app && pnpm run chat \"@bot 蔵書\""
# → list_biblio 発火 (category 未指定 = 全件)

kubectl exec biblio-orchestrator-0 -c orchestrator -n biblio-claw -- \
  sh -c "cd /app && pnpm run chat \"@bot 蔵書 biblio-dev\""
# → list_biblio 発火 + category filter

# 設定変更
kubectl exec biblio-orchestrator-0 -c orchestrator -n biblio-claw -- \
  sh -c "cd /app && pnpm run chat \"@bot 設定 ACQUIRE_SKILL_THRESHOLD 15\""
# → update_config 発火

# 禁書 (実装確認、admin 承認は Slack 経由で手動テスト)
kubectl exec biblio-orchestrator-0 -c orchestrator -n biblio-claw -- \
  sh -c "cd /app && pnpm run chat \"@bot 禁書 wf--dummy biblio-dev\""
# → enkin_biblio 発火 → 中間応答「承認を admin にお願いしました」
```

### 関連

- `src/adk/tools/{categorize,list-biblio,shelve-multi,config,enkin,shokyaku}-tool.ts` (= 6 新 tool)
- `src/adk/dispatcher.ts` (= Phase 4 で `runAsync` 経路 + pending 検知に書換)
- `src/adk/approval-dispatcher.ts` (= HITL resume 経路、`resolveAdkApproval`)
- `src/modules/approvals/adk-approvals.ts` (= `requestAdkApproval` + `ADK_CONFIRM_ACTION`)
- `src/modules/approvals/response-handler.ts` (= adk_confirm 分岐追加)
- `src/adk/runner.ts` (= `SharedRunnerContext` shape 拡張、sessionService expose)
- `src/adk/root-agent.ts` (= 9 tools + HITL 判断規範 instruction)
- `src/biblio/config-validation.ts` (= `validateValueForKey` を config-action.ts から切り出し、副作用なし)
- `scripts/verify-m4-b.sh` (= Section 4.5 + 6.5 追加、9 section 化)

---

## Vertex 401 ACCESS_TOKEN_EXPIRED retry loop の対症手順

### 症状

- Slack で `@bot` に発話 → 応答無し
- `kubectl get pods -n biblio-claw` で agent Pod は `Running`、`kubectl get jobs -n biblio-claw` は `COMPLETIONS=0/1` のまま分単位で滞留
- agent Pod log に `Error: API retry (retryable: true)` が連続、最終的に `Result: Failed to authenticate. API Error: 401 ... ACCESS_TOKEN_EXPIRED` が出る

### 自動復旧 (issue #49 Step 4 適用後の期待挙動)

- 次の patron メッセージで `isSessionInvalid` (= `container/agent-runner/src/providers/claude.ts` の `STALE_SESSION_RE`) が 401 ACCESS_TOKEN_EXPIRED にマッチして true を返し、continuation がクリアされる
- 次回 patron メッセージで SDK が新規 session を init → fresh Vertex client → OneCLI から (rotator が既に投入済の) fresh token を取得 → 401 自然回復
- (注) `@anthropic-ai/claude-agent-sdk` が Vertex client を process-init 時に token cache する場合は session 再生成だけでは不十分。下記の手動復旧が必要

### 手動復旧

```bash
# 1. stuck している agent Job を Job ごと削除 (= cascade で Pod も消える)。
#    Pod 単独削除だと Job controller が即 respawn して race condition の温床になる。
kubectl get jobs -n biblio-claw | grep -v COMPLETIONS  # → stuck job 名を確認
kubectl delete job <stuck-job-name> -n biblio-claw

# 2. Pod の完全削除を待機 (= 再 spawn race 防止)。
kubectl wait --for=delete pod/<stuck-pod-name> -n biblio-claw --timeout=60s
kubectl get pods -n biblio-claw -l 'job-name'   # → No resources found を確認

# 3. (vault token も期限切れが疑わしい場合) rotator を即時に 1 周期回す。
#    rotator sidecar 内で onecli-vertex-secret.sh を手動キックして fresh ADC token を OneCLI に PATCH。
kubectl exec biblio-orchestrator-0 -c vertex-token-rotator -n biblio-claw -- \
  bash /scripts/onecli-vertex-secret.sh

# 4. Slack で再度 @bot に発話 → 新しい agent Pod が fresh token で spawn される
```

### 構造的予防 (issue #49 で実施済)

| 経路 | 変更 | 効果 |
|------|------|------|
| rotator 周期 | 50min → 40min (`scripts/vertex-rotate.sh` + `k8s/10-orchestrator-statefulset.yaml`) | ADC token TTL ~60min との gap を 10min → ~0min に縮小 |
| secret 投入流儀 | DELETE→POST → POST/PATCH 分岐 (`scripts/onecli-vertex-secret.sh`) | rotation 中の vault 不在 gap (= secondary 401 発火源) を消滅 |
| continuation 固着 | `STALE_SESSION_RE` に `401.*ACCESS_TOKEN_EXPIRED` + `invalid authentication credentials` を追加 | 一度発火しても次の patron メッセージで自然回復 |

### 関連

- issue #49 (= 本セクションの直接元)
- ルート `CLAUDE.md` の「シークレット / クレデンシャル / OneCLI」§GH installation token (GitHub App Sidecar 経路) — rotator sidecar 同型構造
- `agent_pod_residual_race_condition` (= Pod 残置 race の親類、運用罠 memory)

---

## Pending Pod の対症手順 (GKE 経路、issue #57)

### 背景

biblio-claw の orchestrator PVC は zonal Persistent Disk (`standard-rwo`) で固定 zone (`asia-northeast1-b`) に縛られ、agent Pod は同 PVC を subPath マウントするため b zone の node でしか spawn できない。b zone の memory が稼働中 agent Pod で埋まると、新規 spawn 要求が `Pending` で固まり、cluster autoscaler も `NotTriggerScaleUp` を返す。patron からは「応答無し」に見える。

### 自動 cleanup (M4 系列以降の標準動作)

`src/host-sweep.ts` の host-sweep が 60 秒 tick で agent session を監視し、次の条件を満たす session の agent container を自動 kill する:

1. heartbeat ファイルが `AGENT_IDLE_THRESHOLD_MS` (デフォルト 5 分) 以上更新されていない
2. processing 中のメッセージ (claims) が存在しない

kill 後、次の inbound message で `wakeContainer` が新 container を spawn する (= 既存 wake 経路、追加配線なし)。`ABSOLUTE_CEILING_MS` (30 分、stuck container 用) は最後の砦として温存。

### threshold tuning

`AGENT_IDLE_THRESHOLD_MS` env で閾値を ms 単位で上書き可能。manifest 例:

```yaml
# k8s/10-orchestrator-statefulset.yaml の orchestrator container env block
- name: AGENT_IDLE_THRESHOLD_MS
  value: '600000'  # 10 分 (= prod 負荷状況に応じて調整)
```

短すぎる (1-2 分) と patron 発話の間隔で spawn-kill が反復し体感遅延が増える、長すぎる (15 分以上) と本対症の効きが薄い。default 5 分は trade-off の中間案。

### 手動対症 (緊急時、auto cleanup が間に合わない場合)

```bash
# 1. Pending Pod の特定
kubectl get pods -n biblio-claw -l 'job-name'
kubectl describe pod <pending-pod> -n biblio-claw | grep -A 5 Events

# 2. 既存 agent Pod の idle 時間確認
kubectl exec biblio-orchestrator-0 -n biblio-claw -c orchestrator -- \
  pnpm run ncl sessions list | tail -10

# 3. idle session の Job 削除 → memory 解放
kubectl delete job <oldest-idle-job> -n biblio-claw
kubectl wait --for=delete pod/<oldest-pod> -n biblio-claw --timeout=60s

# 4. Pending Pod の schedule 再評価 (10-30 秒で Running になる見込み)
kubectl get pod <pending-pod> -n biblio-claw
```

### 構造的解消 (中期、別 PRD)

orchestrator PVC を Regional Persistent Disk に切替えることで agent Pod が両 zone (`asia-northeast1-a` / `-b`) の node に乗れるようになり、Pending 確率を構造的に下げる。disk cost が約 2 倍 + PVC 移行手順 (snapshot → restore or 再構築) の検証が必要なため、本 idle cleanup のリリース後 1 週間程度観測してから判断する。

### 関連

- issue #57 (= 本セクションの直接元、PVC zonal disk 由来の構造制約)
- `agent_pod_residual_race_condition` (= Pod 残置 race、本 cleanup で観測症状が緩和される)
- ルート `CLAUDE.md` §Two-DB セッション分割 / §コンテナ再起動 (= kill 経路の wake 周辺)

---

## M4-E Phase 4: observability-ad-honji (Fugue channel の OTel 2 段構造 + AD の本義)

M4-E PRD の Phase 4 で Fugue channel adapter (`src/channels/fugue-http.ts`) に **2 段 trace 構造** + trace 相関 log field + AD 本義契約の unit test 網羅を実装した(PR #122)。**Phase 4 は local 完結 = Cloud Trace への実 push と BQ sink 動作確認は Phase 5 (Prod deploy) の scope**、Phase 4 では InMemorySpanExporter + `LOG_FORMAT=json` + stdout spy で内部整合を担保する。

**当初 plan は 3 段構造 (auto HTTP SERVER span → fugue → biblio) 想定だったが、Phase 4 review C1 で「本 repo は `"type": "module"` の純 ESM プロジェクト + `node --import ./dist/instrumentation.js` 起動で、`@opentelemetry/instrumentation-http` の core module patch (require-in-the-middle / import-in-the-middle 依存) が `module.register()` 等の ESM フック未整備のため機能していない = auto server span は現状 traceparent 有無どちらでも発火していない」と実測で判明。Phase 5 で ESM フック追加 or 2 段構造を正式仕様として運用の判断予定。**

### 2 段 trace 構造(Phase 4 実装本体)

```
fugue.consult / fugue.equip             (INTERNAL, Phase 4 新設 withFugueEntrySpan)
  └─ biblio.list / biblio.equip         (INTERNAL, M4-A withBiblioActionSpan 継承)

# Phase 5 で auto HttpInstrumentation が ESM で機能するようになった場合:
# HTTP POST /v1/channels/fugue/{consult,equip}   (SERVER, Phase 5 で検証予定)
#   └─ fugue.consult / fugue.equip                  ↑ 自動的にその子として nest される
#        └─ biblio.list / biblio.equip              (extractTraceContextFromHttpHeaders の base が
                                                    context.active() なので非破壊)
```

- 中央層 `fugue.<operation>` は `src/observability/fugue-entry-span.ts` の `withFugueEntrySpan` が生成する。M4-A の `withBiblioActionSpan` の Fugue channel 版として位置付ける(signature を最小化 = `sessionId` 引数なし、`channel:'fugue'` を span 属性として持たせる、Cloud Trace UI で channel filter 可能)
- 下層 (`biblio.<action>`) は M4-A 既存、Phase 4 で touch しない = M4-A `biblio.<action>` 集計は channel-agnostic に温存
- 上層 (auto server span) は **Phase 5 で検証**。ESM フック整備が必要 (下記「Phase 5 に押しやる項目」参照)

### span 名 / 属性一覧

| span 名               | kind     | 主な属性                                                                                                        |
| --------------------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `HTTP POST /v1/...`   | SERVER   | (Phase 5 で発火予定、`http.method` / `http.route` / `http.status_code` / `net.peer.*` を auto 付与)               |
| `fugue.consult`       | INTERNAL | `channel='fugue'` / `fugue.operation='consult'` / `fugue.request_id` / `fugue.outcome ∈ {ok, not_found, error}` / `fugue.mode` / (劣化時) `fugue.degraded=true` |
| `fugue.equip`         | INTERNAL | `channel='fugue'` / `fugue.operation='equip'` / `fugue.request_id` / `fugue.outcome ∈ {equipped, already_equipped, not_found, error, hitl_required}` |
| `biblio.list`         | INTERNAL | `biblio.action='list'` / `biblio.request_id` / `biblio.session_id=''` / `biblio.outcome ∈ {success, failure, not_found}` |
| `biblio.equip`        | INTERNAL | `biblio.action='equip'` / `biblio.request_id` / `biblio.session_id=''` / `biblio.outcome ∈ {success, failure, not_found}` |

- `fugue.outcome` と `biblio.outcome` は **別軸**。fugue.outcome は Fugue 契約 §5.2 / §5.3 の応答 `status` フィールドと 1:1、biblio.outcome は M4-A 集計の 3 値。両者は分岐直後に「対称に並置」して設定する grep 検知可能な流儀(`fugue-http.ts` 内で `span.setAttribute('biblio.outcome', ...)` の直後に `fugueSpan.setAttribute('fugue.outcome', ...)` を並べる)
- **catch 経路のデフォルト outcome** (Phase 4 review I1): `withFugueEntrySpan` / `withBiblioActionSpan` の catch は throw 経路で無条件に `fugue.outcome='error'` / `biblio.outcome='failure'` を反映する。成功経路の setAttribute より後段の未想定例外で outcome 属性が欠落し Cloud Trace のダッシュボードから消える silent failure を撲滅
- **`fugue.degraded=true`** (Phase 4 review M1): `equipped_state_unavailable` (装備状態 DB read failure、`fugue-http.ts:558` 付近) で刻む categorical signal。log.warn だけでは Cloud Trace outcome 集計で通常成功と区別不能な silent degraded を可視化する
- **`fugue.outcome='hitl_required'`** (Phase 4 review M2): HITL defensive path (`requiresApproval('equip','fugue')` = 現状 dormant) 通過時に刻む。matrix 変更時に silent HITL bypass + Cloud Trace 上の完全不可視の両方を明示的に閉じる

### event 名対応表(PRD 記述 ↔ 実装)

| PRD 記述(underscore)          | 実装(dot-separated、既存)              | 意味                                       |
| ---------------------------- | -------------------------------------- | ------------------------------------------ |
| `fugue_consult_requested`    | `fugue.consult.invoked`                | request 受信 + schema 通過                 |
| `fugue_consult_completed`    | `fugue.consult.completed`              | 200 応答完了(成功)                       |
| `fugue_consult_completed`    | `fugue.consult.not_found`              | 200 応答完了(蔵書 0 件)                  |
| `fugue_consult_failed`       | `fugue.consult.partial_failure`        | 200 応答完了(部分失敗、AD の本義)         |
| `fugue_consult_failed`       | `fugue.handler.error`                  | 500 応答(catch-all uncaught)              |
| `fugue_consult_warn`         | `fugue.consult.equipped_state_unavailable` | 装備状態 DB read failure(200 で継続、`fugue.degraded=true`) |
| `fugue_equip_requested`      | `fugue.equip.invoked`                  | 同上(equip 側)                            |
| `fugue_equip_completed`      | `fugue.equip.completed`                | 200 応答(装備成立)                        |
| `fugue_equip_completed`      | `fugue.equip.already_equipped`         | 200 応答(既装備)                          |
| `fugue_equip_completed`      | `fugue.equip.not_found`                | 200 応答(棚に存在しない skill_id)         |
| `fugue_equip_failed`         | `fugue.equip.partial_failure`          | 200 応答(部分失敗、listBiblio / DB write) |
| `fugue_equip_rejected`       | `fugue.equip.hitl_required`            | 200 応答(HITL defensive path、現状 dormant) |
| `fugue_traceparent_warn`     | `fugue.traceparent.malformed`          | request header traceparent が壊れて W3C parse に失敗、silent fallback を可視化 (Phase 4 review M3) |

- 命名は既存 dot-separated 維持(Phase 4 は scope 最小化、event rename は Phase 6 verify 前の cleanup で判断)

### `LOG_FORMAT=json` の運用注意

`src/log.ts:31` の `FORMAT = process.env.LOG_FORMAT === 'json' ? 'json' : 'text'` により **`LOG_FORMAT=json` でなければ `getTraceLogFields()` 経由の trace 相関 field は log payload に載らない**:

- Prod GKE 経路: `k8s/10-orchestrator-statefulset.yaml` で `LOG_FORMAT=json` 投入済 → BQ sink 経路で trace 相関可能
- dev 経路(`pnpm run dev`): default `text` = trace 相関 field なし、span 発火は独立に動く(Cloud Trace UI で observe 可能)
- unit test: `LOG_FORMAT=json` を先に `process.env` にセットしてから `await import('./fugue-http.js')` で dynamic import(`src/channels/fugue-http.otel-log.test.ts` 参照、log-trace.test.ts と同流儀)

### Cloud Trace UI での検索(Phase 5 以降)

```
# fugue channel 経由の呼び出しを operation 別に集計
span:fugue.consult
span:fugue.equip

# channel 属性による filter (M4-A の biblio.* span には channel 属性がない)
attribute:channel=fugue

# Fugue Cloud Run → biblio-claw の 1 trace 串刺し (Phase 5 実結線後、auto server span 発火後)
trace:<parent-trace-id>  # Fugue 側 request の trace_id
```

### BQ sink 集計 SQL(Phase 5 稼働後)

**注**: GKE sink 経路のテーブル名は logName 由来で **`stdout` / `stderr` の 2 テーブル** (§M4-A Phase 3 で実測済)。Cloud Logging の予約 field (`trace` / `spanId` / `traceSampled`) は BQ で **top-level column** に昇格され、`jsonPayload.<field>` ではなく直接カラム名で参照する (§M4-A Phase 3 §BQ サマリ SQL 参照)。

```sql
-- fugue channel の event 別カウント (直近 24h、stdout/stderr の両テーブルを UNION ALL で結合)
SELECT
  channel,
  event,
  COUNT(*) AS count
FROM (
  SELECT
    jsonPayload.channel AS channel,
    jsonPayload.event   AS event,
    timestamp
  FROM `<PROJECT_ID>.<DATASET_ID>.stdout`
  UNION ALL
  SELECT
    jsonPayload.channel AS channel,
    jsonPayload.event   AS event,
    timestamp
  FROM `<PROJECT_ID>.<DATASET_ID>.stderr`
)
WHERE
  timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
  AND channel = 'fugue'
GROUP BY 1, 2
ORDER BY 3 DESC;

-- 特定 trace_id の相関ログ抽出 (Fugue Cloud Run → biblio-claw の 1 trace 串刺し debug 用)。
-- trace は top-level column、値は `projects/<PROJECT_ID>/traces/<32-hex>` 形式に自動昇格される。
SELECT
  timestamp,
  jsonPayload.event,
  jsonPayload.processing_time_ms,
  jsonPayload
FROM `<PROJECT_ID>.<DATASET_ID>.stdout`
WHERE trace = 'projects/<PROJECT_ID>/traces/<32-hex-trace-id>'
UNION ALL
SELECT
  timestamp,
  jsonPayload.event,
  jsonPayload.processing_time_ms,
  jsonPayload
FROM `<PROJECT_ID>.<DATASET_ID>.stderr`
WHERE trace = 'projects/<PROJECT_ID>/traces/<32-hex-trace-id>'
ORDER BY timestamp ASC;
```

### ESM フック判断 (Phase 5 で確定 = 2 段構造正式化)

Phase 4 review C1 で「`@opentelemetry/instrumentation-http` の auto HTTP SERVER span 層が
ESM + `--import` 構成で未発火」と実測判明した件は、Phase 5 で以下の理由から **3 段化投資を
見送り、2 段構造 (`withFugueEntrySpan → withBiblioActionSpan`) を正式仕様として運用** する:

- Node 24.15.0 で `module.register()` が DEP0205 として documentation-only 非推奨化
  (Node 26.0.0 で runtime deprecation 予定)
- OTel JS の推奨移行先 (issue #4933、`module.register()` ベース) が既に陳腐化中
- `fugue-entry-span.ts:15-18` の設計により、将来 auto SERVER span 発火時は AsyncLocalStorage
  で自動 nest されるため 3 段化への切替はコード変更ゼロ (可逆な判断)

Fugue channel の trace ルート親は `fugue.consult` / `fugue.equip` = 直接 Cloud Trace の
root span として観測される。Fugue Cloud Run 側からの分散 trace 継承は `traceparent` header
の手動 extract (`http-propagation.ts`) で成立済 (Phase 4 test 45 case で担保、Phase 5 Task 7
の Prod 実結線で最終確認)。

### 既知の罠 3 件

1. **auto HTTP SERVER span 層が ESM + `--import` 構成で現状発火しない (Phase 5 で 2 段構造正式化決定、上記 §ESM フック判断 参照)**:
   - `@opentelemetry/instrumentation-http` は `require-in-the-middle` / `import-in-the-middle` に依存し、ESM で機能させるには `--experimental-loader` や `module.register()` 等の明示的な ESM フック登録が必要 (本 repo に未整備)。実測で `getNodeAutoInstrumentations()` を `NodeSDK` に渡していても auto server span は traceparent 有無どちらでも一切生成されない状態。
   - 現状の動作: `fugue.consult` / `fugue.equip` は事実上 ROOT span となる (traceparent 不在時)、または remote span の直下に付く (traceparent 有時、Fugue 側 span の子)。runbook / JSDoc の「2 段構造」記述はこの実態を正確に反映したもの。
   - **Phase 5 で確定**: (b) 2 段構造を正式仕様として運用 = 上記 §ESM フック判断 参照。Node 24/26 世代の非推奨化リスクを避けて可逆な選択 (`fugue-entry-span.ts:15-18` の AsyncLocalStorage 設計により、将来 auto SERVER span 発火時は自動 nest される保険)。
   - 検知経路: `fugue-http.otel.test.ts` 冒頭 JSDoc + 各 case の「2 段」記述、および Phase 5 Task 7 の Prod 実結線 (実 orchestrator + Fugue Cloud Run 経由の Cloud Trace 目視) が唯一の実挙動確認手段。

2. **`LOG_FORMAT` env が json でないと trace 相関 field は log に載らない**:
   - 症状:Cloud Trace UI で span は見えるが Cloud Logging Trace サイドバーから log がリンクされない
   - 確認:orchestrator Pod の `env` に `LOG_FORMAT=json` があるか(`kubectl exec biblio-orchestrator-0 -c orchestrator -- env | grep LOG_FORMAT`)
   - 回避:`k8s/10-orchestrator-statefulset.yaml` で継続投入。dev 経路で trace 相関を見たい場合のみ `LOG_FORMAT=json pnpm run dev` で立ち上げる

3. **Fake Fugue client の `--traceparent` は W3C spec 準拠の 32+16 hex format 必須 (Phase 4 review M3 で可視化済)**:
   - malformed だと biblio 側 propagator が silent に root context に fallback(`http-propagation.test.ts` の malformed case で挙動固定)
   - client 側は grammar validation を持たない = raw 値を forward するのみ
   - **可視化 (Phase 4 で追加)**: biblio 側で `req.headers.traceparent` 存在 + extract 結果に valid span が乗らない場合、`log.warn` + `event: 'fugue.traceparent.malformed'` が emit される。BQ で `SELECT COUNT(*) WHERE jsonPayload.event = 'fugue.traceparent.malformed'` で Fugue 側 trace 送信 regression を継続監視可能
   - 併せて Fake Fugue client の `Result.used_traceparent` が `string | null` (未指定時 `null`) で常に RESULT= 出力に載る (Phase 4 review S2)

### Phase 4 で追加した test 一覧 (レビュー Wave 1 修正込み)

| test file                                                     | case 数 | 検証対象                                                                 |
| ------------------------------------------------------------- | ------- | ------------------------------------------------------------------------ |
| `src/observability/__tests__/http-propagation.test.ts`        | 8       | httpHeadersGetter の 5 case + `extractTraceContextFromHttpHeaders` の 3 case |
| `src/observability/__tests__/fugue-entry-span.test.ts`        | 6       | span 名 + attributes / extraAttributes / exception (Error + non-Error) / finally / biblio 子 span 親子 |
| `src/channels/fugue-http.otel.test.ts`                        | 12      | 2 段構造 / traceparent 継承 / outcome=ok/not_found/error / equip 6 分岐 (成功 / not_found / already_equipped / listBiblio throw / DB write throw / 401 で span 未発火) / M1 degraded=true |
| `src/channels/fugue-http.otel-log.test.ts`                    | 4       | LOG_FORMAT=json で `completed` 2 case + `partial_failure` 2 case の trace 相関 field 付与 |
| `src/channels/fugue-http.ad-honji.test.ts`                    | 15      | 5xx catch-all only(静的 grep + 5 case)+ 200 partial failure(5 case)+ processing_time_ms(3 case)+ **静的 grep で outcome 属性強制の対称性 (S1)** |
| **合計**                                                      | **45**  | Phase 4 完成判定の unit test 網羅 (レビュー Wave 1 修正で 36 → 45 に増加)                    |

### Phase 5 に押しやる項目(scope boundary)

- ~~**ESM フック追加 or 2 段構造の正式化判断** (Phase 4 review C1)~~ → **Phase 5 で確定済 = 2 段構造正式化** (上記 §ESM フック判断 参照)
- Cloud Trace への実 push の verify(Prod Fugue Cloud Run 接続後)
- BQ sink での fugue event log 集計 SQL の実データ確認(上記 BQ SQL テンプレの `<PROJECT_ID>` / `<DATASET_ID>` を実値に置換 + 直近 24h の event 分布を確認)
- GKE Ingress manifest(`k8s/25-ingress-fugue-channel.yaml`)の apply
- Terraform module(`terraform/fugue-channel/`)の apply
- `SecretManagerSecretProvider` の実装
- `scripts/verify-m4-e.sh` の統合 verify(任意 Phase 6)

### 関連

- Source PRD: `.claude/PRPs/prds/m4/m4-e-fugue-integration.prd.md` (Phase 4)
- Source Plan (archived): `.claude/PRPs/plans/completed/phase-4-observability-ad-honji.plan.md`
- 実装本体: `src/observability/{http-propagation,fugue-entry-span,index}.ts` + `src/channels/fugue-http.ts` + `scripts/fake-fugue-client.ts`
- test 群: `src/observability/__tests__/{http-propagation,fugue-entry-span}.test.ts` + `src/channels/fugue-http.{otel,otel-log,ad-honji}.test.ts`
- M4-A 継承元: 本 runbook §M4-A Phase 1-4 (OTel foundation + GenAI semconv + BQ sink)
- Slack adapter との対称性: `src/channels/slack.ts` (channel adapter agnostic な withBiblioActionSpan 相乗り経路の pattern 源)

---

## M4-E Phase 5: prod-deploy (Fugue channel を GKE Ingress で外部公開 + Fugue Cloud Run 実結線)

M4-E PRD の Phase 5 で、Phase 4 完成の Fugue channel adapter (`src/channels/fugue-http.ts`) を
**GKE Autopilot `biblio-prod` cluster** に **GCE Ingress + Google-managed cert + 固定 DNS + WIF** で
外部公開し、Fugue Cloud Run から `https://biblio-claw.fugue-channel.hajimari-ai-hackathon-2026.app`
経由の実結線 (1 trace 串刺し + BQ sink 到達) を確認する Phase。

**アプリ本体は 4 箇所のみ改修** で大半は infra 追加:

- `src/channels/fugue-http.ts`: `/healthz` endpoint を auth check の前に追加 (LB probe を 401 回避)
- `src/index.ts`: boot sentinel 2 段 (`/tmp/boot-complete` = migration 完了 / `/tmp/host-ready` = 全 subsystem 完了)
- `scripts/fake-fugue-client.ts`: `FUGUE_URL` env で Prod URL 全体切替 (Prod 疎通 verify 経路)
- `.env.example`: `FUGUE_URL` + `FUGUE_HTTP_HOST=0.0.0.0` GKE 記述

Infra 追加 = k8s manifest 4 枚 + Terraform module 1 個:

- `k8s/10-orchestrator-statefulset.yaml` (UPDATE): envFrom fugue secret + ports.fugue:8080 + FUGUE env + 3 probe
- `k8s/25-ingress-fugue-channel.yaml` (NEW): GCE Ingress + pre-shared-cert + global-static-ip-name
- `k8s/26-service-fugue-channel.yaml` (NEW): ClusterIP Service + `cloud.google.com/neg` 明示 + BackendConfig
- `k8s/27-networkpolicy-fugue-channel.yaml` (NEW): LB health check IP range 許可 + egress
- `terraform/fugue-channel/` (NEW): static IP + managed cert + DNS + Secret Manager + secret-scoped IAM binding

**issue #73 (probe 配線) + Phase 4 review C1 (ESM フック判断 = 2 段構造正式化)** を同時吸収済。
ESM 判断の詳細は上記 §M4-E Phase 4 §ESM フック判断 参照。

### deploy 手順 (8 step、DEN さん実行、Cloud Endpoints DNS + Secret Manager 経路)

**設計原則**: **ホスト名を静的ファイルに書かない**。Source of Truth = Secret Manager
`fugue-domain-name`。全 Step でホスト名は `gcloud secrets versions access` で動的取得し、
セッション先頭で 1 回 `export DOMAIN=...` すれば以降の Step は同 shell で継承。

**前提**: terraform CLI (v1.5+ 推奨、install 手順は上記 §M4-A Phase 3 §前提 参照) +
`envsubst` (`gettext` package) がインストール済 (WSL2 AlmaLinux 9 なら
`sudo dnf install gettext` で導入、未インストールなら Step 4 の Ingress apply で shell error)。

**Step 0: Cloud Endpoints API 有効化 (初回のみ)**

```bash
gcloud services enable endpoints.googleapis.com \
  --project=hajimari-ai-hackathon-2026
# 既に enable 済なら no-op、初回は Terraform apply 前に必須 (罠 9 で fail-fast)
```

**Step 1: Domain 決定 + Terraform 変数投入 (セッション先頭で 1 回)**

```bash
# Service 名は自由 (例: biblio-claw-fugue = 全固有名詞を含めてシンプル)
export TF_VAR_domain_name='biblio-claw-fugue.endpoints.hajimari-ai-hackathon-2026.cloud.goog'
export TF_VAR_fugue_shared_token=$(openssl rand -hex 32)

# 値の確認 (log には出さない、tmux buffer / ephemeral copy 用)
echo "domain: $TF_VAR_domain_name"
echo "token prefix: ${TF_VAR_fugue_shared_token:0:8}..."
```

**Step 2: Terraform apply (static IP + Cloud Endpoints Service + cert + Secret Manager 2 個 + IAM 2 個)**

```bash
cd terraform/fugue-channel
terraform init
terraform plan   # 期待: 8 resource create (IP + Endpoints Service + cert + secret x2 +
                 # secret_version x2 + IAM binding x2)
terraform apply
terraform output # static_ip_address / cert_name / endpoints_service_name / secret 2 個の名前
```

**Step 3: DNS 反映確認 (cert Active 化は Step 4 の Ingress apply 後に待つ)**

⚠️ **重要な順序修正 (Phase 5 実 deploy で判明)**: 旧 runbook では「Step 3 で cert Active 待ち → Step 4 で K8s apply」の順序だったが、**cert Active 化には Ingress apply (Load Balancer authorization) が前提条件**。Terraform apply 直後は cert が `PROVISIONING` + domain status = `FAILED_NOT_VISIBLE` になり、Ingress apply しない限り無限に stuck する。詳細は 罠 13 参照。

```bash
# Domain を Secret Manager から動的取得 (ここ以降 hardcode 参照ゼロ、セッション env で継承)
export DOMAIN=$(gcloud secrets versions access latest --secret=fugue-domain-name \
  --project=hajimari-ai-hackathon-2026)
echo "domain: $DOMAIN"

# Cloud Endpoints Service 状態確認 (Terraform apply で ACTIVE 化済)
gcloud endpoints services describe "$DOMAIN" \
  --project=hajimari-ai-hackathon-2026 --format='value(state)'

# DNS 反映確認 (.cloud.goog は Google 内部 DNS = 通常 5-10 分)
while ! dig +short "$DOMAIN" | grep -q .; do
  echo "waiting for DNS ($DOMAIN)..." && sleep 30
done
dig +short "$DOMAIN"
# 期待: static IP アドレス (terraform output static_ip_address と一致)

# cert 現状 (この時点では PROVISIONING + FAILED_NOT_VISIBLE の想定、Step 4 後に ACTIVE 化する)
gcloud compute ssl-certificates describe biblio-fugue-channel-cert \
  --global --format='value(managed.status)'
gcloud compute ssl-certificates describe biblio-fugue-channel-cert \
  --global --format='value(managed.domainStatus)'
# 期待: PROVISIONING / FAILED_NOT_VISIBLE (Ingress 未 apply の証拠、Step 4 後に ACTIVE 化)
```

**Step 4: K8s Secret 作成 + StatefulSet + Service + NetworkPolicy + Ingress apply**

```bash
# 前提: DOMAIN 変数が Step 3 で export 済 (同一 shell セッション内で継承)

# K8s Secret を Secret Manager から手動 sync (Phase 5 は手動、rotation 自動化は Phase 90+)
# 罠 8 の silent fail (`$(...)` の空出力を kubectl が正常な空文字値として受け入れる) を防ぐため
# 2 段に分けて token 空チェック → apply。
TOKEN=$(gcloud secrets versions access latest --secret=fugue-shared-token \
  --project=hajimari-ai-hackathon-2026)
[[ -n "$TOKEN" ]] || { echo 'ERROR: token fetch failed (permission / typo / propagation?)'; exit 1; }
kubectl create secret generic biblio-fugue-shared-token -n biblio-claw \
  --from-literal=FUGUE_SHARED_TOKEN="$TOKEN"

# deploy 順序 = StatefulSet update → Service + BackendConfig → NetworkPolicy → Ingress
# (Ingress 最後 = NEG + backend health 反映が早い、rollout 中の 502 window 最短化)
kubectl apply -f k8s/10-orchestrator-statefulset.yaml
kubectl rollout status statefulset biblio-orchestrator -n biblio-claw --timeout=10m
# → Pod 再起動時に `/tmp/host-ready` が書かれるまで startupProbe が pending
#   (30 * 10s = 5 min 猶予)。ready 化後 LB backend に組み込まれる

kubectl apply -f k8s/26-service-fugue-channel.yaml
kubectl apply -f k8s/27-networkpolicy-fugue-channel.yaml

# Ingress は envsubst で ${DOMAIN} を展開してから apply (host 値は Secret Manager が SoT)
# 罠 10: envsubst 未インストールなら shell error、罠 11: envsubst をかけずに直 apply すると
# `host: ${DOMAIN}` が literal で登録 = TLS SNI 不整合で全 request 404 silent failure
envsubst '${DOMAIN}' < k8s/25-ingress-fugue-channel.yaml | kubectl apply -f -

# NEG 自動作成 + backend health 反映待ち (最大 5 分)
kubectl describe ingress biblio-fugue-channel -n biblio-claw | grep -E 'Address|Backends'
```

**Step 4.5: Ingress apply 後の cert Active 化待ち + LB frontend rollout 待ち (順序 bug 修正で追加)**

⚠️ **Ingress apply が cert Active 化の前提** (罠 13)。実測: Ingress apply → cert Active 化まで **15-30 分** (通常)、最大 60 分。cert Active 直後は LB frontend の cert rollout が更に 1-5 分必要 (罠 14)。

```bash
# cert Active 待ち (Ingress apply 後に Google Cert Authority が Load Balancer authorization を再試行)
while true; do
  status=$(gcloud compute ssl-certificates describe biblio-fugue-channel-cert \
    --global --format='value(managed.status)')
  domain_status=$(gcloud compute ssl-certificates describe biblio-fugue-channel-cert \
    --global --format='value(managed.domainStatus)')
  echo "[$(date +%H:%M:%S)] cert=$status domain=$domain_status"
  if [[ "$status" == "ACTIVE" ]]; then
    echo "CERT_ACTIVE_OK"
    break
  fi
  sleep 60
done

# cert Active 直後は LB frontend rollout に追加 1-5 分。TLS handshake が成立するまで poll
# (罠 14: curl で SSL_ERROR_ZERO_RETURN → 数分後に 200 に切り替わる)
for i in {1..12}; do
  sleep 30
  RES=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "https://${DOMAIN}/healthz" 2>&1)
  echo "[$(date +%H:%M:%S)] TLS handshake attempt $i: HTTP $RES"
  if [[ "$RES" =~ ^[2-9] ]]; then
    echo "LB_FRONTEND_READY"
    break
  fi
done
```

**Step 5: CLI 経路で Prod URL 経由の疎通 verify (URL + Token は session env、`.env` に書かない)**

```bash
# 前提: DOMAIN + TOKEN は Step 3-4 で export 済、同一 shell セッション内で継承
# (再取得する場合は Step 3 冒頭の gcloud secrets versions access コマンドを再実行)

# 1. Health probe (Bearer なし、LB probe と同経路)
curl -sS "https://${DOMAIN}/healthz"
# 期待: 200 "ok"

# 2. Consult 疎通 (Bearer 認証込)
curl -sS -X POST "https://${DOMAIN}/v1/channels/fugue/consult" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"schema_version":"1","request_id":"verify-01","query":"typescript","mode":"ask-ad"}'
# 期待: 200 応答 + status:'ok' or 'not_found' の JSON

# 3. 認証 fail 確認 (Bearer なし + 不正 Bearer)
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "https://${DOMAIN}/v1/channels/fugue/consult" \
  -H "Authorization: Bearer INVALID" -H "Content-Type: application/json" -d '{}'
# 期待: 401

# 4. fake-fugue-client 経由の equip 冪等発火 (FUGUE_URL は inline、`.env` に書かない)
FUGUE_URL="https://${DOMAIN}" FUGUE_SHARED_TOKEN="$TOKEN" \
  pnpm exec tsx scripts/fake-fugue-client.ts equip --skill-id example-org--test-biblio-minimal
# 期待: status:'equipped' or 'already_equipped' の JSON、processing_time_ms あり
```

**Step 6: Cloud Trace + BigQuery sink 実観測 (Phase 5 完了判定の 4 assertion の 3, 4)**

```
# Cloud Trace UI で 1 trace 串刺し確認 (直近 1 時間の trace リスト)
# https://console.cloud.google.com/traces/list?project=hajimari-ai-hackathon-2026
# 期待: fugue.consult (top) → biblio.list (child) の親子関係、
#       attributes に channel='fugue' / fugue.request_id / biblio.request_id 揃う
```

```bash
# BigQuery で channel='fugue' の event log 到達確認 (dataset ID = llm_observability、事前確認済)
# 注: BQ sink は timestamp 列による column-based DAY partition = `_PARTITIONTIME` 疑似列
# (ingestion-time partition 専用) は存在しないため、`timestamp` 列で filter する。
# §M4-A Phase 3 / §M4-E Phase 4 の集計 SQL と同流儀で stdout/stderr を UNION ALL する。
bq query --project_id=hajimari-ai-hackathon-2026 --nouse_legacy_sql --format=pretty \
  "SELECT event, channel, COUNT(*) as cnt
   FROM (
     SELECT jsonPayload.event AS event, jsonPayload.channel AS channel, timestamp
     FROM \`hajimari-ai-hackathon-2026.llm_observability.stdout\`
     UNION ALL
     SELECT jsonPayload.event AS event, jsonPayload.channel AS channel, timestamp
     FROM \`hajimari-ai-hackathon-2026.llm_observability.stderr\`
   )
   WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)
     AND channel = 'fugue'
   GROUP BY 1, 2 ORDER BY cnt DESC LIMIT 20"
# 期待: fugue.consult.completed / fugue.consult.invoked 等が cnt >= 1
```

**Step 7: Fugue チーム連携 (domain + token を Secret 経由で共有)**

```
Fugue チームに Slack DM or ephemeral share で共有する値 (両方とも Secret Manager から取得):
  - DOMAIN: gcloud secrets versions access latest --secret=fugue-domain-name \
            --project=hajimari-ai-hackathon-2026
  - TOKEN:  gcloud secrets versions access latest --secret=fugue-shared-token \
            --project=hajimari-ai-hackathon-2026

Fugue 側 Cloud Run:
  - Fugue 自身の Secret Manager に BIBLIO_CLAW_URL = "https://${DOMAIN}" + FUGUE_SHARED_TOKEN
    として保管、Cloud Run env で secretRef 経由参照 (biblio 側の GSA 相当 IAM 権限は Fugue 側)
  - Fugue 側から consult / equip を実際に発火 → 応答確認 → 1 trace 串刺し確認
    Cloud Trace UI で Fugue 側 root span → biblio-claw の fugue.consult / fugue.equip が
    親子関係で見える = W3C traceparent 継承成立の実証
```

**Step 8: 完了マーカー refinement (Task 8、Task 7 = Step 0-7 完了後)**

- `CLAUDE.md` line 3 の `PR #XXX` を実 PR # に置換 (Phase 5 実装 PR、および fugue-domain 追加 PR)
- `.claude/PRPs/prds/m4/m4-e-fugue-integration.prd.md` Phase 5 status を `in-progress` → `complete`
- `.claude/PRPs/plans/phase-5-prod-deploy.plan.md` を `completed/` に archive

### Phase 5 完了判定 (4 assertion)

1. **Prod HTTPS で listen 成立**: Step 5 の直接 curl が 200 応答 (認証済)
2. **Ingress backend healthy**: `kubectl describe ingress biblio-fugue-channel -n biblio-claw | grep -A1 Backends` で `HEALTHY` 状態
3. **1 trace 串刺し**: Cloud Trace UI で `fugue.consult → biblio.list` の親子関係表示
4. **BQ sink 到達**: Step 6 の BQ query で `channel='fugue'` の row が cnt >= 1

**M4-E PRD 完了判定** = 上記 4 assertion + Fugue チーム側 verify 合同 exit 0。

> **Phase 6 で自動化済** (2026-07-03): 上記 4 assertion は `scripts/verify-fugue-channel.sh --prod`
> の Section 5-8 に組み込まれ、1 command で pass/fail 判定できるようになった。今後は手動で
> `curl` / `kubectl describe` / `bq query` を叩き直す代わりに verify script 実行を推奨。
> 詳細は §M4-E Phase 6 (下記) 参照。

### 再デプロイ手順 (image 更新のみ)

```bash
# init-project-gcp Phase 4.5 image-sync で新 tag (m4e-p5-N 等) を打った後:
kubectl set image statefulset/biblio-orchestrator -n biblio-claw \
  orchestrator=asia-northeast1-docker.pkg.dev/hajimari-ai-hackathon-2026/biblio-claw/biblio-claw:m4e-p5-<N>
kubectl rollout status statefulset biblio-orchestrator -n biblio-claw --timeout=10m
# Ingress / Service / Terraform は無変更で継続
```

### rollback 手順

```bash
# 案 1: image を Phase 4 完了時点の tag に戻す (fugue endpoint は残るが機能面 Phase 4 相当)
kubectl set image statefulset/biblio-orchestrator -n biblio-claw \
  orchestrator=asia-northeast1-docker.pkg.dev/.../biblio-claw:m4b-p4
# rollout status 待ち

# 案 2: Fugue endpoint 全撤去 (Ingress + Service + Fugue Secret + NetworkPolicy 削除)
#   注: envFrom biblio-fugue-shared-token が `optional: false` のため、Secret 削除だけで
#       StatefulSet が起動失敗する = 一時的に optional: true に変えるか StatefulSet manifest を revert
kubectl delete -f k8s/25-ingress-fugue-channel.yaml
kubectl delete -f k8s/27-networkpolicy-fugue-channel.yaml
kubectl delete -f k8s/26-service-fugue-channel.yaml
kubectl delete secret biblio-fugue-shared-token -n biblio-claw
git checkout HEAD~1 -- k8s/10-orchestrator-statefulset.yaml   # 例、Phase 5 前へ revert
kubectl apply -f k8s/10-orchestrator-statefulset.yaml

# 案 3: Terraform destroy (Fugue infra を完全削除、Fugue チーム連携が終わっていることが前提)
#   順序 = k8s Ingress + Secret 削除 → terraform destroy
#   sensitive var (`TF_VAR_domain_name` + `TF_VAR_fugue_shared_token`) は destroy 時も
#   必須 (Terraform lifecycle 経路の要求)、dummy 値で OK
cd terraform/fugue-channel
export TF_VAR_domain_name='biblio-claw-fugue.endpoints.hajimari-ai-hackathon-2026.cloud.goog'
export TF_VAR_fugue_shared_token='dummy-for-destroy'
terraform destroy
```

### 既知の罠 14 件

1. **Managed cert Active 化が 60 分超えるケース**:
   Google-managed cert の provisioning は DNS record propagate 済状態で始まる = DNS 先出しの
   順序が必須。CAA record を持つ domain / A record 未反映では cert が PROVISIONING で停止する。
   対処: DNS 反映を dig で確認してから cert status 監視ループに入る。

2. **K8s Secret sync 忘れ → StatefulSet 起動失敗**:
   `biblio-fugue-shared-token` Secret を作らずに StatefulSet apply すると、`envFrom` で
   `optional: false` 指定のため Pod が `CreateContainerConfigError` で立ち上がらない。
   意図した挙動 (silent skip 撲滅) = Secret 作成を先に済ませる。

3. **NEG annotation を省くと NetworkPolicy 有効時に backend unhealthy 継続**:
   `k8s/26-service-fugue-channel.yaml` の `cloud.google.com/neg: '{"ingress": true}'` を
   忘れると、GKE の自動 NEG 付与が NetworkPolicy 導入により条件から外れるため、Ingress
   backend が unhealthy 継続の silent failure に落ちる。JSON 書式のダブルクォート順序に注意
   (シングル外・ダブル内: `'{"ingress": true}'`)。

4. **`FUGUE_HTTP_HOST=0.0.0.0` 忘れ → LB 到達不能**:
   env を投入しないと `fugue.ts` factory は default `127.0.0.1` bind に落ちる = Pod IP に
   listen せず LB からの流入を受けられない silent failure。`.env.example` の警告 +
   StatefulSet manifest の env で 2 重に防御している。dev 経路で `127.0.0.1` にしたいときは
   local `.env` で override する。

5. **Terraform destroy 順序ミス → cert が Ingress attach 中で failed**:
   `google_compute_managed_ssl_certificate` が Ingress に attach されたままだと destroy が
   failed になる。上記 rollback 案 3 の順序 (Ingress delete → Secret delete → terraform destroy)
   が必須。runbook `terraform/fugue-channel/README.md` §Teardown 参照。

6. **Fugue チーム側 URL 切替タイミングずれ → old URL で 5xx 継続**:
   Fugue Cloud Run の `BIBLIO_CLAW_URL` env 切替は biblio 側 Step 6 (BQ 到達確認) 完了後に
   同期する。biblio 側 deploy 完了前に Fugue 側切替してしまうと、Fugue が old URL (DNS 未確定)
   で 5xx を継続受信する。Fugue チームとの手動同期 = Slack 等で「切替 OK」の合図を確認する運用。

7. **`FUGUE_SHARED_TOKEN` が「空文字値の Secret」で silent skip される**:
   K8s Secret `biblio-fugue-shared-token` は存在するが `FUGUE_SHARED_TOKEN` key の値が空文字
   の場合、`createFugueAdapter()` (`src/channels/fugue.ts:41`) は `null` を返し `channel:'fugue'`
   の warn ログ 1 行のみで fugue-http server が起動しない (Slack と対称の silent skip 設計)。
   Pod probe は全て exec `test -f /tmp/host-ready` = sentinel file のみ判定 = Pod は healthy
   のまま LB backend に組み入れられる。しかし Fugue endpoint への request は connection
   refused = Fugue Cloud Run 側で 5xx が上がり続ける。**検知経路**: Fugue Cloud Run 側の
   error log (5xx) + biblio 側 host log の `channel:'fugue'` warn 検索
   (`event:'fugue.adapter.credential_missing'` 等)。**対処**: Step 4 の Secret 作成時に
   `TOKEN=$(gcloud secrets versions access latest ...); [[ -n "$TOKEN" ]] || exit 1` で
   空文字を fail-fast (下記 罠 8 と対)、または `kubectl get secret biblio-fugue-shared-token
   -n biblio-claw -o jsonpath='{.data.FUGUE_SHARED_TOKEN}' | base64 -d | wc -c` で値の長さを
   post-deploy に確認する運用を追加。

8. **`gcloud secrets versions access` の `$(...)` 失敗が silent に空 Secret を作る**:
   Step 4 の `kubectl create secret generic biblio-fugue-shared-token
   --from-literal=FUGUE_SHARED_TOKEN="$(gcloud secrets versions access latest --secret=...)"`
   で、内側 `gcloud` が権限不足 / secret 名 typo / propagation 未完了で失敗しても、`$(...)`
   の空出力を kubectl は正常な空文字値として受け入れ Secret を「正常に」作成する。結果として
   罠 7 の crash-loop 回避経路に落ちる。**対処**: Step 4 のコマンドを 2 段に分ける
   (Step 4 本文で明示済)。

9. **Cloud Endpoints API 未有効化 → Terraform apply が `SERVICE_DISABLED` で失敗**:
   Step 0 の `gcloud services enable endpoints.googleapis.com` を skip すると、Terraform
   apply が `google_endpoints_service.fugue_dns` resource create で `SERVICE_DISABLED` エラーで
   fail-fast する。初回 setup のみ必要、以降の apply は enable 済で no-op。**対処**: 罠 8 と
   対称で Step 0 の有効化コマンドを罠として明示 = 手順書き漏れの再発を防ぐ。

10. **`envsubst` 未インストール → Step 4 の Ingress apply コマンドが shell error**:
    Step 4 の `envsubst '${DOMAIN}' < k8s/25-*.yaml | kubectl apply -f -` で `envsubst`
    (`gettext` package の一部) が PATH にないと shell が `command not found` を返す。
    WSL2 AlmaLinux 9 / Debian 系 / macOS 全て標準で入っていないケースあり。**対処**:
    `sudo dnf install gettext` (AlmaLinux/RHEL) / `sudo apt install gettext-base` (Debian) /
    `brew install gettext` (macOS) で導入。install 後、`which envsubst` で確認してから
    Step 4 に進む。

11. **`${DOMAIN}` を envsubst せずに `kubectl apply` = literal 登録で TLS SNI 不整合の silent 404**:
    `k8s/25-ingress-fugue-channel.yaml` の `host: ${DOMAIN}` は envsubst 前提で書かれている
    (public 化予定 repo に domain を hardcode しないため)。うっかり `kubectl apply -f
    k8s/25-ingress-fugue-channel.yaml` を直接叩くと、Ingress rule の host に literal
    `${DOMAIN}` が登録される。K8s 側 apply は成功、しかし LB の TLS SNI は Google-managed cert
    の SAN (実 domain) と不整合になり、全 request が **404 not_found または 421 Misdirected
    Request** で silent に落ちる。log からは Ingress が healthy に見える罠。**対処**: Step 4
    の `envsubst ... | kubectl apply -f -` パイプラインを必ず使う。手動 apply する場合も
    envsubst rendering 後の yaml を一度 file / stdout に確認してから apply する運用。

12. **NetworkPolicy egress で Cloud SQL Auth Proxy `:3307` 見落とし → OneCLI proxy 死んで listBiblio 30 秒 timeout**
    (Phase 5 実 deploy で silent-failure-hunter の指摘 [issue #128](https://github.com/HajimariInc/biblio-claw/issues/128)
    に追加事実として判明した重要な silent failure chain):

    Phase 5 で新規追加した NetworkPolicy `biblio-fugue-channel` の egress rule を `:443`
    (外部 HTTPS) + `:5432` (Cloud SQL 直接) のみ許可すると、**orchestrator Pod 内の
    `cloud-sql-proxy` sidecar は Cloud SQL Admin API 経路で instance に `:3307` で dial する**
    ため、その port が block されて `dial tcp 10.191.0.3:3307: i/o timeout` を継続する。

    silent failure chain (6 段):
    1. cloud-sql-proxy が `:3307` dial timeout
    2. OneCLI proxy (`onecli` sidecar) が Postgres query で `pool timed out while waiting
       for an open connection`
    3. OneCLI proxy が gh installation token の access_token 検証で agent lookup 失敗
    4. `CONNECT rejected: internal error host=api.github.com:443 error=db error`
    5. orchestrator の gh API 呼出 (biblio-shelf `marketplace.json` fetch) が 30 秒 timeout
    6. Fugue consult が `reason: 'other'` で `partial_failure`、応答は HTTP 200 だが
       `status: 'error'`

    症状: Phase 5 完了判定 4 assertion (HTTPS 200 + backend HEALTHY + trace + BQ) は満たされる
    が、内部 listBiblio 実データ通信が dead = Fugue MVP デモは成立不可の silent 状態。

    **対処**: `k8s/27-networkpolicy-fugue-channel.yaml` の egress rule に `- protocol: TCP,
    port: 3307` を追加 (Phase 5 の commit `c0de0dc` で対応済)。修正後の consult
    `processing_time_ms`: 30007ms → 374ms (80x speedup)。

    **hardening 反映 (issue #128、2026-07-03)**: 本罠の応急対処 (`0.0.0.0/0 :443/:5432/:3307` の
    broad rule) を目的別 3 rule + metadata 明示許可に分離:
    - Cloud SQL Auth Proxy 用: `10.191.0.0/16 :3307` (VPC peering CIDR + Admin API tunnel のみ、
      issue #128 実装時に確定)
    - GCE metadata (WI 経路) 用: `169.254.169.254/32 :80` (**PR #126 直後の追加発見**、下記 hardening
      Wave 2 参照)
    - 外部 HTTPS 用: `0.0.0.0/0 :443` (Vertex/GitHub/Cloud Trace/Secret Manager が相乗り)
    - `:5432` は cloud-sql-proxy の localhost listen 用のため Pod 外 dial 対象外 = rule から除去。

    **hardening Wave 2 (issue #128 実装中に発見した既存 broken の是正、2026-07-03)**: PR #126 で
    新設した本 NetworkPolicy は agent Pod の `k8s/60-netpol-agent-egress.yaml` の設計を継承した
    ため、egress rule に `except 169.254.169.254/32` (GCE metadata block) を含んでいた。しかし
    orchestrator Pod は agent Pod と違い、以下 3 経路が **Workload Identity 経由の metadata
    token を必須** とする:
    - `fetch-pem` initContainer: `gcloud secrets versions access` で ADC 解決 (WI 経由 GSA
      impersonation)
    - `cloud-sql-proxy` sidecar: sqladmin API token 取得 → instance metadata refresh → :3307 dial
    - `onecli` sidecar (Prisma): IAM DB auth token (`biblio-orchestrator@...iam@127.0.0.1:5432`)

    NetworkPolicy で `169.254.169.254` を block すると WI 経路が silent に死亡し、上記 3 経路が
    全て機能停止する。**Phase 5 実 deploy 直後 (罠 12 の 374ms 復旧観測時) は token cache
    (数時間有効) が生きていたため動いていた**が、数時間経過後は cache 期限切れで silent broken に
    移行 = Fugue MVP 完全機能停止。

    **確認方法**: `kubectl exec biblio-orchestrator-0 -c fetch-pem -- gcloud config list` で
    active account が空 = broken。`kubectl exec ... -c orchestrator -- node -e
    "fetch('http://metadata.google.internal/...')"` が 5 秒 timeout も broken の signature。

    **対処**: 本 hardening (issue #128) で `except 169.254.169.254/32` を削除し、代わりに
    `169.254.169.254/32 :80` の専用 rule を明示追加。agent Pod の egress rule は OneCLI 経由前提
    のため metadata block を維持 (この差分は本 orchestrator Pod と agent Pod の役割違いに基づく
    正当な非対称性)。apply 後は Pod rollout restart で新 Pod が起動 → WI 経路復活 → 全 keyless
    ADC 復旧を実機確認済 (2026-07-03):
    - (1) `fetch-pem` initContainer exit 0 → Pod Ready 5/5 復活 (crash-loop 解消)
    - (2) `cloud-sql-proxy` log: `Authorizing with ADC` → `Ready for new connections!` → `refresh
      error` なし (i/o timeout 完全解消)
    - (3) `onecli` gateway (`localhost:10254`): 500 → 200、`agents count = 6` (DB read 復活)
    - (4) WI 直接 test (`fetch('http://metadata.google.internal/...')`): timeout → 200 応答
    - (5) `consult processing_time_ms = 499ms` (罠 12 復旧値 374ms 相当、`listBiblio total=1`
      で listBiblio 経路も完全復活)

    **教訓**: silent failure 再発の教訓として、新 port を egress 許可する際は「Pod 外 dial か /
    localhost listen か」を必ず区別する。localhost listen port (cloud-sql-proxy の :5432) は
    NetworkPolicy 対象外のため rule に追加すると dead code = 意図せぬ許可の温床になる。

    **Cloud SQL private IP CIDR の再検証手順**: `10.191.0.0/16` は repo 内に IaC declare が
    ない (Terraform module にも定義なし) = manifest 側に hardcode。Cloud SQL の region 移設や
    peering 再割当があった場合は以下で再検証 + `k8s/27-networkpolicy-fugue-channel.yaml` を更新する:
    ```bash
    gcloud sql instances describe biblio-pgsql \
      --project=hajimari-ai-hackathon-2026 \
      --format='value(ipAddresses[].ipAddress)'
    gcloud compute addresses list \
      --filter="purpose:VPC_PEERING AND project:hajimari-ai-hackathon-2026" \
      --format='table(name,address,prefixLength,subnetwork)'
    ```

13. **Cert Active 化には Ingress apply (Load Balancer authorization) が必要 = Terraform apply 直後の cert 待ちは無意味**:
    Google-managed cert (`google_compute_managed_ssl_certificate`) は Domain Validation (DV)
    方式で、**Load Balancer が cert を serve できる状態を Google Cert Authority が検証する**。
    Terraform apply 直後は LB (Ingress) が存在しないため cert status は `PROVISIONING`、domain
    status は `FAILED_NOT_VISIBLE` で無限に stuck する。旧 runbook (Phase 5 実 deploy 前) の
    「Step 3 で cert Active 待ち → Step 4 で K8s apply」順序はここで永久 stuck する bug だった。

    **正しい順序**: Terraform apply → K8s Secret + StatefulSet + Service + NetworkPolicy + Ingress
    apply → cert が LB に attach → Google Cert Authority が Load Balancer authorization を
    再試行 → cert Active 化 (15-30 分)。runbook Step 3 は「DNS 反映確認のみ」、Step 4.5 で
    cert Active 化を待つ経路が正解。

    **検知経路**: `gcloud compute ssl-certificates describe biblio-fugue-channel-cert
    --global --format='value(managed.domainStatus)'` で `FAILED_NOT_VISIBLE` が継続する場合、
    Ingress apply していない可能性を疑う (Cloud SQL 到達性 or NEG 反映は別問題)。

14. **Cert Active 直後は LB frontend の cert rollout に追加 1-5 分 = curl `SSL_ERROR_ZERO_RETURN`**:
    `gcloud compute ssl-certificates describe` の status が `ACTIVE` になった **直後** に curl
    で HTTPS を叩くと、`OpenSSL SSL_connect: SSL_ERROR_ZERO_RETURN` = **TLS handshake が Server
    側で close** される現象が発生する。これは cert Active になっても LB frontend への cert
    rollout が完了していないタイミング。

    実測: cert Active から **1-3 分後** に TLS handshake が成立、curl 200 応答に切り替わる。
    最大 5 分見込み。runbook Step 4.5 の後半で TLS handshake poll ループ (12 回 x 30 秒 = 6 分)
    を経て verify Step 5 に進む運用。

### 関連

- Source PRD: `.claude/PRPs/prds/m4/m4-e-fugue-integration.prd.md` (Phase 5)
- Source Plan (archived): `.claude/PRPs/plans/completed/phase-5-prod-deploy.plan.md`
- Terraform module: `terraform/fugue-channel/` (README.md に apply / verify / teardown 手順)
- k8s manifest 4 file: `k8s/{10-orchestrator-statefulset,25-ingress-fugue-channel,26-service-fugue-channel,27-networkpolicy-fugue-channel}.yaml`
- 継承元 §M4-E Phase 4 (本 runbook 上部): 2 段 trace 構造 + AD の本義 + ESM フック判断
- 継承元 §M4-A Phase 3 (本 runbook 上部): BQ sink 集計 SQL テンプレ (Phase 5 で `<DATASET_ID>` 置換)

---

## M4-E Phase 6: verify-fugue-channel.sh (Fugue channel MVP 完成判定 5 軸 assertion)

Phase 5 実 apply で確定した「4 assertion」 (Prod HTTPS 200 / Ingress backend HEALTHY /
Cloud Trace `fugue.consult → biblio.list` 親子 / BQ sink `channel='fugue'` row >= 1) を
`scripts/verify-fugue-channel.sh` で E2E assertion 化。5 軸 (疎通 / 認証 / HITL 簡略化 /
channel 分離 / keyless) × 2 環境 (local docker compose / Prod GKE) を 1 command で
pass/fail 判定できる状態にした。

### 概要

**verify-fugue-channel.sh の Section 分割 (全 10 section)**:

- Section 1: Preflight (共通、全 mode 発火) — .env / 必須 CLI / kubectl context / Secret Manager Token/Domain 取得 / 罠 2/4/7/8 の pre-detect
- Section 2: LOCAL 疎通 + 認証 — 127.0.0.1:8080 curl /healthz + consult 200 + equip 200 + auth-fail 401
- Section 3: LOCAL HITL 簡略化 — 3 point AND (reply not hitl_required + host log 不在 + local SQLite pending_approvals 0 件)
- Section 4: LOCAL channel 分離 — SQLite 2 table 独立性 (fugue_equipped_biblios + session_equipped_biblios 存在 + row 追加 + session 無影響 + 静的 grep)
- Section 5: PROD 疎通 + 認証 — Prod HTTPS /healthz + consult 200 + auth-fail 401 (罠 12 detect: consult error 応答)
- Section 6: PROD Ingress backend HEALTHY — NEG annotation + backend-services 名動的解決 + get-health 全 HEALTHY
- Section 7: PROD Cloud Trace 親子関係 — 決定的 trace_id 生成 + consult 発火 + REST v1 retry 30×3s + 親子 assert + channel='fugue' label assert
- Section 8: PROD BigQuery sink — stdout/stderr で `jsonPayload.channel = 'fugue'` の row cnt >= 1 (retry 6×10s + 3 連続 fail early abort)
- Section 9: PROD HITL 簡略化 + channel 分離 — Prod GKE 上で equip 発火 + 3 point AND (Pod ログ + Prod SQLite) + channel 分離 SQLite 2 assertion
- Section 10: PROD keyless 3 段 — KSA annotation + GSA IAM workloadIdentityUser binding + no USER_MANAGED key

### 実行手順

```bash
# --- 1. local mode (docker compose + host orchestrator 起動時) ---
docker compose up -d --wait
pnpm run dev &   # host orchestrator 起動 (別 terminal 推奨)

bash scripts/verify-fugue-channel.sh --local
# 期待: M4-E PASS (local) + exit 0

# --- 2. Prod mode (Phase 5 実 apply 済) ---
# 前提: gcloud auth application-default login 済、kubectl context=biblio-prod、GCP_PROJECT_ID / BQ_DATASET_ID 設定済

bash scripts/verify-fugue-channel.sh --prod
# 期待: M4-E PASS (prod) + exit 0

# --- 3. both mode (両環境揃うとき) ---
bash scripts/verify-fugue-channel.sh
# 期待: M4-E PASS (both) + exit 0

# --- 4. 2 連続実行で冪等性確認 ---
bash scripts/verify-fugue-channel.sh --prod && bash scripts/verify-fugue-channel.sh --prod
# 期待: 両方 exit 0 (trap cleanup が fugue_equipped_biblios verify 用 row を DELETE、次回も 200 経路が動く)
```

**Expected Output (stdout 末尾)**:

```
[INFO]   all assertions passed
M4-E PASS (prod)
```

### M4 統合 verify (verify-m4.sh)

M4-A + M4-B + M4-E の chain を 1 command で回す統合 verify:

```bash
bash scripts/verify-m4.sh
# 期待: M4 PARTIAL PASS (A+B+E) + exit 0
# 所要時間: ~10-20 min (verify-m4-a ~5min + verify-m4-b ~5-10min + verify-fugue-channel --prod ~3-5min)
```

M4-C (reporting) / M4-D (presentation-ui) は未実装のため verify chain には含まれない
(M4 milestone 完成時に verify-m4.sh に追加)。

### 罠 14 件との対応 (verify で pre-detect する 6 件)

verify script で事前 detect する対象は下記に限定 (残り 8 件は deploy 手順側の責務):

- **罠 2 (K8s Secret 不在)**: Section 1 preflight で `kubectl get secret biblio-fugue-shared-token` チェック
- **罠 3 (NEG annotation)**: Section 6 で `svc annotations.cloud.google.com/neg` チェック
- **罠 4 (`FUGUE_HTTP_HOST=0.0.0.0` 忘れ)**: Section 1 preflight で `kubectl exec ... printenv FUGUE_HTTP_HOST` == `0.0.0.0` チェック
- **罠 7 (`FUGUE_SHARED_TOKEN` 空文字 silent skip)**: Section 1 preflight で Secret 値の base64 decode 後の長さ >= 32 チェック
- **罠 8 (`gcloud secrets versions access` silent 空応答)**: Section 1 preflight で `[[ -n "$DOMAIN" ]]` + `[[ -n "$PROD_TOKEN" ]]` チェック
- **罠 12 (NetworkPolicy egress `:3307` 欠落 → consult partial_failure)**: Section 5 の consult 応答で `status:'ok'` を assert (`partial_failure` = `status:'error'` になるため異常検知)

### Fugue チーム合同 verify (separate step)

本 script は biblio 側 exit 0 まで担当。合同 verify (Fugue Cloud Run から実発火 + biblio 側
Cloud Trace で trace 串刺し + `verify-biblio-integration.sh` 相互確認) は次の手順で実施:

```bash
# 1. biblio 側 exit 0 確認
bash scripts/verify-fugue-channel.sh --prod
# → M4-E PASS (prod) 確認

# 2. DOMAIN + TOKEN を Fugue チームに通知
DOMAIN=$(gcloud secrets versions access latest --secret=fugue-domain-name \
  --project=hajimari-ai-hackathon-2026)
TOKEN=$(gcloud secrets versions access latest --secret=fugue-shared-token \
  --project=hajimari-ai-hackathon-2026)
echo "biblio-claw DOMAIN=https://${DOMAIN} TOKEN=${TOKEN:0:8}..."
# → Slack DM (ephemeral share 推奨) で full token + DOMAIN を共有

# 3. Fugue チーム側 verify-biblio-integration.sh 実行 (Fugue repo)
# 4. 両側 exit 0 確認 → M4-E PRD 完了判定成立

# 5. シナリオ 1 (Figma) 10 分デモを Fugue チームと合同で実施
```

**M4-E PRD 完了判定成立の条件**:

| PRD 成功シグナル | 本 Phase での対応 |
|---|---|
| `bash scripts/verify-fugue-channel.sh --local` exit 0 | verify script 実装で担保 |
| `bash scripts/verify-fugue-channel.sh --prod` exit 0 | verify script 実装で担保 |
| Fugue 側 `verify-biblio-integration.sh` との相互確認 = 両側 exit 0 | separate step (上記手順で運用) |
| シナリオ 1 (Figma) 10 分デモが本番 GKE 上で通る | separate step (Fugue チームと合同実施) |

上 2 件は本 script の直接的 deliverable、下 2 件は本節の運用手順 + DEN さん HITL 実行。

### 関連

- Source PRD: `.claude/PRPs/prds/m4/m4-e-fugue-integration.prd.md` (Phase 6)
- Source Plan (archived): `.claude/PRPs/plans/completed/phase-6-verify-fugue-channel.plan.md`
- verify script: `scripts/verify-fugue-channel.sh` (Section 1-10) + `scripts/verify-m4.sh` (統合 chain)
- 継承元 §M4-E Phase 5 (本 runbook 上部): 罠 14 件 + Prod deploy 手順 + 4 assertion 手動確認

---

## 関連

- Slack 環境分離の手順:[slack-environments-setup.md](slack-environments-setup.md)
- host ログの読み方・トラブル切り分け:ルート `CLAUDE.md` の「トラブルシューティング」節
- OneCLI / secret / 承認の配線:ルート `CLAUDE.md` の「シークレット / クレデンシャル / OneCLI」節
