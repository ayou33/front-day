import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { z } from 'zod'
import { taskTypes } from '../shared/context.ts'
import type { TaskType } from '../shared/context.ts'
import { defaultPreferences, themes } from '../shared/preferences.ts'
import type { Preferences } from '../shared/preferences.ts'

export const preferencesSchema = z.object({
  dataDirectory: z.string().trim().max(1000).refine(path => isAbsolute(path) && !path.includes('\0'), '请选择本机数据目录'),
  defaultEngineId: z.string().max(100),
  defaultTaskType: z.enum(['', ...Object.keys(taskTypes) as TaskType[]]),
  followOutput: z.boolean(),
  recentTaskLimit: z.number().int().min(1).max(30),
  theme: z.enum(themes).default('auto'),
})

export function loadPreferences(filename: string, dataDirectory: string): Preferences {
  const defaults = { ...defaultPreferences, dataDirectory }
  try {
    const saved = JSON.parse(readFileSync(filename, 'utf8'))
    return preferencesSchema.parse({ ...defaults, ...saved })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaults
    throw error
  }
}

export function savePreferences(filename: string, preferences: Preferences) {
  mkdirSync(dirname(filename), { recursive: true })
  const temporary = `${filename}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(preferences, null, 2), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, filename)
  } finally { rmSync(temporary, { force: true }) }
}
