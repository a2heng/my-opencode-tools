# my-opencode-tools

给 [OpenCode](https://opencode.ai) 用的两个独立工具，一个插件、一个 Web 看板，互不依赖：

| 目录 | 类型 | 作用 |
| --- | --- | --- |
| [`live-compact/`](live-compact/) | **插件**（V2 `session.hook("context")`） | 每轮结束后就地压缩刚完成的 turn，切点之前的字节完全不动，保住 provider 的 prefix cache；全程不调模型 |
| [`cache-hit/`](cache-hit/) | **Web 看板**（零依赖 Node） | 浏览器里实时查看各会话的提示词缓存命中率、每步 tokens 与花费 |

## live-compact —— 插件

把 `live-compact/` 放到任意目录，然后在 `~/.config/opencode/opencode.json` 里用**绝对路径**注册：

```jsonc
{
  "plugins": [
    {
      "package": "/path/to/live-compact",
      "options": { "minContextTokens": 20000, "keepChars": 8000, "shadow": true }
    }
  ]
}
```

它只改**发出去的那一次请求**，不写会话历史；被切掉的原文写到 shadow 文件，随时可删。
原理、全部选项、测试与回滚见 [`live-compact/README.md`](live-compact/README.md)。

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
