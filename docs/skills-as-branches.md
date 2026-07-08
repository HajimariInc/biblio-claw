# ブランチとしての Skill

> **注記**: これは NanoClaw 上流の feature skill 配布モデルの説明。biblio-claw は本モデルを踏襲する。

## 概要

本ドキュメントは **feature skill** をカバーする — git ブランチの merge 経由で機能を追加する skill。これは最も複雑な skill タイプであり、NanoClaw を拡張する主要な方法である。

NanoClaw には全体として 4 種類の skill がある。完全な分類は [CONTRIBUTING.md](../CONTRIBUTING.md) を参照:

| 種類 | 配置 | 動作 |
|------|----------|-------------|
| **Feature**(本ドキュメント) | `.claude/skills/` + `skill/*` ブランチ | SKILL.md は命令文を持ち、コードはブランチに住み、`git merge` で適用される |
| **Utility** | `.claude/skills/<name>/` にコードファイルを同梱 | 自己完結ツール、skill ディレクトリ内のコードがインストール時に所定位置にコピーされる |
| **オペレーショナル** | `main` 上の `.claude/skills/` | 命令文のみのワークフロー(setup、debug、update) |
| **コンテナ** | `container/skills/` | ランタイムで agent コンテナ内にロードされる |

---

Feature skill は upstream リポジトリ上の git ブランチとして配布される。Skill の適用は `git merge`。コアの更新も `git merge`。すべて標準的な git である。

これは以前の `skills-engine/` システム(3-way ファイル merge、`.nanoclaw/` 状態、manifest ファイル、replay、backup/restore)を、プレーンな git 操作と Claude による衝突解決に置き換えるものである。

## 動作

### リポジトリ構造

upstream リポジトリ(`nanocoai/nanoclaw`)は次を保持する:

- `main` — コア NanoClaw(skill コード無し)
- `skill/discord` — main + Discord 統合
- `skill/telegram` — main + Telegram 統合
- `skill/slack` — main + Slack 統合
- `skill/gmail` — main + Gmail 統合
- etc.

各 skill ブランチはその skill のすべてのコード変更を含む:新規ファイル、変更されたソースファイル、更新された `package.json` 依存、`.env.example` 追加 — すべて。Manifest なし、構造化された操作なし、別の `add/` と `modify/` ディレクトリなし。

### Skill の発見とインストール

Skill は 2 カテゴリに分かれる:

**オペレーショナル skill**(`main` 上、常に利用可能):
- `/setup`、`/debug`、`/update-nanoclaw`、`/customize`、`/update-skills`
- これらは命令文のみの SKILL.md ファイル — コード変更なし、ワークフローのみ
- `main` 上の `.claude/skills/` に住み、全ユーザがすぐに使える

**Feature skill**(marketplace 内、オンデマンドでインストール):
- `/add-discord`、`/add-telegram`、`/add-slack`、`/add-gmail` 等
- 各々セットアップ命令を持つ SKILL.md と、コードを持つ対応する `skill/*` ブランチを持つ
- marketplace repo(`nanocoai/nanoclaw-skills`)に住む

ユーザは marketplace と直接やりとりしない。オペレーショナル skill の `/setup` と `/customize` がプラグインインストールを透過的に扱う:

```bash
# Claude が裏で実行する — ユーザは見ない
claude plugin install nanoclaw-skills@nanoclaw-skills --scope project
```

`claude plugin install` の後、skill はホットロードされる — 再起動不要。これは `/setup` が marketplace plugin をインストールし、その後すぐに任意の feature skill を実行できることを意味する、すべて 1 セッション内で。

### 選択的な skill インストール

`/setup` はユーザに使いたい channel を尋ね、関連する skill のみを提示する:

1. 「どのメッセージング channel を使いたいですか?」 → Discord、Telegram、Slack、WhatsApp
2. ユーザが Telegram を選ぶ → Claude がプラグインをインストールして `/add-telegram` を実行
3. Telegram セットアップ後:「Telegram 用の Agent Swarm サポートを追加しますか?」 → `/add-telegram-swarm` を提示
4. 「コミュニティ skill を有効にしますか?」 → コミュニティ marketplace plugin をインストール

