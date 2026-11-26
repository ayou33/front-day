import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Check as CheckIcon, CheckCircle2, FolderOpen, Monitor, Moon, Sun } from 'lucide-react'
import { taskTypeDefinition } from '../shared/context.ts'
import type { Engine, EngineAvailability } from '../shared/contracts.ts'
import { defaultPreferences, themeOptions } from '../shared/preferences.ts'
import type { Preferences } from '../shared/preferences.ts'
import { request } from './api.ts'
import { DirectoryPicker } from './DirectoryPicker.tsx'
import { applyTheme, watchSystemTheme } from './theme.ts'
import { Check, EngineOptions, ErrorLine, Field, message, SectionHeading, TaskTypeOptions } from './ui.tsx'

const themeIcons = { auto: Monitor, light: Sun, dark: Moon }

export function PreferencesView({ preferences, engines, availability, onSave }: {
  preferences: Preferences; engines: Engine[]; availability?: EngineAvailability[]; onSave: (preferences: Preferences) => void
}) {
  const [draft, setDraft] = useState<Preferences>(() => ({
    ...preferences, theme: preferences.theme ?? 'auto',
    defaultEngineId: engines.some(engine => engine.id === preferences.defaultEngineId) ? preferences.defaultEngineId : '',
  }))
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const changingDirectory = draft.dataDirectory !== preferences.dataDirectory
  // An older server strips `theme` from the payload; say so instead of silently staying light.
  const themeStale = !preferences.theme

  // Preview a new theme immediately, but fall back to the saved one when leaving without saving.
  useEffect(() => {
    applyTheme(draft.theme)
    if (draft.theme !== 'auto') return
    return watchSystemTheme(() => applyTheme('auto'))
  }, [draft.theme])
  useEffect(() => () => {
    applyTheme(preferences.theme)
  }, [preferences.theme])

  function edit(values: Partial<Preferences>) {
    setDraft(current => ({ ...current, ...values }))
    setSaved(false)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    setSaved(false)
    try {
      const result = await request<Preferences>('/preferences', 'PUT', draft)
      if (!result.theme) throw new Error('当前 Front Day 服务版本较旧，请重启服务后再保存主题。')
      setDraft(result)
      onSave(result)
      setSaved(true)
    } catch (error) { setError(message(error)) }
    finally { setBusy(false) }
  }

  return <>
    <SectionHeading title="配置" description="设置数据保存位置、外观和工作台的默认行为。" />
    <form className="stack" onSubmit={submit}>
      <section className="panel"><div className="panel-header"><div><h2>数据存储</h2><p>任务记录、日志、配置和本机账户保存在这里。</p></div></div>
        <div className="preference-fields">
          <div className="field"><label className="directory-label" htmlFor="data-directory">数据目录</label>
            <div className="directory-address"><input id="data-directory" className="mono" readOnly value={draft.dataDirectory} />
              <button type="button" className="button" disabled={busy} onClick={() => setPicking(true)}><FolderOpen size={16} />选择目录</button></div>
          </div>
          {changingDirectory && <p className="caption">保存时会复制现有数据并启用新目录。旧目录保留备份。</p>}
        </div>
      </section>
      <section className="panel"><div className="panel-header"><div><h2>外观</h2><p>选择工作台主题。跟随系统时会随操作系统自动切换，保存后保留。</p></div></div>
        <div className="preference-fields">
          <div className="theme-options" role="radiogroup" aria-label="主题">
            {themeOptions.map(({ value, label, hint }) => {
              const Icon = themeIcons[value]
              const active = draft.theme === value
              return <button type="button" key={value} role="radio" aria-checked={active} disabled={busy}
                className={`theme-option${active ? ' active' : ''}`} onClick={() => edit({ theme: value })}>
                <Icon className="theme-icon" size={17} aria-hidden="true" />
                <span className="theme-copy"><strong>{label}</strong><small>{hint}</small></span>
                {active && <CheckIcon className="theme-check" size={15} aria-hidden="true" />}
              </button>
            })}
          </div>
          {themeStale && <p className="caption">当前 Front Day 服务版本较旧，未返回主题设置。请重启服务后再保存主题。</p>}
        </div>
      </section>
      <section className="panel"><div className="panel-header"><h2>默认偏好</h2></div>
        <div className="preference-fields">
          <div className="form-columns">
            <Field label="默认引擎"><select value={draft.defaultEngineId} disabled={busy} onChange={event => edit({ defaultEngineId: event.target.value })}>
              <option value="">自动选择本机可用引擎</option><EngineOptions engines={engines} availability={availability} />
            </select></Field>
            <Field label="默认任务类型" detail={taskTypeDefinition(draft.defaultTaskType)?.hint}><select value={draft.defaultTaskType} disabled={busy} onChange={event => edit({ defaultTaskType: event.target.value as Preferences['defaultTaskType'] })}>
              <option value="">由 Agent 根据目标判断</option><TaskTypeOptions />
            </select></Field>
          </div>
          <Field label="最近任务显示数量" detail="用于项目页和迭代页。默认显示 5 条。"><input type="number" required min={1} max={30} step={1} disabled={busy}
            value={Number.isNaN(draft.recentTaskLimit) ? '' : draft.recentTaskLimit} onChange={event => edit({ recentTaskLimit: event.target.valueAsNumber })} /></Field>
          <Check checked={draft.followOutput} onChange={followOutput => { if (!busy) edit({ followOutput }) }}>打开任务时跟随最新输出</Check>
        </div>
      </section>
      <ErrorLine text={error} />
      <div className="preference-actions">
        {saved && <span className="preference-saved" role="status"><CheckCircle2 size={16} />已保存</span>}
        <button type="button" className="button" disabled={busy} onClick={() => edit({ ...defaultPreferences, dataDirectory: draft.dataDirectory })}>恢复默认偏好</button>
        <button className="button primary" disabled={busy}>{busy ? changingDirectory ? '正在复制数据…' : '正在保存…' : '保存配置'}</button>
      </div>
    </form>
    {picking && <DirectoryPicker title="选择数据目录" initial={draft.dataDirectory} close={() => setPicking(false)} select={dataDirectory => { edit({ dataDirectory }); setPicking(false) }} />}
  </>
}
