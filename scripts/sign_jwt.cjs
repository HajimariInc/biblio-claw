#!/usr/bin/env node
// scripts/sign_jwt.cjs — GitHub App 用 RS256 JWT 署名 (Node 組み込み crypto / npm install 不要)
//
// 秘密の非露出 (絶対):
//   - PEM は stdin (fd 0) から受け取り、argv・一時ファイルには一切載せない。
//   - 出力は JWT のみ (stdout)。PEM や鍵素材は出力しない。
//
// env:
//   GH_APP_ID        : JWT の iss (App ID。必須)
//   JWT_EXP_SECONDS  : exp を「現在時刻から何秒後」に設定するか (既定 540)。
//                      iat = now - 60 (クロックドリフト吸収) なので、JWT の
//                      有効期間 (exp - iat) = JWT_EXP_SECONDS + 60。既定では
//                      540 + 60 = 600 秒 = 10 分 (GitHub 上限ちょうど)。
'use strict';

const crypto = require('crypto');
const fs = require('fs');

const appId = process.env.GH_APP_ID;
if (!appId) {
  process.stderr.write('sign_jwt: GH_APP_ID env が未設定\n');
  process.exit(1);
}
const expSec = parseInt(process.env.JWT_EXP_SECONDS || '540', 10);

// PEM を stdin から読む (変数経由ではなく fd 0 を直接読む)。argv には載せない。
let pem;
try {
  pem = fs.readFileSync(0, 'utf8');
} catch (e) {
  // e.code (EACCES / ENOENT / EPIPE) または e.message を可視化。
  // 元情報を消すと「stdin 失敗」だけで原因切り分けができない。
  process.stderr.write(`sign_jwt: PEM の stdin 読込に失敗: ${e.code || e.message}\n`);
  process.exit(1);
}
if (!pem || !/BEGIN[^-]*PRIVATE KEY/.test(pem)) {
  process.stderr.write('sign_jwt: stdin が PEM 秘密鍵でない (BEGIN ... PRIVATE KEY 不在)\n');
  process.exit(1);
}

const b64url = (buf) =>
  Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const now = Math.floor(Date.now() / 1000);
const header = { alg: 'RS256', typ: 'JWT' };
// iat を 60 秒過去にずらしクロックドリフトを吸収 (GitHub 推奨)。
const payload = { iat: now - 60, exp: now + expSec, iss: appId };
const signingInput =
  b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));

let sig;
try {
  sig = crypto.sign('RSA-SHA256', Buffer.from(signingInput), pem);
} catch (e) {
  // OpenSSL エラー (e.message) は PEM 内容を含まない (Node crypto はエラー文字列のみ)。
  // FIPS mode / HSM / 鍵長不一致などの具体原因は e.message に出る。
  process.stderr.write(`sign_jwt: 署名に失敗 (PEM が不正な秘密鍵): ${e.message}\n`);
  process.exit(1);
}

process.stdout.write(signingInput + '.' + b64url(sig) + '\n');
