# セットアップフロー

本ドキュメントは NanoClaw の end-to-end スクリプトセットアップ
(`bash nanoclaw.sh` → `pnpm run setup:auto`)の契約である。新しい
ステップを追加する前、リグレッションを修正する前、出力レンダリングを
変える前に読むこと。

## 3 つの出力レベル

すべてのセットアップステップは **3 つの異なるレベル** で出力を生成する。
それぞれ別の読み手を持ち、別の場所に行き、別の形でフォーマットされる。
混同しないこと。

| レベル | 読み手 | 出力先 | 形式 |
|---|---|---|---|
| 1. ユーザ向け | セットアップを実行するオペレータ | ターミナル (clack 経由) | ブランド付き、簡潔、情報的 — 「製品コンテンツ」 |
| 2. 進行ログ | 将来のデバッガ、失敗実行をレビューする AI agent、リリースサポート | `logs/setup.log`(1 ファイル、追記のみ) | ステップごとの構造化ブロック、線形時系列、人間 + マシン可読 |
| 3. Raw | 特定ステップを深掘りする者 | `logs/setup-steps/NN-step-name.log`(ステップごとに 1 ファイル) | 子プロセスの raw stdout + stderr、逐語 |

考え方:ユーザは **サマリ** を見る、進行ログは **キーファクト付きの index**、
raw ログは **証拠**。

### Level 1: ユーザ向け (clack)

`setup/auto.ts` が `@clack/prompts` 経由でレンダリングする。これはセット
アップの *プロダクト面* — どの行も、初日に来た見ず知らずの人にも届くよう
にデザインされているように読めるべき。

- 進行中作業には clack スピナーを使う。経過時間を表示する。
- 永続的な状態マーカーには `p.log.success` / `p.log.step` / `p.log.warn`
  を使う。
- 複数行の情報(ペアリングコード、次のステップ)には `p.note` を使う。
- プロンプトには `p.text` / `p.select` / `p.password` を使う。
- ブランドパレット:`setup/auto.ts` の `brand()` / `brandBold()` /
  `brandChip()` ヘルパー。ターミナルがサポートしていれば truecolor、
  それ以外は 16 色 cyan フォールバック、パイプ時 / `NO_COLOR` のときは
  プレーンテキスト。

ルール:
- **不連続を作らない。** すべてのサブステップは同じ視覚フローに属する。
  唯一の例外は Anthropic クレデンシャル登録(下記)。
- **Raw な子出力なし。** 自分たちが書いていない子の出力を決して
  `stdio: 'inherit'` しない。キャプチャして失敗時のみ表示する。
- **デバッグ風プレフィックスなし**(`[add-telegram] …`、`INFO …`、
  タイムスタンプ)。これらはレベル 2 と 3 に属する。
- **絵文字なし**、clack のグリフが要求する場合を除く。

### Level 2: 進行ログ

`logs/setup.log` — セットアップ実行ごとに 1 ファイル、追記のみ、複数回実行
の install で累積する(実行が途中で失敗して再試行されると、新エントリが
追記される)。セットアップバグを報告するときオペレータに貼り付けを依頼
するもの、そして AI agent が何が起きたか理解するために読むもの。

エントリ形式:

```
=== [2026-04-22T22:14:12Z] bootstrap [45.1s] → success ===
  platform: linux
  is_wsl: false
  node_version: 22.22.2
  deps_ok: true
  native_ok: true
  raw: logs/setup-steps/01-bootstrap.log

=== [2026-04-22T22:14:57Z] environment [2.3s] → success ===
  docker: running
  apple_container: not_found
  raw: logs/setup-steps/02-environment.log

=== [2026-04-22T22:15:00Z] container [92.4s] → success ===
  runtime: docker
  image: nanoclaw-agent:latest
  build_ok: true
  raw: logs/setup-steps/03-container.log
```

設計制約:
- 開始時刻のタイムスタンプ(UTC、ISO-8601)を開きの行に置き、`grep` で
  シーケンスが得られるようにする。
