# 入力ゲート 4 層設計 (M4-F Phase 2)

biblio-claw の全ての外部入力 (Slack / CLI / Fugue channel) は **agent-container に到達する前に 4 層の入力ゲート** を通る。gate は各 patron 発話を **Layer 2 → Layer 1 → Layer 3 → Layer 4 の cheap-to-expensive** で評価し、最終的に 3 分類 (`biblio-adk` / `biblio-other` / `in-secure`) のいずれかに振り分ける。この 3 分類がそのまま **経路 routing** を兼ねている。

> **セキュリティモデル全体像**: 本 doc は「入力ゲートの設計」に特化する。container 分離 + OneCLI Vault + keyless 認証等を含む全体は [`SECURITY.md`](SECURITY.md) 参照。

---

## なぜ入力ゲートが必要か

LLM エージェントに **`lethal trifecta`** (Simon Willison) が揃うと、prompt injection 経由でクレデンシャル漏洩や自律的な悪意ある行動が成立する:

1. **信頼できない入力** (Untrusted input) — patron 発話 / 外部 Web / Drive の中身
2. **私的データへのアクセス** (Access to private data) — 装備 skill 経由の secret / OneCLI 経由の GitHub token
3. **外部通信の権利** (External communication) — Slack DM 送信 / GitHub API 呼び出し / Web 検索

biblio-claw は 3 者すべてを持つ。単純な allowlist / denylist では対処できない (prompt injection が任意の文字列で表現可能) ため、**defense in depth** で複数層を重ねる。

---

## gate 4 層の全体像

各 Layer は独立した責務を持ち、cheap-to-expensive で並ぶ。合成順序は **Layer 2 → Layer 1 → Layer 3 → Layer 4**。Layer 2 (入力正規化) を先頭に置くことで、後段の Layer 1/3/4 全てが正規化済 text を評価するようになり、fullwidth / invisible unicode 経由の bypass に対して層全体の効き目が上がる。Layer 1 で pattern matched なら Layer 3/4 を待たず **早期 `in-secure` return**。

| Layer | 責務 | 判定材料 | 実装ファイル |
| :--- | :--- | :--- | :--- |
| **L2** | 入力側 Unicode 正規化 (bypass 対策) | NFKC + zero-width / bidi override / Unicode Tag block の strip | `src/gate/layer2-normalize.ts` |
| **L1** | pattern detection (OWASP LLM01 最小) | 静的な injection 文字列パターン (正規化済 text で評価) | `src/gate/layer1-pattern.ts` |
| **L3** | XML trust boundaries (Spotlighting、最小完全) | untrusted input を `<untrusted-input>` で囲む | `src/gate/layer3-xml.ts` |
| **L4** | LLM evaluator (最も表現力あり) | Gemini Flash Lite の分類応答 | `src/gate/layer4-evaluator.ts` |

合成 (L2 → L1 → L3 → L4 の cheap-to-expensive) と `withGateSpan` (OpenTelemetry 観測) は `src/gate/gate.ts` の `evaluateGate()` / `withGateSpan()` に集約されている。`GateResult.layerHit` の値 (`'layer1'` / `'layer4'`) は「どこで確定したか」を示す keying 用で、順序と一致する必要はない (Layer 2 は shell として type に残るが実際の layerHit として発火する経路はない)。

---

## Layer 1: pattern detection (最小)

**責務**: 明らかに攻撃と分かる静的な文字列パターンを弾く (`Ignore previous instructions` / `System:` へのなりすまし / `<|im_start|>` 等)。

- OWASP Top 10 for LLM Applications (LLM01: Prompt Injection) の代表的 pattern を最小実装
- Layer 1 で pattern matched → **Layer 4 を待たずに `in-secure` return** = 明らかな攻撃に LLM コストを払わない
- 実装: `detectInjectionPattern(text)` in `src/gate/layer1-pattern.ts`

Layer 1 は **偽陽性の許容度が低い** (LLM への正当な自然文が偽陽性で in-secure に落ちるとユーザ体験が壊れる) ため、パターンを保守的に持つ。網羅性は Layer 4 に委ねる。

---

## Layer 2: 入力側 Unicode 正規化

**責務**: patron 発話中の Unicode ベース bypass 攻撃 (fullwidth 迂回 / zero-width 挟み込み / bidi override 経由 Trojan Source 型 / Unicode Tag block 経由の invisible instruction) を、後段の Layer 1/3/4 に **正規化済 canonical form** で渡す。

