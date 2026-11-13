# my-opencode-tools

给 [OpenCode](https://opencode.ai) 用的两个独立工具，一个插件、一个 Web 看板，互不依赖：

| 目录 | 类型 | 作用 |
| --- | --- | --- |
| [`vendor/opencode-live-compact/`](vendor/opencode-live-compact/) | **插件**（git submodule，MIT） | **当前部署**：上游 [Haoming9527/opencode-live-compact](https://github.com/Haoming9527/opencode-live-compact)。完成回合后就地缩短历史，原文归档、可 `live_compact_recall` 回读；全程不调模型 |
| [`live-compact/`](live-compact/) | **旧插件**（留档） | 我们自己写的 V2 `session.hook("context")` 移植（单调切分）。2026-11-13 起不再部署，保留作对照 |
| [`cache-hit/`](cache-hit/) | **Web 看板**（零依赖 Node） | 浏览器里实时查看各会话的提示词缓存命中率、每步 tokens 与花费 |

## vendor/opencode-live-compact —— 当前插件

[上游 OpenCode 移植](https://github.com/Haoming9527/opencode-live-compact)（DSH Live Compact 作者
在 README 里点名的实现，MIT）。submodule 钉在 `19a3faa`（npm `0.1.2`），构建产物不入库，
首次使用要装依赖并编译：

```bash
git submodule update --init --recursive
cd vendor/opencode-live-compact
npm ci && npm run build          # 需要 Node >= 22.18；npm test 需要 Node 24
```

然后在 `~/.config/opencode/opencode.json` 里用**绝对路径**注册：

```jsonc
{
  "plugins": [
    { "package": "/path/to/my-opencode-tools/vendor/opencode-live-compact" }
  ]
}
```

默认参数：20k 上下文起评、单刀至少 1k 源 tokens、每轮最多 3 刀、保护最近 3 个工具轮；
归档在 `~/.local/state/opencode-live-compact`（默认 256 MiB）。它会改写**已保存的**会话窗口，
但每个 cut 都先备份原文；备份失败/前缀变化/容量不足时保留全文、不写摘要。另提供
`live_compact_status` / `live_compact_recall` 两个工具。切换记录见
[`../agent-records/2026-11-13-switch-to-upstream-opencode-live-compact.md`](../agent-records/2026-11-13-switch-to-upstream-opencode-live-compact.md)。

## cache-hit —— Web 看板

```bash
cd cache-hit
node server.mjs --port 8788
# 打开 http://127.0.0.1:8788
```

零依赖，Node 18+ 即可；自动从 `~/.config/opencode/service.json` /
`~/.local/state/opencode/service.json` 读取 OpenCode 地址和密码，
也可用 `OPENCODE_URL` / `OPENCODE_PASSWORD` / `PORT` / `HOST` 覆盖。只读，不写 OpenCode 数据。
功能与接口见 [`cache-hit/README.md`](cache-hit/README.md)。

## 隐私

仓库里没有任何账号、密码、token、本机会话内容或真实用户路径：

- OpenCode 的 `service.json`（含密码）只在本机读取，已在 `.gitignore` 中排除；
- 看板/插件不随仓库分发任何会话数据或日志；
- README 里的示例路径都是占位符（`/path/to/...`、`~/.config/...`）。

## License

[MIT](LICENSE)。`live-compact` 是 [dsh-live-compact](https://github.com/MerkyorLynn/dsh-live-compact)
（MIT，Copyright © 2026 Merkyor）的 OpenCode 移植，保留原作者版权声明。