依存する skill(例:`telegram-swarm` は `telegram` に依存)は、親がインストールされた後にのみ提示される。`/customize` も setup 後の追加で同じパターンに従う。

### Marketplace 設定

NanoClaw の `.claude/settings.json` が公式 marketplace を登録する:

```json
{
  "extraKnownMarketplaces": {
    "nanoclaw-skills": {
      "source": {
        "source": "github",
        "repo": "nanocoai/nanoclaw-skills"
      }
    }
  }
}
```

Marketplace repo は Claude Code のプラグイン構造を使う:

```
nanocoai/nanoclaw-skills/
  .claude-plugin/
    marketplace.json              # プラグインカタログ
  plugins/
    nanoclaw-skills/              # すべての公式 skill をまとめた単一プラグイン
      .claude-plugin/
        plugin.json               # プラグインマニフェスト
      skills/
        add-discord/
          SKILL.md                # セットアップ命令、step 1 は「ブランチを merge する」
        add-telegram/
          SKILL.md
        add-slack/
          SKILL.md
        ...
```

複数の skill が 1 つのプラグインにまとめられる — `nanoclaw-skills` をインストールするとすべての feature skill が一度に利用可能になる。個別の skill ごとのインストールは不要。

各 SKILL.md は step 1 として対応する skill ブランチを merge するよう Claude に指示し、その後対話的なセットアップ(env var、bot 作成等)を進める。

### Skill の適用

ユーザが `/add-discord` を実行する(marketplace 経由で発見)。Claude が SKILL.md に従う:

1. `git fetch upstream skill/discord`
2. `git merge upstream/skill/discord`
3. 対話的セットアップ(bot 作成、token 取得、env var 設定 等)

または手動で:

```bash
git fetch upstream skill/discord
git merge upstream/skill/discord
```

### 複数 skill の適用

```bash
git merge upstream/skill/discord
git merge upstream/skill/telegram
```

Git が合成を扱う。両方の skill が同じ行を変更すると本当の衝突であり、Claude が解決する。

### コアの更新

```bash
git fetch upstream main
git merge upstream/main
```

Skill ブランチは main と merge-forward 状態に保たれているので(下記 CI セクション参照)、ユーザが merge した skill の変更と upstream の変更には適切な共通祖先がある。

### Skill 更新の確認

以前 skill ブランチを merge したユーザは更新を確認できる。各 `upstream/skill/*` ブランチに対し、そのブランチにユーザの HEAD にないコミットがあるか確認する:

```bash
git fetch upstream
for branch in $(git branch -r | grep 'upstream/skill/'); do
  # ユーザがどこかでこの skill を merge したか確認
  merge_base=$(git merge-base HEAD "$branch" 2>/dev/null) || continue
  # skill ブランチに、ユーザが持つもの以上の新コミットがあるか確認
  if ! git merge-base --is-ancestor "$branch" HEAD 2>/dev/null; then
    echo "$branch has updates available"
  fi
done
```

これは状態を必要としない — git 履歴を使って、以前どの skill が merge されたか、新しいコミットがあるかを判定する。

このロジックは 2 つの方法で利用可能:
- `/update-nanoclaw` に組み込み — main を merge した後、オプションで skill 更新を確認
- スタンドアロンの `/update-skills` — skill の更新を独立して確認・merge

### 衝突解決

任意の merge ステップで衝突が起こりうる。Claude が解決する — 衝突したファイルを読み、両側の意図を理解し、正しい結果を作る。これがブランチアプローチをスケールで実現可能にしているもの:以前は人間の判断を要した衝突解決が、今や自動化されている。

### Skill の依存

一部の skill は他の skill に依存する。例:`skill/telegram-swarm` は `skill/telegram` を必要とする。依存する skill ブランチは `main` ではなく、親 skill ブランチから派生する。

