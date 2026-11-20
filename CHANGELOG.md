# Changelog

## 0.3.2

- **修复侧边栏顶部一直显示"未绑定目录"**：webview 内联脚本里的正则表达式写在 TypeScript 模板字符串里，
  反斜杠被当作转义吞掉，浏览器拿到的脚本存在语法错误，因此整个脚本从未执行——
  目录绑定、会话数量、按钮全部没有生效（dsh 页面本身能显示，所以看起来像"只差一点点"）。
  内联脚本改用 `String.raw` 书写，浏览器收到的 JavaScript 与源码逐字一致。
- 新增 `probe/check-embedded-scripts.mjs`：对 webview 内联脚本与注入 SPA 的桥接脚本做语法检查，
  防止这类问题再次发生。
- 扩展日志同时写入 `globalStorage/aurumjin.dsh-vscode-extension/dsh-vscode.log`
  （VS Code 的输出面板文件只在窗口关闭时才落盘），便于排查边栏问题。
- webview 会向代理回报"脚本已运行"与脚本异常，代理把它们写进日志。
- **连接远程 `dsh` 实例**：新增设置项 `dsh.remoteUrl` 与 `dsh.remoteToken`。
  填了远程地址就只连那台主机（不再扫描本机、不再自动启动本地主机），
  对方打印的带 `?token=` 的完整 URL 可以直接填进 `dsh.remoteUrl`；
  修改设置后扩展自动重连。
- **找不到主机时给出安装提示**：本机没有 `dsh web` 也没有 `dsh` 安装时，
  边栏与通知里会提示 `npm install -g @deepseek-ai/dsh`、桌面应用官网
  <https://harness.deepseek.com>，以及可以用 `dsh.remoteUrl` 连接远程实例。
- 新增 `probe/remote-probe.mjs`：验证远程实例的候选列表、附着、不另起主机与提示文案。
- 发布工具链：`@vscode/vsce` 升到 `^4.1.1`——只有 4.x 才支持可信发布需要的 `--oidc` 参数，
  3.x 的工作流会在发布步骤报 `unknown option '--oidc'`。

## 0.3.1

- **编辑区右上角的鲸鱼角标**：像 Codex / Claude Code 一样，编辑器标题栏右上角新增一枚黑色鲸鱼角标，
  点击后在新标签页里打开 `dsh` 界面（命令 `DeepSeek Harness: 在编辑器标签页中打开`，`dsh.openInEditor`）。
  标签页图标同样是这枚鲸鱼；标签页与右侧边栏共享同一个 `dsh web` 主机。
- **换成 dsh 自己的黑色鲸鱼标志**：扩展图标、边栏视图图标、编辑器角标全部改用 DSH 的品牌图形
  （取自 DSH 前端的 `FISH_LOGO_PATH`，viewBox `0 0 23.16 17.04`），
  Marketplace 图标改用 DeepSeek Harness 桌面端的应用图标缩放到 128×128。
- 侧边栏与编辑器标签页共用同一份 webview 渲染代码（`src/webviewHtml.ts`）。

## 0.3.0

- 显示名由 `DeepSeek Harness` 改为 `DeepSeek Harness Sidebar Embed`（显示名同样要求全商店唯一，原名已被 `weinibuliu.dsh-vsc` 占用）。
- 扩展在 Marketplace 上的名字改为 `dsh-vscode-extension`（`dsh-vscode` 已被 `Jager.dsh-vscode` 占用，Marketplace 的扩展名全局唯一），商店 id 为 `Aurumjin.dsh-vscode-extension`；GitHub 仓库名仍是 `Aujin/dsh-vscode`。

- **自动发现正在运行的 `dsh web`**：扩展不再假定主机跑在 `3080`，而是依次尝试
  `dsh.webUrl` → 环境变量 `DSH_WEB_URL` → `dsh.autoStartPort` → 常用端口（3080/8080/3000），
  最后用 `netstat -ano -p TCP`（Windows）/ `ss`/`lsof`（其它平台）扫描本机监听端口，
  以首页文档中的 `__DSH_BOOT__` 标记确认主机。
  这样从开始菜单启动（没有 `DSH_WEB_URL`）、而 `dsh web` 跑在非默认端口时，
  边栏仍然附着到同一个主机进程，会话与浏览器里的 `dsh web` 保持同步；
  否则扩展会另起一个 `3080` 主机，导致两边会话分家。
- 自动启动时若配置的端口已被占用（`EADDRINUSE`），改为让系统分配一个空闲端口。
- 新增 `probe/discovery-probe.mjs`：验证候选地址列表、netstat 解析、端口识别与整条连接路径。

## 0.2.0

- **默认工作区**：绑定目录后会在边栏里打开该目录的会话，SPA 的"当前工作区"随之变成该目录，
  在 SPA 中新建的会话因此落在**当前目录**；同时移除主机自带的 `default-workspace` 注册
  （目录与会话日志保留，设置项 `dsh.retireDefaultWorkspace` 可关闭）。
- **未绑定时不创建任何工作区**：没有绑定目录时扩展不会调用 `workspace/create`，
  并在代理层拦下 SPA 的 `workspace/initializeDefault` 请求，主机保持空状态。
- 新增命令 `dsh.unbind`（解除目录绑定）与 `dsh.retireDefaultWorkspace`（手动清理主机默认工作区），
  边栏新增 ✕ 按钮；关闭绑定的文件夹会自动解除绑定。
- 通过 `workspace/follow` 流实时跟随主机的工作区注册表（新增 `src/mux.ts`、`src/workspaces.ts`），
  边栏状态栏显示当前工作区与主机默认工作区是否仍然存在。
- **修复从开始菜单启动 VS Code 时找不到 `dsh`**：不再依赖 PATH，改为搜索 fnm / nvm / npm 全局 /
  官方 node 安装包 / volta 的安装位置，并用该安装自带的 `node.exe` 运行
  `@deepseek-ai/dsh/lib/bin.js`（此前误用 `process.execPath`，在扩展宿主里它是 VS Code 自己）。
- 新增设置项 `dsh.executablePath`，可手动指定 `dsh` 可执行文件或入口脚本。
- 许可由 MIT 改为 **GPL-3.0-or-later**（可自由修改，但再分发必须同样开源）。
- 发布者 ID 设为 `Aurumjin`（已注册的 Marketplace 发布者），仓库地址改为 `https://github.com/Aujin/dsh-vscode`。
- 新增 `PUBLISHING.md`：发布到 VS Code Marketplace 的完整步骤。

## 0.1.0

- 在 VS Code 右侧（辅助）边栏中嵌入 `dsh web` 的真实前端 SPA。
- 附着到已在运行的 `dsh web`（自行签发浏览器 Cookie），会话与浏览器 GUI 实时同步；
  没有运行中的 host 时自动以 `dsh web --no-open` 启动一个。
- 扩展宿主内的 loopback 反向代理：注入 Cookie、改写 `Origin`/`Host`、转发 `/api/remote.mux` 的 WebSocket。
- 工作目录可复用 VS Code 当前打开的文件夹，或新建一个工作区文件夹。
- 命令：在右侧边栏打开、绑定当前文件夹、新建工作目录、打开会话、新建会话、重新连接、在浏览器中打开、显示日志。
