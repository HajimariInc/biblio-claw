# 運用 Runbook — ログ・状態確認・管理コマンド(ローカル / GCP)

最終更新:2026-06-17

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

### 2. agent container(agent-runner)

| 操作 | ローカル | GCP |
| :--- | :--- | :--- |
| **ログ** | `docker logs <container> -f` | `kubectl logs <agent-pod> -n biblio-claw -f` |
| **一覧** | `docker ps --filter name=nanoclaw` | `kubectl get pods -l app.kubernetes.io/component=agent -n biblio-claw` |
| **再起動/kill** | `pnpm run ncl groups restart --id <AGENT_GROUP_ID>` | `kubectl exec biblio-orchestrator-0 -n biblio-claw -c orchestrator -- sh -c "cd /app && pnpm run ncl groups restart --id <AGENT_GROUP_ID>"` |
| **孤児の強制削除** | `docker rm -f <container>` | `kubectl delete job <job-name> -n biblio-claw`(host 台帳外の孤児用) |

> ⚠️ **agent ログはコンテナ終了で消える**(ローカルは `--rm`、GCP も Job 完了後 pod が剥がれる)。silent fail を追うなら**生きているうちに**採取する。再起動は host 経由(`ncl groups restart`)が基本で、`kubectl delete job` は host が見失った孤児専用。

### 3. OneCLI gateway

| 操作 | ローカル | GCP |
| :--- | :--- | :--- |
| **ログ** | `docker logs biblio-onecli -f` | `kubectl logs biblio-orchestrator-0 -n biblio-claw -c onecli -f` |
| **状態 / agent 一覧** | `curl -s http://127.0.0.1:10254/v1/agents` | Pod 内から:`kubectl exec biblio-orchestrator-0 -n biblio-claw -c orchestrator -- node -e "fetch(process.env.ONECLI_URL+'/v1/agents').then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,0)))"` |
| **secret 一覧** | `curl -s http://127.0.0.1:10254/v1/secrets` | port-forward 経由 or 上記 fetch を `/v1/secrets` に |
| **Web UI** | http://127.0.0.1:10254 | `kubectl port-forward svc/biblio-onecli -n biblio-claw 20254:10254` → http://127.0.0.1:20254 |
| **token 再投入** | `bash scripts/onecli-vertex-secret.sh` / `bash scripts/onecli-gh-secret.sh` | **不要**(sidecar が自動更新。下記) |

> GCP の `/v1/agents` は **orchestrator Pod 内から叩く**こと。ローカル端末から port-forward 経由で叩くと auth context が違い別 view になる(CLAUDE.md の罠参照)。

### 4. token rotator(GCP のみ、自動更新)

| | コマンド |
| :--- | :--- |
| GH token rotator ログ | `kubectl logs biblio-orchestrator-0 -n biblio-claw -c gh-token-rotator -f` |
| Vertex token rotator ログ | `kubectl logs biblio-orchestrator-0 -n biblio-claw -c vertex-token-rotator -f` |

ローカルには rotator がない → **Vertex token は ~1h で失効**するので `bash scripts/onecli-vertex-secret.sh` を手動再実行(401 が出たら)。

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

- biblio-claw は仕入れ経路で `gh api repos/<owner>/<repo>`(= `api.github.com`)と `git clone https://github.com/...`(= `github.com`)の **2 経路** を子プロセスで叩く。
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
- 検品(Vertex × Gemini)と陳列(GitHub Git Data API)はどちらも `api.github.com` 系 host pattern マッチなので MITM 経路で動く。`git clone`(`github.com`)だけが tunnel 経路。

---

## M2 完成判定 verify(`scripts/verify-m2.sh`)

M2 PRD B Phase 3 で導入した E2E 検証スクリプト。Slack 入力 → 仕入れ → 検品 → カテゴライズ → 陳列(棚リポへ draft PR 作成) → 重複検知 の 6 段を 1 度に流す。host process は起動不要 — 各段の CLI ハーネス(`scripts/biblio-{acquire,inspect,categorize,shelve}.ts`)が `initHostProxy()` / `setupVertexProxy()` を自前で呼ぶ。

### 前提セットアップ(Phase 1+2+3 合算)

| # | 項目 | コマンド/確認 |
| :---: | :--- | :--- |
| 1 | docker compose 起動 | `docker compose up -d --wait`(OneCLI gateway = localhost:10254 / proxy = :10255) |
| 2 | `.env` 設定 — Vertex / GH / SHELF / Model | `ANTHROPIC_VERTEX_PROJECT_ID` / `CLOUD_ML_REGION` / `INSPECT_DANGEROUS_MODEL` / `CATEGORIZE_MODEL` / `GH_APP_ID` / `GH_INSTALLATION_ID` / `GH_APP_PEM_PATH` / `SHELF_REPO_OWNER` / `SHELF_REPO_NAME` / `SHELF_PR_AUTHOR_NAME` / `SHELF_PR_AUTHOR_EMAIL`(全て non-empty) |
| 3 | OneCLI Vertex secret 投入 + mode=all 昇格 | `bash scripts/onecli-vertex-secret.sh` |
| 4 | OneCLI GH secret 投入 + mode=all 昇格 | `bash scripts/onecli-gh-secret.sh`(`hj-biblio-github-app` の installation token を投入) |
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
- **shelf 内の biblio が残った**: `ls .data/shelf/` で確認 → 不要なら `rm -rf .data/shelf/<category>/<owner--name>`
- **`marketplace.json` への entry は draft PR を close = branch 削除すれば消える**(main は更新されていない)

### GKE 経路で実行する場合(将来運用、現状は local のみ)

orchestrator Pod 内から実行する。GKE では sidecar が GH/Vertex token を自動 rotate するため、ステップ 3-5 は不要(steps 1-2 は `.env` ではなく Secret 経由)。

```bash
kubectl exec biblio-orchestrator-0 -n biblio-claw -c orchestrator -- \
  sh -c 'cd /app && bash scripts/verify-m2.sh HajimariInc/biblio-shelf'
```

---

## 関連

- Slack 環境分離の手順:[slack-environments-setup.md](slack-environments-setup.md)
- host ログの読み方・トラブル切り分け:ルート `CLAUDE.md` の「トラブルシューティング」節
- OneCLI / secret / 承認の配線:ルート `CLAUDE.md` の「シークレット / クレデンシャル / OneCLI」節
