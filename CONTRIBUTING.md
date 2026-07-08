# 貢献ガイド

biblio-claw は [`nanocoai/nanoclaw`](https://github.com/nanocoai/nanoclaw) (NanoClaw v2, commit `2492259`, 2026-05-28) を fork した司書実装リポジトリで、**2026 年夏の DevOps × AI Agent Hackathon 決勝 (2026-08-19 @ Google 渋谷) 提出用 fork** である。

**外部貢献は当面受け付けない**。以下の理由による:

- 大会提出用 fork のため、実装スコープは WForest 内部で完結する必要がある
- 実装内容の大部分は fork 前提の `.claude/` 配下 (PRP コマンド / plan / prd) に置かれており、public には公開されない
- Fork 元 NanoClaw への貢献を検討する場合は、上流 [`nanocoai/nanoclaw/CONTRIBUTING.md`](https://github.com/nanocoai/nanoclaw/blob/main/CONTRIBUTING.md) を参照

## biblio-claw への feedback

大会観戦者 / 審査員 / 一般閲覧者からの feedback や質問は [GitHub Discussions](https://github.com/HajimariInc/biblio-claw/discussions) (稼働時) または [GitHub Issue](https://github.com/HajimariInc/biblio-claw/issues) で受け付ける。

## Fork 側の設計方針

biblio-claw 固有の設計・実装方針は以下を参照:

- `README.md` — fork attribution 節 (§クイックスタート / §なぜ biblio-claw か)
- `CLAUDE.md` — biblio-claw 上部運用ルール (PRP コマンドフロー / Branch 戦略 / 環境分離方針 / 公開ポリシー) + 下部 NanoClaw v2 上流継承部 (base アーキ理解の正本)
- `CHANGELOG.md` — biblio-claw fork の変更履歴 (冒頭 `[biblio-claw-*]` セクション) + 上流 NanoClaw のリリース (`[2.x.x]` セクション)