つまり `skill/telegram-swarm` は telegram のすべての変更に自身の追加を加えたものを含む。ユーザが `skill/telegram-swarm` を merge すると、両方を得る — telegram を別に merge する必要はない。

依存は git 履歴に暗黙的にある — `git merge-base --is-ancestor` がある skill ブランチが他のブランチの祖先かを判定する。別の依存ファイルは不要。

### Skill のアンインストール

```bash
# merge コミットを探す
git log --merges --oneline | grep discord

# 取り消す
git revert -m 1 <merge-commit>
```

これは skill の変更を取り消す新しいコミットを作る。Claude がフローすべてを扱える。

ユーザが merge 以降に skill のコードを変更している(独自変更を上に積んでいる)場合、revert は衝突するかもしれない — Claude が解決する。

ユーザが後で skill を再適用したくなったら、まず revert を revert する必要がある(git は revert された変更を「既に適用されて取り消された」として扱う)。Claude はこれも扱う。

## CI:Skill ブランチを最新に保つ

GitHub Action が `main` へのプッシュごとに走る:

1. すべての `skill/*` ブランチを列挙
2. 各 skill ブランチに `main` を merge する(merge-forward、rebase ではない)
3. Merge 結果でビルドとテストを実行
4. テストが通れば、更新された skill ブランチを push
5. Skill が失敗したら(衝突、ビルドエラー、テスト失敗)、手動解決のため GitHub issue をオープン

**なぜ rebase でなく merge-forward か:**
- Force push なし — 既に skill を merge したユーザの履歴を保つ
- ユーザは skill ブランチを再 merge して skill の更新(バグ修正、改善)を取り込める
- Git は merge グラフ全体で適切な共通祖先を持つ

**なぜこれがスケールするか:** 数百の skill と 1 日数コミットの main で、CI コストはわずか。Haiku は速くて安い。1〜2 年前なら現実的でなかったアプローチが、Claude がスケールで衝突を解決できる今は実用的である。

## インストールフロー

### 新規ユーザ(推奨)

1. GitHub で `nanocoai/nanoclaw` を fork する(Fork ボタンをクリック)
2. fork を clone する:
   ```bash
   git clone https://github.com/<you>/nanoclaw.git
   cd nanoclaw
   ```
3. Claude Code を実行:
   ```bash
   claude
   ```
4. `/setup` を実行 — Claude が依存、認証、コンテナセットアップ、サービス設定を扱い、無ければ `upstream` remote を追加する

Fork が推奨される理由は、ユーザにカスタマイズを push する remote を与えるため。Clone のみは試すには良いが、remote バックアップを提供しない。

### Clone から移行する既存ユーザ

以前 `git clone https://github.com/nanocoai/nanoclaw.git` で clone してローカルカスタマイズを持つユーザ:

1. GitHub で `nanocoai/nanoclaw` を fork する
2. Remote を再ルーティング:
   ```bash
   git remote rename origin upstream
   git remote add origin https://github.com/<you>/nanoclaw.git
   git push --force origin main
   ```
   `--force` が必要なのは、フレッシュな fork の main は upstream の最新だが、ユーザは自分の(おそらく遅れた)バージョンを欲しいから。Fork は今作ったばかりで失うものはない。
3. この時点から、`origin` = 自分の fork、`upstream` = nanocoai/nanoclaw

### 旧 skills engine から移行する既存ユーザ

以前 `skills-engine/` システム経由で skill を適用したユーザは、ツリーに skill コードがあるが、skill ブランチへリンクする merge コミットは無い。Git はこれらの変更が skill から来たことを知らないので、skill ブランチを上に merge すると衝突または重複する。

**今後の新 skill について:** 通常通り skill ブランチを merge するだけ。問題なし。

**既存の旧エンジン skill について**、2 つの移行パス:

**Option A: skill ごとに再適用(fork を保つ)**
1. 各旧エンジン skill について:旧変更を識別して取り消し、その後 skill ブランチを新規に merge する
2. Claude が何を取り消すかの識別と衝突解決を支援する
3. カスタム修正(skill 以外の変更)は保たれる

