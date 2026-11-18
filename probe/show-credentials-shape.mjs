import fs from 'node:fs'
import os from 'node:os'

const file = `${os.homedir()}/.dsh/.credentials.yaml`
const text = fs.readFileSync(file, 'utf8')
text.split(/\r?\n/).forEach((line, index) => {
  const redacted = line.replace(/([:=]\s*)([^\s'"]+)/g, (_match, sep, value) => `${sep}<${value.length}>`)
  console.log(`${index + 1}: ${JSON.stringify(redacted)}`)
})
