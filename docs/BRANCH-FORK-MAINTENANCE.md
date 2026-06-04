# Branch と Fork の維持ガイドライン

## 構造

**`nanocoai/nanoclaw`**(upstream) — skill 定義(`.claude/skills/`)を持つコアエンジン。`main` には channel コードは無い。

**Channel fork**(`nanoclaw-whatsapp`、`nanoclaw-telegram`、`nanoclaw-slack` 等) — 各 fork = upstream + 1 つの channel のコードを適用したもの。ユーザは upstream を clone した後、fork を自分の clone に merge して channel を追加する。

**upstream 上の `skill/*` と `feat/*` ブランチ** — channel に無関係な機能を追加する(例:`skill/compact`、`skill/apple-container`)。ユーザはこれらを自分の clone に merge して機能を追加する。fork と重複する channel 固有の skill ブランチ(例:`skill/whatsapp`、`skill/telegram`)はレガシー。

## ユーザはどう機能を追加するか

```
ユーザは upstream main を clone する
  ├── nanoclaw-whatsapp fork を merge  → WhatsApp 追加
  ├── skill/compact ブランチを merge    → /compact コマンド追加
  └── skill/apple-container を merge   → Apple Container に切替
```

## merge の方向

```
upstream main ──→ channel fork    (forward merge で fork を追従させる)
upstream main ──→ skill ブランチ   (forward merge でブランチを追従させる)
```

Fork と skill ブランチは、適用したコード変更を保持する。ユーザはそれらを自分の clone / fork に merge して機能を追加する。それらが upstream `main` に逆向きに merge されることはない。

## Forward merge の手順

```bash
# ローカルの nanoclaw チェックアウト内で
git checkout main && git pull

# fork の場合:
git fetch nanoclaw-whatsapp
git checkout -B whatsapp-merge nanoclaw-whatsapp/main
git merge main
# 衝突を解決する(下記参照)
# upstream 専用の workflow を削除する(main に存在するため毎回 merge で再追加される):
git rm .github/workflows/bump-version.yml .github/workflows/update-tokens.yml 2>/dev/null
git push nanoclaw-whatsapp HEAD:main
git checkout main && git branch -D whatsapp-merge

# skill ブランチの場合:
git checkout -B skill/compact origin/skill/compact
git merge main
# 衝突を解決する(下記参照)
git push origin skill/compact
git checkout main && git branch -D skill/compact
```

## 衝突の解決

毎回同じファイルが衝突する:

| ファイル | 解決法 |
|------|------------|
| `package.json` | main のバージョンを取りつつ、fork / ブランチ固有の依存は残す |
| `pnpm-lock.yaml` | `git checkout main -- pnpm-lock.yaml && pnpm install` |
| `.env.example` | main のエントリ + fork / ブランチ固有のエントリを統合 |
| `repo-tokens/badge.svg` | main のバージョンを取る(自動生成) |

ソースコードの変更(例:`src/types.ts`、`src/index.ts`)は通常クリーンに自動 merge されるが、両側が同じ行を変更すると衝突しうる。**forward merge のたびに必ずビルドとテストを行う** — 自動 merge されたコードは、git が衝突を報告しなくても silent に間違っている可能性がある(例:リネームされた関数を参照する、削除されたパラメータを使う等)。

## いつ forward merge するか

共有ファイル(`package.json`、`src/index.ts`、`CLAUDE.md` 等)に触る main の変更があった後。小さな頻繁な merge = trivial な衝突。大きな低頻度の merge = 痛い。

## Fork のセットアップ

新しい channel fork を作るとき:

1. `nanoclaw` を `nanoclaw-{channel}` に fork する
2. upstream 専用 workflow を削除する:`bump-version.yml`、`update-tokens.yml`
3. channel コード、依存、env var を追加する
4. クリーンなベースラインを確立するため、すぐに main を forward merge する

## 依存

Fork とブランチは upstream の依存に加えて、自分の依存を持つ。upstream が依存を追加 / 削除したら、次の forward merge 後も fork / ブランチがビルドできるか確認すること — 推移的な依存の変更が downstream のコードを壊しうる。
