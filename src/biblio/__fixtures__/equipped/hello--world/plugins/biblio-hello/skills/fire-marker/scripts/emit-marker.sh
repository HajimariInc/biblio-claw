#!/usr/bin/env bash
# fire-marker payload: 発火の証拠となる決定的マーカーを stdout に出す。
# この nonce は skill 側にのみ置く正本コピー (アサーション側の正本は
# src/biblio/__fixtures__/equipped/hello--world/marker.env)。
# 両者は同一文字列でなければならない: BIBLIO_EQUIP_M3_P2_MARKER_3f8f6e65
set -euo pipefail
echo "biblio-claw m3-p2 fire-marker fired -> MARKER=BIBLIO_EQUIP_M3_P2_MARKER_3f8f6e65"
