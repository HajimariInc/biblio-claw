# NanoClaw のリリース手順

v2.0.63 以降、`main` にランディングする `package.json` のバージョンバンプごとに GitHub Release を公開することを目指している。リリースはメンテナーが手作業でカットするので、バンプの merge とリリース公開の間にラグが出ることがある。意図は **タイムリーさ** であって、すべてのバンプとの厳密な 1:1 対応ではない。

各リリースは次を出荷する:

- `main` 上のタグ付きコミット(`vX.Y.Z`)
- `## [<version>] - <YYYY-MM-DD>` 配下の `CHANGELOG.md` エントリ
- 本文が CHANGELOG エントリ + コントリビューターセクションをミラーする GitHub Release

## いつリリースをカットするか

リリースはメンテナーが公開することによってカットされる。トリガーは `main` 上の `package.json` バンプだが、公開ステップは手動である — 固定されたスケジュールはなく、続けて landed したバンプは 1 つのリリースにまとめてもよい(v2.0.55 〜 v2.0.63 がそうだったように)。バッチにするよりも、頻繁にカットする方が好ましい:小さいリリースの方が読みやすく、pin しやすく、revert もしやすい。

## リリースに含めるもの

`CHANGELOG.md` がユーザーから見える変更の正本である。GitHub 上のリリース本文はそれをミラーする。次を目指す:

- メジャー機能や修正ごとに **太字のリードイン**、続けて文章での説明
- ユーザーアクションが必要なあらゆる変更には **`[BREAKING]` プレフィックス**。回避策は常にインラインで含めること — 修正のために別ドキュメントへのリンクで済ませない。
- メジャー機能には **ドキュメントリンク**(repo 内の相対パス、例: `[setup/lib/install-slug.sh](setup/lib/install-slug.sh)`)
- 実行可能なステップは **インラインコマンド** として backtick で囲む
- **マイナー項目** はエントリ末尾に太字リードインなしの 1 行 bullet として置く
- ユーザー向けの文章には **PR 番号を入れない**。PR 参照は GitHub Release の `## Contributors` セクションに置く

## リリースの公開

1. `package.json` をバンプし、同じコミットで `CHANGELOG.md` エントリを追加する(コミットメッセージ:`chore: bump version to vX.Y.Z`)。
2. バンプコミットが `main` にランディングしたら、ドラフトの GitHub Release を開く:
   - **Tag:** `vX.Y.Z`、ターゲットは `main`
   - **Title:** `vX.Y.Z`(バージョンのみ — 記述的な内容は本文に置き、CHANGELOG のヘッダパターンと一致させる)
   - **Body:** CHANGELOG エントリを逐語的にコピーする。リリース期間中に作業を landed したすべての PR 作者を列挙する `## Contributors` セクションを追記する。末尾に `**Full Changelog**: https://github.com/nanocoai/nanoclaw/compare/<prev-tag>...vX.Y.Z` の行を追加する。
3. 期間中に初めて NanoClaw に PR を出した人がいる場合は、`## Contributors` の上に `## New Contributors` セクションを追加し、各初参加者の初 PR リンクと Discord への招待を入れる。
4. 公開する(ドラフト保存だけで済ませない)。

## ロールアップリリース

2 つの GitHub Release の間に複数の `package.json` バンプがランディングした場合(v2.0.54 と v2.0.63 の間に起きたように)、次のリリースはロールアップになる:その CHANGELOG エントリは最後にリリースされたタグ以降に merge されたすべてをカバーし、本文は 1 行の「Rollup release covering vX.Y.Z through vX.Y.W.」というノートで始める。キャッチアップ後は、1 バンプ 1 リリースに戻る。

## チャネルと安定性

NanoClaw は現状単一のチャネルを出荷している:公開されるすべてのリリースが安定版である。

- **Latest** — `main` 上の最新リリース、GitHub Releases ページで "Latest release" と表示される。自動バンプを希望するコンシューマーは GitHub の `/releases/latest` ポインタを追う。
- **Stable** — 現状は latest と同一。NanoClaw には別の stable ブランチも、pre-release / RC チャネルも存在しない。
- **Pinned** — タグ付けされた任意のリリース。再現可能で、パッケージャーや fork に推奨される選択肢である;公開されたタグは移動も撤回もされない。

将来 pre-release チャネルが導入された場合(例:`vX.Y.Z-rc.N`)、これらのリリースは GitHub 上で "Pre-release" としてマークされ、`latest` ポインタにはならない。その際、本セクションはプロモーションパスを説明するように更新される。

タグが正本である — GitHub Release の `target_commitish` は常にタグ付きコミットを指す。
