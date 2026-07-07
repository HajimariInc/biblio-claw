# Slack 環境分離セットアップ — GCP / ローカル

最終更新:2026-06-17

> **語彙メモ**: biblio-claw 独自語彙 (`biblio` / `司書` / `patron` / `装備` / `禁書` / `焼却` 等) の解説は [`glossary.md`](glossary.md) 参照。

biblio-claw を **GCP(本番相当)とローカル(開発)で別々の Slack App = 別ワークスペース**に分けて運用するための手順。メンション/DM 先で「どちらの環境の Claw が反応するか」を選べるようにする。

| 環境 | Slack App(例) | 反応するプロセス | 中央 DB |
| :--- | :--- | :--- | :--- |
| **GCP** | `biblio-slack-app`(本番 ws) | `biblio-orchestrator-0` Pod(`biblio-claw` ns) | GKE 側 `/data/v2.db` |
| **ローカル** | `biblio-local`(開発 ws) | `pnpm run dev` の host | ローカル `data/v2.db` |

## なぜ別 App / 別ワークスペースにするか

- **Socket Mode の token は App 単位**。GCP とローカルが同じ App token で同時に Socket 接続すると、Slack 側でイベントを取り合う。App を分ければ token も接続も独立し、競合が原理的に起きない。
- **ワークスペースごとにメッセージが物理隔離**される。開発のテスト発話が本番に混ざらない。
- メンション先(= bot)で環境を選べる:本番 ws の bot に話す → GCP、開発 ws の bot に話す → ローカル。

> **重要な落とし穴 — ワークスペースごとに「自分」の user ID が違う**
> Slack の user ID / channel ID は **ワークスペース単位で一意**。同じ人でもワークスペースが違えば user ID が変わる(例:本番 ws では `U9V1A1MNE`、開発 ws では `U7F8TRM6X`)。owner / wiring / destination は**ワークスペース(= DB)ごとに別々**にセットアップする必要があり、user ID の取り違えが最大の事故源になる。

## 仕組み(どこが受けるか)

Slack イベントは Socket Mode(host/orchestrator から外向きに張る WebSocket)で届く。

- host 側で Slack adapter が読む env は **`SLACK_BOT_TOKEN` と `SLACK_APP_TOKEN` の 2 つだけ**(`src/channels/slack.ts` の `readEnvFile([...])`)。`SLACK_SIGNING_SECRET` は **Socket Mode では不要**(Events API のリクエスト署名検証用なので)。
- 起動ログの `Slack auth completed { botUserId: ... }` でどの bot(= どの App)に接続したか判別できる。

---

## 前提:Slack App の用意(各ワークスペース)

1. ワークスペースに Slack App を作成(本番用・開発用で別 App)
2. **Socket Mode を有効化**し、**app-level token**(scope `connections:write`、`xapp-…`)を発行
3. Bot token(`xoxb-…`)を取得、必要 scope(`app_mentions:read`、`chat:write`、`im:history`、`im:read`、`im:write` など)
4. Event Subscriptions で `app_mention` / `message.im` を購読
5. bot を対象の DM/channel に追加

---

## GCP 側セットアップ

### 1. Slack token を K8s Secret に投入

格納先は Secret **`biblio-slack-tokens`**(`biblio-claw` ns)。`k8s/10-orchestrator-statefulset.yaml` が `envFrom: secretRef`(optional)で読むので、**Secret のキー名がそのまま env 変数名**になる。

token 値をプロンプト/コマンド履歴に出さないため、値ファイル経由で投入する(`.secrets/` は gitignore 済み):

```bash
# .secrets/slack-gcp.env に 2 行書く(SLACK_SIGNING_SECRET は不要):
#   SLACK_BOT_TOKEN=xoxb-…
#   SLACK_APP_TOKEN=xapp-…

kubectl create secret generic biblio-slack-tokens \
  --from-env-file=.secrets/slack-gcp.env -n biblio-claw \
  --dry-run=client -o yaml | kubectl apply -f -
```

### 2. orchestrator を restart(env 再読込 + Socket 張り直し)

```bash
kubectl rollout restart statefulset biblio-orchestrator -n biblio-claw
kubectl rollout status  statefulset biblio-orchestrator -n biblio-claw --timeout=180s
# ログで botUserId が期待どおりか確認:
kubectl logs biblio-orchestrator-0 -n biblio-claw -c orchestrator --since=3m | grep -iE 'auth completed|socket mode'
```

### 3. owner / wiring / destination を整える(ncl)

ncl は orchestrator Pod 内で実行する(`kubectl exec biblio-orchestrator-0 -n biblio-claw -c orchestrator -- sh -c "cd /app && pnpm run ncl <…>"`)。

