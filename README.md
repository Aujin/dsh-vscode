# DeepSeek Harness for VS Code

把 **DeepSeek Harness（`dsh`）** 嵌入 VS Code 的**右侧（辅助）边栏**，让 agent 直接在 VS Code 里工作：

- 边栏内嵌的是 `dsh web` 的**真实前端 SPA**（不是另写一套 UI）；
- 聊天记录、会话列表、模型、工作区树与 `dsh web` 浏览器界面**实时同步**；
- agent 的工作目录可以直接复用 **VS Code 当前打开的文件夹**，也可以**新建一个文件夹**。

---

## 它是怎么工作的

```
VS Code 右侧边栏 (webview)
   └─ <iframe>  http://127.0.0.1:<随机端口>      ← 扩展内置的反向代理
                    │  注入 dsh 浏览器 Cookie、改写 Origin/Host
                    ▼
                 dsh web  (http://127.0.0.1:3080)
                    ▲
      同一个 host 进程 ⇒ 同一个会话池 ⇒ 与浏览器 GUI 实时同步
```

三个关键点：

1. **同一个 host 进程**：扩展优先"附着"到已经在运行的 `dsh web`。它用 `$DSH_HOME/.credentials.yaml` 里的
   `client-connection/browser-session` 密钥自行签发一枚合法的浏览器 Cookie，因此不需要 `dsh web` 启动时
   打印的一次性 `?token=`。因为会话是 host 端状态，两端看到的是同一批会话。
   没有正在运行的 host 时，扩展才会自己拉起 `dsh web --no-open`。
2. **本地反向代理**：`dsh web` 的浏览器鉴权 Cookie 是 `SameSite=Strict`，而且会拒绝 `sec-fetch-site:
   cross-site` 和不匹配的 `Origin`，Webview 里直接 iframe `http://127.0.0.1:3080` 一定被拒。
   代理在扩展宿主进程里终结浏览器这一侧：它持有 Cookie、把 `Origin`/`Host` 改写成 host 的值、
   丢掉 `sec-fetch-*`，并把 `/api/remote.mux` 的 WebSocket 握手与帧**原样转发**。
3. **目录绑定**：绑定目录时先 `workspace/create`（幂等），再 `session/create { workspaceId }`。
   这样会话的工作目录就是那个文件夹，并且它同时出现在 `dsh web` 的浏览器界面里。
4. **谁才是"默认工作区"**：`dsh` 主机自己会在"文档"目录下建一个 `default-workspace`，
   它的路径是主机写死的，**不可能**变成你在 VS Code 里打开的文件夹。
   所以本扩展的做法是：
   - 绑定目录后，**在边栏里打开该目录的一个会话** —— SPA 的"当前工作区"随即变成这个目录，
     于是你在 SPA 里点"新建会话"时，新会话就落在**当前目录**（主机端 `cwd` 不可变，只能靠这一点对齐）；
   - 绑定成功时顺手把主机那个 `default-workspace` 的**注册**删掉（目录与会话日志都会保留），
     主机便不会再自动创建它；
   - **没有绑定任何目录时，扩展不会创建任何工作区**，并且代理会拦下 SPA 发出的
     `workspace/initializeDefault` 请求，让主机保持"空"状态。

---

## 安装与构建

**从商店安装（推荐）**：<https://marketplace.visualstudio.com/items?itemName=Aurumjin.dsh-vscode-extension>

```
扩展面板 → 搜索 "DeepSeek Harness Sidebar Embed" → 安装
```

也可以直接用命令行：

```bash
code --install-extension Aurumjin.dsh-vscode-extension
```

本地构建：

```bash
npm install          # 只装依赖；构建用 TypeScript 编译器 API，不依赖 esbuild
npm run typecheck    # 类型检查
npm run build        # 编译到 dist/
npm run package      # 打包成 .vsix（需要 @vscode/vsce 4.x）
```

安装 `.vsix`：

```bash
code --install-extension dsh-vscode-extension-0.3.3.vsix
```

开发调试：

```bash
code --extensionDevelopmentPath=D:\Workspace\VSCplugin
```

> 需要 VS Code **1.146+**（`contributes.viewsContainers.secondarySidebar` 从该版本开始提供）。
> 需要本机已安装 `dsh`（`@deepseek-ai/dsh`），或至少有一个正在运行的 `dsh web`。

### 从开始菜单启动也能找到 `dsh`

Windows 的开始菜单启动的 VS Code 只继承**系统 PATH**，看不到 `fnm`/`nvm` 装出来的 `dsh`。
扩展因此不依赖 PATH，而是自己搜索常见安装位置：

