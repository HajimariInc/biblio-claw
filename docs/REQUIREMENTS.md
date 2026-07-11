# NanoClaw 要件

> **biblio-claw fork note**: 本 doc は NanoClaw v2 上流 (commit `2492259`) の日本語訳。biblio-claw の追加要件 (Node 24.13+ / Vertex AI + GKE Autopilot + Google Cloud + Slack 2 環境 + Fugue channel 連携) は [`../README.md`](../README.md) のクイックスタート節を参照。本 doc は上流の設計判断の背景として残置。

プロジェクト作成者による原初の要件と設計判断。

---

## なぜ存在するか

これは OpenClaw(旧 ClawBot)に対する軽量で安全な代替である。あのプロジェクトはモンスター化した — 異なる gateway を走らせる 4〜5 個のプロセス、終わらない設定ファイル、終わらない統合。Agent が分離されたプロセスで動かず、システムの触ってはいけない部分にアクセスしないよう、leaky な workaround だらけのセキュリティ悪夢。コードベース全体を現実的に理解するのは不可能。動かすときは事実上 yolo するだけ。

NanoClaw は、そうした混乱なしにコア機能を提供する。

---

## 設計哲学

### 理解できるほど小さく

コードベース全体は、自分で読んで理解できるものであるべきだ。1 つの Node.js プロセス。わずかなソースファイル。マイクロサービスなし、メッセージキューなし、抽象化レイヤなし。

### True な分離によるセキュリティ

Agent が何かにアクセスするのを防ごうとするアプリケーションレベルの permission システムではなく、agent は実際の Linux コンテナで動く。分離は OS レベルである。Agent は明示的にマウントされたものしか見られない。コマンドは Mac ではなくコンテナの中で動くので、bash アクセスを許しても安全である。

### 個人ユーザのために作る

これはフレームワークでもプラットフォームでもない。各ユーザの正確なニーズに合わせるソフトウェアである。repo を fork し、欲しい channel(WhatsApp、Telegram、Discord、Slack、Gmail)を追加すると、ちょうどやりたいことをするクリーンなコードが手に入る。

### カスタマイズ = コード変更

設定の肥大化はなし。振る舞いを変えたいなら、コードを書き換える。コードベースは、それが安全で実用的なほど小さい。トリガーワードのような最小限のものは config にある。それ以外はすべて — やりたいことに合わせてコードを書き換えるだけ。

### AI ネイティブ開発

インストールウィザードは要らない — Claude Code がセットアップを案内する。監視ダッシュボードは要らない — Claude Code に何が起きているか聞く。手の込んだログ UI は要らない — Claude にログを読んでもらう。デバッグツールは要らない — 問題を説明すれば Claude が直す。

コードベースは AI コラボレータの存在を前提にしている。Claude が常にいるので、過度に自己ドキュメント化や自己デバッグ化される必要はない。

### 機能ではなくスキル

人々が貢献するとき、「WhatsApp と並んで Telegram サポート」を追加すべきではない。コードベースを変形させる `/add-telegram` のような skill を貢献すべきである。ユーザは repo を fork し、skill を実行してカスタマイズし、ちょうどやりたいことをするクリーンなコードを手にする — 全員のユースケースを同時にサポートしようとする肥大化したシステムではなく。

---

## RFS (Request for Skills)

貢献してほしい skill のリスト:

### 通信チャネル
- `/add-signal` - Signal を channel として追加
- `/add-matrix` - Matrix 統合を追加

