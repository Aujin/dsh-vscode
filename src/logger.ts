import * as vscode from 'vscode'

/** Timestamped output channel used by every component of the extension. */
export class Logger implements vscode.Disposable {
  private readonly channel: vscode.OutputChannel

  constructor(name: string) {
    this.channel = vscode.window.createOutputChannel(name)
  }

  info(message: string): void {
    this.channel.appendLine(`[${new Date().toISOString()}] ${message}`)
  }

  warn(message: string): void {
    this.channel.appendLine(`[${new Date().toISOString()}] WARN ${message}`)
  }

  error(message: string, error?: unknown): void {
    const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : error === undefined ? '' : String(error)
    this.channel.appendLine(`[${new Date().toISOString()}] ERROR ${message}${detail ? `\n${detail}` : ''}`)
  }

  show(): void {
    this.channel.show(true)
  }

  dispose(): void {
    this.channel.dispose()
  }
}