| 安装方式 | 搜索位置 |
| --- | --- |
| fnm | `%FNM_DIR%`、`%APPDATA%\fnm`、`%LOCALAPPDATA%\fnm`、`~\.fnm` 下的 `node-versions\*\installation` |
| nvm / nvm-windows | `%NVM_HOME%\*`、`~\.nvm\versions\node\*` |
| npm 全局 | `%APPDATA%\npm`（Windows）、`/usr/local/lib` 等 |
| 官方安装包 | `%ProgramFiles%\nodejs` |
| volta | `~\.volta`、`%LOCALAPPDATA%\Volta` 下的 `tools\image\node\*` |

命中后，扩展用**该安装目录自带的 `node.exe`** 去跑 `@deepseek-ai/dsh/lib/bin.js`
（扩展宿主里的 `process.execPath` 是 VS Code 自己，不能拿来当 node 用）。
如果装在别处，用设置项 `dsh.executablePath` 直接指定 `dsh.cmd` 或 `bin.js` 即可。

### 自动找到正在运行的 `dsh web`

扩展**优先附着到已经在跑的 `dsh web`**，因为只有共用同一个主机进程，边栏和浏览器里的
`dsh web` 才会看到同一批会话。查找顺序：

1. 设置项 `dsh.webUrl`（留空则跳过）；
2. 环境变量 `DSH_WEB_URL`（从终端启动 VS Code 时会有）；
3. 设置项 `dsh.autoStartPort`；
4. 常用端口 `3080` / `8080` / `3000`；
5. **扫描本机所有监听端口**（Windows 用 `netstat -ano -p TCP`，其它平台用 `ss`/`lsof`），
   逐个请求首页，只有返回的文档里带 `__DSH_BOOT__` 启动信息的才算 `dsh web`。

第 5 步保证了这种场景也能对上：从开始菜单启动（没有 `DSH_WEB_URL`）、而你的 `dsh web`
跑在 `8080` 之类的非默认端口时，扩展依然会附着上去，而不是另外启动一个 `3080` 的主机
——后者会让边栏和浏览器里的会话分家。

只有所有地址都没找到主机时，扩展才会用 `dsh web --no-open` 自己启动一个；
如果配置的端口已被占用，会自动改为让系统分配一个空闲端口。

如果本机既没有正在运行的 `dsh web`，也没有安装 `dsh`，边栏会直接给出提示：

```
请先安装并启动 DeepSeek Harness：
· npm install -g @deepseek-ai/dsh，然后运行 dsh web
· 或安装桌面应用：https://harness.deepseek.com
· 也可以在设置里填写 dsh.remoteUrl 连接远程实例
```

### 连接远程的 `dsh` 实例

把 `dsh.remoteUrl` 填成远程主机的地址（例如 `http://192.168.1.20:3080`），
扩展就只连这台远程主机：不再扫描本机端口，也不再在本机另起一个 `dsh web`，
边栏里的会话就是远程主机上的会话。

远程主机的会话密钥和本机不同，所以要用对方的**启动令牌**换一张会话 cookie：

- 把对方启动 `dsh web` 时打印的完整 URL（带 `?token=…`）填进 `dsh.remoteUrl` 即可；
- 或者地址填 `dsh.remoteUrl`，令牌单独填进 `dsh.remoteToken`。

另外，远程主机需要信任这个来源，否则它的信任围栏会拒绝请求：

```bash
dsh web --host 0.0.0.0 --trusted-host 192.168.1.20:3080
```

修改这些设置项后扩展会自动重连。

---

## 使用

打开 **右侧边栏**（`Ctrl+Alt+B` / 命令 `View: Toggle Secondary Side Bar Visibility`），
在 "DeepSeek Harness" 容器里就能看到完整的 `dsh` 界面。

边栏顶部的工具条：

| 按钮 | 作用 |
| --- | --- |
| ＋ | 在当前绑定的工作区里新建会话 |
| 会话 | 从主机上的全部会话（含 `dsh web` 里创建的）里挑一个打开 |
| 目录 | 绑定当前 VS Code 打开的文件夹（没有打开文件夹时弹出目录选择器） |
| ＋目录 | 新建一个工作区文件夹并绑定（同名目录会自动加 `-2`、`-3` 后缀） |
| ✕ | 解除目录绑定（此后不会再创建任何 dsh 工作区） |
| ⟳ | 重新连接 `dsh web` |
| ↗ | 在浏览器里打开同一个 `dsh web` |

命令面板里还有 `DeepSeek Harness: 在右侧边栏打开` 等命令，其中包括
`DeepSeek Harness: 移除 dsh 主机的默认工作区注册`（手动清理主机自带的 `default-workspace`）。

### 编辑器右上角的鲸鱼角标

和 Codex、Claude Code 一样，编辑区标题栏右上角有一枚 **黑色鲸鱼角标**
（就是 `dsh` 自己的品牌图形，直接取自 DSH 前端的 `FISH_LOGO_PATH`）：

- 点击角标会在编辑器里 **新开一个标签页**，里面就是同一套 `dsh` 界面；
- 再次点击会聚焦已打开的那个标签页；
- 标签页标题图标同样是这枚鲸鱼；
- 命令：`DeepSeek Harness: 在编辑器标签页中打开`（`dsh.openInEditor`）。

