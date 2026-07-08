# biblio-claw Drive MCP server

biblio-claw の life-capabilities 機能の一部として追加された、Google Drive
read-only の stdio MCP server。agent-container 内で `node /opt/mcp-servers/drive/index.mjs`
として spawn される (Bun ではなく Node 22 で走る)。

## なぜ独立 Node server なのか

3 つの制約が交わる点だけがこの設計を許す:

1. **Bun 1.3.x の HTTPS-over-CONNECT-proxy バグ** (`oven-sh/bun#30381`)
   agent-runner (Bun) 内で `fetch()` を直接叩くと OneCLI proxy トンネル確立後
   応答パースが壊れる。Node 22 native fetch は無問題なので、外部 HTTPS を
   独立 Node プロセスに切り出す。
2. **keyless ADC 維持** (repo 全体制約)
   `GOOGLE_APPLICATION_CREDENTIALS` (SA 鍵 JSON) を持たない = 既存 MCP server
   の Drive 実装が全て使えない。かといって Google 公式 remote MCP は OAuth
   対話必須で無人不可。
3. **agent Pod への WI 追加拒否** (repo 全体で確立された不変条件)
   agent Pod egress は `169.254.169.254/32` を metadata block で拒否している。
   したがって agent-container 内で ADC token を発行することは構造的に不可能。

3 制約を全て満たす唯一の解 = **`Authorization: Bearer placeholder` を送って
OneCLI MITM proxy に実 token 置換を委ねる**。ADC token は orchestrator Pod 内の
`drive-token-rotator` sidecar が 40min 周期で OneCLI に投入する
(Vertex / GH と同流儀)。

## 提供する tool (read-only)

- `drive_list_files(folder_id?, page_size?)` — フォルダ配下 or 共有中の全 file
- `drive_get_file(file_id, export_mime?)` — Google Docs は text 化、Binary は 5 MiB まで

書き込み系 tool (upload / delete / move) は本 server では実装しない。破壊操作は
HITL 承認機構が別途必要 (破壊操作用の既存 HITL 承認 pattern を踏襲する必要があるが、
本 server の MVP スコープ外)。

## 動作確認 (smoke)

```bash
node --input-type=module -e "import('./index.mjs').then(() => console.error('parsed ok')).catch((e) => { console.error(e); process.exit(1); })"
node test.mjs  # initialize + tools/list の 2 request で protocol shape 確認 (実 Drive 到達なし)
```
