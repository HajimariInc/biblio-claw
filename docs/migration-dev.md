# v1 → v2 マイグレーション — 開発ガイド

マイグレーションフローのテスト、開発、デバッグの方法。

## クイックスタート

```bash
# フルサイクル:リセット → マイグレーション → Claude が仕上げ
bash migrate-v2-reset.sh && bash migrate-v2.sh
```

## アーキテクチャ

2 部構成のマイグレーション:

1. **`migrate-v2.sh`** — 決定的な bash スクリプト。前提条件、DB seed、ファイルコピー、channel インストール、コンテナビルド、サービス切替を扱う。`logs/setup-migration/handoff.json` を書いてから Claude に `exec` する。

2. **`/migrate-from-v1` skill** — Claude 駆動。ハンドオフを読み、owner / role を seed し、CLAUDE.local.md をクリーンアップし、コンテナ設定を検証し、fork のカスタマイズを移植する。

## ファイル配置

```
migrate-v2.sh                        # エントリーポイント
migrate-v2-reset.sh                  # 再テスト用に v2 状態を消去
setup/migrate-v2/
  env.ts                             # Phase 1a: .env をマージ
  db.ts                              # Phase 1b: v2 DB を seed
  groups.ts                          # Phase 1c: group フォルダ + container.json をコピー
  sessions.ts                        # Phase 1d: セッションをコピー + 継続を設定
  tasks.ts                           # Phase 1e: スケジュール済タスクを移植
  channel-auth.ts                    # Phase 2b: channel 認証状態をコピー
  select-channels.ts                 # Phase 2a: clack multiselect
  switchover-prompt.ts               # サービス切替プロンプト
setup/migrate-v2/shared.ts           # 共有ヘルパー(JID パース、トリガーマッピング等)
.claude/skills/migrate-from-v1/      # Claude skill
logs/setup-migration/handoff.json    # migrate-v2.sh が書き、skill が読む
logs/migrate-steps/*.log             # ステップごとの生出力
```

## 開発ループ

```bash
# v2 をクリーンな状態にリセット (node_modules は残す)
bash migrate-v2-reset.sh

# 非対話的な channel 選択でマイグレーションを実行
NANOCLAW_CHANNELS="telegram" bash migrate-v2.sh

# または対話的に実行 (clack multiselect)
bash migrate-v2.sh
```

`migrate-v2-reset.sh` が消去するもの:`data/`、`logs/`、`.env`、`groups/`(git 追跡のものを復元)、`container/skills/`(git 追跡のものを復元)、`src/channels/`(git 追跡のものを復元)。

`node_modules/` は消去しない(再インストールがコスト高のため)。

## 個別ステップのテスト

各ステップは単体の TypeScript ファイルである:

```bash
# 単一ステップを実行 (pnpm install 後)
pnpm exec tsx setup/migrate-v2/env.ts /path/to/v1
pnpm exec tsx setup/migrate-v2/db.ts /path/to/v1
pnpm exec tsx setup/migrate-v2/groups.ts /path/to/v1
pnpm exec tsx setup/migrate-v2/sessions.ts /path/to/v1
pnpm exec tsx setup/migrate-v2/tasks.ts /path/to/v1
pnpm exec tsx setup/migrate-v2/channel-auth.ts /path/to/v1 telegram discord
```

各ステップは `OK:<details>`、`SKIPPED:<reason>`、またはエラーを stdout に出力する。成功 / skip で exit 0、失敗で 非ゼロ。

## デバッグ

### 何がマイグレートされたか確認

```bash
# Agent groups
sqlite3 data/v2.db "SELECT * FROM agent_groups"

# Messaging groups + 配線
sqlite3 data/v2.db "SELECT mg.id, mg.channel_type, mg.platform_id, mg.unknown_sender_policy, mga.engage_mode, mga.engage_pattern FROM messaging_groups mg JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id"

# Sessions
sqlite3 data/v2.db "SELECT * FROM sessions"

# Users と roles
sqlite3 data/v2.db "SELECT * FROM users"
sqlite3 data/v2.db "SELECT * FROM user_roles"

# セッション継続 (どの Claude Code セッションが再開されるか)
AG_ID=$(sqlite3 data/v2.db "SELECT id FROM agent_groups LIMIT 1")
SESS_ID=$(sqlite3 data/v2.db "SELECT id FROM sessions LIMIT 1")
sqlite3 data/v2-sessions/$AG_ID/$SESS_ID/outbound.db "SELECT * FROM session_state"

# スケジュール済タスク
sqlite3 data/v2-sessions/$AG_ID/$SESS_ID/inbound.db "SELECT id, kind, recurrence, status FROM messages_in WHERE kind='task'"
```

### ハンドオフを確認

```bash
python3 -m json.tool logs/setup-migration/handoff.json
```

### 一般的な問題

**切替後に bot が応答しない:**
1. 両方のサービスが走っていないか確認:`systemctl --user list-units 'nanoclaw*'`
2. エラーログを確認:`tail logs/nanoclaw.error.log`
3. sender ポリシーを確認:`sqlite3 data/v2.db "SELECT unknown_sender_policy FROM messaging_groups"` — owner が seed される前は `public` でなければならない
4. engage パターンを確認:`sqlite3 data/v2.db "SELECT engage_mode, engage_pattern FROM messaging_group_agents"` — すべてに応答するには `pattern` / `.` であるべき

**v1 からセッションが継続しない:**
1. 継続が設定されているか確認:上記「セッション継続」クエリを参照
2. 正しいパスに JSONL が存在するか確認:`ls data/v2-sessions/<ag_id>/.claude-shared/projects/-workspace-agent/`
3. v1 のセッション JSONL は `-workspace-group/` から `-workspace-agent/` にコピーされるべきである(v2 コンテナの CWD は `/workspace/agent`)

**サービス切替の revert が効かない:**
1. v2 サービス名は `nanoclaw-v2-<hash>` — 探す:`systemctl --user list-units 'nanoclaw*'`
2. 手動で停止:`systemctl --user stop <unit> && systemctl --user disable <unit>`
3. v1 を再起動:`systemctl --user start nanoclaw`

### ステップログ

各ステップは生出力を `logs/migrate-steps/<step>.log` に書く。ステップが失敗したらこれを読む:

```bash
cat logs/migrate-steps/1b-db.log
cat logs/migrate-steps/1d-sessions.log
```

## 主要な決定事項

- `unknown_sender_policy` はマイグレーション中 `public` に設定され、bot が即時応答する。`/migrate-from-v1` skill が owner を seed した後で締める。
- v1 で `requires_trigger=0` は空でない `trigger_pattern` より優先される — 意味は「すべてに応答する」。
- v1 の `container_config.additionalMounts` は v2 の `container.json` に直接書き込まれる(同じ形)。
- v1 の Claude Code セッションは `-workspace-group/` から `-workspace-agent/` にコピーされ、セッション ID は `outbound.db` に `continuation:claude` として書かれるので、agent-runner が同じ会話を再開する。
- 末尾の `exec claude "/migrate-from-v1"` が bash プロセスを置き換える — EXIT トラップは `exec` で発火しないため、`exec` の前に `write_handoff` を明示的に呼ぶ。
