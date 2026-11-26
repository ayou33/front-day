import type { TaskType } from './context.ts'

export const themes = ['auto', 'light', 'dark'] as const
export type ThemeMode = (typeof themes)[number]

export const themeOptions: { value: ThemeMode; label: string; hint: string }[] = [
  { value: 'auto', label: '跟随系统', hint: '随系统外观切换' },
  { value: 'light', label: '浅色', hint: '始终使用浅色' },
  { value: 'dark', label: '深色', hint: '始终使用深色' },
]

export type Preferences = {
  dataDirectory: string
  defaultEngineId: string
  defaultTaskType: '' | TaskType
  followOutput: boolean
  recentTaskLimit: number
  theme: ThemeMode
}

export const defaultPreferences = {
  dataDirectory: '', defaultEngineId: '', defaultTaskType: '', followOutput: true, recentTaskLimit: 5, theme: 'auto',
} satisfies Preferences
