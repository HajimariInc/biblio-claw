# biblio-claw Glossary / 用語集

> **本ファイルは Vault 正本の inject 版**です。編集の起点は Vault (`11-labo/biblio-shelf/design/naming-mapping.md` §「確定した命名」+ `functions.md` §1.2 / §1.3 / §3)。**repo 側での独自加筆は禁止**、正本更新時は re-inject で反映します。この運用は biblio-shelf の 3 ロケーション運用モデル (Vault=TO-BE / repo=AS-IS / wf-realm=index) の可視化を兼ねます。

## Metaphor / 書架メタファ

biblio-claw は「図書館 (library) の司書 (librarian) が、書架 (shelf) に並ぶ蔵書 (biblio) を patron (来館者) の要望に応じて管理する」書架メタファで用語を統一しています。開発者向けの技術用語 (orchestrator / container 等) とは別レイヤの語彙です。

---

## Entities / 実体

### biblio

- **JP**: 蔵書 (skill / plugin の総称)
- **EN**: A biblio (a skill or plugin held on the shelf)
- **説明**: shelf に並ぶコンテンツの総称。派生語 `biblio-skill` / `biblio-plugin` で種別を区別する

### shelf

- **JP**: 棚 (公開 git repo + marketplace)
- **EN**: The shelf (public git repo + marketplace)
- **説明**: `HajimariInc/biblio-shelf` repo が実体、`marketplace.json` がカタログ

### marketplace

- **JP**: 棚のカタログ (biblio-claw 独自) / plugin marketplace (NanoClaw 上流)
- **EN**: (a) Shelf catalog (`marketplace.json`) in biblio-claw context / (b) Claude Code plugin marketplace in NanoClaw upstream context (see [`docs/skills-as-branches.md`](skills-as-branches.md))
- **注意**: 本語彙は文脈で意味が変わる。biblio-claw 独自 doc では (a)、上流由来 doc では (b)。glossary 誘導リンクは biblio-claw 独自の用法に対して張る

### 司書 / Librarian

- **JP**: 司書
- **EN**: Librarian (biblio-claw runtime persona)
- **説明**: biblio-claw への呼びかけ・メンション用の呼称。実装状況は §Implementation Status 参照

### biblio-claw

- **JP/EN**: biblio-claw
- **説明**: (1) repository 名 = `HajimariInc/biblio-claw` (2) GCP project 名 (課金・請求の単位)。静的コード (repo) と動的実行体 (GCP 上の稼働体) の両方を指す

### biblio-orchestrator / biblio-agent-container

- **JP/EN**: biblio-orchestrator / biblio-agent-container
- **説明**: GCP 上の実行体。prefix `biblio-` 遵守が命名規則。orchestrator は司書の中枢 (常駐)、agent-container は実務実行の場 (ephemeral)

### OneCLI Gateway

- **JP/EN**: OneCLI Gateway
- **説明**: 認可・secret 注入担当の別プロセス (上流 NanoClaw 由来、別称なし)

---

## Users / 利用者 (2 種類)

### guest

- **JP**: 訪問者 (shelf の GitHub / Claude marketplace 標準経由の利用者)
- **EN**: Guest (visitor to the shelf via GitHub / Claude marketplace)
- **司書の関与**: なし (標準機能で使う)
- **実装状況**: repo 実装では利用者としての guest 語彙は未実装 (glossary で概念として明示、実装反映は将来)

### patron

- **JP**: パトロン (司書の直接利用者)
- **EN**: Patron (direct user of the librarian)
- **接点**: Slack channel adapter + Fugue channel adapter
- **司書の関与**: あり (依頼・対話)

---

## Biblio Operations / biblio 操作 (9 種)

biblio のライフサイクル基本ワークフロー: **仕入れる → 検品する → カテゴライズ → 収蔵する**。要望に応じて **装備 / 読む / 禁書 / 焼却**。consumer 視点の **install** は司書非関与で別扱い。

