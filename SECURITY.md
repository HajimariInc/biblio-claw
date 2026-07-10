# Security Policy

## Reporting a Vulnerability

biblio-claw のセキュリティ脆弱性を発見した場合、
**GitHub Security Advisories** を通じて private に報告してください。

- 報告ページ: [Report a vulnerability](https://github.com/HajimariInc/biblio-claw/security/advisories/new)
- リポジトリの **Security タブ → Advisories → Report a vulnerability**
  からも同じフォームに到達できます

## 対応方針

- 受領後 **72 時間以内**に受領確認を返信
- 深刻度 (Critical / High / Medium / Low) を評価し、対応方針を通知
- Patch 準備完了後、reporter と協議して disclosure timing を決定
- CVE ID は必要に応じて GitHub 経由で発行

## サポート範囲

- **current main branch のみ** サポート対象
- 過去の release / tag への patch back-porting は基本的に行わない

## Public disclosure

Patch リリース後、GitHub Security Advisories 経由で public advisory を publish します。

## 対象外

- サードパーティ依存の脆弱性 → 該当依存の repo に直接報告してください
- 設定ミス / 運用ミスの相談 → GitHub Issues や Discussions は disable にしているため、
  Security Advisories 経路のみとなります (該当時)

## 参考

- biblio-claw の内部セキュリティモデル (トラストモデル、コンテナ分離、
  OneCLI クレデンシャル分離等): [`docs/SECURITY.md`](docs/SECURITY.md)
