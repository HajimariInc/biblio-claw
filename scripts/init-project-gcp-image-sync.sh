#!/usr/bin/env bash
# biblio-claw: Phase 4.5 (image-sync) — 4 image build/push + manifest 更新 + rollout 統合 wrapper
#
# init-project-gcp PRD Phase 4.5 の本丸。GKE Autopilot biblio-prod に対して以下 6 ブロックを実行:
#
#   Block 1: pre-flight (cluster context + StatefulSet ready + 必要 cmd + 認証 + AR repo 存在)
#   Block 2: 4 image build (biblio-claw orchestrator + nanoclaw-agent + biblio-sidecar-gh + biblio-sidecar-vertex)
#   Block 3: 4 image AR push (docker tag → docker push、agent image の install-slug 衝突を吸収)
#   Block 4: manifest 内 ${IMAGE_TAG} placeholder の存在確認 + rollback backup (envsubst 展開は Block 5)
#   Block 5: kubectl apply -f k8s/ + kubectl rollout status 待ち
#   Block 6: 状況確認 (Pod 内 image tag / env 反映 / M3 ファイル存在 / Phase 2 JSON ログ観測)
#
# 引数:
#   --tag <tag>          必須。AR push する image tag (例: m4b-p3)。既存 tag 上書き事故防止のため required
#   --dry-run            既定。全 Block を echo して exit 0 (Block 1 の実 probe は実行する)
#   --confirm            実行 (= --dry-run の opposite)
#   --no-build           Block 2 (build) を skip
#   --no-push           Block 3 (push) を skip
#   --no-apply          Block 4-6 (manifest 更新 + apply + 状況確認) を skip
#   --rollout-restart   同 tag 上書き push 後の明示再起動 (= imagePullPolicy: Always と連携)
#   -h, --help          ヘルプ
#
# 前提:
#   - kubectl context = gke_*_biblio-prod (= verify-phase-2-wiring.sh と同じ gate)
#   - gcloud auth login + gcloud auth application-default login 済
#   - gcloud auth configure-docker asia-northeast1-docker.pkg.dev 済 (= 初回のみ)
#   - orchestrator StatefulSet が rollout 前の現状で ready (warn 継続可だが不健全なら停止推奨)
#
# 各 assert 失敗で exit 1。全通過で `Image sync PASS (...)` を出して exit 0。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# .env 自動読み込み (= verify-m3.sh / onecli-gh-secret.sh と同パターン)。本 script で
# .env を直接参照する場面は現状ないが、将来の拡張 (= SHELF_* env を kubectl exec に
# 渡す等) で必要になる可能性 + 既存スクリプト群との一貫性のため早期に取り込む。
if [ -f "$ROOT/.env" ]; then set -a; . "$ROOT/.env"; set +a; fi

# info/warn/fail/extract_result/json_field/json_array_length は verify-m3-helpers.sh に集約
# (M3 PRD Phase 5 PR #21 code-simplifier 推奨)。本 Phase 4.5 で必要だが helpers に未集約な
# ok() のみ局所定義 (= verify-phase-4-deploy.sh:41 と同流儀、両 source による
# info/warn/fail 二重定義を回避)。
# shellcheck source=scripts/verify-m3-helpers.sh
source "$(dirname "${BASH_SOURCE[0]}")/verify-m3-helpers.sh"
ok() { printf '[OK]   %s\n' "$*" >&2; }

# 定数
NS='biblio-claw'
ORCH_POD='biblio-orchestrator-0'
: "${GCP_PROJECT_ID:?required for GAR path and envsubst: export GCP_PROJECT_ID before running (e.g. export GCP_PROJECT_ID=your-gcp-project-id)}"
# Cloud SQL instance 名 (envsubst 経由で k8s/10-orchestrator-statefulset.yaml の
# cloud-sql-proxy args + DATABASE_URL 展開に必要)。fork 側で必ず名前が変わるため env 必須。
: "${CLOUD_SQL_INSTANCE:?required for envsubst \${CLOUD_SQL_INSTANCE}: export CLOUD_SQL_INSTANCE (Cloud SQL instance 名) before running}"
# Cloud SQL VPC peering allocation CIDR (envsubst 経由で k8s/27-networkpolicy-fugue-channel.yaml
# の egress rule 展開に必要)。`gcloud compute addresses list --filter=purpose:VPC_PEERING`
# で特定、fork 側の VPC ごとに異なる。
: "${CLOUD_SQL_PEERING_CIDR:?required for envsubst \${CLOUD_SQL_PEERING_CIDR}: export CLOUD_SQL_PEERING_CIDR (Cloud SQL VPC peering CIDR, e.g. 10.191.0.0/16) before running}"
GAR="asia-northeast1-docker.pkg.dev/${GCP_PROJECT_ID}/biblio-claw"
MANIFEST="$ROOT/k8s/10-orchestrator-statefulset.yaml"

