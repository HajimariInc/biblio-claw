# NanoClaw アーキテクチャ図

## システム概要

```mermaid
flowchart TB
  subgraph Platforms["メッセージングプラットフォーム"]
    P1[Discord]
    P2[Telegram]
    P3[Slack]
    P4[GitHub / Linear]
    P5[WhatsApp / iMessage / Teams / GChat / Matrix / Webex / Email]
  end

  subgraph Host["Host プロセス (Node)"]
    direction TB
    Bridge["Chat SDK Bridge<br/>(src/channels/chat-sdk-bridge.ts)"]
    Router["Router<br/>(src/router.ts)<br/>platformId + threadId -> messaging_group -> agent_group -> session"]
    SessMgr["Session Manager<br/>(src/session-manager.ts)<br/>inbound.db + outbound.db を作る"]
    Runner["Container Runner<br/>(src/container-runner.ts)<br/>OneCLI ensureAgent + spawn"]
    Delivery["Delivery Poller<br/>(src/delivery.ts)<br/>1s アクティブ / 60s sweep"]
    Sweep["Host Sweep<br/>(src/host-sweep.ts)<br/>heartbeat, retry, 再帰"]
    Central[("Central DB<br/>data/v2.db<br/>agent_groups<br/>messaging_groups<br/>messaging_group_agents<br/>sessions<br/>pending_approvals")]
  end

  subgraph OneCLI["OneCLI Gateway (0.3.1)"]
    Vault["Agent Vault<br/>secrets + OAuth"]
    Approvals["configureManualApproval<br/>-> pending_approvals"]
  end

  subgraph Session["セッションごとのコンテナ (Docker / Apple Container)"]
    direction TB
    PollLoop["Poll Loop<br/>(container/agent-runner)"]
    Provider["Agent provider<br/>(claude, opencode, mock; todo: codex)"]
    MCP["MCP ツール<br/>send_message, send_file, edit_message,<br/>add_reaction, send_card, ask_user_question,<br/>schedule_task, create_agent,<br/>install_packages, add_mcp_server,<br/>acquire_biblio, inspect_biblio,<br/>categorize_biblio, shelve_biblio,<br/>enkin_biblio, shokyaku_biblio, list_biblio"]
    Skills["コンテナ skill<br/>(container/skills/)"]
    InDB[("inbound.db<br/>host が書く<br/>偶数 seq<br/>messages_in<br/>destinations<br/>processing_ack")]
    OutDB[("outbound.db<br/>コンテナが書く<br/>奇数 seq<br/>messages_out<br/>heartbeat ファイル")]
  end

  subgraph Groups["Agent group ファイルシステム (groups/*)"]
    Folder["CLAUDE.md<br/>memory<br/>group ごとの skill<br/>container_config"]
  end

  P1 & P2 & P3 & P4 & P5 --> Bridge
  Bridge --> Router
  Router --> Central
  Router --> SessMgr
  SessMgr --> InDB
  SessMgr --> Runner
  Runner --> OneCLI
  Runner --> PollLoop
  PollLoop --> InDB
  PollLoop --> Provider
  Provider --> MCP
  Provider --> Skills
  MCP --> OutDB
  OutDB --> Delivery
  Delivery --> Central
  Delivery --> Bridge
  Bridge --> P1 & P2 & P3 & P4 & P5
  Sweep --> InDB
  Sweep --> OutDB
  Sweep --> Central
  Runner -.mounts.-> Folder
  MCP -.approval.-> Approvals
  Approvals --> Central
  Provider -.API calls.-> Vault
```

## メッセージフロー (inbound -> agent -> outbound)

```mermaid
sequenceDiagram
  participant P as プラットフォーム (例: Telegram)
  participant B as Chat SDK Bridge
  participant R as Router
  participant SM as Session Manager
  participant IDB as inbound.db
  participant C as コンテナ (agent-runner)
  participant ODB as outbound.db
  participant D as Delivery Poller

  P->>B: 新しいメッセージ
  B->>R: routeInbound(platformId, threadId, msg)
  R->>R: messaging_group -> agent_group -> session を解決<br/>(agent-shared | shared | per-thread)
  R->>SM: セッション + DB の存在を保証
  R->>IDB: INSERT messages_in (偶数 seq)
  R->>C: コンテナを起こす (docker run / 既に走っている)
  C->>IDB: messages_in を poll
  C->>C: xml をフォーマット、選択された provider にストリーム
  C->>ODB: INSERT messages_out (奇数 seq)<br/><message to="name"> ブロックをパース
  D->>ODB: 1s poll (アクティブ) / 60s (sweep)
  D->>D: hasDestination() で再検証
  D->>B: adapter 経由で配信
  B->>P: メッセージ送信 / edit / react / file / card
```

