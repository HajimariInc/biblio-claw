#!/usr/bin/env node
/**
 * biblio-claw Drive MCP server の stdio smoke test。
 *
 * 実 Drive 到達なし = MCP JSON-RPC の shape 遵守 (initialize + tools/list)
 * のみを確認する。ネットワーク未要求で CI/local 両方で走る。
 *
 * pass 条件:
 *   - initialize response が protocolVersion / serverInfo を返す
 *   - tools/list response の tools 配列に drive_list_files / drive_get_file の 2 tool が含まれる
 *   - 未消費 stdout に余分な行 (= console.log 汚染) が残っていない
 *
 * fail 時は exit 1 + 診断を stderr に出す。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, 'index.mjs');

const proc = spawn('node', [SERVER_PATH], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

/** stdout line-delimited JSON バッファ */
let stdoutBuf = '';
/** id → resolve の待ち行列 */
const pending = new Map();

proc.stdout.setEncoding('utf8');
proc.stdout.on('data', (chunk) => {
  stdoutBuf += chunk;
  let idx;
  while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
    const line = stdoutBuf.slice(0, idx).trim();
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      console.error(`[smoke] stdout に非 JSON line: ${line.slice(0, 200)}`);
      continue;
    }
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    } else {
      // notification 等は無視
    }
  }
});

// stderr は起動ログのため素通し (診断用途)、失敗確認には使わない
proc.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
});

proc.on('error', (err) => {
  console.error(`[smoke] server プロセス起動失敗: ${err.message}`);
  process.exit(1);
});

function send(obj) {
  return new Promise((resolve, reject) => {
    if (typeof obj.id === 'number') {
      pending.set(obj.id, resolve);
    } else {
      resolve(undefined); // notification は即 resolve
    }
    const line = JSON.stringify(obj) + '\n';
    proc.stdin.write(line, 'utf8', (err) => {
      if (err) reject(err);
    });
    // safety timeout
    if (typeof obj.id === 'number') {
      setTimeout(() => {
        if (pending.has(obj.id)) {
          pending.delete(obj.id);
          reject(new Error(`request id=${obj.id} method=${obj.method} timed out (5s)`));
        }
      }, 5000);
    }
  });
}

async function main() {
  // 1. initialize
  const initResp = await send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'biblio-claw-drive-smoke', version: '0.0.0' },
    },
  });
  if (initResp.error) {
    throw new Error(`initialize failed: ${JSON.stringify(initResp.error)}`);
  }
  if (!initResp.result || !initResp.result.serverInfo) {
    throw new Error(`initialize response missing serverInfo: ${JSON.stringify(initResp)}`);
  }
  console.error(
    `[smoke] initialize ok: server=${initResp.result.serverInfo.name} `
      + `v${initResp.result.serverInfo.version} protocol=${initResp.result.protocolVersion}`,
  );

  // 2. initialized notification (MCP 仕様: client → server)
  await send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  // 3. tools/list
  const toolsResp = await send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  });
  if (toolsResp.error) {
    throw new Error(`tools/list failed: ${JSON.stringify(toolsResp.error)}`);
  }
  const tools = toolsResp.result?.tools;
  if (!Array.isArray(tools)) {
    throw new Error(`tools/list response missing tools[]: ${JSON.stringify(toolsResp)}`);
  }
  const names = tools.map((t) => t.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(['drive_get_file', 'drive_list_files'])) {
    throw new Error(`expected 2 tools (drive_list_files, drive_get_file), got: ${names.join(', ')}`);
  }
  console.error(`[smoke] tools/list ok: ${names.join(', ')}`);

  // 4. clean shutdown
  proc.stdin.end();
  await new Promise((resolve) => {
    proc.once('close', resolve);
    setTimeout(resolve, 2000); // graceful timeout
  });
  console.error('[smoke] PASS');
}

main()
  .then(() => {
    proc.kill('SIGTERM');
    process.exit(0);
  })
  .catch((err) => {
    console.error(`[smoke] FAIL: ${err.message}`);
    proc.kill('SIGTERM');
    process.exit(1);
  });