# 引数 parse
DRY_RUN=true
NO_BUILD=false
NO_PUSH=false
NO_APPLY=false
ROLLOUT_RESTART=false
TAG=""

usage() {
  cat <<'EOF'
Usage: scripts/init-project-gcp-image-sync.sh --tag <tag> [options]

GKE 上の 4 image (biblio-claw orchestrator + nanoclaw-agent + biblio-sidecar-gh
+ biblio-sidecar-vertex) を build → AR push → k8s manifest image tag 更新
→ kubectl apply → rollout 待ち → 状況確認 まで 1 発で完遂する。

Required:
  --tag <tag>           AR push する image tag (例: m4b-p3)。既存 tag 上書き事故防止のため required

Optional:
  --dry-run             既定。全 Block を echo して exit 0 (Block 1 の実 probe は実行する)
  --confirm             実行 (= --dry-run の opposite、破壊的アクション protect 解除)
  --no-build            Block 2 (build) を skip
  --no-push             Block 3 (push) を skip
  --no-apply            Block 4-6 (manifest 更新 + apply + 状況確認) を skip
  --rollout-restart     同 tag 上書き push 後の明示再起動 (= imagePullPolicy: Always と連携)
  -h, --help            このヘルプ

Examples:
  # 既定 (= dry-run、影響なし)
  bash scripts/init-project-gcp-image-sync.sh --tag m4b-p3

  # 本番実行
  bash scripts/init-project-gcp-image-sync.sh --tag m4b-p3 --confirm

  # build のみ走らせて push/apply は止める (= 動作確認用)
  bash scripts/init-project-gcp-image-sync.sh --tag m4b-p3 --confirm --no-push --no-apply

  # 同 tag 上書き push 後の明示再起動
  bash scripts/init-project-gcp-image-sync.sh --tag m4b-p3 --confirm --rollout-restart
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --tag)
      # `--tag` 末尾 (= 値なし) で `shift 2` が silent exit する罠を防ぐ事前チェック。
      # `${2:-}` の空文字確認で「`--tag` の後に何もない」と「`--tag ''`」の両方を弾く。
      if [ -z "${2:-}" ]; then usage >&2; fail "--tag の値が指定されていません (例: --tag m4b-p3)"; fi
      TAG="$2"; shift 2 ;;
    --dry-run)         DRY_RUN=true; shift ;;
    --confirm)         DRY_RUN=false; shift ;;
    --no-build)        NO_BUILD=true; shift ;;
    --no-push)         NO_PUSH=true; shift ;;
    --no-apply)        NO_APPLY=true; shift ;;
    --rollout-restart) ROLLOUT_RESTART=true; shift ;;
    -h|--help)         usage; exit 0 ;;
    *)                 usage >&2; fail "unknown arg: $1" ;;
  esac
done

[ -n "$TAG" ] || { usage >&2; fail "--tag <tag> は必須引数 (例: --tag m4b-p3)"; }

# run() 関数: dry-run なら echo、--confirm なら実行 (= teardown-phase-2.sh:64-73 と同パターン)
# 失敗時は fail() で停止 (= teardown-phase-2.sh は WARN 継続だが、本 Phase は build/push 失敗
# = fail にすべき性質のため stricter)
run() {
  if "$DRY_RUN"; then
    info "[dry-run] $*"
  else
    "$@" || fail "command failed: $*"
  fi
}

