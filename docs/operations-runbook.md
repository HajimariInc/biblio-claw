# 運用 Runbook — ログ・状態確認・管理コマンド(ローカル / GCP)

最終更新:2026-06-27

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
| M3-b | shelf に biblio が 1 件以上 main merge 済 | `pnpm exec tsx scripts/biblio-list.ts` で `total > 0` を確認。0 件の場合は `acquire → inspect → categorize → shelve` の 4 段 CLI で 1 件投入 → GitHub UI で draft PR を merge(= verify-m2 の auto-cleanup を経ない経路、verify-m3 では destructive 経路の対象 biblio が必要なため) |
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
```

全 6 assertion 緑 → `M3 PASS (local|gke|both)` を stdout に出して exit 0。実時間 ~36 秒(= 全段順次)。`trap cleanup EXIT INT TERM` で:

- enkin/shokyaku draft PR を `gh pr list --search 'is:pr is:open draft:true (head:enkin/ OR head:shokyaku/)'` で検索 → `gh pr close --delete-branch` で auto-close
- `$STDERR_DIR` を rm -rf

### 後始末(verify 中断時)

- **draft PR が残った(= trap 走らず)**: `gh pr list --repo HajimariInc/biblio-shelf --state open --search 'in:title enkin OR in:title shokyaku' | head -10` で目視 → `gh pr close --repo HajimariInc/biblio-shelf --delete-branch <PR#>` で個別 close
- **shelve 済 biblio が消えた(= destructive 経路で焼却された)**: 次回 verify-m3.sh 実行前に同 biblio を再 shelve + main merge(= 連続 run の `not_shelved` 連鎖の救済は `verify-m3-phase-3.sh:247-255` で吸収されるが、`total > 0` を維持するため次回前に投入推奨)
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

```bash
GOOGLE_CLOUD_PROJECT=hajimari-ai-hackathon-2026 pnpm run otel-smoke-test
# 出力: RESULT={"trace_id":"<32hex>"}

TRACE_ID=<上記>
sleep 30
# `gcloud trace` CLI は廃止済 (= "Invalid choice: 'trace'")。Cloud Trace v1 REST API を直叩き。
TOKEN=$(gcloud auth application-default print-access-token)
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://cloudtrace.googleapis.com/v1/projects/hajimari-ai-hackathon-2026/traces/${TRACE_ID}" \
  | jq '{traceId, spans: [.spans[] | {name, labels}]}'
# 同 TRACE_ID と labels.gcp.project_id / service.name / biblio.phase が返れば PASS
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

1. **smoke-test 起動時のログ**:`[otel] init failed` warn が出ているか → init 段階の失敗(projectId 不在 / ADC 不在 / network)
2. **stdout の `RESULT={...}` 出力**:span 自体は生成されているか
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
- `scripts/otel-smoke-test.ts`(疎通スクリプト)
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

projectId 解決ロジックは持たない (= Cloud Logging UI が現在の project context で resolve する設計、`projects/<project>/traces/<id>` の Legacy full path 経路は採用していない。UI 遷移が立たない事象が出たら plan §Fallback Option G に切替判断)。

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
- PoC-10 `/home/proj/wforest/repos/PoC/biblio-poc-10-logging-bigquery/` (写経元)

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

### 内部フロー (7 セクション)

1. **preflight** — `.env` 読み + 必須 env + CLI 存在 (gcloud / bq / jq / node)
2. **keyless 4 面** — `GOOGLE_APPLICATION_CREDENTIALS` 未設定 / ADC type が authorized_user|external_account|impersonated_service_account / repo 内に SA key json 不在 / TF に `google_service_account_key` resource 不在
3. **emit-test-span** — `OTEL_DIAG=true pnpm exec tsx --import ./src/instrumentation.ts scripts/emit-test-span.ts` 実行、stdout から `TRACE_ID` / `REQUEST_ID` / `SESSION_ID` 抽出 (`--import` は NodeSDK を main より前にロードする唯一の経路、`OTEL_DIAG=true` は OTLP export 失敗を stderr に流すための強制 diag、PR #75 提案 D)
4. **Cloud Trace poll** — `https://cloudtrace.googleapis.com/v1/projects/.../traces/<TRACE_ID>` を sleep 3 × 30 (90s) ポーリング、span >= 1 で break、root span 名 = `biblio.acquire` + `labels[biblio.request_id]` 一致を assert
5. **BQ poll** — `stdout` / `stderr` テーブル (= sink の `use_partitioned_tables=true` で生成される単独形、`timestamp` 列で DAY partition) を `bq ls` で動的列挙、各テーブルに `WHERE JSON_VALUE(jsonPayload, '$["logging.googleapis.com/trace"]') = 'projects/<PROJECT>/traces/<TRACE_ID>' AND timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)` (= partition pruning) で sleep 10 × 30 (5 min) ポーリング、count >= 1 で break
6. **summary SQL** — `sed` で `<PROJECT_ID>` / `<DATASET_ID>` を置換した `terraform/m4-a-observability/sql/summary.sql` を実行、`hit_count >= 1` + `marker = 'M4A_OK'` を assert
7. **ネガティブ対照** — random GHOST_TRACE_ID (128-bit) で BQ 0 行を assert + `main.tf` の sink filter に `k8s_container` / `namespace_name=` の両方が残っていることを静的反証

