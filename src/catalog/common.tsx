import { useState } from 'react'
import type { ReactNode } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import type { Catalog, ConfigKind, Engine, Entity, Project, Stage, TestCommand } from '../../shared/contracts.ts'
import { request, saveConfig } from '../api.ts'
import { Dialog, EditForm, ErrorLine, message } from '../ui.tsx'

export type Props = { catalog: Catalog; refresh: () => Promise<void> }
export const modes = { agent: 'Agent · 开发', plan: 'Plan · 规划', ask: 'Ask · 只读' }
export const blankProject: Project = { id: '', name: '', description: '', directory: '', testCommand: null }
export const blankEngine: Engine = { id: '', name: '', provider: 'cursor', executable: '', model: '', mode: 'agent' }
export const blankStage: Stage = { name: '', kind: 'agent', prompt: '', engineId: '', mode: '', resourceIds: [], allResources: true, advance: 'auto', testCommand: null, analyzeTest: false }

export function projectNameFromDirectory(directory: string) {
  const folder = directory.split(/[\\/]+/).filter(Boolean).at(-1) ?? ''
  const words = folder.replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2').match(/[\p{L}\p{N}]+/gu) ?? []
  return words.map(word => {
    const lower = word.toLowerCase()
    const [first] = lower
    return first.toUpperCase() + lower.slice(first.length)
  }).join('').slice(0, 150)
}

export function filePickerStart(directory: string, file: string) {
  if (!file) return directory
  if (/^(?:[a-z]:[\\/]|[\\/])/i.test(file)) return file
  return `${directory.replace(/[\\/]$/, '')}/${file}`
}

export function commandOrNull(command: TestCommand | null) {
  if (!command?.program.trim()) {
    if (command?.args.some(arg => arg.trim())) throw new Error('填写测试参数后需要提供测试程序')
    return null
  }
  return { ...command, args: command.args.filter(arg => arg.length > 0) }
}

export function Editor<K extends ConfigKind>({ kind, value, close, refresh, title, children, prepare, wide, onSaved }: {
  kind: K; value: Entity<K>; close: () => void; refresh: () => Promise<void>; title: string; children: ReactNode; prepare?: () => Entity<K>; wide?: boolean; onSaved?: (item: Entity<K>) => void
}) {
  return <Dialog title={title} onClose={close} wide={wide}>
    <EditForm onClose={close} onSubmit={async () => { const result = await saveConfig(kind, prepare?.() ?? value); await refresh(); onSaved?.(result); close() }}>{children}</EditForm>
  </Dialog>
}

export function ItemActions({ onEdit, onDelete, name, deletePrompt }: { onEdit: () => void; onDelete: () => Promise<void>; name: string; deletePrompt?: string }) {
  const [error, setError] = useState('')
  return <div className="item-actions"><ErrorLine text={error} />
    <button className="icon-button" type="button" aria-label={`编辑${name}`} title="编辑" onClick={onEdit}><Pencil size={15} /></button>
    <button className="icon-button danger-icon" type="button" aria-label={`删除${name}`} title="删除" onClick={() => {
      if (window.confirm(deletePrompt ?? `删除配置「${name}」？`)) void onDelete().catch(error => setError(message(error)))
    }}><Trash2 size={15} /></button>
  </div>
}

export async function remove(kind: ConfigKind, id: string, refresh: Props['refresh']) {
  await request(`/config/${kind}/${encodeURIComponent(id)}`, 'DELETE')
  await refresh()
}
