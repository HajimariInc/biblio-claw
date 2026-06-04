# Apple Container ネットワークセットアップ (macOS 26)

Apple Container の vmnet ネットワーキングは、コンテナがインターネットにアクセスするために手動設定が必要である。これがないと、コンテナはホストとは通信できるが、外部サービス(DNS、HTTPS、API)には到達できない。

## クイックセットアップ

次の 2 コマンドを実行する(`sudo` が必要):

```bash
# 1. ホストがコンテナのトラフィックをルーティングするよう IP forwarding を有効化
sudo sysctl -w net.inet.ip.forwarding=1

# 2. コンテナのトラフィックがインターネットインターフェース経由で masquerade されるよう NAT を有効化
echo "nat on en0 from 192.168.64.0/24 to any -> (en0)" | sudo pfctl -ef -
```

> **Note:** `en0` を自分のアクティブなインターネットインターフェースに置き換えること。確認方法:`route get 8.8.8.8 | grep interface`

## 永続化する

これらの設定は再起動でリセットされる。永続化するには:

**IP Forwarding** — `/etc/sysctl.conf` に追加:
```
net.inet.ip.forwarding=1
```

**NAT ルール** — `/etc/pf.conf` に追加(既存ルールの前):
```
nat on en0 from 192.168.64.0/24 to any -> (en0)
```

そしてリロード:`sudo pfctl -f /etc/pf.conf`

## IPv6 DNS 問題

デフォルトでは、DNS リゾルバは IPv4(A)レコードより先に IPv6(AAAA)レコードを返す。私たちの NAT は IPv4 しか扱わないため、コンテナ内の Node.js アプリケーションはまず IPv6 を試して失敗する。

コンテナイメージと runner は、次の設定で IPv4 を優先するよう構成されている:
```
NODE_OPTIONS=--dns-result-order=ipv4first
```

これは `Dockerfile` で設定され、`container-runner.ts` でも `-e` フラグ経由で渡される。

## 検証

```bash
# IP forwarding が有効か確認
sysctl net.inet.ip.forwarding
# 期待値: net.inet.ip.forwarding: 1

# コンテナのインターネットアクセスをテスト
container run --rm --entrypoint curl nanoclaw-agent:latest \
  -s4 --connect-timeout 5 -o /dev/null -w "%{http_code}" https://api.anthropic.com
# 期待値: 404

# bridge インターフェース確認(コンテナ実行中のみ存在)
ifconfig bridge100
```

## トラブルシューティング

| 症状 | 原因 | 修正 |
|---------|-------|-----|
| `curl: (28) Connection timed out` | IP forwarding が無効 | `sudo sysctl -w net.inet.ip.forwarding=1` |
| HTTP は動くが HTTPS がタイムアウト | IPv6 DNS 解決 | `NODE_OPTIONS=--dns-result-order=ipv4first` を追加 |
| `Could not resolve host` | DNS が forward されていない | bridge100 が存在するか確認、pfctl の NAT ルールを検証 |
| 出力後にコンテナがハング | agent-runner で `process.exit(0)` が呼ばれていない | コンテナイメージを再ビルド |

## 仕組み

```
コンテナ VM (192.168.64.x)
    │
    ├── eth0 → ゲートウェイ 192.168.64.1
    │
bridge100 (192.168.64.1) ← ホスト bridge、コンテナ実行時に vmnet が作成
    │
    ├── IP forwarding (sysctl) が bridge100 → en0 にパケットをルーティング
    │
    ├── NAT (pfctl) が 192.168.64.0/24 → en0 の IP に masquerade
    │
en0 (WiFi/Ethernet) → インターネット
```

## 参考

- [apple/container#469](https://github.com/apple/container/issues/469) — macOS 26 でコンテナからネットワーク不可
- [apple/container#656](https://github.com/apple/container/issues/656) — ビルド中にインターネット URL にアクセスできない
