/**
 * mcp-env-overlay.ts の unit test (M4-F Phase 3、Task 7)。
 *
 * bun test で走る (agent-runner の runtime は Bun)。
 *
 * 保護対象:
 *   (1) extractProxyEnv: host env から PROXY_ENV_KEYS のみを抽出、他 env は無視
 *   (2) extractProxyEnv: undefined / 空文字 は落とす (silent failure 撲滅)
 *   (3) overlayServerEnv: proxyEnv → serverConfig.env の spread 順で serverConfig 優先
 *   (4) overlayServerEnv: serverConfig.env が undefined でも空 object 扱いで動く
 *   (5) overlayServerEnv: proxyEnv 単独時 (server.env なし) は proxyEnv だけが返る
 */
import { describe, expect, it } from 'bun:test';

import { PROXY_ENV_KEYS, extractProxyEnv, overlayServerEnv } from './mcp-env-overlay.ts';

describe('extractProxyEnv', () => {
  it('(1) host env から PROXY_ENV_KEYS のみを抽出、他 env は無視', () => {
    const hostEnv = {
      HTTPS_PROXY: 'http://biblio-onecli:10255',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/onecli/ca.pem',
      PATH: '/usr/bin',
      HOME: '/home/node',
      TAVILY_API_KEY: 'should-not-leak', // 他 env は無視
    } as NodeJS.ProcessEnv;
    const proxy = extractProxyEnv(hostEnv);
    expect(proxy).toEqual({
      HTTPS_PROXY: 'http://biblio-onecli:10255',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/onecli/ca.pem',
    });
    expect(proxy.TAVILY_API_KEY).toBeUndefined();
  });

  it('(2) undefined / 空文字 は落とす (silent failure 撲滅)', () => {
    const hostEnv = {
      HTTPS_PROXY: 'http://biblio-onecli:10255',
      HTTP_PROXY: '', // 空文字は落とす
      NODE_EXTRA_CA_CERTS: undefined,
      SSL_CERT_FILE: '/etc/ssl/certs/onecli/onecli-combined-ca.pem',
    } as NodeJS.ProcessEnv;
    const proxy = extractProxyEnv(hostEnv);
    expect(proxy).toEqual({
      HTTPS_PROXY: 'http://biblio-onecli:10255',
      SSL_CERT_FILE: '/etc/ssl/certs/onecli/onecli-combined-ca.pem',
    });
    expect(proxy).not.toHaveProperty('HTTP_PROXY');
    expect(proxy).not.toHaveProperty('NODE_EXTRA_CA_CERTS');
  });

  it('(2b) 空 host env → 空 object', () => {
    expect(extractProxyEnv({} as NodeJS.ProcessEnv)).toEqual({});
  });

  it('(2c) PROXY_ENV_KEYS の完全な列挙 (regression 保護)', () => {
    // 変更検知テスト: PROXY_ENV_KEYS が想定と違うと Drive/Tavily server に
    // proxy 情報が伝わらなくなる silent failure に直結するため hard-code assert。
    expect([...PROXY_ENV_KEYS]).toEqual([
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'NODE_EXTRA_CA_CERTS',
      'SSL_CERT_FILE',
    ]);
  });
});

describe('overlayServerEnv', () => {
  it('(3) proxyEnv → serverConfig.env の spread 順で serverConfig が優先', () => {
    const proxyEnv = {
      HTTPS_PROXY: 'http://biblio-onecli:10255',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/onecli/ca.pem',
    };
    const serverConfig = {
      env: {
        TAVILY_API_KEY: 'placeholder',
        // 意図的 override: serverConfig 側が優先されることを assert
        HTTPS_PROXY: 'http://custom-override:9999',
      },
    };
    const merged = overlayServerEnv(serverConfig, proxyEnv);
    expect(merged.HTTPS_PROXY).toBe('http://custom-override:9999'); // serverConfig 優先
    expect(merged.NODE_EXTRA_CA_CERTS).toBe('/etc/ssl/certs/onecli/ca.pem'); // proxyEnv から
    expect(merged.TAVILY_API_KEY).toBe('placeholder'); // seed 由来を保護
  });

  it('(4) serverConfig.env が undefined でも空 object 扱いで動く', () => {
    const proxyEnv = { HTTPS_PROXY: 'http://biblio-onecli:10255' };
    const merged = overlayServerEnv({}, proxyEnv);
    expect(merged).toEqual({ HTTPS_PROXY: 'http://biblio-onecli:10255' });
  });

  it('(5) proxyEnv 単独時 (server.env なし) は proxyEnv だけ返る', () => {
    const proxyEnv = {
      HTTPS_PROXY: 'http://biblio-onecli:10255',
      SSL_CERT_FILE: '/etc/ssl/certs/onecli/onecli-combined-ca.pem',
    };
    const merged = overlayServerEnv({ env: undefined }, proxyEnv);
    expect(merged).toEqual(proxyEnv);
  });

  it('(6) proxyEnv 空 + serverConfig.env のみ → serverConfig.env だけ返る (Tavily seed 状態)', () => {
    // seed 直後 (host proxy env 未設定の test 環境) で TAVILY_API_KEY=placeholder が
    // 生き残ることを assert = 命題 2 (secret は wire 上でだけ実体を持つ) の regression 保護。
    const merged = overlayServerEnv({ env: { TAVILY_API_KEY: 'placeholder' } }, {});
    expect(merged).toEqual({ TAVILY_API_KEY: 'placeholder' });
  });
});
