import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

function collectTests(dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)

    if (entry.isDirectory()) {
      files.push(...collectTests(fullPath))
      continue
    }

    if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      files.push(fullPath)
    }
  }

  return files
}

const requested = process.argv.slice(2).filter((arg) => arg !== '--')
const root = process.cwd()

const testFiles = (
  requested.length > 0
    ? requested.map((file) => resolve(root, file))
    : collectTests(resolve(root, 'test'))
).filter((file) => statSync(file, { throwIfNoEntry: false })?.isFile())

if (testFiles.length === 0) {
  console.error('No test files found.')
  process.exit(1)
}

testFiles.sort((a, b) => a.localeCompare(b))

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', ...testFiles],
  { stdio: 'inherit' }
)

if (result.error) {
  throw result.error
}

process.exit(result.status ?? 1)