### 既知の罠 / 解釈

- **Cloud Trace 90s timeout で偽 fail** — 多くは下記 2 つの原因。fail メッセージ内の "対処" 案内も同じ順で参照する:
  1. **`roles/cloudtrace.user` 不足** — 30 回 retry でほぼ全て 403 を返す。Section 4 の poll ループは attempt 3 で warn を 1 度出す設計 (PR #75 提案 A-1)
  2. **OTLP export 失敗** — `BatchSpanProcessor` が export エラーを内部 catch して `shutdownOtel()` が resolve する OTel SDK 仕様の限界 (PR #75 Important 問題 3)。verify は `OTEL_DIAG=true` を emit-test-span に渡して export エラーを stderr に流し、`LAST_HARNESS_STDERR` 経由で fail 時に展開する (PR #75 提案 D 対症)
  3. それ以外: ネットワーク不調 / `BatchSpanProcessor` flush 遅延 — 再実行で多くは解決
- **BQ 5 min timeout で偽 fail** — sink lag 通常 30s 程度だが、初動直後や高負荷時は数分かかる。fail メッセージで sink writer_identity の `roles/bigquery.dataEditor` 付与 + filter の k8s_container/namespace 整合を案内
- **BQ poll の auth-fail early abort** — outer 反復 3 連続で全テーブル query 失敗時 (= persistent な auth 切れ / 権限不足 / network 障害) は 5 分待たず 30s で fail する設計 (PR #75 提案 silent-failure 問題 2)。fail メッセージで `gcloud auth application-default print-access-token` と `roles/bigquery.dataViewer` 付与の確認を案内
- **BQ poll の partition pruning** — verify は `WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)` で過去 1h に絞った partition のみ scan する設計 (sink の `use_partitioned_tables=true` で生成される DAY partition を効かせ、cost + 性能を担保)。emit-test-span → BQ 到達まで通常 30s 程度のため 1h で十分
- **`stdout` / `stderr` テーブル不在** — Phase 3 sink がまだ初動していない可能性。biblio action を 1 回実行して 5 分待ってから再実行 (= テーブルは sink が最初の log 流入時に自動生成、`terraform apply` 単独では作られない)
- **`JSON_VALUE` の JSON path 構文** — フィールド名にドット (`logging.googleapis.com/trace`) を含むため bracketed 形式 `'$["logging.googleapis.com/trace"]'` が必須。`jsonPayload.foo.bar` のドット記法では拾えない
- **ネガティブ対照の意義** — random trace_id で BQ に 0 行 = sink filter が「無関係な trace を黙って通していない」証跡。1 行でも hit したら sink filter または BQ schema を疑う (衝突確率 ~2^-128 = 事実上ゼロ)
- **冪等性** — 2 連続実行で両方 PASS する設計。各実行で新規 trace_id を発射、summary `hit_count` は過去 1h 集計に積算される (= 2 回目で増えるのは正常)

### test fixture (`scripts/emit-test-span.ts`)

`withBiblioActionSpan('acquire', requestId, sessionId, fn)` を直接呼ぶ test fixture。本番 `acquire()` ロジック (GitHub clone 等) は起こさない = 外部依存をパイプ疎通のみに絞り、verify を deterministic に保つ。span 属性は `biblio.request_id` / `biblio.session_id` / `biblio.action='acquire'` + `biblio.test_fixture=true` + event `verify-m4-a.fixture.emitted`。

### Teardown

verify は副作用なし (= shelf / DB / 既存リソース変更なし)。残存リソースは Cloud Trace span と BQ row のみで、Cloud Trace は 30 日 / BQ は dataset の `default_table_expiration_ms` (= 90 日) で自動失効。明示削除不要。

### 関連

- `scripts/verify-m4-a.sh` (本体)
- `scripts/emit-test-span.ts` (test fixture)
- `scripts/verify-m3-helpers.sh` (info/warn/fail 等 source 元)
- `terraform/m4-a-observability/sql/summary.sql` (summary SQL、`<PROJECT_ID>` / `<DATASET_ID>` placeholder)
- PoC-8 `/home/proj/wforest/repos/PoC/biblio-poc-8-observability/verify.sh` (写経元)
- PoC-10 `/home/proj/wforest/repos/PoC/biblio-poc-10-logging-bigquery/scripts/verify.sh` (写経元)

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

## 関連

- Slack 環境分離の手順:[slack-environments-setup.md](slack-environments-setup.md)
- host ログの読み方・トラブル切り分け:ルート `CLAUDE.md` の「トラブルシューティング」節
- OneCLI / secret / 承認の配線:ルート `CLAUDE.md` の「シークレット / クレデンシャル / OneCLI」節