| 操作         | JP       | EN                    | 性質         | HITL              |
| :--------- | :------- | :-------------------- | :--------- | :---------------- |
| 仕入れ        | 仕入れる     | Acquire               | 非破壊        | 自律 (事後報告)         |
| 検品         | 検品する     | Inspect               | 非破壊        | 自律 (事後報告)         |
| カテゴライズ     | 判別       | Categorize            | 破壊的に近い     | 事前通知 + 承認         |
| 収蔵         | 陳列       | Shelve                | 非破壊        | 自律 (事後報告)         |
| 装備         | 装備       | Equip                 | 非破壊        | 自律                |
| 読む         | 読む       | Read                  | 非破壊 (要注意)  | 状況により事前確認         |
| 禁書         | 禁書       | Enkin (Ban)           | 破壊         | 事前通知 + 承認 (HITL)  |
| 焼却         | 焼却       | Shokyaku (Incinerate) | 破壊 (不可逆)   | 事前通知 + 承認 (HITL)  |
| install    | (司書非関与)  | Install (by consumer) | —          | —                 |

### 禁書 vs 焼却 の差

- **禁書** = shelf から除去 + 司書手元の clone は残置 → **装備は引き続き可能**
- **焼却** = shelf から除去 + 司書手元の clone も物理削除 → **装備不可**

---

## Claw Body Operations / biblio-claw 本体操作 (3 種)

biblio とは厳格に区別。全 3 操作が破壊分類 (事前通知 + 承認)。

| 操作       | 概要                                    |
| :------- | :------------------------------------ |
| リポメンテ    | 自分のコードを改修 (issue 解決 / 機能追加)           |
| issue → PR | biblio-claw issue を解決し PR 作成          |
| 能力拡張     | 本体コードベースに能力を焼き込む (mutation)          |

---

## 3 Concepts / 3 概念の区別 (装備 / install / injection)

「棚から biblio を取る」行為は主体 × 行き先 × 目的で 3 分岐。

| 概念            | 主体            | 入る場所                       | 目的                     | 標準/独自   |
| :------------ | :------------ | :------------------------- | :--------------------- | :------ |
| 装備 (equip)    | 司書            | 司書の agent-container         | 司書が自分で biblio を使う      | 独自      |
| install       | guest / patron | consumer の `.claude/` 等     | consumer が自分の環境に入れる    | 標準 (marketplace) |
| injection     | 司書            | 他プロジェクト repo               | 他プロジェクトに biblio を配布    | 独自      |

---

## Categories / namespace (4 種)

| カテゴリ                     | namespace     |
| :----------------------- | :------------ |
| 開発 (Development)          | `biblio-dev`  |
| クリエイティブ (Creative / Art) | `biblio-art`  |
| バックオフィス (Back Office)     | `biblio-bf`   |
| AI 運用 (AI Operations)     | `biblio-ai`   |

---

## Implementation Status / 実装状況 (透明化のための注記)

- **司書名**: 現状の default は `.env.example` の `ASSISTANT_NAME=biblio-dev`。正本 (第一候補「司書」/ フォールバック `BiblioLib`) への切替は別 issue で対応予定
- **`@Andy` 残存**: 上流 NanoClaw 由来の default `@Andy` (`ASSISTANT_NAME`) の使用例が上流継承 doc に残存 (`README.md` / `docs/REQUIREMENTS.md` / `docs/SPEC.md` 等)、別 issue で対応
- **guest 概念**: 上表の通り、repo 実装では利用者としての guest 語彙は未実装。glossary で概念として明示、実装反映は将来

---

## Related / 関連

- Vault 正本 (repo からは辿れません): `11-labo/biblio-shelf/design/naming-mapping.md` + `functions.md`
- 装備機構の物理配置: [`docs/equip-physical.md`](equip-physical.md)
- 運用 Runbook: [`docs/operations-runbook.md`](operations-runbook.md)
- ドキュメント全索引: [`CLAUDE.md`](../CLAUDE.md) §ドキュメント索引