# push_image() ヘルパ: docker tag + docker push + ok の 3 操作を 1 呼び出しに集約。
# Block 3 で 4 image × 3 操作 = 12 行繰り返しを 4 呼び出しに縮約 (= code-simplifier 採用)。
# 2 引数で呼べる単純な関数 = 過剰抽象ではなく機械的反復の正当な吸収。
push_image() {
  local local_img="$1" ar_name="$2"
  info "[push] $local_img → $GAR/$ar_name:$TAG"
  run docker tag "$local_img" "$GAR/$ar_name:$TAG"
  run docker push "$GAR/$ar_name:$TAG"
  ok "[push] $ar_name:$TAG"
}

info "==== Phase 4.5 image-sync (tag=$TAG, dry-run=$DRY_RUN) ===="

# === Block 1: pre-flight =============================================================
info '=== Block 1: pre-flight ==='

# 必須 cmd (envsubst は Block 5 の Ingress ${DOMAIN} 展開に必要 = 罠 10 対応、
# M4-F Phase 1 revival-core で `kubectl apply -f k8s/` が envsubst 未処理で Ingress
# `${DOMAIN}` literal 登録 invalid で FAIL した実測に基づき preflight に追加)。
for c in docker kubectl gcloud sed envsubst; do
  command -v "$c" >/dev/null 2>&1 || fail "必須コマンドが見つかりません: $c (envsubst 未インストールなら sudo apt install gettext / brew install gettext)"
done
ok '[cmd] docker / kubectl / gcloud / sed / envsubst 揃い'

# cluster context gate (= 別 cluster での誤実行防止、verify-phase-2-wiring.sh:32-36 と同パターン)
ctx="$(kubectl config current-context 2>/dev/null || echo '<none>')"
case "$ctx" in
  gke_*_biblio-prod) ok "[ctx] $ctx" ;;
  *) fail "[ctx] kubectl context が biblio-prod ではない (= $ctx)。実行: gcloud container clusters get-credentials biblio-prod --region=asia-northeast1 --project=\"\${GCP_PROJECT_ID}\"" ;;
esac

# StatefulSet ready (= rollout 前の現状確認、warn 継続)
ready="$(kubectl get statefulset biblio-orchestrator -n "$NS" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)"
if [ "$ready" = "1" ]; then
  ok "[statefulset] readyReplicas=1 (= rollout 前の現状)"
else
  warn "[statefulset] readyReplicas != 1 (actual=$ready) — rollout 前から既に異常、続行するが原因切り分けを推奨"
fi

# AR 認証 (= gcloud auth が走っているかを print-access-token で probe)
if ! gcloud auth print-access-token >/dev/null 2>&1; then
  fail "[auth] gcloud auth が未設定。実行: gcloud auth login + gcloud auth application-default login"
fi
ok '[auth] gcloud auth print-access-token OK'

# docker 設定確認 (= ~/.docker/config.json に gcloud helper が登録されているか)。
# 旧版は `grep -q ... 2>/dev/null` で読み取り権限エラーも「未設定」warn に倒していた
# (= 真の原因が見えない silent failure)。stderr を捨てずに残し、grep 自体の失敗
# (= 行 hit なし) のみで warn 経路に倒す。
if [ -f "$HOME/.docker/config.json" ] && grep -q 'asia-northeast1-docker.pkg.dev' "$HOME/.docker/config.json"; then
  ok '[auth] gcloud auth configure-docker (asia-northeast1) 設定済'
else
  warn '[auth] ~/.docker/config.json に asia-northeast1-docker.pkg.dev の credHelper 未設定。push 時に 401 リスク。対処: gcloud auth configure-docker asia-northeast1-docker.pkg.dev'
fi

# AR repository 存在確認 (= init-project-gcp-resource-check.sh:126-129 と同パターン)
if gcloud artifacts repositories describe biblio-claw --location=asia-northeast1 --project="${GCP_PROJECT_ID}" >/dev/null 2>&1; then
  ok '[ar] AR repository biblio-claw 存在'
else
  fail '[ar] AR repository biblio-claw が見えない。権限 (= roles/artifactregistry.reader) を確認、または gcloud auth login 再実行'
fi

# === Block 2: 4 image build ==========================================================
info '=== Block 2: build 4 image ==='

if "$NO_BUILD"; then
  info '[build] --no-build 指定、skip'
