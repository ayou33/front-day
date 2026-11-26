import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import type { DirectoryBrowser, DirectoryEntry } from '../shared/contracts.ts'
import { HttpError } from './errors.ts'
import { projectDirectory } from './resources.ts'

async function isDirectory(path: string) {
  return (await stat(path).catch(() => undefined))?.isDirectory() ?? false
}

async function locations(workspace: string) {
  const roots = process.platform === 'win32'
    ? Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ', drive => `${drive}:\\`)
    : [parse(workspace).root]
  const candidates: DirectoryEntry[] = [
    { name: '项目所在位置', path: resolve(workspace, '..'), kind: 'directory' },
    { name: '用户目录', path: homedir(), kind: 'directory' },
    ...roots.map(path => ({ name: path, path, kind: 'directory' as const })),
  ]
  const available = await Promise.all(candidates.map(async entry => await isDirectory(entry.path) ? entry : null))
  return available.filter((entry): entry is DirectoryEntry => entry !== null)
}

export async function browseDirectories(workspace: string, requested: string | null, includeFiles = false): Promise<DirectoryBrowser> {
  if (requested === null) return { kind: 'locations', entries: await locations(workspace) }
  let selectedFile: string | undefined
  if (includeFiles && isAbsolute(requested) && (await stat(requested).catch(() => undefined))?.isFile()) {
    selectedFile = await realpath(requested).catch(() => undefined)
  }
  const path = await projectDirectory(selectedFile ? dirname(selectedFile) : requested)
  const entries = await readdir(path, { withFileTypes: true }).catch(() => {
    throw new HttpError(400, `无法浏览该目录 · ${path}`)
  })
  const children = await Promise.all(entries.map(async (entry): Promise<DirectoryEntry | null> => {
    const child = join(path, entry.name)
    const destination = entry.isSymbolicLink() ? await stat(child).catch(() => undefined) : entry
    if (destination?.isDirectory()) return { name: entry.name, path: child, kind: 'directory' }
    if (includeFiles && destination?.isFile()) return { name: entry.name, path: child, kind: 'file' }
    return null
  }))
  const parent = dirname(path)
  return { kind: 'directory', path, parent: parent === path ? null : parent, selectedFile,
    entries: children.filter((entry): entry is DirectoryEntry => entry !== null)
      .sort((a, b) => Number(a.kind === 'file') - Number(b.kind === 'file') || a.name.localeCompare(b.name, 'zh-CN', { numeric: true })) }
}