- 1 桁小数の秒で duration を出す — 速いステップは "0ms" ではなく
  "0.5s" と読める。
- ステータスは次のいずれか:`success`、`skipped`、`failed`、`aborted`。
- フィールドはステップ固有だが **必ず** 短いスカラ値であること。JSON
  禁止、複数行禁止。値が長い場合は raw ログに置いて参照する。
- 成功時でも常に `raw:` ポインタを emit する — 2 回目の失敗のデバッグ
  を楽にする。
- **ユーザ選択** はステップにネストせず、独自のエントリとする:

  ```
  === [2026-04-22T22:17:44Z] user-input → display_name ===
    value: gav

  === [2026-04-22T22:17:51Z] user-input → channel_choice ===
    value: telegram
  ```

  セットアップフローのパスがこれらに依存するため重要。

ログは実行を identifyするヘッダブロックで開き、完了ブロックで閉じる:

```
## 2026-04-22T22:14:12Z · setup:auto started
  user: exedev
  cwd: /home/exedev/nanoclaw
  branch: branded-setup
  commit: 6e0d742

… (ステップエントリ) …

## 2026-04-22T22:18:54Z · completed (total 4m42s)
```

失敗時には、完了ブロックが失敗ステップとそのエラーを記す:

```
## 2026-04-22T22:16:40Z · aborted at container (err=cache_miss)
```

### Level 3: ステップごとの raw ログ

`logs/setup-steps/NN-step-name.log` — ステップごとに 1 ファイル、実行
順に番号付け(自然ソート用にゼロパディングされた 2 桁プレフィックス)。
子プロセスからの逐語的な stdout + stderr 完全版。実行ごとに truncate
されて書き直される(追記しない)。

内容はステップが emit するすべて:apt の出力、docker build のレイヤ、
pnpm install のスパム、`curl` のボディ等。これは証拠プレーン —
「シェルが実際に何を見たか?」 何もフィルタしない。

## 新しいステップの契約

ステップを追加するとき(`setup/<name>.ts` の TS ステップでも、`auto.ts`
から呼ばれる bash インストーラでも)、それは次を満たすべき:

1. 呼び出し元から **raw ログパスを受け取る**。すべての stdout + stderr
   をそこに書く。ターミナルに直接書かない。
2. 末尾に **単一のターミナルステータスブロックを emit** する:
   `STATUS: success|skipped|failed` とステップ固有のフィールドを含む:

   ```
   === NANOCLAW SETUP: STEP_NAME ===
   STATUS: success
   KEY: value
   KEY: value
   === END ===
   ```

   フィールド名は `UPPER_SNAKE_CASE`。値は短いスカラ。

3. 長く走るステップなら、オプションでストリーム途中に **サブステータス
   ブロック** を emit する。`auto.ts` がそれをライブでパースし、中間 UI
   をレンダリングできる(`pair-telegram` が `PAIR_TELEGRAM_CODE` /
   `PAIR_TELEGRAM_ATTEMPT` でやっているように)。

4. ハード失敗時には **非ゼロ exit** すること。これにより `auto.ts` は
   「ステップは完走して failed を報告した」と「ステップがクラッシュ
   した」を区別できる。

ドライバが残りを扱う:レベル 1 のスピナー、レベル 2 への構造化追記、
レベル 3 への raw キャプチャ。

## Anthropic 例外

Anthropic クレデンシャル登録(`setup/register-claude-token.sh`)は、
ビジュアルフロー上で許される **唯一** の break である。理由:

- `claude setup-token` はブラウザを開き、独自の OAuth プロンプトを実行
  し、トークンを表示する。`script(1)` 経由で TTY を所有する。
- OAuth デバイスフローを自分たちで再実装したくない。
- トークンをインターセプト / ミラーしたくない(すでにユーザの
  ターミナルに表示されている — ミラーすると攻撃面が増える)。

そのため、このステップ中:
- clack フローは明示的に一時停止する(「ここからは対話的で、Anthropic
  に引き渡している」と `p.log.step` マーカーが言う)。
