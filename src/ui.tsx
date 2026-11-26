import { Children, cloneElement, isValidElement, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { AlertCircle, ArrowUpRight, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { taskTypeGroups, taskTypes } from '../shared/context.ts'
import { statusLabels } from '../shared/contracts.ts'
import { approvalLabels, approvalModes } from '../shared/engines.ts'
import type { Engine, EngineAvailability, RunStatus, TestCommand } from '../shared/contracts.ts'

export const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
export const dateTime = (date: string) => dateFormat.format(new Date(date))

export function Status({ status }: { status: RunStatus }) {
  return <span className={`status status--${status}`}><i />{statusLabels[status]}</span>
}

export function ErrorLine({ text }: { text: string }) {
  return text ? <div className="error-line" role="alert"><AlertCircle size={16} /><span>{text}</span></div> : null
}

export function SectionHeading({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return <div className="section-heading"><div><h1>{title}</h1>{description && <p>{description}</p>}</div>{children && <div className="heading-actions">{children}</div>}</div>
}

export function Empty({ icon: Icon, title, children, action }: { icon: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty"><div className="empty-icon"><Icon size={23} strokeWidth={1.65} /></div><h3>{title}</h3>{children && <p>{children}</p>}{action}</div>
}

export function Field({ label, detail, children }: { label: string; detail?: string; children: ReactNode }) {
  const id = useId()
  const controls = Children.map(children, child => {
    if (!isValidElement<{ 'aria-labelledby'?: string; 'aria-describedby'?: string }>(child) || !['input', 'select', 'textarea'].includes(String(child.type))) return child
    return cloneElement(child, { 'aria-labelledby': id, 'aria-describedby': detail ? `${id}-hint` : undefined })
  })
  return <label className="field"><span id={id}>{label}</span>{controls}{detail && <small id={`${id}-hint`}>{detail}</small>}</label>
}

export function TaskTypeOptions() {
  return taskTypeGroups.map(group => <optgroup label={group.label} key={group.label}>
    {group.types.map(type => <option key={type} value={type}>{taskTypes[type].label}</option>)}
  </optgroup>)
}

export function ApprovalOptions({ inherit = false }: { inherit?: boolean }) {
  return <>{inherit && <option value="">沿用引擎配置</option>}{approvalModes.map(mode => <option key={mode} value={mode}>{approvalLabels[mode]}</option>)}</>
}

export function engineChoices(engines: Engine[], availability?: EngineAvailability[]) {
  const found = new Map(availability?.map(entry => [entry.id, entry]))
  const score = (entry?: EngineAvailability) => {
    if (entry?.health?.connected && entry.health.auth === 'ready') return 4
    if (entry?.health?.sessionReady && entry.health.auth === 'unknown') return 3
    if (entry?.executable && !entry.health) return 2
    return entry?.executable ? 1 : 0
  }
  return engines.map(engine => ({ engine, local: found.get(engine.id) })).sort((a, b) => score(b.local) - score(a.local))
}

export function EngineOptions({ engines, availability }: { engines: Engine[]; availability?: EngineAvailability[] }) {
  return engineChoices(engines, availability).map(({ engine, local }) => <option key={engine.id} value={engine.id}>{engine.name}{
    local?.health?.auth === 'ready' ? ' · 已就绪' : local?.health?.auth === 'required' ? ' · 待登录'
      : local?.health && !local.health.connected && local.executable ? ' · 连接失败' : local && !local.executable ? ' · 未找到 CLI' : ''}</option>)
}

export function Check({ checked, onChange, children }: { checked: boolean; onChange: (value: boolean) => void; children: ReactNode }) {
  return <label className="checkbox"><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />{children}</label>
}

export function Dialog({ title, note, onClose, children, wide }: { title: string; note?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = ref.current!
    dialog.showModal()
    return () => dialog.close()
  }, [])
  return <dialog ref={ref} aria-labelledby={titleId} className={wide ? 'dialog dialog-wide' : 'dialog'} onCancel={event => { event.preventDefault(); onClose() }}>
    <div className="dialog-header"><div><h2 id={titleId}>{title}</h2>{note && <p>{note}</p>}</div><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={19} /></button></div>
    {children}
  </dialog>
}

export function EditForm({ onSubmit, onClose, children, submitLabel = '保存配置' }: {
  onSubmit: () => Promise<void>; onClose: () => void; children: ReactNode; submitLabel?: string
}) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try { await onSubmit() } catch (error) { setError(message(error)) }
    finally { setBusy(false) }
  }
  return <form onSubmit={submit} className="edit-form">
    <div className="dialog-body">{children}<ErrorLine text={error} /></div>
    <div className="dialog-footer"><button type="button" className="button" onClick={onClose}>取消</button><button className="button primary" disabled={busy}>{busy ? '正在提交…' : submitLabel}</button></div>
  </form>
}

export function CommandFields({ value, onChange }: { value: TestCommand | null; onChange: (command: TestCommand | null) => void }) {
  return <div className="form-columns">
    <Field label="测试程序" detail="填写可执行文件或 PATH 中的命令，例如 pnpm。"><input className="mono" placeholder="pnpm" value={value?.program ?? ''}
      onChange={event => onChange({ program: event.target.value, args: value?.args ?? [] })} /></Field>
    <Field label="命令参数" detail="每行一个参数，含空格的参数可直接写在同一行。"><textarea className="mono" rows={2} placeholder={'test\n--run'} value={value?.args.join('\n') ?? ''}
      onChange={event => onChange({ program: value?.program ?? '', args: event.target.value.split('\n') })} /></Field>
  </div>
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return <a className="external" href={href} target="_blank" rel="noreferrer">{children}<ArrowUpRight size={13} /></a>
}