**まず対象ワークスペースの自分の user ID を確定させる**:bot に **DM を 1 回送る**と、host が cold-DM として `users` と `messaging_groups` に自動登録する。`ncl users list` でその user ID(例:`slack:U9V1A1MNE`)と、`messaging_groups` の新しい行(DM channel)を確認する。

```bash
# 1) owner 付与(その ws の自分の user ID)
ncl roles grant --user slack:<USER_ID> --role owner

# 2) DM messaging_group を agent group に wiring(DM は engage-mode=pattern / pattern='.' で全マッチ)
ncl wirings create --messaging-group-id <MG_ID> --agent-group-id <AGENT_GROUP_ID> \
  --engage-mode pattern --engage-pattern '.' --sender-scope all \
  --ignored-message-policy drop --session-mode shared

# 3) agent が返信を送る宛先(destination)を登録 — target は DM の messaging_group
ncl destinations add --agent-group-id <AGENT_GROUP_ID> \
  --local-name slack-<短縮名> --target-type channel --target-id <MG_ID>
```

> **ワークスペースを引っ越したとき(= App を別 ws のものに差し替えたとき)の後始末**
> 旧 ws の owner / wiring / destination が残っていると次のエラーになる。新 ws の値で作り直し、旧を削除する:
> - `ncl roles revoke --user slack:<旧USER_ID> --role owner`
> - `ncl wirings delete --id <旧WIRING_ID>`
> - `ncl destinations remove --agent-group-id <AGENT_GROUP_ID> --local-name <旧LOCAL_NAME>`

---

## ローカル側セットアップ

### 1. `.env` を開発 ws の App token に

`.env`(repo ルート、gitignore 済み)の以下 2 つを開発 ws の App の値に書き換える:

```
SLACK_BOT_TOKEN=xoxb-…   (biblio-local の Bot token)
SLACK_APP_TOKEN=xapp-…   (biblio-local の App-level token)
```

`SLACK_SIGNING_SECRET` は未使用なので触らなくてよい。

### 2. 依存サービス起動 + Vertex token 投入

host は docker compose 管理外(compose は postgres + onecli のみ)。

```bash
docker compose up -d --wait          # postgres + onecli
bash scripts/onecli-vertex-secret.sh # Vertex Bearer を OneCLI に投入 + 全 agent を mode=all 化
```

> **ローカルの Vertex token は ~1 時間で失効する**(ADC アクセストークンのため)。GCP は orchestrator Pod 内の sidecar rotator が自動更新するが、**ローカルは手動**。agent が `401 ... ACCESS_TOKEN_TYPE_UNSUPPORTED` で黙り込んだら `bash scripts/onecli-vertex-secret.sh` を再実行する。

### 3. host を起動

```bash
pnpm run dev   # ログに "Slack socket mode connected" + 期待した botUserId が出れば OK
```

### 4. owner / wiring / destination(ローカル DB、その ws の user ID で)

GCP と同じ流れを**ローカル DB に対して**行う。ローカルでは ncl は直接実行できる(`pnpm run ncl <…>`)。DM を 1 回送って user/messaging_group を登録 → `roles grant` / `wirings create` / `destinations add`。

> M1 期にローカルセットアップ済みなら、これらは既に DB に残っていることがある(`pnpm exec tsx scripts/q.ts data/v2.db 'SELECT …'` で確認)。その場合は追加作業不要。

---

## トラブルシューティング(実例)

| 症状 | 原因 | 対処 |
| :--- | :--- | :--- |
| 全く反応しない | host/orchestrator が起動していない(Socket 未接続) | プロセス稼働とログの `Slack socket mode connected` を確認 |
| `user_not_found`(承認 DM が開けない) | owner の user ID が**別 ws の値**で、現 App から見えない | 現 ws の user ID で owner を grant、旧を revoke |
| `channel_not_found`(返信が配信されない) | destination が**旧 ws の channel(messaging_group)**を指している | destination を現 ws の messaging_group に付け替え(add 新 → remove 旧) |
| `401 ... ACCESS_TOKEN_TYPE_UNSUPPORTED` | OneCLI vault の Vertex token が失効 | `bash scripts/onecli-vertex-secret.sh` を再実行(ローカル)。GCP は sidecar が自動 |
| 二重返信になる | 同じ DM channel に**複数の agent group が wiring**されている | 片方の wiring を `ncl wirings delete --id <…>` で外す |
| ゾンビ agent pod が session を占有(GCP) | host 管理台帳から外れた孤児 Job が残存 | `kubectl delete job <job-name> -n biblio-claw` で直接削除 |

## 関連

- DB の reader/writer・cold-DM の扱い:[db.md](db.md) / [db-central.md](db-central.md)
- セットアップ配線の現況:[setup-wiring.md](setup-wiring.md)
- OneCLI / secret / 承認の配線:ルート `CLAUDE.md` の「シークレット / クレデンシャル / OneCLI」節
