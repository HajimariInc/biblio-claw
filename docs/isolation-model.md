# Channel 分離モデル

> **biblio-claw fork note**: 本 doc は NanoClaw v2 上流 (commit `2492259`) の日本語訳。biblio-claw も **3 レベル分離モデル (`agent-shared` / `shared` / 個別 agent)** を継承する。ただし channel adapter は上流の branch モデル (`/add-<channel>` skill) から離脱し、**Slack adapter (`src/channels/slack.ts`) + Fugue channel adapter (`src/channels/fugue.ts`) を trunk に直接コミット**している。分離モデル自体の実装 (`src/router.ts` / `src/session-manager.ts`) は本 doc の記述通り。

NanoClaw はメッセージング channel と agent group を切り離す。Channel(Discord、Telegram、Slack、GitHub 等)を接続するとき、それを既存の agent とどう関係させるかを決められる。分離レベルは 3 つある。

## 3 つのレベル

### 1. 共有セッション

複数の channel が同じ会話に流れ込む。Agent はすべての channel からの全メッセージを 1 つのスレッドで見る。

**何が共有されるか:** すべて — workspace、メモリ、CLAUDE.md、そして会話自体。GitHub の PR コメントと Slack のメッセージが agent のコンテキストに並んで現れる。

**例:** Slack channel と GitHub webhook を組み合わせる。Agent は GitHub 経由で PR レビュー依頼を受け、それを Slack で議論する — すべて 1 つのセッション内で。誰かが PR にコメントすると、agent はその機能について先に Slack で交わした議論を参照できる。

**いつ使うか:** 1 つの channel が別の channel にコンテキストを供給する場合。Webhook / 通知 channel(GitHub、Linear)とチャット channel(Slack、Discord)の組み合わせが典型的なケース。

**技術的内容:** 両方の messaging group が `session_mode: 'agent-shared'` で同じ agent group に配線される。セッションの解決は agent group ID のみで行われ、messaging group は無視される — そのため全 channel が 1 つのセッションに収束する。

---

### 2. 同じ agent、別セッション

複数の channel が同じ agent(同じ workspace、メモリ、パーソナリティ)を共有するが、独立した会話を持つ。

**何が共有されるか:** Workspace、メモリ、CLAUDE.md、すべての永続状態。あるセッションで agent に何かを伝えると、agent はそれをメモリに保存して別のセッションで思い出せる。Agent のパーソナリティ、知識、ツールはセッション間で同一である。

**何が分離されるか:** 会話スレッド。ある channel からのメッセージは別の channel のセッションには現れない。各 channel は独自のコンテキストウィンドウと会話履歴を持つ。

**例:** Telegram の chat を 3 つ agent と持つ — 1 つはサイドプロジェクト、1 つは個人タスク、1 つは仕事用。3 つすべてが同じ agent の workspace を共有する。プロジェクトの chat で API キーの命名規約を覚えてもらえば、仕事の chat でもその規約を思い出すかもしれない。だが会話そのものは独立している。

**いつ使うか:** あなたが channel を横断する主要(または唯一の)参加者で、統一された agent アイデンティティを持ちたいとき。複数のプラットフォーム、または 1 つのプラットフォーム上の複数 group をまたぐ個人利用で、最も一般的なセットアップである。

**技術的内容:** 複数の messaging group が `session_mode: 'shared'`(または `'per-thread'`)で同じ agent group に配線される。各 messaging group が独自のセッションを持つが、すべて同じ agent group のフォルダで動く。

---

### 3. 別 agent group

各 channel が独自の agent、独自の workspace、メモリ、パーソナリティを持つ。何も共有しない。

**何が共有されるか:** 何も。Agent たちは互いの存在を知らない。CLAUDE.md も、メモリも、workspace も、会話履歴も別。

**例:** 友人との Telegram group と、チームプロジェクトの Discord サーバを持っている。友人にはチームの議論を知られたくないし、その逆も同じ。それぞれが独自のメモリとパーソナリティを持つ独自の agent を持つ。

**いつ使うか:** 関与する人が異なる場合、または、ある channel の情報を別の channel に決して漏らしてはならない場合。Channel 間にプライバシーや機密性の境界があるときは、常にこれが正しい選択である。

**技術的内容:** 各 channel が異なる agent group に配線され、それぞれ `groups/` 配下に独自のフォルダを持つ。コンテナも、セッションデータベースも、すべてが別である。

---

## 選び方

鍵となる質問:**ある channel から得た情報が、いかなる情報であれ、別の channel で利用可能になっても構わないか?**

- **No** → 別 agent group(レベル 3)
- **Yes、かつ channel 同士が互いのメッセージを見るべき** → 共有セッション(レベル 1)
- **Yes、ただし会話は独立しているべき** → 同じ agent、別セッション(レベル 2)

### 経験則

| シナリオ | 推奨レベル |
|----------|------------------|
| 自分だけ、複数プラットフォーム(Telegram + Discord + Slack) | 同じ agent、別セッション |
| 自分だけ、1 プラットフォーム上の複数 group(Telegram chat 3 つ) | 同じ agent、別セッション |
| Webhook channel + chat channel(GitHub + Slack) | 共有セッション |
| 友人 A の channel と友人 B の channel | 別 agent group |
| 個人 channel と仕事 channel | 別 agent group |
| アクセスレベルが異なるチーム channel | 別 agent group |

### 迷ったら

Channel をまたぐ参加者が同じなら → 同じ agent group で通常 OK。

異なる人が関与するなら → 別 agent group。そうしないと、情報は agent のメモリを経由して交差汚染する。

## エンティティモデル

```
agent_groups (workspace, memory, CLAUDE.md, personality)
    ↕ many-to-many
messaging_groups (プラットフォーム上の特定の channel/chat/group)
    via
messaging_group_agents (session_mode, trigger_rules, priority)
```

- **共有セッション:** 複数の messaging_group → 同じ agent_group、`session_mode = 'agent-shared'`
- **同じ agent、別セッション:** 複数の messaging_group → 同じ agent_group、`session_mode = 'shared'`
- **別 agent:** 各 messaging_group → 別の agent_group
