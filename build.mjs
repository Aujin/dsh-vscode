/**
 * Build script: compiles `src/**` to CommonJS in `dist/` with the TypeScript
 * compiler API. No bundler and no child process is required, which keeps the
 * build working in restricted environments.
 */
import ts from 'typescript'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const configPath = path.join(root, 'tsconfig.json')
const noEmit = process.argv.includes('--noEmit')

const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
if (configFile.error) {
  console.error(ts.formatDiagnosticsWithColorAndContext([configFile.error], formatHost()))
  process.exit(1)
}

const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root)
const options = {
  ...parsed.options,
  outDir: path.join(root, 'dist'),
  rootDir: path.join(root, 'src'),
  noEmit,
}

const program = ts.createProgram(parsed.fileNames, options)
const emitResult = program.emit()
const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics)

if (diagnostics.length > 0) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost()))
  if (diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
    process.exit(1)
  }
}

console.log(noEmit ? 'typecheck ok' : 'build ok -> dist/')

function formatHost() {
  return {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => root,
    getNewLine: () => '\n',
  }
}
