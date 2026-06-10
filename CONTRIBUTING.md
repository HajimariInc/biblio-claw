# 貢献ガイド

## 始める前に

1. **既存の作業を確認する。** 着手前に open な PR と issue を検索する:
   ```bash
   gh pr list --repo nanocoai/nanoclaw --search "<your feature>"
   gh issue list --repo nanocoai/nanoclaw --search "<your feature>"
   ```
   関連する PR や issue があれば、作業を重複させずにそれを土台にする。

2. **方向性を確認する。** [README.md の「設計哲学」セクション](README.md#設計哲学) を読むこと。ソースコードの変更は、90% 以上のユーザが必要とするものに限る。Skill はもっとニッチでよいが、それでも 1 人のセットアップ越しに有用であるべき。

3. **1 PR = 1 つのこと。** 各 PR は 1 つのことだけを行う — 1 つのバグ修正、1 つの skill、1 つの簡素化。無関係な変更を 1 つの PR に混ぜないこと。

## ソースコードの変更

**受け付けるもの:** バグ修正、セキュリティ修正、簡素化、コードの削減。

**受け付けないもの:** 機能、新たな能力、互換性対応、エンハンスメント。これらは skill にすべきである。

## Skill

NanoClaw は [Claude Code skills](https://code.claude.com/docs/en/skills) を使う — markdown ファイル(任意で補助ファイル付き)で、Claude に何かのやり方を教える。NanoClaw には 4 種類の skill があり、それぞれ違う目的を持つ。

### なぜ skill か?

各ユーザは、必要なことだけを行うクリーンで最小限のコードを持つべきである。Skill はユーザに、欲しくない機能のコードを継承することなく、自分の fork に選択的に機能を追加させる。

### Skill の種類

#### 1. Feature skill(ブランチベース)

git ブランチをマージすることで NanoClaw に能力を追加する。SKILL.md はセットアップ手順を含み、実際のコードは `skill/*` ブランチに置かれる。

**配置:** `main` 上の `.claude/skills/`(命令文のみ)、コードは `skill/*` ブランチ

**例:** `/add-telegram`、`/add-slack`、`/add-discord`、`/add-gmail`

**動作:**
1. ユーザが `/add-telegram` を実行する
2. Claude が SKILL.md に従い、`skill/telegram` ブランチを fetch + merge する
3. Claude が対話的なセットアップ(env var、bot の作成等)を案内する

**Feature skill の貢献手順:**
1. `nanocoai/nanoclaw` を fork し、`main` からブランチを切る
2. コードを変更する(新規ファイル、ソース修正、`package.json` 更新等)
3. `.claude/skills/<name>/` に SKILL.md を追加し、セットアップ手順を書く — step 1 はブランチのマージにする
4. PR を出す。あなたの作業から `skill/<name>` ブランチを作成する

良い例として `/add-telegram` を参照。完全なシステム設計は [docs/skills-as-branches.md](docs/skills-as-branches.md) を参照。

#### 2. Utility skill(コードファイル同梱)

SKILL.md と一緒にコードファイルを同梱する単体ツール。SKILL.md は Claude にツールのインストール方法を伝え、コードは skill ディレクトリ内(例:`scripts/` サブフォルダ)に置く。

**配置:** 補助ファイル付きの `.claude/skills/<name>/`

**例:** `/claw`(`scripts/claw` 内の Python CLI)

**Feature skill との主な違い:** ブランチマージは不要。コードは skill ディレクトリに自己完結しており、インストール時に所定の場所へコピーされる。

**ガイドライン:**
- コードは SKILL.md にインラインではなく別ファイルに置く
- skill ディレクトリ内のファイルを参照するときは `${CLAUDE_SKILL_DIR}` を使う
- SKILL.md にはインストール手順、使い方ドキュメント、トラブルシューティングを書く

#### 3. オペレーション skill(命令文のみ)

コード変更を伴わないワークフローとガイド。SKILL.md がそれ自身 skill そのものになる — Claude が命令文に従ってタスクを実行する。

**配置:** `main` 上の `.claude/skills/`

**例:** `/setup`、`/debug`、`/customize`、`/update-nanoclaw`、`/update-skills`

**ガイドライン:**
- 純粋な命令文 — コードファイルなし、ブランチマージなし
- 対話的なプロンプトには `AskUserQuestion` を使う
- これらは `main` に留まり、全ユーザが常に利用できる

#### 4. コンテナ skill(agent ランタイム)

ホストではなく agent コンテナ内で動く skill。コンテナの agent にツールの使い方、出力フォーマット、タスクの実行方法を教える。コンテナが起動するとき、各 group の `.claude/skills/` ディレクトリへ同期される。

**配置:** `container/skills/<name>/`

**例:** `agent-browser`(Web ブラウジング)、`capabilities`(`/capabilities` コマンド)、`status`(`/status` コマンド)、`slack-formatting`(Slack の mrkdwn 構文)

**主な違い:** これらはホスト上でユーザに起動されない。コンテナ内の Claude Code がロードし、agent の振る舞いに影響する。

**ガイドライン:**
- 同じ SKILL.md + frontmatter フォーマットに従う
- ツール権限を制限するには `allowed-tools` frontmatter を使う
- 焦点を絞ること — agent のコンテキストウィンドウは全コンテナ skill で共有される

### SKILL.md のフォーマット

すべての skill は [Claude Code skills 標準](https://code.claude.com/docs/en/skills) に従う:

```markdown
---
name: my-skill
description: この skill が何をするか、いつ使うか。
---

ここに命令文...
```

**ルール:**
- SKILL.md は **500 行未満** に保つ — 詳細は別の参照ファイルへ移す
- `name`:小文字、英数 + ハイフン、最大 64 文字
- `description`:必須 — Claude はこれを使って skill を呼ぶかを判断する
- コードは markdown にインラインではなく別ファイルに置く
- 利用可能な全 frontmatter フィールドは [skill 標準](https://code.claude.com/docs/en/skills) を参照

## テスト

提出前に、フレッシュなクローンで貢献内容をテストすること。skill の場合は end-to-end で skill を走らせ、動作することを確認する。

## プルリクエスト

### 開く前に

1. **関連 issue をリンクする。** PR が open な issue を解決するなら、description に `Closes #123` を含めて、merge 時に自動 close されるようにする。
2. **しっかりテストする。** 自分で機能を動かす。skill の場合はフレッシュなクローンでテストする。
3. **インストール固有のファイルが混ざっていないか確認する。** PR を作る前に、インストール固有のファイルが diff に含まれていないことを確認する(CLAUDE.md の「PR 衛生」セクションを参照)。
4. **PR テンプレートで正しいチェックボックスを選ぶ。** 選択に応じてラベルが自動付与される:

| チェックボックス | ラベル |
|----------|-------|
| Feature skill | `PR: Skill` + `PR: Feature` |
| Utility skill | `PR: Skill` |
| オペレーション / コンテナ skill | `PR: Skill` |
| Fix | `PR: Fix` |
| 簡素化 | `PR: Refactor` |
| ドキュメント | `PR: Docs` |

### PR の description

簡潔に保つ。当てはまらないテンプレートのセクションは削除する。description は次を含むべき:

- **What** — PR が何を追加または変更するか
- **Why** — 動機
- **How it works** — アプローチの簡潔な説明
- **How it was tested** — 動作確認のために何をしたか
- **Usage** — ユーザがどう呼び出すか(skill の場合)

description を水増ししない。長い段落より、明確な数文の方がよい。