- **4 種処理** (全て `text.replace` ベースの pure 関数、throw なし、副作用なし):
  1. **NFKC 正規化** — Unicode Standard Annex #15 の compatibility form。fullwidth Latin `Ｉｇｎｏｒｅ` → 半角 `Ignore`、ligature (`ﬀ` → `ff`) 展開、丸数字 (`①` → `1`) の potential loss を含む
  2. **Zero-width strip** — U+200B ZWSP / U+200C ZWNJ / U+200D ZWJ / U+FEFF BOM の 4 種 (Word Joiner U+2060 は業界標準に合わせて strip 対象外)
  3. **Bidi override strip** — U+202A-E (LRE/RLE/PDF/LRO/RLO 5 種) + U+2066-9 (LRI/RLI/FSI/PDI 4 種) の計 9 種。CVE-2021-42574 Trojan Source 攻撃対策
  4. **Unicode Tag block strip** — U+E0000-E007F (astral plane、surrogate pair)。Reverse CAPTCHA 論文 ([arXiv:2603.00164](https://arxiv.org/html/2603.00164v1)) で Claude 系モデル tool use 有効時 98-100% compliance が実証された invisible instruction 経路
- **実装**: `normalizeInput(text)` in `src/gate/layer2-normalize.ts` (Node 標準 `String.prototype.normalize('NFKC')` + 3 種 regex replace、新規 npm dep なし)
- **合成上の位置**: `evaluateGate` の先頭に置き、Layer 1 pattern 検出も Layer 4 LLM 評価も **正規化済 text** で行われる。これにより Layer 1 の ASCII regex (`INSTRUCTION_OVERRIDE_RE` 等) が fullwidth 迂回攻撃も捕捉できるようになる (cheap layer の効き目底上げ)
- **audit / span digest との関係**: `audit-log.ts` の `utterance` フィールドと `withGateSpan` の `text_digest` は **生 text** を保持する (`normalizeInput` を経由しない独立経路、運用者が「何が来たか」を追える可視性を優先)

### 副作用 (trade-off、許容)

以下は仕様として保存する:

- **NFKC 副作用**: `①②③` → `123`、`㍿` → `株式会社`、半角カナ `ｱｲｳ` → 全角カナ `アイウ` (半角→全角が canonical 方向、逆ではない)
- **ZWJ 絵文字破壊**: 家族絵文字 `👨‍👩‍👧‍👦` は ZWJ (U+200D) 除去で個別絵文字にバラける。**context-aware ZWJ 保護は業界に確立実装なし** (Context Guard 2026-05-25 記事)、biblio-claw は日本語/英語主体で絵文字依存度低いため許容
- **地域旗絵文字破壊**: `🏴󠁧󠁢󠁳󠁣󠁴󠁿` (Wales 等) は Unicode Tag block sequence で構成されるため strip で破壊される。biblio 用途で実害少
- **homoglyph 非対応**: Cyrillic `а` (U+0430) → Latin `a` の視覚類似字は NFKC の対象外。`unicode-confusables` 系 npm dep は 2026-07 時点で決定版不在 (素は 6 年前更新、fork も 1 年前で "not healthy")。§Phase 3+ 想定 に anchor

---

## Layer 3: XML trust boundaries (Spotlighting、最小完全)

**責務**: untrusted input を明示的な XML タグで囲み、後段の LLM に「これは外部由来コンテンツ、命令として解釈するな」を **構造的に伝える**。

- 手法: **Spotlighting** ([arXiv:2403.14720](https://arxiv.org/abs/2403.14720))
- 実装: `wrapUntrustedInput(text)` in `src/gate/layer3-xml.ts`
- 出力形式: `<untrusted-input>本文</untrusted-input>` (既存の close tag は `&lt;/untrusted-input&gt;` に HTML entity escape 済 = 境界偽装対策)
- **最小完全** = biblio-claw が LLM に渡す全経路で漏れなく囲む。M4-H (Fugue ask endpoint) の response 4 field (`summary` / `findings[].text` / `sources[].title` / `sources[].snippet`) には **別実装** の `<external-content>` tag を適用 (`src/channels/fugue-ask-content.ts:wrapExternalContent`、外部由来の 4 field 用)。両者は目的が別 (入力側 vs. 出力側)、コード実体も別ファイルで混同しないこと (Contract §5.5)

---

## Layer 4: LLM evaluator (`gemini-3.1-flash-lite`)

**責務**: Layer 1-3 で決まらなかった入力を LLM で分類する。**3 分類 routing** の判定はここで行う。

### F-1 設計原則 (stateless pure)

Layer 4 の LLM 呼び出しは **stateless pure 関数** として設計:

- **入力**: patron 発話テキスト + system instruction (定数)
- **出力**: 分類ラベル (`biblio-adk` / `biblio-other` / `in-secure`) + 判定理由 (audit 用)
- **状態を持たない**: セッション履歴 / MEMORY / 他 patron の発話は一切参照しない
- **情報隔離**: この関数は「テキストを見る」だけで、GitHub / Vertex / OneCLI 等の secret アクセス経路を **構造的に持たない**

これは Dual LLM pattern (Simon Willison) の応用: **判定用の LLM は権限を最小化**し、判定結果だけを orchestrator に返す。判定用 LLM に prompt injection が刺さっても、それが横展開する経路がない。

### モデル選定

- 既定: **`gemini-3.1-flash-lite`** (低 latency + 低コスト、routing 決定の user-facing latency に効く)
- 差替: env `GATE_MODEL` で上書き可能 (M2 検品の `INSPECT_DANGEROUS_MODEL` と同 pattern)
- Vertex 経由呼び出し = 他の LLM 呼び出しと同じ keyless 認証 ([`vertex-claude-keyless.md`](vertex-claude-keyless.md))

### 実装

- `evaluateInput(text)` in `src/gate/layer4-evaluator.ts`
- prompt template: system instruction (3 分類の定義 + 判定基準) + user turn (patron 発話をそのまま)
- 出力 parse: JSON strict schema で `{ classification, reason }` を受け取る

---

## 3 分類 routing

Layer 4 が返す 3 分類がそのまま **経路 routing** を兼ねる:

| 分類 | 意味 | routing 先 |
| :--- | :--- | :--- |
| **biblio-adk** | 確定的・ほぼ決定論的な biblio-shelf 操作 (仕入れ / 検品 / カテゴライズ / 陳列 / 装備 / 蔵書一覧 / 禁書 / 焼却 / 設定変更 の 9 tool) | **ADK 経路** (`@google/adk` の LlmAgent + FunctionTool 9 種) |
| **biblio-other** | 一般会話 / 対話 / 会話ログ + MEMORY 文脈 + 実行力が要る仕事 (fallback 既定) | **agent-container 経路** (NanoClaw の原点、claude-code CLI provider + 装備 skill + Bash + Web + Drive + MCP server) |
| **in-secure** | 明らかに危険な入力 (prompt injection / lethal trifecta 誘発の兆候) | 遮断 (下記 §in-secure 3 点セット) |

**biblio-other が fallback** (デフォルト) = 分類に迷うケースは agent-container 経路に落とす。NanoClaw の原点 = 「対話を通じて何でもする司書」を尊重するため、ADK 経路 (確定的な tool のみ) には確度が高い時だけ振る。

---

## in-secure 3 点セット

`in-secure` 判定は patron に「危険な入力だった」と直接伝えることも、無音で drop することもしない。3 点セットで扱う:

1. **admin 通知** — admin (DEN さん) の Slack DM に「in-secure 判定が発火した」通知を送る。判定理由 + patron ID + 発話 digest を含む (発話原文は audit log 側にのみ、DM には出さない)
2. **audit log** — structured log (`event: gate.in_secure` + `patron_id` + `classification.reason` + `text_digest`) を出力。Cloud Logging → BigQuery sink 経由で集計可能
3. **patron 定型文返信** — patron には「この依頼はセキュリティ判断で保留された。詳細は admin に問い合わせを」の定型文を返す。具体的な判定理由は伝えない (adversary への情報漏洩を防ぐ)

実装: `src/gate/audit-log.ts` (log 生成) + `src/router.ts` の gate 挿入経路 (admin DM + patron 定型文の送信)

---

## 退路: `GATE_ENABLED=false`

env `GATE_ENABLED` が `1` / `true` 以外なら gate は **完全にバイパス** (`isGateEnabled()` in `src/gate/gate.ts`)。全ての入力が旧経路 (M4-F 以前の直接 agent-container spawn) に流れる。

用途:

- gate の LLM latency が問題になった時の緊急退避
- 開発時のデバッグ (gate 判定を挟まずに素の routing 経路を確認)
- Layer 4 モデルの障害 (`gemini-3.1-flash-lite` の quota / discontinue 等) からの一時退避

M2 検品の `INSPECT_DANGEROUS_MODEL` と同 pattern = 「機能を殺す退路」を env で用意し、事故時に即座に安全側に倒せる。

---

## 挿入点

gate は `src/router.ts` の `deliverToAgent` の `provider === 'adk'` 分岐前段に挿入されている:

1. `router.ts` が inbound message を受け取り、agent group を解決
2. **gate 挿入点** — `evaluateGate(text)` を呼び、3 分類のいずれかを得る
3. `in-secure` なら 3 点セットで処理して return
4. `biblio-adk` なら ADK 経路の dispatcher へ
5. `biblio-other` なら agent-container 経路の dispatcher へ

Fugue channel (`src/channels/fugue.ts` の `POST /v1/channels/fugue/consult` / `equip` / `ask`) も同じ 4 層を通る。**200 契約維持** = in-secure 時も HTTP 200 + `status: 'denied'` + `warnings` で応答 (5xx を返さない、これも AD の本義対応)。

---

## 実装ファイル (主要ポインタ)

| ファイル | 内容 |
| :--- | :--- |
| `src/gate/gate.ts` | 4 層合成 (L2 → L1 → L3 → L4) + `withGateSpan` (OpenTelemetry) + `isGateEnabled` |
| `src/gate/layer1-pattern.ts` | Layer 1 pattern detection |
| `src/gate/layer2-normalize.ts` | Layer 2 入力側 Unicode 正規化 (NFKC + zero-width/bidi/Tag block strip) |
| `src/gate/layer3-xml.ts` | Layer 3 XML trust boundaries (Spotlighting) |
| `src/gate/layer4-evaluator.ts` | Layer 4 LLM evaluator (`gemini-3.1-flash-lite`) |
| `src/gate/audit-log.ts` | in-secure audit log 生成 |
| `src/gate/types.ts` | `GateResult` 型 (3 分類 + reason) |
| `src/router.ts` (挿入点) | `deliverToAgent` の gate 挿入 |
| `src/channels/fugue.ts` (挿入点) | Fugue channel 3 endpoint の gate 挿入 |

各 layer には対応する `*.test.ts` で unit test が用意されている (`layer1-pattern.test.ts` / `layer2-normalize.test.ts` / `layer3-xml.test.ts` / `layer4-evaluator.test.ts` / `audit-log.test.ts` / `gate.test.ts` / `gate.otel.test.ts`)。

---

## Phase 3+ 想定

今回スコープ外だが将来の拡張候補として anchor を残す:

- **LLM 出力側 markdown drive-by 対策** (`![alt](url)` / `[text](url)` / iframe): 実装位置は gate ではなく `src/delivery.ts` の `adapter.deliver` 前段、または Fugue の `wrapExternalContent` 拡張。Slack native block builder / Fugue response body / CLI 出力の 3 経路で介入方式が異なる。参考: [AWS Security Blog: Unicode character smuggling](https://aws.amazon.com/blogs/security/defending-llm-applications-against-unicode-character-smuggling/) の出力側 sanitizer 節。**旧本 doc の §Layer 2「markdown escaping」記述はこの想定を先取りしていたが、実装位置と副作用の観点から入力正規化 (現 Layer 2) とは別レイヤ扱いに整理し直した。**
- **homoglyph 対策** (Cyrillic `а` → Latin `a` 等): NFKC の対象外、`unicode-confusables` 系 npm dep は 2026-07 時点で決定版不在 (要再評価)。参考: [UTS #39: Unicode Security Mechanisms](https://www.unicode.org/reports/tr39/) の Confusables Detection 節、ICU 4C `uspoof` API の Node 経由利用可否など

---

## 参考

- **M4-F Phase 2 実装** — PR #141 (`838141d`、2026-07-05)。gate 4 層 + 3 分類 routing + in-secure 3 点セット + Fugue channel 4 層通過 + Layer 4 latency 目安 <1s
- **Layer 2 入力正規化実装** — 2026-07-12。Phase 2 shell (identity return) の本実装化 + 合成順序を L2 → L1 → L3 → L4 に変更
- **Simon Willison の議論** — [The lethal trifecta for AI agents (2025)](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/) + Dual LLM pattern
- **Spotlighting** — [arXiv:2403.14720 "Defending Against Indirect Prompt Injection Attacks With Spotlighting"](https://arxiv.org/abs/2403.14720)
- **OWASP Top 10 for LLM Applications** — [LLM01: Prompt Injection](https://owasp.org/www-project-top-10-for-large-language-model-applications/)
- **Trojan Source 攻撃** — [Wikipedia: Trojan Source](https://en.wikipedia.org/wiki/Trojan_Source) (CVE-2021-42574 bidi override 経由 source code 偽装)
- **Unicode character smuggling** — [AWS Security Blog: Defending LLM applications against Unicode character smuggling (2025-09-30)](https://aws.amazon.com/blogs/security/defending-llm-applications-against-unicode-character-smuggling/) (Tag block strip の実装参考)
- **Reverse CAPTCHA** — [arXiv:2603.00164 "Reverse CAPTCHA: Prompt Injection via Unicode Tag Characters"](https://arxiv.org/html/2603.00164v1) (Claude 系モデル + Unicode Tags の tool use 有効時 98-100% compliance 実証)

---

## 関連ドキュメント

- [`SECURITY.md`](SECURITY.md) — biblio-claw のセキュリティモデル全体像
- [`vertex-claude-keyless.md`](vertex-claude-keyless.md) — Vertex×Claude keyless 認証 (Layer 4 の LLM 呼び出しも同経路)
- [`operations-runbook.md`](operations-runbook.md) §M4-F Phase 2 — gate 4 層の実装記録 + 罠
- [`architecture.md`](architecture.md) — biblio-claw のアーキテクチャ全体