else
  # orchestrator (build context = repo root)
  info "[build] biblio-claw:$TAG (orchestrator)..."
  run docker build -t "biblio-claw:$TAG" "$ROOT"
  ok "[build] biblio-claw:$TAG"

  # agent: container/build.sh は nanoclaw-agent-v2-<hash>:latest を生成する。
  # AR push 用の nanoclaw-agent:$TAG は Block 3 で docker tag で貼り直す。
  info '[build] nanoclaw-agent (= container/build.sh)...'
  run "$ROOT/container/build.sh"
  ok '[build] nanoclaw-agent (install-slug tag local)'

  # sidecar-gh / sidecar-vertex (build context = repo root)
  info "[build] biblio-sidecar-gh:$TAG..."
  run docker build -f "$ROOT/Dockerfile.sidecar.gh" -t "biblio-sidecar-gh:$TAG" "$ROOT"
  ok "[build] biblio-sidecar-gh:$TAG"

  info "[build] biblio-sidecar-vertex:$TAG..."
  run docker build -f "$ROOT/Dockerfile.sidecar.vertex" -t "biblio-sidecar-vertex:$TAG" "$ROOT"
  ok "[build] biblio-sidecar-vertex:$TAG"
fi

# === Block 3: AR push (4 image) ======================================================
info '=== Block 3: AR push (4 image) ==='

if "$NO_PUSH"; then
  info '[push] --no-push 指定、skip'
else
  # agent image の install-slug 取得 (= setup/lib/install-slug.sh の container_image_base)。
  # 旧版は sub-shell の失敗 (= ファイル不在 / shasum 不在 / source 構文エラー) を握らず、
  # set -euo pipefail で silent exit していた (= fail() を経由しないため [FAIL] 不出力)。
  # ファイル存在を先に確認 + stderr を別ファイルに退避して fail メッセージに展開する。
  [ -f "$ROOT/setup/lib/install-slug.sh" ] || \
    fail "[push] setup/lib/install-slug.sh が見つからない (path=$ROOT/setup/lib/install-slug.sh)"
  slug_err="$(mktemp -t biblio-p4-5-slug-XXXXXX.stderr)"
  slug_base="$(bash -c "source '$ROOT/setup/lib/install-slug.sh' && container_image_base" 2>"$slug_err")" \
    || fail "[push] container_image_base 取得失敗 (stderr: $(cat "$slug_err"))"
  rm -f "$slug_err"
  slug_image="${slug_base}:latest"
  info "[push] agent slug 確定: $slug_image"

  # push_image() で 4 image を順次 push (= docker tag → docker push → ok 3 操作)。
  push_image "biblio-claw:$TAG"              biblio-claw
  push_image "$slug_image"                   nanoclaw-agent
  push_image "biblio-sidecar-gh:$TAG"        biblio-sidecar-gh
  push_image "biblio-sidecar-vertex:$TAG"    biblio-sidecar-vertex
fi

# === Block 4: manifest placeholder 確認 + rollback backup =============================
info '=== Block 4: manifest placeholder 確認 + rollback backup ==='

# manifest は ${IMAGE_TAG} placeholder ベースで維持し (= tag literal を git 履歴に残さない)、
# Block 5 の envsubst で --tag 引数値に展開して kubectl apply する経路に統合済。
# 本 Block では apply 前の placeholder 存在 assert + rollback backup 作成のみを行う。
if "$NO_APPLY"; then
  info '[manifest] --no-apply 指定、skip'
