import Module from 'node:module'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// --- minimal vscode API stub so the compiled extension can be loaded outside VS Code
const log = []
const channel = {
  appendLine: (line) => {
    log.push(line)
    console.log('[channel]', line)
  },
  show: () => {},
  dispose: () => {},
}

const registeredViews = []
const registeredCommands = []

const vscode = {
  window: {
    createOutputChannel: () => channel,
    registerWebviewViewProvider: (id, provider, opts) => {
      registeredViews.push({ id, provider, opts })
      console.log('[vscode] registerWebviewViewProvider', id)
      return { dispose: () => {} }
    },
    createWebviewPanel: () => ({ webview: { html: '', cspSource: 'vscode-resource:', postMessage: () => {} }, onDidDispose: () => {}, dispose: () => {} }),
    showErrorMessage: (m) => console.log('[vscode] showErrorMessage', m),
    showInformationMessage: (m) => console.log('[vscode] showInformationMessage', m),
    showInputBox: async () => undefined,
    showQuickPick: async () => undefined,
    showOpenDialog: async () => undefined,
    setStatusBarMessage: () => {},
  },
  commands: {
    registerCommand: (id, fn) => {
      registeredCommands.push(id)
      return { dispose: () => {} }
    },
    executeCommand: async () => {},
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: 'D:\\Workspace\\VSCplugin' } }],
    getConfiguration: () => ({ get: (key, fallback) => fallback }),
    onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
  },
  env: { openExternal: async () => true },
  Uri: {
    joinPath: (base, ...parts) => ({ fsPath: [base.fsPath, ...parts].join('/') }),
    parse: (s) => ({ toString: () => s }),
  },
  ViewColumn: { Active: -1 },
  EventEmitter: class extends EventEmitter {
    constructor() {
      super()
      this.event = () => ({ dispose: () => {} })
    }
  },
}

const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode'
  return originalResolve.call(this, request, ...rest)
}
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscode }

const { activate } = require('../dist/extension.js')
console.log('[probe] activating extension…')
const context = { subscriptions: [], extensionUri: { fsPath: 'D:\\Workspace\\VSCplugin' } }

const timer = setTimeout(() => {
  console.log('\n[probe] TIMEOUT: activate() did not resolve within 20s')
  console.log('[probe] registered views:', registeredViews.map((v) => v.id))
  console.log('[probe] channel lines:', log.length)
  process.exit(1)
}, 20000)

activate(context)
  .then(() => {
    clearTimeout(timer)
    console.log('\n[probe] activate() resolved')
    console.log('[probe] registered views:', registeredViews.map((v) => v.id))
    console.log('[probe] commands:', registeredCommands.length)
    process.exit(0)
  })
  .catch((error) => {
    clearTimeout(timer)
    console.log('\n[probe] activate() rejected:', error?.message)
    console.log(error?.stack)
    process.exit(2)
  })