**Option B: 新規スタート(最もクリーン)**
1. upstream から新しい fork を作る
2. 欲しい skill ブランチを merge する
3. カスタム(skill 以外)変更を手動で再適用する
4. Claude が旧 fork を新 fork と diff してカスタム変更を識別する支援をする

両方のケースで:
- `.nanoclaw/` ディレクトリを削除する(不要)
- `skills-engine/` コードはすべての skill が移行されたら upstream から削除される
- `/update-skills` はブランチ merge 経由で適用された skill のみを追跡する — 旧エンジン skill は更新チェックに現れない

## ユーザワークフロー

### カスタム変更

ユーザは自分の main ブランチに直接カスタム変更をする。これは標準的な fork ワークフロー — 自分の `main` がカスタマイズされたバージョンそのものである。

```bash
# 変更する
vim src/config.ts
git commit -am "change trigger word to @Bob"
git push origin main
```

カスタム変更、skill、コア更新はすべて自分の main ブランチに共存する。Git は各 merge ステップで 3-way merge を扱える — merge 履歴を通して共通祖先を辿れるからである。

### Skill の適用

Claude Code で `/add-discord` を実行(marketplace plugin 経由で発見)、または手動で:

```bash
git fetch upstream skill/discord
git merge upstream/skill/discord
# 設定のセットアップ命令に従う
git push origin main
```

ユーザが skill ブランチを merge する時点で upstream の main より遅れていれば、merge は一部のコア変更も持ち込むかもしれない(skill ブランチは main と merge-forward 状態だから)。一般にこれで問題ない — 互換性のあるバージョンをすべて得る。

### コアの更新

```bash
git fetch upstream main
git merge upstream/main
git push origin main
```

これは既存の `/update-nanoclaw` skill の merge パスと同じである。

### Skill の更新

`/update-skills` を実行するか、`/update-nanoclaw` にコア更新後にチェックさせる。新コミットがある以前 merge した skill ブランチごとに、Claude が更新の merge を提案する。

### upstream に貢献する

upstream に PR を送りたいユーザ:

```bash
git fetch upstream main
git checkout -b my-fix upstream/main
# 変更する
git push origin my-fix
# my-fix から nanocoai/nanoclaw:main へ PR を作る
```

標準的な fork 貢献ワークフロー。自分のカスタム変更は自分の main に残り、PR に漏れない。

## Skill を貢献する

下記のフローは **feature skill**(ブランチベース)用。Utility skill(自己完結ツール)とコンテナ skill については、コントリビュータが直接 `.claude/skills/<name>/` または `container/skills/<name>/` にファイルを追加する PR を開く — ブランチ抽出は不要。すべての skill タイプは [CONTRIBUTING.md](../CONTRIBUTING.md) を参照。

### コントリビュータフロー(feature skill)

1. `nanocoai/nanoclaw` を fork
2. `main` からブランチを切る
3. コード変更を行う(新 channel ファイル、変更された統合ポイント、更新された package.json、.env.example 追加 等)
4. `main` への PR をオープン

コントリビュータは通常の PR を開く — skill ブランチや marketplace repo を知る必要はない。コード変更を行い submit するだけ。

### メンテナーフロー

Skill PR がレビューされて承認されたら:

1. PR のコミットから `skill/<name>` ブランチを作成:
   ```bash
   git fetch origin pull/<PR_NUMBER>/head:skill/<name>
   git push origin skill/<name>
   ```
2. コントリビュータの PR ブランチに force push し、`CONTRIBUTORS.md` にコントリビュータを追加する単一コミットで置き換える(全コード変更を削除)
3. スリム化された PR を `main` に merge(コントリビュータ追加のみ)
4. Skill の SKILL.md を marketplace repo(`nanocoai/nanoclaw-skills`)に追加

