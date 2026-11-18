# Changelog

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
