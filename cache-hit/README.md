# OpenCode 缓存命中率看板（独立 Web UI）

一个零依赖的本地网页，用来实时看 OpenCode 各会话的提示词缓存命中率。
只读 OpenCode 的 API，不写数据库、不改配置。

## 打开

```
http://127.0.0.1:8788
```

### Linux / macOS

```bash
cd cache-hit
chmod +x start.sh stop.sh   # 第一次
./start.sh                  # 后台启动，默认 8788
PORT=9000 ./start.sh        # 换端口
HOST=0.0.0.0 ./start.sh     # 局域网可访问（无鉴权，只给可信网络用）
./stop.sh
```

PID 和日志在本目录的 `.dashboard.pid` / `.dashboard.log`。

### Windows

```bat
cache-hit\start.bat
cache-hit\stop.bat
```

### 手动前台运行

```bash
cd cache-hit
node server.mjs --port 8788
```

### 开机自启（systemd 用户服务）

`opencode-cache-dashboard.service.example` 是示例单元；把里面的仓库路径改成你的实际路径，
复制到 `~/.config/systemd/user/` 后：

```bash
systemctl --user daemon-reload
systemctl --user enable --now opencode-cache-dashboard.service
journalctl --user -u opencode-cache-dashboard -f
```

## 显示什么

- **顶栏（三列，时钟永远居中）**：左＝状态点 + 「缓存命中率」+ 「跟随」方框；中＝每秒走时的本地时钟；
  右＝「历史」方框 + 「主题」下拉（跟随系统 / 浅色 / 深色）。两个开关都是**正方形打勾复选框**
  （不是胶囊按钮，省横向距离）；屏宽 ≤330px 时只留方框，靠 `title` 提示
- **默认只显示当前对话**：顶部会话条只放当前会话；勾「历史」展开最近 20 个会话（按更新时间倒序），
  取消勾选回到只看当前；每张卡片显示命中率、步数、缓存读取量和最后活跃时间
  （今天 `HH:MM` / `昨天` / `N 天前` / `MM-DD`）
- **自动跟随最新**（顶栏方框，默认开）：有新对话或某条会话有新请求时，自动跳到最新会话；
  手动点历史会话会自动关掉跟随，避免被立刻拉回（状态存 `localStorage`）
- **主题**：跟随系统 / 浅色 / 深色，选择存 `localStorage`，跟随系统时随系统切换。
  深色是**纯黑底**（`#000` + 极低亮度面板），浅色是**灰白底 + 纯白卡片 + 柔和描边**；
  浅色下命中率颜色自动换成同色系的深色，避免浅绿/浅黄在纯白上看不清
- 详情：大号命中率 + 档位文字（很好/较好/一般/偏低/差/很差）、最近一步、步数；
  6 张卡片 **3 列 2 行**：第一行 缓存读取 / 缓存写入 / 输出，第二行 节省输入 / 未命中输入 / 花费
- **配色档位**：0 红 → 50 红橙 → 70 橙 → 80 琥珀 → 90 黄 → **≥95 才变绿** → 100 深绿（分段线性插值，过渡自然）：
  ≥95 很好 / 90–95 较好 / 80–90 一般 / 70–80 偏低 / 50–70 差 / <50 很差
- 命中率趋势柱状图（最近 40 步，旧在左、新在右）和首尾时间，**不画横向刻度线**，
  只在底部放一行文字图例（`95+ 很好 · 70–95 一般 · <70 差 · <50 很差`）；
  逐步明细（最近 40 步，新的在上），每行顺序：**时间 | 进度 | 命中率 | token 长度**；
  进度条是 7px 底槽 + **50/70/95 三条满高竖向刻度**（不溢出、不悬空）
- **跨天**：明细里按天插入分隔行（`今天` / `昨天` / `08-12`，跨年给 `2025-12-31`），每行时间统一 `HH:MM:SS`；
  趋势图坐标轴标出首尾时间（同一天 `HH:MM`，跨天 `MM-DD HH:MM`），所以跨天也不会看不出是哪天
- **实时**：订阅 OpenCode 的 `/api/event`（SSE），会话有新的消息/状态变化就看板自动刷新；SSE 断了会退回 5 秒轮询
- **唯一布局**：窄版单列（桌面居中限宽 760px），会话是顶部横向滑动卡片条，卡片两列排布；不提供手动刷新按钮

口径：`命中率 = cache.read / (input + cache.read)`，数据来自每条 assistant 消息的 `tokens` / `cost`。

## 实现

- 零依赖，纯 Node（`server.mjs` + `index.html`），Node 18+ 即可
- 上游地址和密码自动读：
  - `~/.config/opencode/service.json` 的 `password` / `port`
  - `~/.local/state/opencode/service.json` 的 `url` / `password`
  - 可用环境变量覆盖：`OPENCODE_URL`、`OPENCODE_PASSWORD`、`PORT`、`HOST`
  - **推荐钉死**（`service.json` 可能是过期的随机端口，会让 `/api/overview` 报 500 `fetch failed`）：
    systemd 单元里写 `Environment=OPENCODE_URL=http://127.0.0.1:<OpenCode 端口>` + `Environment=OPENCODE_PASSWORD=<你的密码>`
- 接口：
  - `GET /` 页面
  - `GET /api/overview` 所有会话聚合（服务端算好再返回）
  - `GET /api/stream` 转发 OpenCode 事件（过滤 message./session.）
- 只读，不写任何 OpenCode 数据
- 时间一律按浏览器本地时区显示；`/api/overview` 返回的 `lastSteps` **已按时间正序**（旧 → 新），
  前端不再依赖上游顺序（OpenCode 的 `/api/session/<id>/message` 是倒序的）

## 备注

- 端口 8788 仅监听 127.0.0.1；想手机上看用 `--host 0.0.0.0`（注意别暴露到公网）
- 相同会话的消息按 `time.updated` 缓存，没有新消息不会重复拉取
- 如果 OpenCode 服务换了端口：没设 `OPENCODE_URL` 时会自己从 `service.json` 读新端口（重启看板即可）；
  设了 `OPENCODE_URL` 就以它为准，改端口要同步改单元
- **改完 `server.mjs` / `index.html` 后必须重启看板**（Node 无热重载）：
  Linux/macOS 用 `./stop.sh && ./start.sh`，Windows 用 `stop.bat` + `start.bat`，systemd 用 `systemctl --user restart opencode-cache-dashboard`
- OpenCode 新版消息的 `model` 是 `{ id, providerID, variant }`（旧版是 `{ providerID, modelID }`），两种都兼容