これにより:
- コントリビュータは merge クレジットを得る(PR が merge される)
- CONTRIBUTORS.md にメンテナーが自動で追加する
- Skill ブランチが彼らの作業から作られる
- `main` はクリーンに保たれる(skill コード無し)
- コントリビュータがすべきことは 1 つだけ:コード変更付きの PR をオープンすること

**Note:** Fork からの GitHub PR はデフォルトで「Allow edits from maintainers」がチェックされているので、メンテナーがコントリビュータの PR ブランチに push できる。

### Skill SKILL.md

コントリビュータはオプションで SKILL.md を提供できる(PR 内 or 別途)。これは marketplace repo に行き、次を含む:

1. Frontmatter(name、description、triggers)
2. Step 1:skill ブランチを merge する
3. Step 2-N:対話的セットアップ(bot 作成、token 取得、env var 設定、検証)

コントリビュータが SKILL.md を提供しなければ、メンテナーが PR をもとに書く。

## コミュニティ Marketplace

誰でも独自の fork に skill ブランチと marketplace repo を保持できる。これは upstream リポジトリへの書き込み権限を必要としないコミュニティ駆動の skill エコシステムを可能にする。

### 動作

コミュニティコントリビュータは:

1. NanoClaw の fork(例:`alice/nanoclaw`)を保持する
2. 自分の fork 上にカスタム skill の `skill/*` ブランチを作る
3. Marketplace repo(例:`alice/nanoclaw-skills`)を `.claude-plugin/marketplace.json` とプラグイン構造付きで作る

### コミュニティ marketplace を追加する

コミュニティコントリビュータが信頼されていれば、NanoClaw の `.claude/settings.json` に自分の marketplace を追加する PR を開ける:

```json
{
  "extraKnownMarketplaces": {
    "nanoclaw-skills": {
      "source": {
        "source": "github",
        "repo": "nanocoai/nanoclaw-skills"
      }
    },
    "alice-nanoclaw-skills": {
      "source": {
        "source": "github",
        "repo": "alice/nanoclaw-skills"
      }
    }
  }
}
```

Merge されると、すべての NanoClaw ユーザが公式と並んでコミュニティ marketplace を自動的に発見する。

### コミュニティ skill のインストール

`/setup` と `/customize` はユーザにコミュニティ skill を有効にするか尋ねる。Yes なら、Claude は `claude plugin install` 経由でコミュニティ marketplace プラグインをインストールする:

```bash
claude plugin install alice-skills@alice-nanoclaw-skills --scope project
```

コミュニティ skill はホットロードされて即座に利用可能 — 再起動不要。依存する skill は前提条件が満たされた後にのみ提示される(例:コミュニティの Telegram アドオンは Telegram インストール後)。

ユーザは `/plugin` 経由でコミュニティプラグインを手動でブラウズ・インストールもできる。

### このシステムの性質

- **ゲートキーピングは不要。** 誰でも許可なしに自分の fork に skill を作れる。自動発見される marketplace に list されるには承認だけが必要。
- **複数の marketplace が共存する。** ユーザは `/plugin` ですべての信頼された marketplace の skill を見る。
- **コミュニティ skill は同じ merge パターンを使う。** SKILL.md は単に異なる remote を指す:
  ```bash
  git remote add alice https://github.com/alice/nanoclaw.git
  git fetch alice skill/my-cool-feature
  git merge alice/skill/my-cool-feature
  ```
- **ユーザは marketplace を手動でも追加できる。** settings.json に list されていなくても、`/plugin marketplace add alice/nanoclaw-skills` を実行して任意のソースから skill を発見できる。
- **CI は fork ごと。** 各コミュニティメンテナーは自分の CI を回して自分の skill ブランチを merge-forward に保つ。upstream repo と同じ GitHub Action を使える。

## Flavor

Flavor は NanoClaw のキュレートされた fork — skill、カスタム変更、特定ユースケースに合わせた設定の組合せ(例:「NanoClaw for Sales」、「NanoClaw Minimal」、「NanoClaw for Developers」)。

### Flavor を作る

