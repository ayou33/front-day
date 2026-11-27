import { useState } from 'react'
import { Activity, Braces, Pencil, Plus, Trash2 } from 'lucide-react'
import { optimizerProviderOptions, promptOptimizerProviders } from '../../shared/prompt-optimizer.ts'
import type { ModelApiHealth, ModelApiProfile, ModelApiPurpose, PromptOptimizerProvider } from '../../shared/prompt-optimizer.ts'
import { request } from '../api.ts'
import { Check, Dialog, EditForm, Empty, Field, message } from '../ui.tsx'

const purposes: Record<ModelApiPurpose, string> = { both: '执行与优化', execution: '仅任务执行', optimization: '仅提示词优化' }
const healthLabels: Record<ModelApiHealth['status'], string> = {
  ready: '模型已响应', key: '认证失败', model: '模型或权限异常', quota: '配额受限', network: '网络异常', service: '服务异常',
}

export function ModelApisPanel({ profiles, refresh }: { profiles: ModelApiProfile[]; refresh: () => Promise<void> }) {
  const [editor, setEditor] = useState<ModelApiProfile | 'new'>()
  const [provider, setProvider] = useState<PromptOptimizerProvider>('deepseek')
  return <section className="panel">
    <div className="panel-header">
      <div className="icon-heading"><div className="section-icon"><Braces size={20} /></div>
        <div><h2>厂商 API</h2><p>保存模型和 API Key，供任务执行和提示词优化选择。</p></div>
      </div>
      <button className="button" onClick={() => { setProvider('deepseek'); setEditor('new') }}><Plus size={16} />配置厂商 API</button>
    </div>
    {profiles.length === 0 && <Empty icon={Braces} title="暂无厂商 API 配置" />}
    {profiles.map(profile => <ModelApiRow key={profile.id} profile={profile} refresh={refresh} edit={() => { setProvider(profile.provider); setEditor(profile) }} />)}
    {editor && <Dialog title="配置厂商 API" onClose={() => setEditor(undefined)}>
      <ModelApiEditor key={provider} provider={provider} profile={editor === 'new' ? undefined : editor}
        onProvider={setProvider} close={() => setEditor(undefined)} refresh={refresh} />
    </Dialog>}
  </section>
}

function ModelApiRow({ profile, edit, refresh }: { profile: ModelApiProfile; edit: () => void; refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [checked, setChecked] = useState<{ signature: string; result: ModelApiHealth }>()
  const signature = JSON.stringify(profile)
  const health = checked?.signature === signature ? checked.result : undefined
  async function check() {
    setBusy(true)
    setError('')
    try {
      const result = await request<ModelApiHealth>(`/model-apis/${encodeURIComponent(profile.id)}/health`, 'POST', {})
      setChecked({ signature, result })
    } catch (error) { setChecked({ signature, result: { status: 'service', message: message(error), elapsedMs: 0 } }) }
    finally { setBusy(false) }
  }
  async function remove() {
    if (busy || !window.confirm(`删除厂商 API「${profile.name}」？如果提示词优化正在使用它，会同时关闭提示词优化。`)) return
    setBusy(true)
    setError('')
    try { await request(`/model-apis/${encodeURIComponent(profile.id)}`, 'DELETE'); await refresh() }
    catch (error) { setError(message(error)) }
    finally { setBusy(false) }
  }
  const provider = optimizerProviderOptions[profile.provider].label
  return <article className="list-row" aria-label={profile.name}>
    <div className="list-icon"><Braces size={18} /></div>
    <div className="list-description"><strong>{profile.name}</strong><div className="mono ellipsis muted">{provider} · {profile.model} · {purposes[profile.purpose ?? 'both']}</div>
      {health && <p className="caption" role="status"><strong>{healthLabels[health.status]}</strong> {health.message}{health.elapsedMs > 0 && ` · ${health.elapsedMs} ms`}</p>}
      {error && <p className="caption" role="status">{error}</p>}
    </div>
    <span className="chip">{profile.hasApiKey ? '已保存密钥' : '待填写密钥'}</span>
    <button className="button compact" disabled={busy || !profile.hasApiKey} title="发送一条简短测试消息到厂商，可能产生少量用量"
      onClick={() => void check()}><Activity size={15} />{busy ? '检查中…' : '检查 API 连接'}</button>
    <button className="icon-button" disabled={busy} aria-label={`编辑 ${profile.name} API`} onClick={() => { setChecked(undefined); edit() }}><Pencil size={16} /></button>
    <button className="icon-button" disabled={busy} aria-label={`删除 ${profile.name} API`} onClick={() => void remove()}><Trash2 size={16} /></button>
  </article>
}

function ModelApiEditor({ provider, profile, onProvider, close, refresh }: {
  provider: PromptOptimizerProvider; profile?: ModelApiProfile; onProvider: (value: PromptOptimizerProvider) => void
  close: () => void; refresh: () => Promise<void>
}) {
  const options = optimizerProviderOptions[provider]
  const [model, setModel] = useState(profile?.model ?? options.models[0])
  const [name, setName] = useState(profile?.name ?? '')
  const [purpose, setPurpose] = useState<ModelApiPurpose>(profile?.purpose ?? 'both')
  const [custom, setCustom] = useState(!options.models.includes(model))
  const [key, setKey] = useState('')
  const [remove, setRemove] = useState(false)
  async function save() {
    await request(profile ? `/model-apis/${encodeURIComponent(profile.id)}` : '/model-apis', profile ? 'PUT' : 'POST',
      { provider, model, name: name.trim() || undefined, purpose, apiKey: remove ? null : key.trim() || undefined })
    await refresh()
    close()
  }
  return <EditForm onClose={close} onSubmit={save} submitLabel="保存 API 配置">
    <div className="form-columns">
      <Field label="厂商" detail={options.detail}><select disabled={!!profile} value={provider} onChange={event => onProvider(event.target.value as PromptOptimizerProvider)}>
        {promptOptimizerProviders.map(value => <option key={value} value={value}>{optimizerProviderOptions[value].label}</option>)}
      </select></Field>
      <Field label="模型"><select value={custom ? '' : model} onChange={event => { setModel(event.target.value); setCustom(!event.target.value) }}>
        {options.models.map((value, index) => <option value={value} key={value}>{value}{index === 0 ? '（默认）' : ''}</option>)}
        <option value="">自定义模型 ID</option>
      </select></Field>
    </div>
    {custom && <Field label="自定义模型 ID" detail="填写厂商控制台提供的准确 ID。">
      <input required maxLength={150} value={model} onChange={event => setModel(event.target.value)} />
    </Field>}
    <div className="form-columns">
      <Field label="配置名称"><input maxLength={150} placeholder={`${options.label} · ${model}`} value={name} onChange={event => setName(event.target.value)} /></Field>
      <Field label="用途"><select value={purpose} onChange={event => setPurpose(event.target.value as ModelApiPurpose)}>
        {Object.entries(purposes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></Field>
    </div>
    <Field label={`${options.label} API Key`} detail={profile?.hasApiKey ? '留空沿用已加密保存的密钥。' : '密钥在本机加密保存。'}>
      <input type="password" autoComplete="new-password" maxLength={1024} value={key} disabled={remove} onChange={event => setKey(event.target.value)} />
    </Field>
    {profile?.hasApiKey && <Check checked={remove} onChange={setRemove}>移除已保存的 API Key</Check>}
  </EditForm>
}
