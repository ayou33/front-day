import { useState } from 'react'
import { Cable, CircleCheck, CircleDashed, CircleHelp, CircleX, LoaderCircle, LogIn, Plus, Terminal, TriangleAlert, Unplug } from 'lucide-react'
import { engineGuides, engineProviders } from '../../shared/engines.ts'
import type { ApprovalMode } from '../../shared/engines.ts'
import type { Engine, EngineAvailability, EngineHealth } from '../../shared/contracts.ts'
import { request } from '../api.ts'
import { ApprovalOptions, Empty, ExternalLink, Field, SectionHeading, engineChoices, message } from '../ui.tsx'
import { Editor, ItemActions, blankEngine, modes, remove } from './common.tsx'
import type { Props } from './common.tsx'

type EngineCheck = EngineHealth | { error: string } | 'loading'

const engineStatuses = {
  idle: { label: '尚未检查', icon: CircleDashed }, loading: { label: '检查中', icon: LoaderCircle },
  missing: { label: '未找到 CLI', icon: CircleX }, disconnected: { label: '连接失败', icon: Unplug },
  login: { label: '待登录', icon: LogIn }, unknown: { label: '认证待确认', icon: CircleHelp },
  ready: { label: '已就绪', icon: CircleCheck }, error: { label: '检查失败', icon: TriangleAlert },
}

function engineStatus(check: EngineCheck | undefined): keyof typeof engineStatuses {
  if (!check) return 'idle'
  if (check === 'loading') return 'loading'
  if ('error' in check) return 'error'
  if (!check.installed) return 'missing'
  if (!check.connected) return 'disconnected'
  if (check.auth === 'required') return 'login'
  return check.auth === 'ready' ? 'ready' : 'unknown'
}

function EngineCommand({ label, command, executable, codexHome }: {
  label: string; command: string; executable?: string | null; codexHome?: string
}) {
  const [copyStatus, setCopyStatus] = useState('')
  const args = command.slice(command.indexOf(' '))
  const powershell = /^[a-z]:[\\/]|^\\\\/i.test(executable ?? codexHome ?? '')
  const quote = (value: string) => "'" + value.replaceAll("'", powershell ? "''" : "'\\''") + "'"
  const invoke = executable ? (powershell ? '& ' : '') + quote(executable) + args : command
  const profile = codexHome ? (powershell ? '$env:CODEX_HOME = ' + quote(codexHome) + '\n' : 'CODEX_HOME=' + quote(codexHome) + ' ') : ''
  const text = profile + invoke

  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopyStatus('已复制') }
    catch { setCopyStatus('请选择命令文本复制') }
  }

  return <div className="engine-command"><span>{label}</span><code>{text}</code><button type="button" className="button compact" onClick={() => { void copy() }}>复制命令</button>
    {copyStatus && <span className="caption" role="status">{copyStatus}</span>}
  </div>
}

function CursorModelField({ model, onChange }: { model: string; onChange: (model: string) => void }) {
  const [selection, setSelection] = useState(() => !model ? 'default' : model.toLowerCase() === 'auto' ? 'auto' : 'custom')
  return <>
    <Field label="模型" detail="Auto 由 Cursor 为任务选择模型。沿用默认模型时使用 CLI 当前的模型设置。">
      <select value={selection} onChange={event => {
        setSelection(event.target.value)
        onChange(event.target.value === 'auto' ? 'auto' : '')
      }}>
        <option value="default">沿用 Cursor CLI 默认模型</option>
        <option value="auto">Auto（由 Cursor 自动选择）</option>
        <option value="custom">自定义模型 ID</option>
      </select>
    </Field>
    {selection === 'custom' && <Field label="模型 ID"><input required className="mono" value={model} onChange={event => onChange(event.target.value)} /></Field>}
  </>
}

