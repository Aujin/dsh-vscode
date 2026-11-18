# 发布到 VS Code Marketplace

本插件采用 **GPL-3.0-or-later**：允许任何人使用与修改，但**再分发**时必须同样开源。
下面的流程既满足 Marketplace 的要求，也满足 copyleft 的要求。

> **2026 年 12 月 1 日起，Azure DevOps 的全局 Personal Access Token (PAT) 将被停用**，
> 微软官方推荐改用 **可信发布（Trusted Publishing）**：由 GitHub Actions 通过 OIDC
> 直接向 Marketplace 换取一次性凭据，仓库里不必保存任何长期密钥。
> 因此下面的 **方案 A（推荐）** 是首选，方案 B 只是过渡期的备选。

---

## 0. 前置条件

| 需要什么 | 说明 |
| --- | --- |
| Microsoft / Azure DevOps 账号 | 用来注册 Publisher 与发布扩展 |
| 一个 Publisher 名称 | 本项目用的是 `Aurumjin`（已注册）；**必须**与 `package.json` 里的 `publisher` 字段一致 |
| 一个 GitHub 仓库 | 仓库地址写在 `package.json` 的 `repository`；GPL 要求再分发时提供源码 |
| `vsce` 命令行 | `npm install -g @vscode/vsce`，或在项目里用 `npx @vscode/vsce` |

---

## 1. 本地打包（任何方案发布前都要做）

```bash
npm install --cache .npm-cache --ignore-scripts   # 沙箱内安装依赖时需要这两个参数
npm run typecheck
npm run build
npm run package            # 生成 dsh-vscode-<version>.vsix
```

`package.json` 的 `scripts.package` 已经是：

```json
"package": "vsce package --no-dependencies --allow-missing-repository"
```

> 扩展本身**零运行时依赖**（没有 `dependencies`），`--no-dependencies` 只是为了避开
> 离线/沙箱环境下 npm 枚举依赖时的失败。
>
> `vscode:prepublish` 已经配成 `npm run build`，所以 `vsce publish` 会自动重新编译 `dist/`。

---

## 2. 注册 Publisher（已完成）

1. 打开 <https://marketplace.visualstudio.com/manage> 并用 Microsoft 账号登录。
2. 在 **Publishers** 页点 **Create publisher**：
   - Azure DevOps 组织名（只用于绑定账号，不必公开）；
   - **Publisher name**（本项目为 `Aurumjin`）—— Marketplace 上的发布者标识，
     必须与 `package.json` 的 `"publisher"` 完全一致，大小写敏感。
3. 本项目的发布者页面：
   - 管理页 <https://marketplace.visualstudio.com/manage/publishers/aurumjin>
   - 公开页 <https://marketplace.visualstudio.com/publishers/aurumjin>

> 若 `vsce publish` 报 `Publisher 'Aurumjin' does not exist`，说明账号下注册的 id 是
> 全小写 `aurumjin`（管理页 URL 里就是小写），把 `package.json` 的 `publisher` 改成小写即可。

---

## 3. 方案 A（推荐）：GitHub Actions + 可信发布

### 3.1 建仓库并推送源码

本仓库已经带好了工作流文件 `.github/workflows/publish.yml`。

```bash
cd D:\Workspace\VSCplugin
git init
git add .
git commit -m "Initial release: DeepSeek Harness for VS Code"
git branch -M main
git remote add origin https://github.com/Aujin/dsh-vscode.git
git push -u origin main
```

仓库建议设为 **Public**（GPL 强调提供完整源码；Trusted Publishing 对私有仓库还有
"创建策略后 48 小时内必须跑一次工作流" 的额外要求）。

### 3.2 在 Marketplace 上创建可信发布策略

打开 <https://marketplace.visualstudio.com/manage/publishers/aurumjin> →
**Trusted Publishing** → **Create**，按下表填写（大小写敏感）：

| 表单字段 | 填写内容 |
| --- | --- |
| Policy name | `Release workflow` |
| Provider | `GitHub Actions` |
| Repository owner | `Aujin`（**GitHub** 登录名；注意它和 Marketplace 发布者 `Aurumjin` 不是同一个字符串） |
| Repository | `dsh-vscode`（不含 owner） |
| Workflow | `publish.yml`（`.github/workflows/` 下的文件名） |
| Environment | **留空**（本工作流不使用 GitHub environment） |

点 **Create**。

### 3.3 激活策略并发布