## Named destination と agent-to-agent

```mermaid
flowchart LR
  subgraph AgentA["Agent group A (main)"]
    A_out["output:<br/>&lt;message to='slack'&gt;...&lt;/message&gt;<br/>&lt;message to='browser-agent'&gt;...&lt;/message&gt;<br/>&lt;internal&gt;scratchpad&lt;/internal&gt;"]
  end

  subgraph Dests["inbound.db.destinations (agent ごと)"]
    D1["slack -> messaging_group 42"]
    D2["browser-agent -> agent_group 7<br/>(双方向行)"]
    D3["github -> messaging_group 13"]
  end

  subgraph AgentB["Agent group B (browser sub-agent)"]
    B_session["自身の inbound.db / outbound.db<br/>A への戻り destination を継承"]
  end

  Slack[Slack channel]
  GitHub[GitHub PR スレッド]

  A_out -->|パース + ルックアップ| Dests
  D1 -->|配信| Slack
  D2 -->|B の inbound.db に書く| B_session
  D3 -->|配信| GitHub
  B_session -.'parent' 経由で返信.-> Dests
```

## エンティティモデル + 分離レベル

```mermaid
erDiagram
  agent_groups ||--o{ messaging_group_agents : wired
  messaging_groups ||--o{ messaging_group_agents : wired
  agent_groups ||--o{ sessions : runs
  messaging_groups ||--o{ sessions : context
  agent_groups ||--o{ agent_destinations : owns
  agent_groups ||--o{ pending_approvals : requests

  agent_groups {
    int id
    string name
    string folder
    string agent_provider
    json container_config
  }
  messaging_groups {
    int id
    string channel_type
    string platform_id
    string name
    bool is_group
    string unknown_sender_policy "strict | request_approval | public"
  }
  users {
    string id PK "namespaced <channel>:<handle>"
    string kind
    string display_name
  }
  user_roles {
    string user_id FK
    string role "owner | admin"
    string agent_group_id FK "null = global"
  }
  agent_group_members {
    string user_id FK
    string agent_group_id FK
  }
  user_dms {
    string user_id FK
    string channel_type
    string messaging_group_id FK
  }
  messaging_group_agents {
    int messaging_group_id
    int agent_group_id
    string session_mode "agent-shared | shared | per-thread"
    json trigger_rules
    int priority
  }
  sessions {
    int id
    int agent_group_id
    int messaging_group_id
    string sdk_session_id
    string status
  }
```

### 分離レベル早見表

| レベル | `session_mode` | 何が共有されるか | 例 |
|---|---|---|---|
| 1. 共有セッション | `agent-shared` | Workspace + memory + 会話 | Slack + GitHub webhook を 1 スレッドで |
| 2. 同じ agent、別セッション | `shared` / `per-thread` | Workspace + memory のみ | 1 agent を 3 つの Telegram chat 越しに |
| 3. 別 agent group | (異なる `agent_group_id`) | 何も共有しない | 個人 channel vs 仕事 channel |

## Two-DB 分割 (理由)

```mermaid
flowchart LR
  subgraph Mount["/workspace (コンテナにマウントされたボリューム)"]
    In[("inbound.db")]
    Out[("outbound.db")]
    HB["/.heartbeat (ファイルタッチ)"]
  end

  Host[Host プロセス] -->|"書き込みのみ<br/>(偶数 seq)"| In
  Host -->|読み込み| Out
  Container[agent-runner] -->|読み込み| In
  Container -->|"書き込みのみ<br/>(奇数 seq)"| Out
  Container -->|poll ごとに touch| HB
  HostSweep[Host sweep] -->|mtime を stat| HB
  HostSweep -->|processing_ack を読む| In

  note1["各ファイルに writer は厳密に 1 つ。<br/>SQLite のクロスプロセス書き込み競合を排除。<br/>衝突なしの seq 番号付け。"]
```