1. `nanocoai/nanoclaw` を fork
2. 欲しい skill を merge する
3. カスタム変更を行う(トリガーワード、プロンプト、統合 等)
4. 自分の fork の `main` が flavor そのもの

### Flavor をインストールする

`/setup` 中、設定が始まる前にユーザに flavor の選択肢が提示される。Setup skill は repo から `flavors.yaml` を読み(upstream と一緒に出荷、常に最新)、オプションを提示する:

AskUserQuestion:「Flavor で始めますか、それともデフォルトの NanoClaw で?」
- Default NanoClaw
- NanoClaw for Sales — Gmail + Slack + CRM(alice がメンテ)
- NanoClaw Minimal — Telegram のみ、軽量(bob がメンテ)

Flavor が選ばれた場合:

```bash
git remote add <flavor-name> https://github.com/alice/nanoclaw.git
git fetch <flavor-name> main
git merge <flavor-name>/main
```

その後 setup は通常通り続く(依存、認証、コンテナ、サービス)。

**この選択肢はフレッシュな fork でのみ提示される** — ユーザの main が upstream の main にマッチまたは近く、ローカルコミットがないとき。`/setup` が大きなローカル変更を検知した場合(既存 install で再実行)、flavor 選択をスキップして直接設定に進む。

インストール後、ユーザの fork は 3 つの remote を持つ:
- `origin` — 自分の fork(カスタマイズをここに push)
- `upstream` — `nanocoai/nanoclaw`(コア更新)
- `<flavor-name>` — flavor fork(flavor 更新)

### Flavor の更新

```bash
git fetch <flavor-name> main
git merge <flavor-name>/main
```

Flavor メンテナーが自分の fork を最新に保つ(upstream を merge、skill を更新)。ユーザはコア更新を pull するのと同じ方法で flavor 更新を pull する。

### Flavor レジストリ

`flavors.yaml` は upstream repo に住む:

```yaml
flavors:
  - name: NanoClaw for Sales
    repo: alice/nanoclaw
    description: Gmail + Slack + CRM 統合、毎日のパイプラインサマリ
    maintainer: alice

  - name: NanoClaw Minimal
    repo: bob/nanoclaw
    description: Telegram のみ、コンテナオーバーヘッドなし
    maintainer: bob
```

誰でも自分の flavor を追加する PR を出せる。`/setup` 実行時、clone された repo の一部なのでローカルで利用可能。

### 発見可能性

- **セットアップ中** — flavor 選択が初期セットアップフローの一部として提示される
- **`/browse-flavors` skill** — `flavors.yaml` を読み、いつでもオプションを提示する
- **GitHub トピック** — flavor fork は検索性のため `nanoclaw-flavor` でタグ付けできる
- **Discord / website** — コミュニティキュレートのリスト

## 移行

旧 skills engine からブランチへの移行は完了している。すべての feature skill は今 `skill/*` ブランチに住み、skills engine は削除された。

### Skill ブランチ

| ブランチ | ベース | 説明 |
|--------|------|-------------|
| `skill/whatsapp` | `main` | WhatsApp channel |
| `skill/telegram` | `main` | Telegram channel |
| `skill/slack` | `main` | Slack channel |
| `skill/discord` | `main` | Discord channel |
| `skill/gmail` | `main` | Gmail channel |
| `skill/voice-transcription` | `skill/whatsapp` | OpenAI Whisper 音声書き起こし |
| `skill/image-vision` | `skill/whatsapp` | 画像添付処理 |
| `skill/pdf-reader` | `skill/whatsapp` | PDF 添付読み込み |
| `skill/local-whisper` | `skill/voice-transcription` | ローカル whisper.cpp 書き起こし |
| `skill/ollama-tool` | `main` | ローカルモデル用 Ollama MCP server |
| `skill/apple-container` | `main` | Apple Container ランタイム |
| `skill/reactions` | `main` | WhatsApp 絵文字リアクション |

### 削除されたもの