function EngineRow({ engine, local, refresh, onEdit, onDelete }: {
  engine: Engine; local?: EngineAvailability; refresh: () => Promise<void>; onEdit: () => void; onDelete: () => Promise<void>
}) {
  const [latest, setLatest] = useState<EngineCheck>()
  const [expanded, setExpanded] = useState(false)

  async function inspect() {
    setLatest('loading')
    try {
      const result = await request<EngineHealth>(`/engines/${engine.id}/health`)
      setLatest(result)
      if (!result.installed || result.auth === 'required') setExpanded(true)
      void refresh().catch(() => {})
    } catch (error) {
      setLatest({ error: message(error) })
    }
  }

  const check = latest ?? local?.health
  const status = !check && local?.executable === null ? 'missing' : engineStatus(check)
  const { icon: Icon, label } = engineStatuses[status]
  const health = check && check !== 'loading' && 'installed' in check ? check : undefined
  const guide = engineGuides[engine.provider]
  const executable = health?.executable ?? local?.executable
  const authExecutable = engine.provider === 'claude' ? health?.authExecutable : executable
  const codexHome = health?.codexHome ?? local?.codexHome
  const diagnostics = health && [
    { name: 'CLI', label: health.installed ? '已找到' : '未找到', tone: health.installed ? 'ready' : 'missing' },
    { name: '协议', label: health.connected ? '已连接' : health.installed ? '连接失败' : '待检查', tone: health.connected ? 'ready' : health.installed ? 'disconnected' : 'idle' },
    { name: '认证', label: health.auth === 'ready' ? '已认证' : health.auth === 'required' ? '需要登录' : health.connected ? '待确认' : '待检查',
      tone: health.auth === 'ready' ? 'ready' : health.auth === 'required' ? 'login' : health.connected ? 'unknown' : 'idle' },
  ]
  const note = check && check !== 'loading' && 'error' in check ? check.error : health?.message
  return <article className="settings-row" aria-label={engine.name}>
    <div className="list-row engine-row"><div className="list-icon"><Terminal size={17} /></div><div className="list-description">
      <strong><span>{engine.name}</span>{engine.name !== guide.name && <span className="chip">{guide.name}</span>}
        <span className={`engine-badge engine-tone-${status}`} role="status"><Icon size={14} aria-hidden="true" />{label}</span></strong>
      <div className="ellipsis muted">{engine.provider === 'cursor' && engine.model.toLowerCase() === 'auto' ? 'Auto' : engine.model || 'CLI 默认模型'} · {modes[engine.mode]} · {executable ? '已发现本机 CLI' : engine.executable || '自动查找 CLI'}</div></div>
      <div className="action-row engine-actions">
        <button className="button compact" disabled={status === 'loading'} onClick={() => { void inspect() }}>{status === 'loading' ? '检查中…' : '检查连接'}</button>
        <ItemActions name={engine.name} onEdit={onEdit} onDelete={onDelete} />
      </div>
    </div>
    <div className="health-details">
      {diagnostics && <dl className="engine-diagnostics">{diagnostics.map(item => <div key={item.name} className={`engine-tone-${item.tone}`}>
        <dt>{item.name}</dt><dd>{item.label}</dd>
      </div>)}</dl>}
      {note && <p className={`engine-note engine-tone-${status}`}>{note}</p>}
      {executable && <p className="mono path">{[health?.version, executable].filter(Boolean).join(' · ')}</p>}
      <details className="engine-guide" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
        <summary>连接指引</summary>
        <div className="engine-guide-body">
          <p>{guide.setup}</p>
          <p>已登录时可先核对下方命令是否使用同一个 CLI 和系统账户。若刚修改 PATH，请从已更新环境的终端重启工作台。</p>
          {guide.status && <EngineCommand key={`${authExecutable}-${codexHome}-status`} label="查看状态" command={guide.status} executable={authExecutable} codexHome={codexHome} />}
          <EngineCommand key={`${authExecutable}-${codexHome}-login`} label="在终端登录" command={guide.login} executable={authExecutable} codexHome={codexHome} />
          <ExternalLink href={guide.docs}>安装与连接文档</ExternalLink>
        </div>
      </details>
    </div>
  </article>
}

