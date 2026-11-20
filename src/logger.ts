import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as vscode from 'vscode'

/** Maximum size of the log file before it is rotated. */
const MAX_LOG_BYTES = 2 * 1024 * 1024

/**
 * Timestamped output channel used by every component of the extension.
 *
 * Besides the output channel the logger keeps a copy of every line in the
 * extension's global storage. VS Code only flushes an output channel to its
 * log file when the window is closed, so the file is the reliable place to
 * look when something goes wrong in a running window.
 */
export class Logger implements vscode.Disposable {
  private readonly channel: vscode.OutputChannel
  private readonly file?: string

  constructor(name: string, storageUri?: vscode.Uri) {
    this.channel = vscode.window.createOutputChannel(name)
    if (storageUri) {
      try {
        mkdirSync(storageUri.fsPath, { recursive: true })
        this.file = join(storageUri.fsPath, 'dsh-vscode.log')
      } catch {
        // Without a log file the output channel is still available.
      }
    }
  }

  info(message: string): void {
    this.write(`[${new Date().toISOString()}] ${message}`)
  }

  warn(message: string): void {
    this.write(`[${new Date().toISOString()}] WARN ${message}`)
  }

  error(message: string, error?: unknown): void {
    const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : error === undefined ? '' : String(error)
    this.write(`[${new Date().toISOString()}] ERROR ${message}${detail ? `\n${detail}` : ''}`)
  }

  show(): void {
    this.channel.show(true)
  }

  dispose(): void {
    this.channel.dispose()
  }

  private write(line: string): void {
    this.channel.appendLine(line)
    if (!this.file) return
    try {
      const stats = statSync(this.file)
      if (stats.size > MAX_LOG_BYTES) {
        // Keep the log small: the previous content is dropped once it grows
        // beyond the limit.
        writeFileSync(this.file, `--- log rotated ---\n`)
      }
    } catch {
      // The file does not exist yet.
    }
    try {
      appendFileSync(this.file, `${line}\n`)
    } catch {
      // Ignore write errors: logging must never break the extension.
    }
  }
}
