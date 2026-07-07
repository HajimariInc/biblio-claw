# .claude/templates/ — AI 協業テンプレート集

biblio-claw を新しい環境で起動する際に AI エージェントが読み込む雛形集。**`.gitignore` の明示的例外** (`!.claude/templates/`) で public 化後の repo に残る同梱物。fork した開発者 / PC 移行者 / 大会審査員が初回セットアップに使う「AI 協業の入り口」に位置します。

## 4 ファイルの位置づけ

| ファイル             | 用途                                                                                                        |
| :--------------- | :-------------------------------------------------------------------------------------------------------- |
| `BOOTSTRAP.md`   | biblio-claw を新しいマシンで初起動するための、Claude Code 向け対話型セットアップ手順書 (Vertex/Slack/GitHub App/OneCLI secret 投入からスモーク確認まで) |
| `SOUL.md`        | AI アシスタントの人格・振る舞い定義テンプレート                                                                          |
| `USER.md`        | ユーザー (patron) のプロフィール空テンプレート                                                                       |
| `MEMORY.md`      | 長期記憶の骨格テンプレート (見出しのみ、中身は各 PC で埋める)                                                             |

## BOOTSTRAP.md の使い方 (実運用フロー)

```bash
# 1. 開発者が repo root にコピー
cp .claude/templates/BOOTSTRAP.md ./BOOTSTRAP.md

# 2. Claude Code を起動して "BOOTSTRAP.md に従ってセットアップして" と指示

# 3. Claude が段階 0〜6 を進めて .env を埋める・依存 install・secret 投入・スモーク確認

# 4. 完了時点で Claude が自身で ./BOOTSTRAP.md を rm (repo root 側のみ、正本は残す)
```

段階 6.2 (完了時) で Claude が自身で `rm BOOTSTRAP.md` するのは、`.gitignore` の `!.claude/templates/` で正本を保護しつつ、repo root 側に一時展開したコピーが git status に混入するのを防ぐため。

## SOUL.md / USER.md / MEMORY.md の使い方

これら 3 ファイルは各 PC / 各 fork で個別に「その環境でどんな相手 (patron = ユーザー) と、どんな人格でやり取りするか」を組み込むための雛形です。各 PC 上での実運用は repo root 直下の `.claude/SOUL.md` / `.claude/USER.md` / `.claude/MEMORY.md` (`.gitignore` 対象) で行い、`templates/` の雛形は **共有可能な骨格** として機能します (fork した第三者が独自の運用を組み立てる起点になる)。

biblio-claw 本体 (`biblio-orchestrator` + `biblio-agent-container`) の司書ペルソナ (patron 概念を持つ marketplace 管理者) は、これら 3 ファイルとは独立して `src/biblio/` + `.claude/PRPs/prds/` で定義されます。`templates/` の 3 ファイルは fork 者 / 各 PC 側で使う「AI Agent との協業の入り口」の役割に留まります。

## Related / 関連

- biblio-claw の位置づけ: root [`README.md`](../../README.md) §Fork Attribution
- biblio 独自語彙: [`docs/glossary.md`](../../docs/glossary.md)