- 子は stdio を完全に継承する。
- 制御が戻ったら、clack は次の行で success マーカーと共に再開する。

レベル 2 ログには依然エントリが入る(`auth [interactive] → success` と
使った method — subscription / oauth-token / api-key)。レベル 3 の
キャプチャはここではオプション;`script -q` の出力をミラーするのは
トリッキーで、トークンがディスクに漏れるリスクが、デバッグ価値を
上回る。

## ファイルリファレンス

| ファイル | 役割 |
|---|---|
| `nanoclaw.sh` | トップレベルラッパー。Phase 1 (bootstrap) と phase 2 (setup:auto) のオーケストレーション。bootstrap の raw ログ + 進行エントリを書く。 |
| `setup.sh` | Phase 1 bootstrap:Node、pnpm、ネイティブモジュール検証。自身の `BOOTSTRAP` ステータスブロックを emit する(歴史的には stdout に出力していたが、現在は bootstrap raw ログへ)。 |
| `setup/auto.ts` | Phase 2 ドライバ。clack UI、ステップ実行、ユーザプロンプトをオーケストレートし、spawn する各ステップの全 3 ログレベルへ書く。 |
| `setup/logs.ts` | ログプリミティブ(`logStep`、`logUserInput`、`logComplete`、`stepRawLog`、`initSetupLog`)。レベル 2/3 のフォーマットとファイルパスの唯一の正本。 |
| `setup/<step>.ts` | 個別ステップ実装。単一のターミナルステータスブロックを emit する必要があり、ターミナルに直接書いてはならない。 |
| `setup/register-claude-token.sh` | Anthropic 例外。stdio を継承し、自身の UI を出し、ドライバにステータスを返す。 |
| `setup/add-telegram.sh` | 非対話的な adapter インストーラ。env から `TELEGRAM_BOT_TOKEN` を読む;プロンプトしない。ユーザ向けの部分は `auto.ts` に住む。 |
| `setup/pair-telegram.ts` | `PAIR_TELEGRAM_CODE` / `PAIR_TELEGRAM_ATTEMPT` / `PAIR_TELEGRAM` ステータスブロックを emit。UI を決してプリントしない。ドライバが clack note 経由でレンダリングする。 |

## よくある落とし穴

- **ステップ内部からデバッグ出力をプリントする。** 開発中は誘惑される
  が、checkin されたコードでは禁止。すべてのランタイムメッセージは
  ステータスブロック(レベル 2)または raw ログ書き込み(レベル 3)を
  経由する。
- **「ほんの 1 度だけ」とターミナルに行く `console.log` を追加する。**
  clack フローを壊す — スピナー行が破ける。代わりに `src/log.ts` の
  `log.info` / `log.error`(raw ログに書く)を使う。
- **例外でない子に対する `stdio: 'inherit'`。** 上の Anthropic を参照。
  それ以外は `pipe` + 明示キャプチャが必要。
- **stderr への tee。** Clack のスピナーはステップ中ターミナルを所有
  する。stderr 書き込みでもフレームが破ける。すべてパイプし、何を
  surface するかを選ぶ。
- **bash の `$VAR…` 位置での UTF-8。** Bash のレキサはマルチバイト文字
  の最初のバイトを変数名に取り込んで `set -u` を引っ掛けることがある。
  常に brace で:`${VAR}…`。

## 将来作業 (未実装)

- **進行ログのローテーション。** 今日の実装は実行ごとに truncate する。
  将来:過去の実行を `logs/setup.log.1`、`.2` 等に回す。
- **複数回実行 install のための raw ログローテーション。** 現状は各
  実行が上書き。今は問題ないが、サポートが連続試行を比較する必要が
  出てきたら見直す。
- **`register-claude-token.sh` からの構造化出力。** 対話ステップは
  現在マシン可読なステータスを emit しない。将来は使われた method 付き
  の post-interaction ステータスブロックを追加できる。
