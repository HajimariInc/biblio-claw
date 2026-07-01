<!-- biblio-claw-pr-template: v1 -->
## Type of Change

- [ ] **Feature** — 新機能 / agent への新能力追加 (MCP tool / biblio action / orchestrator 機能 等)
- [ ] **Infrastructure** — Terraform / K8s manifest / GCP リソース宣言の追加・変更
- [ ] **Verify** — verify chain (`scripts/verify-*.sh`) の追加・変更
- [ ] **Fix** — bug fix / runtime hotfix
- [ ] **Refactor** — 振る舞い不変な再構成 / simplification
- [ ] **Docs** — README / docs / CLAUDE.md / runbook / PRD 変更のみ

## PRP / Plan / Issue

<!-- 該当するものを記入。該当しない欄は削除して可。 -->

- Source PRD: `.claude/PRPs/prds/...` (該当する場合)
- Source Plan: `.claude/PRPs/plans/(completed/)?...` (該当する場合、実施後は `completed/` 配下)
- Issue: `Closes #N` または `関連: #N`

## 要約

<!-- 変更内容と背景を 2-3 文で。 -->

## 変更内容

<!-- 主要ファイルと変更ポイントの table または箇条書き。 -->

## 検証

<!-- 該当する verify Level / 手動確認手順 / 自動テスト実行コマンド。 -->

```bash
# 例
pnpm test
bash scripts/verify-m3.sh
```

## 関連

<!-- 関連 PR / 関連 issue / 関連 memory / 関連 runbook 節。 -->