边栏与标签页共享同一个 `dsh web` 主机，会话状态完全一致。

### 快捷键建议

`keybindings.json`：

```json
{
  "key": "ctrl+alt+d",
  "command": "dsh.showPanel",
  "when": "terminalFocus"
}
```

---

## 日志

命令面板里的 **DeepSeek Harness: 显示日志** 会打开输出面板。同一份日志还会写入文件：

```
%APPDATA%\Code\User\globalStorage\aurumjin.dsh-vscode-extension\dsh-vscode.log
```

（VS Code 的输出面板文件要等窗口关闭才落盘，所以排查问题时直接看这个文件更快。）
日志里会记录：附着的 `dsh web` 地址、工作区绑定、会话数、webview 脚本是否正常运行。

---

## 设置项

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `dsh.webUrl` | `""` | `dsh web` 地址。留空时依次尝试 `DSH_WEB_URL`、`dsh.autoStartPort`、常用端口，最后扫描本机监听端口自动发现正在运行的 `dsh web` |
| `dsh.remoteUrl` | `""` | 远程 `dsh web` 的地址，例如 `http://192.168.1.20:3080`。填了就只连这台远程主机（不再扫描本机，也不再自动启动） |
| `dsh.remoteToken` | `""` | 远程实例的启动令牌（对方打印的 URL 里的 `token=`）。远程主机与本机的会话密钥不同，需要它换一张浏览器会话 cookie |
| `dsh.autoStart` | `true` | 没有正在运行的 `dsh web` 时自动启动一个 |
| `dsh.autoStartPort` | `3080` | 自动启动使用的端口（`0` = 由系统分配） |
| `dsh.workspaceMode` | `currentFolder` | `currentFolder` 复用当前文件夹 / `newFolder` 新建文件夹 / `none` 不自动绑定 |
| `dsh.newFolderParent` | `""` | 新建文件夹的父目录，留空用当前文件夹的上级目录 |
| `dsh.newFolderName` | `dsh-workspace` | 新建文件夹的默认名称 |
| `dsh.reuseExistingSession` | `true` | 绑定目录时复用该目录已有的会话 |
| `dsh.pollIntervalMs` | `3000` | 会话列表轮询间隔，用于同步边栏状态 |
| `dsh.executablePath` | `""` | 手动指定 `dsh` 的可执行文件或 `bin.js`；留空时自动搜索 fnm/nvm/npm/volta 等安装位置 |
| `dsh.retireDefaultWorkspace` | `true` | 绑定目录后删除主机 `default-workspace` 的注册（目录与会话日志保留） |

---

## 已知的边界

- **客户端选中状态不同步**：SPA 的"当前选中哪个会话"保存在浏览器 `localStorage` 里，
  边栏（不同源）和浏览器 GUI 不共享；但服务端状态（会话、消息、工作区）完全共享。
  边栏通过桥接脚本点击会话行来打开会话。
- **会话的工作目录在创建后不能改**：host 没有提供修改 `cwd` 的 RPC（只有 host 侧的
  `ctx.workingDirectory.set` 与 `working_directory` 工具）。要换目录请新建会话。
- **扩展只能连到 loopback**：host 的信任边界要求 loopback 地址或显式 `--trusted-host`。

---

## 目录结构

```
src/
  extension.ts    激活、命令、设置、后台自动绑定
  controller.ts   连接状态、轮询、目录绑定、默认工作区退役
  host.ts         附着/拉起 dsh web，签发 Cookie，发现 dsh 安装位置
  credentials.ts  读取 .credentials.yaml，签发浏览器 Cookie
  rpc.ts          /api/<method> 单次 RPC 客户端
  mux.ts          node:net 上手写的 WebSocket 客户端（访问远端流）
  workspaces.ts   通过 workspace/follow 跟随主机的工作区注册表
  binding.ts      workspace/create、session/create、session/list、workspace/delete
  proxy.ts        面向 webview 的 HTTP + WebSocket 反向代理
  bridge.ts       注入 SPA 的桥接脚本（打开会话、上报当前会话）
  webviewView.ts  右侧边栏 webview（头部 + iframe + CSP）
probe/            协议级验证脚本（不含 VS Code 依赖）
```

---

## 许可与再分发

本项目以 **GPL-3.0-or-later** 发布（见 [LICENSE](LICENSE)）。

- 你可以自由使用、修改、闭源集成到你自己的产品里；
- 但凡你**再分发**本项目的代码（修改版或原版），都必须同样以 GPL-3.0（或更高版本）开放其源码，
  并保留本许可与版权声明。

发布到 VS Code Marketplace 前请确认你发布的 `.vsix` 里包含 `LICENSE`，
且 `package.json` 中的 `license` 字段为 `GPL-3.0-or-later`。

发布步骤见 [PUBLISHING.md](PUBLISHING.md)。
