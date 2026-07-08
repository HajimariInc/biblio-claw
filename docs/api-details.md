# NanoClaw API 詳細

アーキテクチャの実装レベル詳細。高レベル設計は [architecture.md](architecture.md) を参照。

## Channel Adapter インターフェース

### NanoClaw Channel インターフェース

```typescript
interface ChannelSetup {
  // central DB からの会話設定 — セットアップ時に渡され、adapter はクエリしない
  conversations: ConversationConfig[];

  // host コールバック
  onInbound(platformId: string, threadId: string | null, message: InboundMessage): void;
  onMetadata(platformId: string, name?: string, isGroup?: boolean): void;
}

interface ConversationConfig {
  platformId: string;
  agentGroupId: string;
  triggerPattern?: string;       // regex 文字列 (ネイティブ channel 用)
  requiresTrigger: boolean;
  sessionMode: 'shared' | 'per-thread';
}

interface ChannelAdapter {
  name: string;
  channelType: string;

  // ライフサイクル
  setup(config: ChannelSetup): Promise<void>;
  teardown(): Promise<void>;
  isConnected(): boolean;

  // outbound 配信
  deliver(platformId: string, threadId: string | null, message: OutboundMessage): Promise<void>;

  // オプション
  //
  // Slack 進行ステート表示対応で `status?: TypingStatus` (= `string | null | undefined`) を追加。
  // 意味は `channels/adapter.ts` の TypingStatus 型定義に集約 (undefined = 未指定、
  // 非空 string = 進行ステート文言、null = 内部の明示クリア意図)。既存 adapter (CLI /
  // Fugue 等) は本メソッド未実装のため optional のまま = 影響ゼロ。
  setTyping?(platformId: string, threadId: string | null, status?: TypingStatus): Promise<void>;
  syncConversations?(): Promise<ConversationInfo[]>;
  updateConversations?(conversations: ConversationConfig[]): void;
}

// adapter から host への inbound メッセージ
interface InboundMessage {
  id: string;
  kind: 'chat' | 'chat-sdk';
  content: unknown;       // JSON blob — NanoClaw chat フォーマットまたは Chat SDK SerializedMessage
  timestamp: string;
}

// host から adapter への outbound メッセージ
interface OutboundMessage {
  kind: 'chat' | 'chat-sdk';
  content: unknown;       // JSON blob — kind に合わせる
}
```

### Chat SDK ブリッジ

Chat SDK の adapter + Chat インスタンスをラップして、NanoClaw の ChannelAdapter インターフェースに準拠させる。Trunk が出荷するのはブリッジと channel レジストリのみ — プラットフォーム固有の Chat SDK adapter(Discord、Slack、Telegram 等)とネイティブ adapter(WhatsApp/Baileys)は、`channels` ブランチから `/add-<channel>` skill によってインストールされる。

```typescript
function createChatSdkBridge(
  adapter: Adapter,
  chatConfig: { concurrency?: ConcurrencyStrategy }
): ChannelAdapter {
  let chat: Chat;
  let hostCallbacks: ChannelSetup;

  return {
    name: adapter.name,
    channelType: adapter.name,

    async setup(config) {
      hostCallbacks = config;

      chat = new Chat({
        adapters: { [adapter.name]: adapter },
        state: new SqliteStateAdapter(),
        concurrency: chatConfig.concurrency ?? 'concurrent',
      });

      // 登録された会話を subscribe
      for (const conv of config.conversations) {
        if (conv.agentGroupId) {
          await chat.state.subscribe(conv.platformId);
        }
      }

      // subscribe 済 thread → 全メッセージを forward
      chat.onSubscribedMessage(async (thread, message) => {
        const channelId = adapter.channelIdFromThreadId(thread.id);
        config.onInbound(channelId, thread.id, {
          id: message.id,
          kind: 'chat-sdk',
          content: message.toJSON(),
          timestamp: message.metadata.dateSent.toISOString(),
        });
      });

      // 未 subscribe thread 内の @mention → 発見
      chat.onNewMention(async (thread, message) => {
        const channelId = adapter.channelIdFromThreadId(thread.id);
        config.onInbound(channelId, thread.id, {
          id: message.id,
          kind: 'chat-sdk',
          content: message.toJSON(),
          timestamp: message.metadata.dateSent.toISOString(),
        });
        // 今後の thread 内メッセージを受け取るために subscribe
        await thread.subscribe();
      });

      // DM → 常に forward
      chat.onDirectMessage(async (thread, message) => {
        config.onInbound(thread.id, null, {
          id: message.id,
          kind: 'chat-sdk',
          content: message.toJSON(),
          timestamp: message.metadata.dateSent.toISOString(),
        });
        await thread.subscribe();
      });

      await chat.initialize();
    },

    async deliver(platformId, threadId, message) {
      const tid = threadId ?? platformId;
      if (message.kind === 'chat-sdk') {
        const content = message.content as Record<string, unknown>;
        if (content.operation === 'edit') {
          await adapter.editMessage(tid, content.messageId as string, 
            { markdown: content.text as string });
        } else if (content.operation === 'reaction') {
          await adapter.addReaction(tid, content.messageId as string, 
            content.emoji as string);
        } else {
          await adapter.postMessage(tid, content as AdapterPostableMessage);
        }
      } else {
        const content = message.content as { text: string };
        await adapter.postMessage(tid, { markdown: content.text });
      }
    },

    async setTyping(platformId, threadId, status) {
      // 進行ステート表示: status を vendor に forward。null は undefined に正規化して
      // vendor 側 `?? "Typing..."` fallback に載せる (vendor 実装は null/undefined を同一扱い)。
      await adapter.startTyping(threadId ?? platformId, status ?? undefined);
    },

    async teardown() {
      await chat.shutdown();
    },

    isConnected() { return true; },

    updateConversations(conversations) {
      // 新しい会話を subscribe、削除されたものを unsubscribe できる
      for (const conv of conversations) {
        if (conv.agentGroupId) {
          chat.state.subscribe(conv.platformId);
        }
      }
    },
  };
}
```

