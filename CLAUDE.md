# biblio-claw

biblio-shelf プロジェクトの **司書実装 repo**。**NanoClaw fork を base** に M1 (司書骨格) を実装する。

## 3 ロケーションのポインタ

- **構想・設計の正本** (TO-BE): `/mnt/d/labo-obs/11-labo/biblio-shelf/` (Obsidian Vault)
- **本 repo** (AS-IS): biblio-claw 司書実装の正本
- **オペレーション拠点**: wf-realm の `proj/biblio-shelf.md` が索引

## /prime コマンドで読み取るコンテキスト

biblio-claw で作業を始める時、Crane は次の順で読み込む:

1. wf-realm `proj/biblio-shelf.md` — 3 ロケーションのポインタ + 解消済み論点 + TBD
2. Vault `11-labo/biblio-shelf/INDEX.md` — Vault 配下の MOC
3. Vault `11-labo/biblio-shelf/design/milestones.md` — マイルストーン定義 + Phase 構成 + PRD 起草方針
4. Vault `11-labo/biblio-shelf/design/tech-stack.md` — 技術スタック + 環境分離方針 + 抽象化境界
5. `.claude/PRPs/prds/m1-shisho-kokkaku.prd.md` — M1 大 PRD (Vault から注入済)
6. `.claude/PRPs/plans/phase-1-local-implementation.plan.md` — Phase 1 sub PRD (骨格、Task 1 完了後に /prp-plan で詳細化)
7. (NanoClaw 取り込み後) NanoClaw 側の `CLAUDE.md` / `docs/` — base アーキの理解

> **補足**: NanoClaw fork を取り込み次第、本 CLAUDE.md は **NanoClaw 側の CLAUDE.md を優先**する方針に書き換える可能性が高い。/prime の指示は Phase を進めながら少しずつ調整する。

## PRP コマンドフロー

本 repo は **PRP コマンドフロー** で開発する:

1. `/prp-prd` (or 議論済の場合は Vault でテンプレ埋め) → 大 PRD を `.claude/PRPs/prds/` に
2. `/prp-plan {prd}` → 次の pending phase の Plan を `.claude/PRPs/plans/` に
3. `/prp-implement {plan}` or `/prp-ralph {plan}` → 実装 + 検証 + レポート
4. `/prp-review-agents` → 専門エージェント並列レビュー

詳細は wf-realm `reference/prd_phase_structure.md` を参照。

## 環境分離方針 (M1 採用)

M1 は **環境分離型 (D-1)** で進める:

- **Phase 1**: docker compose で local 実装を完成 (抽象化アダプタを含む)
- **Phase 2**: 同一バイナリを GKE へ + GCP 特有要素を追加適用 = M1 完成

詳細は Vault `design/milestones.md` §本プロジェクトの環境分離方針 / Vault `design/tech-stack.md` §環境分離方針 (M1 採用) と抽象化境界 を参照。

## 公開ポリシー — 重要

- **本 repo は大会提出時に public 化する**前提 (現状は private)
- **`.claude/` 配下は全 gitignore**。AI Agent の開発支援設定・PRP の議論内容は公開しない (`.gitignore` 参照)
- CLAUDE.md (root) は公開対象
- 部分公開の判断は提出直前 (M5/M6 完了後)

## 関連

- biblio-shelf (棚、public) = `example-org/biblio-shelf` — skill 本体 + marketplace
- NanoClaw (司書ベース) = **Phase 1 で fork 取り込み予定** (取り込み方法は Phase 1 sub PRD Task 1 で選定)
- wf-realm = `proj/biblio-shelf.md` (オペレーション索引)