export function EnginesView({ catalog, refresh }: Props) {
  const [engineEdit, setEngineEdit] = useState<Engine | null>(null)
  const editingGuide = engineEdit && engineGuides[engineEdit.provider]
  const choices = engineChoices(catalog.engines, catalog.engineAvailability)
  const missing = choices.filter(({ local }) => local?.executable === null)
  const engineRow = ({ engine, local }: (typeof choices)[number]) => <EngineRow engine={engine} local={local} refresh={refresh}
    key={JSON.stringify([engine, local?.executable])} onEdit={() => setEngineEdit(engine)} onDelete={() => remove('engines', engine.id, refresh)} />
  return <>
    <SectionHeading title="引擎" description="配置本地 Agent CLI、运行模式与授权方式。" />
    <div className="stack">
      <section className="panel"><div className="panel-header"><div className="icon-heading"><div className="section-icon"><Cable size={20} /></div><div><h2>本地 Agent</h2><p>已就绪和已安装的引擎优先显示。点击「检查连接」查看 CLI、协议和认证状态。</p></div></div><button className="button" onClick={() => setEngineEdit(blankEngine)}><Plus size={16} />添加配置</button></div>
        {choices.filter(({ local }) => local?.executable !== null).map(engineRow)}
        {missing.length > 0 && <details className="missing-engines">
          <summary>未找到 CLI 的引擎 <span className="chip">{missing.length}</span></summary>
          {missing.map(engineRow)}
        </details>}
        {!catalog.engines.length && <Empty icon={Cable} title="暂无 Agent 配置" />}
      </section>
    </div>
    {engineEdit && editingGuide && <Editor kind="engines" value={engineEdit} close={() => setEngineEdit(null)} refresh={refresh} title={engineEdit.id ? '编辑 Agent 配置' : '添加 Agent 配置'}>
      <Field label="配置名称"><input required value={engineEdit.name} onChange={event => setEngineEdit({ ...engineEdit, name: event.target.value })} /></Field>
      <div className="form-columns"><Field label="引擎"><select value={engineEdit.provider} onChange={event => setEngineEdit({ ...engineEdit, provider: event.target.value as Engine['provider'], executable: '', model: '' })}>
        {engineProviders.map(provider => <option key={provider} value={provider}>{engineGuides[provider].name}</option>)}
      </select></Field><Field label="默认运行模式"><select value={engineEdit.mode} onChange={event => setEngineEdit({ ...engineEdit, mode: event.target.value as Engine['mode'] })}>
        {Object.entries(modes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></Field></div>
      <Field label="默认授权模式" detail="处理引擎提交给工作台的工具权限请求。自动允许适用于引擎提供的单次授权。">
        <select value={engineEdit.approvalMode ?? 'manual'} onChange={event => setEngineEdit({ ...engineEdit, approvalMode: event.target.value as ApprovalMode })}><ApprovalOptions /></select>
      </Field>
      <Field label="CLI 路径或命令名" detail={`留空时自动查找。${editingGuide.setup}`}><input className="mono" placeholder={editingGuide.commands[0]} value={engineEdit.executable} onChange={event => setEngineEdit({ ...engineEdit, executable: event.target.value })} /></Field>
      <ExternalLink href={editingGuide.docs}>安装与连接文档</ExternalLink>
      {engineEdit.provider === 'cursor' ? <CursorModelField model={engineEdit.model} onChange={model => setEngineEdit({ ...engineEdit, model })} />
        : <Field label="模型 ID" detail="留空使用引擎默认模型。"><input className="mono" value={engineEdit.model} onChange={event => setEngineEdit({ ...engineEdit, model: event.target.value })} /></Field>}
    </Editor>}
  </>
}