### ネイティブな NanoClaw Channel (Chat SDK なし)

ネイティブ channel は ChannelAdapter インターフェースを直接実装する。WhatsApp/Baileys adapter が代表例 — trunk ではなく `/add-whatsapp` skill 経由で出荷される:

```typescript
function createWhatsAppChannel(): ChannelAdapter {
  let socket: WASocket;
  let config: ChannelSetup;

  return {
    name: 'whatsapp',
    channelType: 'whatsapp',

    async setup(setup) {
      config = setup;
      socket = await connectBaileys();

      socket.on('messages.upsert', (event) => {
        for (const msg of event.messages) {
          const jid = msg.key.remoteJid;
          const conv = config.conversations.find(c => c.platformId === jid);

          // トリガーチェック (ネイティブ — adapter が行う、host ではない)
          if (conv?.requiresTrigger && conv.triggerPattern) {
            if (!new RegExp(conv.triggerPattern).test(msg.message?.conversation || '')) {
              return; // トリガーにマッチしない
            }
          }

          config.onInbound(jid, null, {
            id: msg.key.id,
            kind: 'chat',
            content: {
              sender: msg.pushName || msg.key.participant,
              senderId: msg.key.participant || msg.key.remoteJid,
              text: msg.message?.conversation || '',
              attachments: [],
              isFromMe: msg.key.fromMe,
            },
            timestamp: new Date(msg.messageTimestamp * 1000).toISOString(),
          });
        }
      });
    },

    async deliver(platformId, threadId, message) {
      const content = message.content as { text: string };
      await socket.sendMessage(platformId, { text: content.text });
    },

    async setTyping(platformId) {
      await socket.sendPresenceUpdate('composing', platformId);
    },

    async teardown() {
      await socket.logout();
    },

    isConnected() { return !!socket; },
  };
}
```

## セッション DB スキーマの詳細

### messages_in コンテンツ例

**`chat`** — シンプルな NanoClaw フォーマット:
```json
{
  "sender": "John",
  "senderId": "user123",
  "text": "Check this PR",
  "attachments": [{ "type": "image", "url": "https://signed-url..." }],
  "isFromMe": false
}
```

**`chat-sdk`** — フルな Chat SDK の `SerializedMessage`:
```json
{
  "_type": "chat:Message",
  "id": "msg-1",
  "threadId": "slack:C123:1234.5678",
  "text": "Check this PR",
  "formatted": { "type": "root", "children": [...] },
  "author": { "userId": "U123", "userName": "john", "fullName": "John", "isBot": false, "isMe": false },
  "metadata": { "dateSent": "2024-01-01T00:00:00Z", "edited": false },
  "attachments": [{ "type": "image", "url": "https://...", "name": "screenshot.png" }],
  "isMention": true,
  "links": []
}
```

**質問応答**(対話カードをクリックしたユーザから):
```json
{
  "sender": "John",
  "senderId": "user123",
  "text": "Yes",
  "questionId": "q-123",
  "selectedOption": "Yes",
  "isFromMe": false
}
```

### messages_out コンテンツ例

**通常の chat メッセージ:**
```json
{ "text": "LGTM, merging now" }
```

**Chat SDK markdown:**
```json
{ "markdown": "## Review Summary\n**Status**: Approved\n\nNo issues found." }
```

**Card:**
```json
{
  "card": {
    "type": "card",
    "title": "Deployment Approval",
    "children": [
      { "type": "text", "content": "Deploy 2.1.0 to production?" },
      { "type": "actions", "children": [
        { "type": "button", "id": "approve", "label": "Approve", "style": "primary" },
        { "type": "button", "id": "reject", "label": "Reject", "style": "danger" }
      ]}
    ]
  },
  "fallbackText": "Deployment Approval: Deploy 2.1.0 to production? [Approve] [Reject]"
}
```

**Ask user question:**
```json
{
  "operation": "ask_question",
  "questionId": "q-123",
  "title": "Failing Test",
  "question": "How should we handle the failing test?",
  "options": [
    "Skip it",
    { "label": "Fix and retry", "selectedLabel": "✅ Fixing", "value": "fix" },
    { "label": "Abort deployment", "selectedLabel": "❌ Aborted", "value": "abort" }
  ]
}
```

**Edit メッセージ:**
```json
{ "operation": "edit", "messageId": "3", "text": "Updated: LGTM with minor comments on line 42" }
```

**Reaction:**
```json
{ "operation": "reaction", "messageId": "5", "emoji": "thumbs_up" }
```

**システムアクション:**
```json
{ "action": "reset_session", "payload": { "session_id": "sess-123", "reason": "Skills updated" } }
```

## Host 配信ロジック

Host は messages_out を読み、`kind` と `operation` でディスパッチする:

```typescript
async function deliverMessage(row: MessagesOutRow, adapter: ChannelAdapter) {
  const content = JSON.parse(row.content);

  // システムアクション — host が内部で扱う
  if (row.kind === 'system') {
    await handleSystemAction(content);
    return;
  }

  // agent-to-agent — ターゲットセッション DB に書く
  if (isAgentDestination(row)) {
    await writeToAgentSession(row);
    return;
  }

  // channel 配信 — adapter に委譲
  await adapter.deliver(row.platform_id, row.thread_id, {
    kind: row.kind,
    content,
  });
}
```

Adapter の `deliver()` メソッドが内部で operation ディスパッチ(post vs edit vs reaction)を扱う。