- `skills-engine/` ディレクトリ(エンジン全体)
- `scripts/apply-skill.ts`、`scripts/uninstall-skill.ts`、`scripts/rebase.ts`
- `scripts/fix-skill-drift.ts`、`scripts/validate-all-skills.ts`
- `.github/workflows/skill-drift.yml`、`.github/workflows/skill-pr.yml`
- すべての skill ディレクトリから `add/`、`modify/`、`tests/`、`manifest.yaml`
- `.nanoclaw/` 状態ディレクトリ

オペレーショナル skill(`setup`、`debug`、`update-nanoclaw`、`customize`、`update-skills`)は main の `.claude/skills/` に残る。

## 何が変わるか

### README クイックスタート

Before:
```bash
git clone https://github.com/nanocoai/NanoClaw.git
cd NanoClaw
claude
```

After:
```
1. GitHub で nanocoai/nanoclaw を fork
2. git clone https://github.com/<you>/nanoclaw.git
3. cd nanoclaw
4. claude
5. /setup
```

### Setup skill(`/setup`)

セットアップフローの更新:

- `upstream` remote が存在するか確認、無ければ追加:`git remote add upstream https://github.com/nanocoai/nanoclaw.git`
- `origin` がユーザの fork を指しているか確認(nanocoai ではない)。Nanocoai を指していたら、fork 移行を案内する。
- **Marketplace プラグインをインストール:** `claude plugin install nanoclaw-skills@nanoclaw-skills --scope project` — すべての feature skill を利用可能にする(ホットロード、再起動なし)
- **どの channel を追加するか尋ねる:** channel オプション(Discord、Telegram、Slack、WhatsApp、Gmail)を提示し、選択された channel の対応する `/add-*` skill を実行
- **依存する skill を提示:** channel セットアップ後、関連アドオンを提示(例:Telegram の後に Agent Swarm、WhatsApp の後に音声書き起こし)
- **オプションでコミュニティ marketplace を有効化:** ユーザにコミュニティ skill が欲しいか尋ね、それらの marketplace プラグインもインストール

### `.claude/settings.json`

公式 marketplace が自動登録されるための marketplace 設定:

```json
{
  "extraKnownMarketplaces": {
    "nanoclaw-skills": {
      "source": {
        "source": "github",
        "repo": "nanocoai/nanoclaw-skills"
      }
    }
  }
}
```

### main 上の skill ディレクトリ

`main` 上の `.claude/skills/` ディレクトリはオペレーショナル skill(setup、debug、update-nanoclaw、customize、update-skills)のみを保持する。Feature skill(add-discord、add-telegram 等)は marketplace repo に住み、`/setup` または `/customize` 中に `claude plugin install` 経由でインストールされる。

### Skills engine の削除

以下が削除可能:

- `skills-engine/` — ディレクトリ全体(apply、merge、replay、state、backup 等)
- `scripts/apply-skill.ts`
- `scripts/uninstall-skill.ts`
- `scripts/fix-skill-drift.ts`
- `scripts/validate-all-skills.ts`
- `.nanoclaw/` — 状態ディレクトリ
- すべての skill ディレクトリから `add/` と `modify/` サブディレクトリ
- main 上の `.claude/skills/` から feature skill SKILL.md ファイル(marketplace に移動した)

オペレーショナル skill(`setup`、`debug`、`update-nanoclaw`、`customize`、`update-skills`)は main の `.claude/skills/` に残る。

### 新しいインフラ

- **Marketplace repo**(`nanocoai/nanoclaw-skills`) — すべての feature skill の SKILL.md ファイルをまとめた単一の Claude Code プラグイン
- **CI GitHub Action** — `main` への push ごとにすべての `skill/*` ブランチに `main` を merge-forward、衝突解決は Claude(Haiku)を使う
- **`/update-skills` skill** — git 履歴を使って skill ブランチ更新を確認・適用する
- **`CONTRIBUTORS.md`** — skill コントリビュータを追跡する

### Update skill(`/update-nanoclaw`)

