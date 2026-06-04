# ローカル Ollama で agent を動かす

NanoClaw の agent は Anthropic API の代わりに、ローカルの [Ollama](https://ollama.com) インスタンスへルーティングできる。これにより API コストはゼロになり、推論はすべて自分のハードウェア上に留まる。

## 仕組み

Ollama は Anthropic 互換の `/v1/messages` エンドポイントを公開している。Claude Code CLI(agent コンテナ内で動く)は Anthropic SDK を使い、それは `ANTHROPIC_BASE_URL` を読んで API ホストを見つける。この変数を Ollama に向けるだけで済む — 新しい provider コードは不要、agent ランタイムへの変更も不要。

```
┌─────────────────────────────┐
│  Agent コンテナ              │
│                             │
│  Claude Code CLI            │
│    ↓ ANTHROPIC_BASE_URL     │
│    http://host.docker.      │      ┌──────────────────┐
│    internal:11434    ───────┼─────▶│  Ollama :11434   │
│                             │      │  gemma4:latest   │
└─────────────────────────────┘      └──────────────────┘
```

`host.docker.internal` は Docker のマジックホスト名で、コンテナ内からホストマシンに解決される — そのため、Mac や Linux マシン上で動いている Ollama にこのアドレスで到達できる。

## OneCLI まわりの厄介事

NanoClaw は通常、API 呼び出しを OneCLI の HTTPS proxy 経由で流し、placeholder キーの代わりに実クレデンシャルを注入する。Ollama にリダイレクトするときはこの proxy をバイパスし、リクエストが直接届くようにする必要がある。env var 2 つで対応する:

- `NO_PROXY=host.docker.internal` — Anthropic SDK の HTTP クライアントに、そのホスト名では proxy をスキップするよう伝える
- `no_proxy=host.docker.internal` — 小文字形式をチェックするツール向けの小文字バリアント

両方とも agent group の `container.json` に `ANTHROPIC_BASE_URL` と並べて設定する。

## ネットワーク分離

`ANTHROPIC_BASE_URL` を設定するとリクエストはリダイレクトされるが、設定が乱れた agent が `api.anthropic.com` に直接到達するのを防がない。`container.json` の `blockedHosts` フィールドが Docker の `--add-host` フラグを追加して、ドメインを `0.0.0.0` に解決させる(コンテナ内から物理的に到達不能にする):

```json
"blockedHosts": ["api.anthropic.com"]
```

これを置いておけば、モデル設定が Claude のモデル名に戻ってしまっても、API 呼び出しはすぐに失敗する — アカウントに silent に課金されない。

## モデル選択

Claude Code CLI はコンテナ内の `~/.claude/settings.json` からモデルを読み、NanoClaw はそれを `data/v2-sessions/<agent-group-id>/.claude-shared/settings.json` から bind-mount する。そこに `"model": "gemma4:latest"`(または pull した任意の Ollama モデル)を設定する。`ollama list` で出る正確な名前を使う。

Apple Silicon でのモデル選択の参考:

| モデル | サイズ | 品質 | 速度 (M4 Pro) |
|-------|------|---------|----------------|
| `gemma4:latest` | 12B | 汎用に良い | 速い |
| `qwen3-coder:latest` | 32B | コーディングタスクに優れる | 中程度 |
| `llama3.2:latest` | 3B | 基本 | 非常に速い |

Agent はツール呼び出し(ファイル read/write、shell コマンド)を多用する。ツール使用を信頼性高くサポートするモデルが最も適する。Gemma 4 と Qwen 3 Coder は、構造化されたツール呼び出しを両方ともうまく処理する。

## コードレベルで何が変わるか

この機能をサポートするには 3 つのファイルが変更される。正確な変更は `/add-ollama-provider` を参照。

**`src/container-config.ts`** — `ContainerConfig` インターフェースに `env` と `blockedHosts` フィールドが必要(group ごとの JSON がそれらを運ぶため)。

**`src/container-runner.ts`** — コンテナ spawn 時に、`env` エントリは `-e KEY=VAL` の Docker フラグになり(OneCLI が注入する var の後に適用されるので勝つ)、`blockedHosts` エントリは `--add-host HOST:0.0.0.0` フラグになる。

**`container/Dockerfile`** — コンテナは host ユーザの uid(例:macOS では 501)で動き、`node` ユーザ(uid 1000)では動かない。任意の uid が `~/.claude.json` と `~/.claude/settings.json` に書き込めるよう、home ディレクトリを `chmod 777` する必要がある。

## トレードオフ

| | Ollama(ローカル) | Anthropic API |
|---|---|---|
| コスト | 無料 | トークン課金 |
| プライバシー | 完全にローカル | Anthropic にデータ送信 |
| モデル品質 | 良い(open-weight) | 優秀(Claude) |
| コールドスタート | 5–30 秒(モデルロード) | 約 1 秒 |
| コンテキストウィンドウ | モデルによる | 200k トークン(Sonnet) |
| ツール使用の信頼性 | 良い(大モデル) | 優秀 |
| ハードウェア要件 | 16GB+ RAM | なし |

性能のあるハードウェアでの個人自動化なら、トレードオフはローカル有利。大きなコンテキストや高い信頼性を要する複雑なマルチステップタスクなら、Claude が依然優位。

## Claude に戻す

`groups/<folder>/container.json` から `env` と `blockedHosts` キーを削除し、共有 settings ファイルから `"model"` を削除して、サービスを再起動する。再ビルドは不要。

## 参考

- `/add-ollama-provider` — 任意の agent group を Ollama 用に設定するステップ別 skill
- [Ollama Anthropic 互換ドキュメント](https://ollama.com/blog/openai-compatibility) — API ブリッジに関する上流ドキュメント
- `docs/architecture.md` — コンテナの spawn と env 注入パイプラインの仕組み
