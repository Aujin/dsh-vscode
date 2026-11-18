import { dirname } from 'node:path'
import { homedir } from 'node:os'
import * as vscode from 'vscode'
import { Logger } from './logger'
import { DshHost, type DshHostOptions } from './host'
import { DshRpc } from './rpc'
import { WorkspaceBinding } from './binding'
import { WorkspaceDirectory } from './workspaces'
import { DshProxy } from './proxy'
import { DshController } from './controller'
import { DshViewProvider } from './webviewView'

let host: DshHost | undefined

function settings(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('dsh')
}

function hostOptions(): DshHostOptions {
  return {
    webUrl: settings().get<string>('webUrl', ''),
    autoStart: settings().get<boolean>('autoStart', true),
    autoStartPort: settings().get<number>('autoStartPort', 3080),
    executablePath: settings().get<string>('executablePath', '').trim() || undefined,
  }
}

/** Folder the sidebar binds to on activation. */
async function resolveAutoFolder(controller: DshController): Promise<string | undefined> {
  const mode = settings().get<string>('workspaceMode', 'currentFolder')
  if (mode === 'none') return undefined

  const folders = vscode.workspace.workspaceFolders ?? []
  const current = folders[0]?.uri.fsPath
  if (mode === 'currentFolder') {
    return current
  }

  const name = settings().get<string>('newFolderName', 'dsh-workspace') || 'dsh-workspace'
  const configuredParent = settings().get<string>('newFolderParent', '').trim()
  const parent = configuredParent || (current ? dirname(current) : homedir())
  const target = await controller.createWorkspaceFolder(parent, name)
  controller.logger.info(`created workspace folder ${target}`)
  return target
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = new Logger('DeepSeek Harness')
  context.subscriptions.push(logger)

  const dshHost = new DshHost(logger, hostOptions)
  host = dshHost
  const rpc = new DshRpc(() => dshHost.current, logger)
  const binding = new WorkspaceBinding(rpc, logger)
  const directory = new WorkspaceDirectory(() => dshHost.current, logger)
  context.subscriptions.push(directory)

  // The proxy blocks the host's own default workspace while nothing is bound,
  // so an unbound sidebar never creates a workspace below the documents folder.
  let boundPath: string | undefined
  const proxy = await DshProxy.start(
    () => dshHost.current,
    logger,
    () => boundPath === undefined,
  )
  context.subscriptions.push({ dispose: () => void proxy.dispose() })

  const controller = new DshController(dshHost, binding, directory, logger, () => proxy.url)
  context.subscriptions.push(controller)
  controller.onDidChange((state) => {
    boundPath = state.boundPath
  })

  const provider = new DshViewProvider(controller, logger)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DshViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('dsh.showPanel', async () => {
      try {
        await vscode.commands.executeCommand('workbench.action.openView', 'dsh.dsh.chat')
      } catch (error) {
        logger.warn(`openView failed (${(error as Error).message}), toggling the auxiliary bar`)
        await vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar')
      }
    }),

    vscode.commands.registerCommand('dsh.bindCurrentFolder', async () => {
      const folders = vscode.workspace.workspaceFolders ?? []
      let target = folders[0]?.uri.fsPath
      if (!target) {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: '绑定此目录',
        })
        if (!picked?.[0]) return
        target = picked[0].fsPath
      }
      try {
        const result = await controller.bindFolder(target)
        if (result.sessionId) provider.openSession(result.sessionId)
        void vscode.window.setStatusBarMessage(`DeepSeek Harness 已绑定 ${target}`, 4000)
      } catch (error) {
        logger.error('binding failed', error)
        void vscode.window.showErrorMessage(`绑定目录失败：${(error as Error).message}`)
      }
    }),

    vscode.commands.registerCommand('dsh.createWorkspaceFolder', async () => {
      const name = await vscode.window.showInputBox({
        prompt: '新建工作区文件夹名称',
        value: settings().get<string>('newFolderName', 'dsh-workspace'),
      })
      if (!name) return
      const folders = vscode.workspace.workspaceFolders ?? []
      const configuredParent = settings().get<string>('newFolderParent', '').trim()
      const parent = configuredParent || (folders[0] ? dirname(folders[0].uri.fsPath) : homedir())
      try {
        const target = await controller.createWorkspaceFolder(parent, name, true)
        const result = await controller.bindFolder(target)
        if (result.sessionId) provider.openSession(result.sessionId)
        void vscode.window.setStatusBarMessage(`DeepSeek Harness 已绑定 ${target}`, 4000)
      } catch (error) {
        logger.error('workspace folder creation failed', error)
        void vscode.window.showErrorMessage(`新建工作目录失败：${(error as Error).message}`)
      }
    }),

    vscode.commands.registerCommand('dsh.pickSession', async () => {
      await controller.refreshSessions()
      const sessions = controller.current.sessions
      if (sessions.length === 0) {
        void vscode.window.showInformationMessage('当前 dsh 主机没有会话。')
        return
      }
      const items = sessions.map((session) => ({
        label: WorkspaceBinding.titleOf(session),
        description: session.cwd ?? '',
        detail: `${session.sessionId}${session.running ? '  · 运行中' : ''}${session.blank ? '  · 空白' : ''}`,
        sessionId: session.sessionId,
      }))
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: '选择要打开的会话',
        matchOnDescription: true,
        matchOnDetail: true,
      })
      if (picked) provider.openSession(picked.sessionId)
    }),

    vscode.commands.registerCommand('dsh.newSession', async () => {
      try {
        const sessionId = await controller.newSession()
        if (sessionId) provider.openSession(sessionId)
      } catch (error) {
        logger.error('session creation failed', error)
        void vscode.window.showErrorMessage(`新建会话失败：${(error as Error).message}`)
      }
    }),

    vscode.commands.registerCommand('dsh.reconnect', async () => {
      await controller.reconnect()
      provider.reload()
    }),

    vscode.commands.registerCommand('dsh.unbind', () => {
      controller.unbind()
      boundPath = undefined
      void vscode.window.setStatusBarMessage('DeepSeek Harness 已解除目录绑定', 4000)
    }),

    vscode.commands.registerCommand('dsh.retireDefaultWorkspace', async () => {
      try {
        const removed = await controller.retireHostDefaultWorkspace()
        void vscode.window.setStatusBarMessage(
          removed
            ? '已移除 dsh 主机的默认工作区注册（目录与会话日志保留）'
            : '没有需要移除的默认工作区',
          4000,
        )
      } catch (error) {
        logger.error('retiring the default workspace failed', error)
        void vscode.window.showErrorMessage(`移除默认工作区失败：${(error as Error).message}`)
      }
    }),

    vscode.commands.registerCommand('dsh.openInBrowser', async () => {
      const url = controller.current.proxyUrl ?? proxy.url
      await vscode.env.openExternal(vscode.Uri.parse(url))
    }),

    vscode.commands.registerCommand('dsh.showLogs', () => logger.show()),
  )

  // Keep the binding in sync with the folders that are open in VS Code: when
  // the bound folder is closed the agent is unbound again, and nothing is
  // created on the host until the user picks a folder again.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      const bound = controller.current.boundPath
      if (!bound) return
      const stillOpen = (vscode.workspace.workspaceFolders ?? []).some(
        (folder) => folder.uri.fsPath.toLowerCase() === bound.toLowerCase(),
      )
      if (!stillOpen) {
        logger.info(`the bound folder ${bound} was closed, unbinding`)
        controller.unbind()
        boundPath = undefined
        void vscode.window.setStatusBarMessage('DeepSeek Harness 已解除目录绑定', 4000)
      }
      void event
    }),
  )

  // Connect and bind in the background so activation stays fast.
  void (async () => {
    await controller.connect()
    try {
      const folder = await resolveAutoFolder(controller)
      if (folder) {
        const result = await controller.bindFolder(folder)
        boundPath = result.workspaceId ? controller.current.boundPath : undefined
        if (result.sessionId) provider.openSession(result.sessionId)
      }
    } catch (error) {
      logger.error('automatic workspace binding failed', error)
    }
  })()
}

export async function deactivate(): Promise<void> {
  const current = host
  host = undefined
  await current?.dispose()
}