> **Note:** Telegram、Slack、Discord、Gmail、Apple Container の skill は既に存在する。全リストは [skills ドキュメント](https://docs.nanoclaw.dev/integrations/skills-system) を参照。

---

## ビジョン

メッセージング経由でアクセス可能なパーソナル Claude アシスタント、最小限のカスタムコードで実現する。

**コアコンポーネント:**
- **Claude Agent SDK** をコア agent として
- **コンテナ** で分離された agent 実行(Linux VM)
- **マルチチャネルメッセージング**(WhatsApp、Telegram、Discord、Slack、Gmail) — 必要な channel だけを追加
- **永続メモリ** 会話ごと + グローバル
- **スケジュール済タスク** Claude を走らせて結果をメッセージで返せる
- **Web アクセス** 検索 + ブラウジング
- **ブラウザ自動化** agent-browser 経由

**実装アプローチ:**
- 既存ツール(channel ライブラリ、Claude Agent SDK、MCP server)を使う
- 最小限のグルーコード
- 可能ならファイルベースのシステム(メモリは CLAUDE.md、group はフォルダ)

---

## アーキテクチャ判断

### メッセージルーティング
- router が接続された channel を listen し、設定に基づきメッセージをルーティングする
- 登録済 group からのメッセージのみ処理する
- トリガー:`@Andy` プレフィックス(大小文字区別なし)、`ASSISTANT_NAME` env var で設定可能
- 未登録 group は完全に無視する

### メモリシステム
- **Group ごとのメモリ:** 各 group は自身の `CLAUDE.md` を持つフォルダを持つ
- **グローバルメモリ:** ルートの `CLAUDE.md` は全 group から読まれるが、「main」(self-chat)からのみ書き込める
- **ファイル:** Group は自身のフォルダ内でファイルを作成 / 読み取り、参照できる
- Agent は group のフォルダで動き、両方の CLAUDE.md を自動的に継承する

### セッション管理
- 各 group は会話セッションを保持する(Claude Agent SDK 経由)
- セッションはコンテキストが長くなりすぎたら重要情報を保ちつつ自動コンパクションする

### コンテナ分離
- すべての agent はコンテナ(軽量 Linux VM)の中で動く
- 各 agent 呼び出しはマウントされたディレクトリを伴うコンテナを spawn する
- コンテナはファイルシステム分離を提供する — agent はマウントされたパスしか見られない
- コマンドは host ではなくコンテナの中で動くので、bash アクセスを許しても安全
- agent-browser によるブラウザ自動化、コンテナ内に Chromium

### スケジュール済タスク
- ユーザは任意の group から Claude に繰り返しまたは 1 回限りのタスクをスケジュール依頼できる
- タスクは作成元 group のコンテキストで完全な agent として実行される
- タスクはコンテナ内で安全な Bash を含む全ツールにアクセスできる
- タスクは `send_message` ツール経由で自身の group にメッセージを送るか、silent に完了するかをオプションで選べる
- タスク実行は duration と結果と共にデータベースにログされる
- スケジュール種別:cron 式、間隔(ms)、または 1 回限り(ISO timestamp)
- main から:任意の group にタスクをスケジュール、全タスクを表示 / 管理可能
- 他の group から:その group のタスクのみ管理可能

### Group 管理
- 新しい group は main channel 経由で明示的に追加される
- Group は SQLite に登録される(main channel または IPC `register_group` コマンド経由)
- 各 group は `groups/` 配下に専用フォルダを持つ
- Group は `containerConfig` 経由で追加ディレクトリをマウントできる

### Main channel の特権
- Main channel は admin / control group(典型的には self-chat)
- グローバルメモリ(`groups/CLAUDE.md`)に書き込める
- 任意の group にタスクをスケジュールできる
- 全 group のタスクを表示 / 管理できる
- 任意の group に対して追加ディレクトリマウントを設定できる

---

## 統合ポイント

### Channel
- WhatsApp(baileys)、Telegram(grammy)、Discord(discord.js)、Slack(@slack/bolt)、Gmail(googleapis)
- 各 channel は別の fork repo に住み、skill 経由で追加される(例:`/add-whatsapp`、`/add-telegram`)
- メッセージは SQLite に保存され、router が poll する
- Channel は起動時に self-register する — 未設定の channel は警告と共にスキップされる

### Scheduler
- 組み込みの scheduler が host 上で走り、タスク実行のためコンテナを spawn する
- カスタム `nanoclaw` MCP server(コンテナ内)がスケジューリングツールを提供する
- ツール:`schedule_task`、`list_tasks`、`pause_task`、`resume_task`、`cancel_task`、`send_message`
- タスクは SQLite に実行履歴と共に保存される
- Scheduler ループは 1 分ごとに due タスクをチェックする
- タスクはコンテナ化された group コンテキスト内で Claude Agent SDK を実行する

### Web アクセス
- 組み込みの WebSearch と WebFetch ツール
- 標準の Claude Agent SDK 機能

### ブラウザ自動化
- agent-browser CLI、コンテナ内に Chromium
- snapshot ベースの操作、要素参照(@e1、@e2 等)付き
- スクリーンショット、PDF、動画記録
- 認証状態の永続化

---

## セットアップとカスタマイズ

### 哲学
- 最小限の設定ファイル
- セットアップとカスタマイズは Claude Code 経由で行う
- ユーザは repo を clone し、Claude Code を実行して設定する
- 各ユーザは自分の正確なニーズに合うカスタムセットアップを得る

### Skill
- `/setup` - 依存をインストール、channel を設定、サービスを起動
- `/customize` - 機能追加のための汎用 skill
- `/update-nanoclaw` - upstream の変更を pull、カスタマイズと merge

### デプロイ
- macOS(launchd)、Linux(systemd)、Windows(WSL2)で動く
- 単一の Node.js プロセスがすべてを扱う

---

## 個人設定(参考)

これは作成者の設定で、参考のためここに保存されている:

- **トリガー:** `@Andy`(大小文字区別なし)
- **応答プレフィックス:** `Andy:`
- **ペルソナ:** デフォルトの Claude(カスタムパーソナリティなし)
- **Main channel:** Self-chat(WhatsApp で自分自身にメッセージ)

---

## プロジェクト名

**NanoClaw** - Clawdbot(現 OpenClaw)への参照。
