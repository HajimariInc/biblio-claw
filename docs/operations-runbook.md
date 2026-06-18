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

## 関連

- Slack 環境分離の手順:[slack-environments-setup.md](slack-environments-setup.md)
- host ログの読み方・トラブル切り分け:ルート `CLAUDE.md` の「トラブルシューティング」節
- OneCLI / secret / 承認の配線:ルート `CLAUDE.md` の「シークレット / クレデンシャル / OneCLI」節