策略创建后，**必须至少成功跑一次**工作流，策略才会被激活
（私有仓库须在创建策略后 48 小时内完成；第一次成功换取令牌后永久生效）。

- 仓库页 → **Actions** → 左侧 **Publish** → 右侧 **Run workflow**；
- 或者推送一个 tag：`git tag v0.3.0 && git push origin v0.3.0`。

工作流会执行 `npm ci → typecheck → build → npx @vscode/vsce publish --oidc`，
凭据由 GitHub 的 OIDC 令牌换取，**仓库里不需要保存 PAT**。

### 3.4 之后的每次发布

```bash
# 1) 提升版本号（Marketplace 不允许覆盖同一版本）
npm version patch        # 0.3.0 -> 0.3.1
# 2) 提交并打 tag，tag 会触发工作流
git add package.json package-lock.json
git commit -m "Release 0.3.1"
git tag v0.3.1
git push origin main --tags
```

发布成功后扩展地址为：

```
https://marketplace.visualstudio.com/items?itemName=Aurumjin.dsh-vscode
```

---

## 4. 方案 B（备选）：本机用 PAT 发布

> 仅在暂时还没配置 GitHub Actions 时使用。Azure DevOps 的全局 PAT 将于
> 2026-12-01 停用，之后只能用方案 A。

1. 在 Azure DevOps 打开 <https://dev.azure.com/> → 右上角头像 →
   **Personal Access Tokens** → **+ New PAT**。
2. 作用域：**All accessible organizations**；权限勾选 **Manage**
   （Marketplace 发布所需；老文档写作 "Code → Manage"）。
3. 复制 token（只显示一次），然后：

```bash
vsce login Aurumjin                     # 交互输入 PAT
# 或
vsce login --pat <TOKEN>
vsce publish --pat <TOKEN>              # 正式版
vsce publish --pat <TOKEN> --pre-release # 预发布版
```

> 首次发布时 `vsce` 会问是否展示 README、许可协议等，同意即可。

---

## 5. 撤销 / 更新

```bash
vsce unpublish <publisher>.<name>      # 撤销某个版本
vsce show <publisher>.<name>            # 查看已发布版本
```

也可以在管理页 **More Actions → Unpublish**；删除版本则在 **Manage** 页删除，
但**最后一个版本不能删**，且删掉的版本号不能复用。

---

## 6. 开源与 copyleft 的落实

| 要求 | 本项目的做法 |
| --- | --- |
| 源码公开 | 仓库放在 GitHub（`Aujin/dsh-vscode`），`package.json` 的 `repository` / `homepage` / `bugs` 指向它 |
| 许可证可被看到 | `.vsix` 内包含 `LICENSE`（GPL-3.0 全文），`package.json` 的 `license` 为 `GPL-3.0-or-later` |
| 修改版也必须开源 | GPL-3.0 的传染性条款：任何基于本项目的再分发版本都必须以 GPL-3.0（或更高）发布并提供源码 |
| 声明 | README 里写明"可以自由修改，但再分发必须同样开源" |

注意事项：

* **不要**把 MIT/Apache 等宽松许可证的文件复制进本仓库，除非它们与 GPL-3.0 兼容
  （MIT/Apache-2.0/BSD 兼容，AGPL 兼容，CC-BY-4.0 不兼容）。
* 扩展**不打包**任何第三方代码：它是在运行时通过本地代理访问 `dsh` 自己的 SPA，
  因此不存在"把非 GPL 代码打进 `.vsix`"的问题。
* 如果以后要增加运行时依赖，记得检查其许可证兼容性。

---

## 7. 打包前的自检清单

- [ ] `npm run typecheck` / `npm run build` / `npm run package` 全部通过
- [ ] `.vsix` 里包含 `LICENSE`、`README.md`、`CHANGELOG.md`
- [ ] `package.json` 的 `version` 已经提升
- [ ] `publisher` 与 Marketplace 上的 Publisher name 一致
- [ ] `repository` 指向公开仓库，且仓库里是**完整源码**（GPL 要求）
- [ ] `icon` 是 PNG（Marketplace 不接受 SVG 作为扩展大图标；本项目用 `media/dsh.png`
      作为 128×128 的大图标，边栏图标仍是 `media/dsh.svg`）
- [ ] 在另一台机器上安装 `.vsix` 试跑：`code --install-extension dsh-vscode-<version>.vsix`