else
  [ -f "$MANIFEST" ] || fail "[manifest] $MANIFEST が見つからない"

  # 期待 hit 数: image 名 4 種 × 各 manifest 行 1 = 4 行 (biblio-claw / nanoclaw-agent
  # / biblio-sidecar-gh / biblio-sidecar-vertex + drive-token-rotator の vertex 再利用で 5 行)。
  hit="$(grep -cE 'biblio-claw/[^"'"'"' ,}]+:\$\{IMAGE_TAG\}' "$MANIFEST" || true)"
  [ "$hit" -ge 4 ] || \
    fail "[manifest] \${IMAGE_TAG} placeholder が manifest 内に不足 (期待=4 行以上、実際=$hit 行)。cleanup 後の manifest では image tag は \${IMAGE_TAG} placeholder として保持する設計。manifest を確認: $MANIFEST"
  info "[manifest] \${IMAGE_TAG} placeholder 検出 ($hit 行、Block 5 で --tag=$TAG に envsubst 展開)"

  # rollback 用 backup (= --confirm 時のみ実体作成、dry-run では skip)
  # $(date +%s) を先に変数に捕捉 = cp が作った実ファイル名と log 出力が
  # 秒境界跨ぎで食い違うのを防ぐ (rollback 復元時の混乱を撲滅)。
  if ! "$DRY_RUN"; then
    backup_path="$MANIFEST.bak.$(date +%s)"
    cp "$MANIFEST" "$backup_path"
    ok "[manifest] backup 作成: $backup_path"
  fi

  # fork 側 deploy で手動置換が必要な angle-bracket placeholder が残っていないか
  # fail-fast 検出 (envsubst 対象外 = envsubst で literal のまま container に注入され、
  # `readListEnv` / `readShelveEnv` は空文字チェックのみで literal `<...>` を通過するため
  # 起動 → 最初の `@bot 蔵書` / `@bot 仕入れて` を叩くまで異常に気付けない silent failure)。
  # 全 placeholder は fork 側で sed / envsubst 前の手動 rewrite で実値に置換必須。
  placeholder_pattern='<(shelf-repo-owner|shelf-repo-name|bot-commit-author-name|bot-commit-author-email|cloud-sql-db-name)>'
  if grep -qE "$placeholder_pattern" "$MANIFEST"; then
    warn "[manifest] 未置換の angle-bracket placeholder を検出 (envsubst 対象外):"
    grep -nE "$placeholder_pattern" "$MANIFEST" | head -10 >&2
    fail "[manifest] fork 側で全 placeholder を実値に置換してから deploy してください (sed 例: sed -i 's|<shelf-repo-owner>|myorg|g' $MANIFEST)"
  fi
fi

# === Block 5: kubectl apply + rollout status 待ち ====================================
info '=== Block 5: kubectl apply + rollout 待ち ==='

# PR #145 実機で判明した罠 (2026-07-06):
# `kubectl apply -f k8s/` は StatefulSet spec を manifest 内容で完全に書き換えるため、
# 過去に `kubectl set env` で in-place 変更した env (= manifest には反映されていない
# override 値) が全て消える。M4-F Phase 2 の GATE_ENABLED は「main 合流退路として
# manifest = false、GKE のみ kubectl set env で true」の運用モデルだったが、Phase 4
# deploy で Prod が silent regression した。恒久策として (a) manifest 側で GATE_ENABLED
# を 'true' に既定変更 (2026-07-06 PR #145 で恒久化)、(b) 本 script で apply 前後の
# 差分を検知して復元する二重保険を敷く。
# 対象 env は PRESERVE_ENV_KEYS で明示 (将来 ADK_APPROVAL_TIMEOUT_MS 等が加わる想定)。
# bash 3.2 互換のため `KEY=VALUE` 形式の 1 配列で保持 (連想配列不使用、parallel array で
# インデックスずれる罠を構造的に消す = PR #145 review code-simplifier P-6)。
# `${entry%%=*}` (最初の `=` より前) / `${entry#*=}` (最初の `=` より後ろ) で分離可能なため、
# 値に `=` が含まれても正しく分離できる (今の GATE_ENABLED=true は単純ケース)。
PRESERVE_ENV_KEYS=("GATE_ENABLED")
PRESERVED=()
if ! "$NO_APPLY"; then
  info '[preserve] apply 前に override 済 env の現状値を保存 (deploy regression 防止)'
  for env_key in "${PRESERVE_ENV_KEYS[@]}"; do
    # PR #145 review silent-failure IM-6: `2>/dev/null || echo ''` は kubectl 失敗
    # (認証切れ / API server 到達不能 / context 誤り) と「値が空 (env 未設定)」を
    # 区別しない silent fallback。二重保険自身に穴があった。exit code を分離して
    # 「失敗を明示」する = restore 側で「保存されていない = 復元不要」の判断が
    # kubectl 失敗と env 空を混同しない。
    val="$(kubectl -n "$NS" get statefulset biblio-orchestrator \
      -o jsonpath="{.spec.template.spec.containers[?(@.name=='orchestrator')].env[?(@.name=='${env_key}')].value}" \
      2>/dev/null)"
    rc=$?
    if [ "$rc" -ne 0 ]; then
      warn "[preserve] ${env_key}: kubectl get 失敗 (exit=$rc)。認証 / context / API server 到達性を確認。復元保証されません"
      continue
    fi
    if [ -n "$val" ]; then
      PRESERVED+=("${env_key}=${val}")
      info "[preserve] ${env_key}=${val}"
    fi
  done
