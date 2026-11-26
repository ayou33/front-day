import { useState } from 'react'
import type { FormEvent } from 'react'
import { CheckCircle2 } from 'lucide-react'
import { optimizerProviderOptions, promptOptimizerProviders } from '../../shared/prompt-optimizer.ts'
import type { PromptOptimizerProvider, PromptOptimizerSettings } from '../../shared/prompt-optimizer.ts'
import { request } from '../api.ts'
import { Check, ErrorLine, Field, message } from '../ui.tsx'

export function PromptOptimizerPanel({ initial, refresh }: { initial: PromptOptimizerSettings; refresh: () => Promise<void> }) {
  const [draft, setDraft] = useState(initial)
  const [savedConfig, setSavedConfig] = useState(initial)
  const [customModel, setCustomModel] = useState(() => !optimizerProviderOptions[initial.provider].models.includes(initial.model))
  const [apiKey, setApiKey] = useState('')
  const [removeKey, setRemoveKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState({ error: '', saved: false })
  const providerOptions = optimizerProviderOptions[draft.provider]
  const changingProvider = draft.provider !== savedConfig.provider
  // The browser can receive a new build while the local server still returns the old configuration.
  const needsServerRestart = changingProvider && !initial.profiles && !savedConfig.profiles

  function selectProvider(provider: PromptOptimizerProvider) {
    const options = optimizerProviderOptions[provider]
    const profile = savedConfig.profiles?.[provider] ?? initial.profiles?.[provider]
      ?? (provider === savedConfig.provider ? savedConfig : undefined)
    const model = profile?.model ?? options.models[0]
    setDraft({ ...draft, provider, model, hasApiKey: profile?.hasApiKey ?? false })
    setCustomModel(!options.models.includes(model))
    setApiKey('')
    setRemoveKey(false)
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (saving || needsServerRestart) return
    setSaving(true)
    setFeedback({ error: '', saved: false })
    try {
      const result = await request<PromptOptimizerSettings>('/prompt-optimizer', 'PUT', { enabled: draft.enabled, provider: draft.provider, model: draft.model,
        apiKey: removeKey ? null : apiKey.trim() || undefined })
      setSavedConfig(result)
      setDraft(result)
      setCustomModel(!optimizerProviderOptions[result.provider].models.includes(result.model))
      setApiKey('')
      setRemoveKey(false)
      setFeedback({ error: '', saved: true })
      void refresh().catch(() => {})
    } catch (error) { setFeedback({ error: message(error), saved: false }) }
    finally { setSaving(false) }
  }

  return <form className="panel" onSubmit={save} onChange={() => setFeedback({ error: '', saved: false })}>
    <div className="panel-header"><div><h2>提示词优化</h2><p>在新建任务时按需生成优化稿，确认后应用。</p></div></div>
    <div className="preference-fields">
      <Check checked={draft.enabled} onChange={enabled => { setDraft({ ...draft, enabled }); if (enabled) setRemoveKey(false) }}>启用提示词优化</Check>
      <div className="form-columns">
        <Field label="厂商" detail={providerOptions.detail}><select disabled={saving} value={draft.provider}
          onChange={event => selectProvider(event.target.value as PromptOptimizerProvider)}>
          {promptOptimizerProviders.map(provider => <option key={provider} value={provider}>{optimizerProviderOptions[provider].label}</option>)}
        </select></Field>
        <Field label="模型">
          <select disabled={saving} value={customModel ? '' : draft.model} onChange={event => {
            const model = event.target.value
            setCustomModel(!model)
            setDraft({ ...draft, model })
          }}>
            {providerOptions.models.map((model, index) => <option key={model} value={model}>{model}{index === 0 ? '（默认）' : ''}</option>)}
            <option value="">自定义模型 ID</option>
          </select>
        </Field>
      </div>
      {customModel && <Field label="自定义模型 ID" detail="填写厂商控制台提供的准确 ID。">
        <input required disabled={saving} maxLength={150} value={draft.model} onChange={event => setDraft({ ...draft, model: event.target.value })} />
      </Field>}
      <Field label={`${providerOptions.label} API Key`} detail={draft.hasApiKey ? '已在本机加密保存。填写新值可替换。' : '在本机加密保存，仅供所选厂商使用。'}>
        <input type="password" autoComplete="new-password" maxLength={1024} value={apiKey} disabled={saving || removeKey} onChange={event => setApiKey(event.target.value)} />
      </Field>
      {draft.hasApiKey && <Check checked={removeKey} onChange={value => { setRemoveKey(value); if (value) { setDraft({ ...draft, enabled: false }); setApiKey('') } }}>移除已保存的 API Key</Check>}
      <ErrorLine text={needsServerRestart ? '当前服务版本较旧，请重启 Front Day 服务后保存新厂商。' : feedback.error} />
      <div className="preference-actions">
        {feedback.saved && <span className="preference-saved" role="status"><CheckCircle2 size={16} />提示词优化已保存</span>}
        {changingProvider && !needsServerRestart && <span className="caption" role="status">保存后切换至 {providerOptions.label}。</span>}
        <button className="button primary" disabled={saving || needsServerRestart}>{saving ? '正在保存…' : changingProvider ? '保存并切换厂商' : '保存提示词配置'}</button>
      </div>
    </div>
  </form>
}
