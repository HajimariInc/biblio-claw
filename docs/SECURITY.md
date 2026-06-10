# NanoClaw セキュリティモデル

## トラストモデル

| エンティティ | 信頼レベル | 根拠 |
|--------|-------------|-----------|
| Main group | Trusted | プライベートな self-chat、admin コントロール |
| Non-main group | Untrusted | 他のユーザは悪意がある可能性 |
| コンテナ agent | Sandboxed | 分離された実行環境 |
| 受信メッセージ | ユーザ入力 | プロンプト injection の可能性 |

## セキュリティ境界

### 1. コンテナ分離(主要境界)

Agent はコンテナ(軽量 Linux VM)で実行され、次を提供する:
- **プロセス分離** - コンテナのプロセスは host に影響を与えられない
- **ファイルシステム分離** - 明示的にマウントされたディレクトリのみ可視
- **非 root 実行** - 非特権の `node` ユーザ(uid 1000)として動作
- **エフェメラルコンテナ** - 呼び出しごとにフレッシュな環境(`--rm`)

これが主要セキュリティ境界である。アプリケーションレベルのパーミッションチェックに依存するのではなく、攻撃面はマウントされたものに限定される。

### 2. マウントセキュリティ

**外部 Allowlist** - マウント権限は `~/.config/nanoclaw/mount-allowlist.json` に保存されており、これは:
- プロジェクトルートの外側
- コンテナに決してマウントされない
- Agent には変更できない

**デフォルトでブロックされるパターン:**
```
.ssh, .gnupg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, id_rsa, id_ed25519,
private_key, .secret
```

**保護策:**
- 検証前にシンボリックリンクを解決(traversal 攻撃を防ぐ)
- コンテナパス検証(`..` と絶対パスを拒否)
- `nonMainReadOnly` オプションが non-main group に対して read-only を強制

**Read-only プロジェクトルート:**

Main group のプロジェクトルートは read-only でマウントされる。Agent が書き込み可能なパス(store、group フォルダ、IPC、`.claude/`)は別途マウントされる。これにより、agent が host のアプリケーションコード(`src/`、`dist/`、`package.json` 等)を変更してしまい、次回再起動時にサンドボックスが完全にバイパスされる事態を防ぐ。`store/` ディレクトリは read-write でマウントされ、main agent が SQLite データベースに直接アクセスできるようにしてある。

### 3. セッション分離

各 group は `data/sessions/{group}/.claude/` に分離された Claude セッションを持つ:
- Group は他の group の会話履歴を見られない
- セッションデータには全メッセージ履歴と読まれたファイル内容を含む
- グループ横断の情報漏洩を防ぐ

### 4. IPC 認可

メッセージとタスク操作は group identity に対して検証される:

| 操作 | Main Group | Non-Main Group |
|-----------|------------|----------------|
| 自分の chat へのメッセージ送信 | ✓ | ✓ |
| 他の chat へのメッセージ送信 | ✓ | ✗ |
| 自分宛のタスクスケジュール | ✓ | ✓ |
| 他者宛のタスクスケジュール | ✓ | ✗ |
| 全タスク表示 | ✓ | 自分のみ |
| 他 group の管理 | ✓ | ✗ |

### 5. クレデンシャル分離(OneCLI Agent Vault)