fi

if "$NO_APPLY"; then
  info '[apply] --no-apply 指定、skip'
else
  # k8s/25-ingress-fugue-channel.yaml の `host: ${DOMAIN}` は envsubst で展開してから
  # apply する必要がある (罠: envsubst 未処理で literal 登録 = Ingress invalid)。
  # DOMAIN は env で明示、あるいは Secret Manager `fugue-domain-name` から動的取得
  # (host 名を静的ファイルに露出させない設計)。
  # k8s/10-orchestrator-statefulset.yaml の image tag / Cloud SQL instance も同経路で
  # ${IMAGE_TAG} / ${CLOUD_SQL_INSTANCE} placeholder として envsubst 展開する
  # (= public 化 cleanup で literal を manifest から除去、fork 側で値を注入する設計)。
  # k8s/27-networkpolicy-fugue-channel.yaml の Cloud SQL VPC peering CIDR も同経路で
  # ${CLOUD_SQL_PEERING_CIDR} 展開 (fork 側 VPC ごとに CIDR が異なるため env 必須)。
  info '[apply] envsubst ${DOMAIN} + ${GCP_PROJECT_ID} + ${IMAGE_TAG} + ${CLOUD_SQL_INSTANCE} + ${CLOUD_SQL_PEERING_CIDR} + kubectl apply (tmpdir 経由)'
  if [ -z "${DOMAIN:-}" ]; then
    # `--project` は image build/push の GAR と同一プロジェクト前提。
    DOMAIN="$(gcloud secrets versions access latest --secret=fugue-domain-name \
      --project="${GCP_PROJECT_ID}" 2>/dev/null | tr -d '[:space:]' || true)"
  fi
  [ -n "${DOMAIN:-}" ] || \
    fail "[apply] DOMAIN 未解決 (env 未設定 + Secret Manager fugue-domain-name 空 or gcloud 権限不足)。DOMAIN=<host> を env で明示 or gcloud secrets versions access で単独確認"
  # ${IMAGE_TAG} は --tag 引数値を export、${CLOUD_SQL_INSTANCE} は preflight で env 必須確認済
  export DOMAIN
  export GCP_PROJECT_ID
  export IMAGE_TAG="$TAG"
  export CLOUD_SQL_INSTANCE
  export CLOUD_SQL_PEERING_CIDR
  # tmpdir で render (envsubst で 5 変数を展開、他 manifest は cp で pass-through)。
  # 対象 env 変数を含む file を grep で判定 = 将来 別 manifest に env 変数が増えた場合も
  # 自動追随。
  apply_tmp="$(mktemp -d -t biblio-p4-5-apply-XXXXXX)"
  # top-level script なので trap EXIT で cleanup (関数 scope の RETURN は使わない)
  trap 'rm -rf "$apply_tmp"' EXIT
  substituted_count=0
  for f in "$ROOT/k8s"/*.yaml; do
    base="$(basename "$f")"
    if grep -qE '\$\{(DOMAIN|GCP_PROJECT_ID|IMAGE_TAG|CLOUD_SQL_INSTANCE|CLOUD_SQL_PEERING_CIDR)\}' "$f" 2>/dev/null; then
      envsubst '${DOMAIN} ${GCP_PROJECT_ID} ${IMAGE_TAG} ${CLOUD_SQL_INSTANCE} ${CLOUD_SQL_PEERING_CIDR}' < "$f" > "$apply_tmp/$base"
      substituted_count=$((substituted_count + 1))
    else
      cp "$f" "$apply_tmp/$base"
    fi
  done
  info "[apply] envsubst 展開: $substituted_count 個の manifest で \${DOMAIN}, \${GCP_PROJECT_ID}, \${IMAGE_TAG}, \${CLOUD_SQL_INSTANCE}, \${CLOUD_SQL_PEERING_CIDR} を実値に展開"
  run kubectl apply -f "$apply_tmp/"
  ok '[apply] kubectl apply done'

  # rollout-restart オプション (= 同 tag 上書き push の場合の明示再起動)
  if "$ROLLOUT_RESTART"; then
    info '[rollout-restart] kubectl rollout restart (= 同 tag 上書き push の場合)'
    run kubectl rollout restart "statefulset/biblio-orchestrator" -n "$NS"
  fi

  # rollout status 待ち (= timeout 300s)
  info '[rollout] kubectl rollout status (timeout=300s)'
  if "$DRY_RUN"; then
    info '[dry-run] kubectl rollout status statefulset/biblio-orchestrator -n biblio-claw --timeout=300s'
  else
    kubectl rollout status "statefulset/biblio-orchestrator" -n "$NS" --timeout=300s \
      || fail "[rollout] timeout or failed. kubectl describe pod $ORCH_POD -n $NS で原因確認"
    ok '[rollout] partitioned roll out complete'
  fi

  # preserve 済 env を restore (2 回目 rollout が走る = 追加 ~2 分)。
  # manifest 値と一致するなら no-op 判定でスキップ (kubectl set env は spec を書き換えて
  # rollout を trigger するため、無駄な rollout を避ける)。
  # PR #145 review P-6: PRESERVED は KEY=VALUE 形式の 1 配列で保持 = parallel array の
  # インデックスずれ罠を構造的に消す。
  if [ ${#PRESERVED[@]} -gt 0 ]; then
    info '[restore] preserve 済 env の現在値との差分を確認'
    restored_count=0
    for entry in "${PRESERVED[@]}"; do
      key="${entry%%=*}"    # 最初の `=` より前 (KEY)
      val="${entry#*=}"     # 最初の `=` より後ろ全部 (VALUE、`=` 含みも OK)
      manifest_val="$(kubectl -n "$NS" get statefulset biblio-orchestrator \
        -o jsonpath="{.spec.template.spec.containers[?(@.name=='orchestrator')].env[?(@.name=='${key}')].value}" \
        2>/dev/null)"
      rc=$?
      if [ "$rc" -ne 0 ]; then
        warn "[restore] ${key}: kubectl get 失敗 (exit=$rc)、manifest 側の現状値を取得できず。復元を skip"
        continue
      fi
      if [ "$val" = "$manifest_val" ]; then
        ok "[restore] ${key}=${val} (manifest と一致 = no-op)"
      else
        info "[restore] ${key}: manifest='${manifest_val}' → 前値='${val}' で復元 (kubectl set env、追加 rollout)"
        if "$DRY_RUN"; then
          info "[dry-run] kubectl -n $NS set env statefulset/biblio-orchestrator ${key}=${val}"
        else
          run kubectl -n "$NS" set env "statefulset/biblio-orchestrator" "${key}=${val}"
          restored_count=$((restored_count + 1))
        fi
      fi
    done
    if [ "$restored_count" -gt 0 ] && ! "$DRY_RUN"; then
      info "[restore] $restored_count 個の env を復元、追加 rollout 待ち (timeout=300s)"
      kubectl rollout status "statefulset/biblio-orchestrator" -n "$NS" --timeout=300s \
        || fail '[restore] 2 回目 rollout timeout or failed'
      ok '[restore] 追加 rollout 完了'
    fi
  fi
fi

# === Block 6: 状況確認 ================================================================
info '=== Block 6: 状況確認 ==='

if "$NO_APPLY"; then
  info '[verify] --no-apply 指定のため verify は skip'
elif "$DRY_RUN"; then
  info '[dry-run] Pod 内 image tag / env / files / log を確認 (skip in dry-run)'
else
  # Pod 内 image tag 一致確認
  pod_image="$(kubectl get pod "$ORCH_POD" -n "$NS" -o jsonpath='{.spec.containers[?(@.name=="orchestrator")].image}' 2>/dev/null || echo '<none>')"
  expected_image="$GAR/biblio-claw:$TAG"
  if [ "$pod_image" = "$expected_image" ]; then
    ok "[pod-image] orchestrator container = $pod_image"
  else
    fail "[pod-image] mismatch: got=$pod_image expected=$expected_image"
  fi

  # Pod 内 env 反映確認 (= Phase 2 で追加した LOG_FORMAT / LOG_COMPONENT)。
  # 旧版は `2>/dev/null || echo '<exec failed>'` で kubectl exec 自体の失敗
  # (Pod 不在 / CrashLoop / RBAC 不足) を「env 未反映」と誤誘導していた。
  # stderr を保持して exec 失敗時は接続問題として fail する。
  env_err="$(mktemp -t biblio-p4-5-env-XXXXXX.stderr)"
  env_dump="$(kubectl exec "$ORCH_POD" -c orchestrator -n "$NS" -- \
    sh -c 'echo LOG_FORMAT=${LOG_FORMAT:-<unset>}; echo LOG_COMPONENT=${LOG_COMPONENT:-<unset>}' \
    2>"$env_err")" \
    || fail "[pod-env] kubectl exec 失敗 (Pod/コンテナ接続問題): $(cat "$env_err")"
  rm -f "$env_err"
  if echo "$env_dump" | grep -q 'LOG_FORMAT=json' && echo "$env_dump" | grep -q 'LOG_COMPONENT=host-orchestrator'; then
    ok '[pod-env] LOG_FORMAT=json + LOG_COMPONENT=host-orchestrator'
  else
    fail "[pod-env] Phase 2 env が反映されていない (got: $env_dump)"
  fi

  # M3 ファイル存在確認 (= image に biblio-list.ts 等が焼かれているか)。
  # 旧版は `>/dev/null 2>&1` で kubectl exec 失敗と test -f 失敗を区別できなかった
  # (= 「再 build 必要」と誤誘導されることがあった)。stderr を保持して原因分離する。
  files_err="$(mktemp -t biblio-p4-5-files-XXXXXX.stderr)"
  if kubectl exec "$ORCH_POD" -c orchestrator -n "$NS" -- \
    test -f /app/scripts/biblio-list.ts 2>"$files_err"; then
    ok '[pod-files] /app/scripts/biblio-list.ts 存在 (= M3 反映済)'
  else
    # kubectl exec の stderr が空 = test -f が exit 1 (= ファイル不在 = M3 未焼成)
    # stderr 出力あり = kubectl 接続問題 (= RBAC / Pod 状態)
    if [ -s "$files_err" ]; then
      fail "[pod-files] kubectl exec 失敗 (Pod/コンテナ接続問題): $(cat "$files_err")"
    else
      fail '[pod-files] /app/scripts/biblio-list.ts が存在しない (= image に M3 未焼成、再 build 必要)'
    fi
  fi
  rm -f "$files_err"

  # Phase 2 JSON ログ観測 (= 直近 60s、Pod 起動直後のログを拾う)。
  # 旧版は `2>/dev/null | sed | grep | head -3 || true` で kubectl logs 自体の失敗
  # (= Pod 名不正 / namespace エラー / RBAC 不足 / CrashLoopBackOff) を握りつぶし、
  # 「ログが出ていないだけ」と誤誘導していた。stderr を保持して取得失敗を warn 経路で
  # 可視化する。
  info '[log-gke] orchestrator JSON ログ観測 (直近 60s)...'
  sleep 5
  log_err="$(mktemp -t biblio-p4-5-log-XXXXXX.stderr)"
  recent_logs="$(kubectl logs "$ORCH_POD" -n "$NS" -c orchestrator --since=60s 2>"$log_err" \
    | sed -r 's/\x1b\[[0-9;]*m//g' \
    | grep -E '^\{.*"severity":.*"component":.*\}' \
    | head -3 || true)"
  if [ -s "$log_err" ]; then
    warn "[log-gke] kubectl logs 取得時に stderr: $(tr '\n' ' ' < "$log_err")"
  fi
  rm -f "$log_err"
  if [ -z "$recent_logs" ]; then
    warn '[log-gke] 直近 60s に JSON ログ未観測 (= Pod 起動直後で normal、後で verify-phase-4-deploy.sh で再確認)'
  else
    ok "[log-gke] JSON ログ $(printf '%s\n' "$recent_logs" | wc -l) 件観測"
  fi
fi

# === 全 PASS =========================================================================
echo "Image sync PASS (4 image, tag=$TAG, dry-run=$DRY_RUN)"
info '次のステップ: bash scripts/verify-phase-4-deploy.sh'
