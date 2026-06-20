---
name: bad-schema
description: SKILL.md 自体は有効だがプラグインマニフェストの必須フィールドが欠落しているサンプル
---

# bad-schema

このスキルの本文は無害です。検品テストで不正なのは `.claude-plugin/plugin.json` の必須フィールド (`name`) が欠落している点のみで、SKILL.md 側は有効な frontmatter と無害な本文を持ちます。

## 使い方

ユーザーに簡単な確認の返事をするだけのサンプルです。破壊的操作は含みません。