実 API クレデンシャルは **コンテナに入らない**。NanoClaw は [OneCLI's Agent Vault](https://github.com/onecli/onecli) を使って outbound リクエストを proxy し、gateway レベルでクレデンシャルを注入する。

**仕組み:**
1. クレデンシャルは `onecli secrets create` で一度だけ登録され、OneCLI が保持・管理する
2. NanoClaw がコンテナを spawn するとき、`applyContainerConfig()` を呼んで outbound HTTPS を OneCLI gateway 経由にする
3. Gateway がリクエストを host とパスでマッチし、実クレデンシャルを注入して forward する
4. Agent は実クレデンシャルを発見できない — 環境変数にも、stdin にも、ファイルにも、`/proc` にも無い

**Agent ごとのポリシー:**
NanoClaw の各 group は独自の OneCLI agent identity を持つ。これにより group ごとに異なるクレデンシャルポリシーを許す(例:営業 agent vs サポート agent)。OneCLI はレート制限をサポートしており、時間制限付きアクセスと承認フローはロードマップ上にある。

**マウントされないもの:**
- Channel 認証セッション(`store/auth/`) — host のみ
- マウント allowlist — 外部、決してマウントされない
- ブロックされるパターンにマッチするクレデンシャル
- プロジェクトルートマウントでは `.env` は `/dev/null` で覆われる

## 権限の比較

| 能力 | Main Group | Non-Main Group |
|------------|------------|----------------|
| プロジェクトルートアクセス | `/workspace/project` (ro) | なし |
| Store (SQLite DB) | `/workspace/project/store` (rw) | なし |
| Group フォルダ | `/workspace/group` (rw) | `/workspace/group` (rw) |
| グローバルメモリ | プロジェクト経由で暗黙的 | `/workspace/global` (ro) |
| 追加マウント | 設定可能 | 許可されない限り read-only |
| ネットワークアクセス | 無制限 | 無制限 |
| MCP ツール | すべて | すべて |

## セキュリティアーキテクチャ図

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  受信メッセージ (悪意がある可能性)                                  │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ トリガーチェック、入力エスケープ
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                        │
│  • メッセージルーティング                                          │
│  • IPC 認可                                                       │
│  • マウント検証 (外部 allowlist)                                   │
│  • コンテナライフサイクル                                          │
│  • OneCLI Agent Vault (クレデンシャル注入、ポリシー強制)            │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ 明示マウントのみ、シークレットなし
┌──────────────────────────────────────────────────────────────────┐
│                CONTAINER (ISOLATED/SANDBOXED)                     │
│  • Agent 実行                                                     │
│  • Bash コマンド (サンドボックス内)                                │
│  • ファイル操作 (マウント先に限定)                                  │
│  • API 呼び出しは OneCLI Agent Vault 経由でルーティング             │
│  • 環境変数にもファイルシステムにも実クレデンシャルなし              │
└──────────────────────────────────────────────────────────────────┘
```

## サプライチェーンセキュリティ (pnpm)

NanoClaw は `pnpm-workspace.yaml` に設定された 2 つのサプライチェーン防御を持つ pnpm を使う:

### Minimum Release Age

`minimumReleaseAge: 4320`(3 日)。pnpm は公開から 3 日未満のパッケージバージョンを解決しない。これは typosquatting と侵害されたメンテナアカウントへの防御である — 悪意ある公開のほとんどは 72 時間以内に検出されて取り下げられる。

**Release age ゲートからパッケージを除外する**(`minimumReleaseAgeExclude`):

これは稀であるべき。zero-day fix や重要な依存が即時更新を要する場合:

1. 除外は人間のメンテナによってレビューと承認を受けること
2. エントリは除外する **正確なバージョン** を pin すること — 範囲やワイルドカードは不可
   ```yaml
   minimumReleaseAgeExclude:
     some-package: "1.2.3"  # @user が承認、2026-04-14 — CVE-XXXX-YYYY 修正
   ```
3. バージョンが閾値(3 日)を超えたら除外を取り除く
4. 自動 agent(Claude、CI bot)は人間のサインオフ無しに除外を追加してはならない

### Build スクリプト Allowlist

`onlyBuiltDependencies` は、どのパッケージが install / postinstall スクリプトを実行できるかを制限する。このリストに載っているパッケージのみ、`pnpm install` 中の build スクリプト実行を許可される。現在許可されているもの:

- `better-sqlite3` — ネイティブな SQLite バインディングをコンパイル
- `esbuild` — プラットフォーム固有のバイナリをダウンロード
- `protobufjs` — protobuf バインディングを生成(Baileys / libsignal が使う)
- `sharp` — プラットフォーム固有の画像処理バイナリをダウンロード

このリストにパッケージを追加するには人間の承認が必要 — build スクリプトはインストールユーザの権限で任意のコードを実行する。

### `.npmrc` セーフティネット

`.npmrc` ファイルはフォールバックとして `minReleaseAge=3d` を含む。正本設定は `pnpm-workspace.yaml` にあるが、`.npmrc` は npm が直接呼ばれた場合(例:pnpm を尊重しないツール)の defense-in-depth を提供する。
