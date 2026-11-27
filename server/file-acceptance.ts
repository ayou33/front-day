import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileChange } from '../shared/contracts.ts'

const ignored = new Set(['.git', '.front-day', '.cache', 'node_modules', 'dist', 'coverage', '.next'])
const maxFiles = 4000
const maxBytes = 80_000_000

export async function workspaceContents(directory: string, abort: AbortSignal) {
  const signal = AbortSignal.any([abort, AbortSignal.timeout(4000)])
  const files = new Map<string, string>()
  let total = 0
  async function visit(path: string, depth: number): Promise<boolean> {
    if (depth > 30) return false
    signal.throwIfAborted()
    for (const entry of await readdir(join(directory, path), { withFileTypes: true })) {
      signal.throwIfAborted()
      if (ignored.has(entry.name) || /^\.front-day[.-]|^workbench\.sqlite(?:[.-]|$)/i.test(entry.name)) continue
      const relative = path ? `${path}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!await visit(relative, depth + 1)) return false
      } else if (entry.isFile()) {
        if (files.size >= maxFiles) return false
        const file = join(directory, relative)
        total += (await stat(file)).size
        if (total > maxBytes) return false
        const bytes = await readFile(file, { signal })
        files.set(relative, createHash('sha256').update(bytes).digest('hex'))
      }
    }
    return true
  }
  try { return await visit('', 0) ? files : undefined }
  catch { abort.throwIfAborted(); return undefined }
}

export function changedWorkspaceFiles(before: Map<string, string>, after: Map<string, string>) {
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap<FileChange>(path => {
    if (before.get(path) === after.get(path)) return []
    return [{ path, kind: !before.has(path) ? 'added' : after.has(path) ? 'modified' : 'deleted' }]
  })
}