Update skill はブランチベースのアプローチでシンプルになる。旧 skills engine はコア更新を merge した後にすべての適用済 skill を replay する必要があった — そのステップ全体が消える。Skill 変更はすでにユーザの git 履歴にあるので、`git merge upstream/main` がそのまま動く。

**そのまま残るもの:**
- Preflight(クリーンな working tree、upstream remote)
- バックアップブランチ + タグ
- プレビュー(git log、git diff、ファイルバケット)
- Merge / cherry-pick / rebase オプション
- 衝突プレビュー(dry-run merge)
- 衝突解決
- ビルド + テスト検証
- Rollback 命令

**削除されるもの:**
- Skill replay ステップ(旧 skills engine がコア更新後に skill を再適用するのに必要だった)
- 構造化操作の再実行(npm 依存、env var — 今は git 履歴の一部)

**追加されるもの:**
- 末尾のオプションステップ:「Skill 更新を確認?」 これは `/update-skills` ロジックを走らせる
- これは以前 merge した skill ブランチに新コミットがあるかを確認する(バグ修正、skill 自身の改善 — 単なる main からの merge-forward ではない)

**なぜユーザがコア更新後に skill を再 merge する必要がないか:**
ユーザが skill ブランチを merge した時、その変更は git 履歴の一部になった。後で `upstream/main` を merge するとき、git は通常の 3-way merge を行う — ツリー内の skill 変更は触られず、コア変更だけが持ち込まれる。Merge-forward CI は skill ブランチを最新 main と互換性を保つが、それは新規に skill を適用するユーザのため。既に skill を merge した既存ユーザは何もする必要がない。

ユーザが skill ブランチを再 merge する必要があるのは、skill 自身が更新されたとき(main からの merge-forward だけではない)。`/update-skills` チェックがこれを検出する。

## Discord 告知

### 既存ユーザ向け

> **Skill が git ブランチになった**
>
> NanoClaw の skill の仕組みを簡素化しました。カスタム skills engine の代わりに、skill は今や merge する git ブランチになっています。
>
> **これがあなたにとって何を意味するか:**
> - Skill の適用:`git fetch upstream skill/discord && git merge upstream/skill/discord`
> - コア更新:`git fetch upstream main && git merge upstream/main`
> - Skill 更新確認:`/update-skills`
> - `.nanoclaw/` 状態ディレクトリと skills engine はもうありません
>
> **clone より fork を推奨します。** これによりカスタマイズを push する remote を得られます。
>
> **現在ローカル変更付きの clone を持っているなら**、fork に移行してください:
> 1. GitHub で `nanocoai/nanoclaw` を fork する
> 2. 実行:
>    ```
>    git remote rename origin upstream
>    git remote add origin https://github.com/<you>/nanoclaw.git
>    git push --force origin main
>    ```
>    上流から遠く遅れていてもこれは動きます — 現在の状態を push するだけ。
>
> **以前旧システム経由で skill を適用していたなら**、コード変更はすでに working tree にあります — やり直す必要はありません。`.nanoclaw/` ディレクトリは削除できます。今後の skill と更新はブランチベースのアプローチを使います。
>
> **Skill の発見:** Skill は今 Claude Code のプラグイン marketplace 経由で利用可能です。Claude Code で `/plugin` を実行して利用可能な skill をブラウズ・インストールしてください。

### Skill コントリビュータ向け

> **Skill の貢献**
>
> Skill を貢献するには:
> 1. `nanocoai/nanoclaw` を fork
> 2. `main` からブランチを切ってコード変更
> 3. 通常の PR をオープン
>
> それだけです。私たちがあなたの PR から `skill/<name>` ブランチを作り、CONTRIBUTORS.md にあなたを追加し、SKILL.md を marketplace に追加します。CI は Claude を使って衝突解決をしながら、skill ブランチを `main` と merge-forward 状態に自動的に保ちます。
>
> **自分の skill marketplace を運営したい?** 自分の fork に skill ブランチを保持して marketplace repo を作ってください。NanoClaw の自動発見 marketplace に追加する PR をオープン — またはユーザは `/plugin marketplace add` 経由で手動追加できます。
