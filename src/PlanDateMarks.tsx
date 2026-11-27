import { useRef, useState } from 'react'
import type { CSSProperties, FormEvent, PointerEventHandler } from 'react'
import { Plus, X } from 'lucide-react'
import type { PlanDayMark, PlanDayMarks } from '../shared/contracts.ts'
import { planMarkLabelMax } from '../shared/plans.ts'
import { request } from './api.ts'
import { contrastRatio, markInk } from './mark-contrast.ts'
import { Dialog, ErrorLine, Field, message } from './ui.tsx'

const presets = [
  { title: '添加「休」', mark: { label: '休', style: 'border', color: '#27966b' } },
  { title: '添加「假」', mark: { label: '假', style: 'fill', color: '#f5c66c' } },
  { title: '自定义标记', mark: { label: '', style: 'border', color: '#397aa6' } },
] satisfies { title: string; mark: PlanDayMark }[]

export function PlanMarkChip({ mark, onPointerEnter, onPointerLeave }: {
  mark: PlanDayMark; onPointerEnter?: PointerEventHandler<HTMLSpanElement>; onPointerLeave?: PointerEventHandler<HTMLSpanElement>
}) {
  const style = { '--mark-color': mark.color, '--mark-ink': mark.style === 'fill' ? markInk(mark.color) : undefined } as CSSProperties
  return <span className={`plan-mark-chip ${mark.style}`} title={onPointerEnter ? undefined : mark.label} style={style}
    onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>{mark.label}</span>
}

export function PlanDateMarksEditor({ date, marks, close, onSave }: {
  date: string; marks: PlanDayMark[]; close: () => void; onSave: (entry: PlanDayMarks) => void
}) {
  const [draft, setDraft] = useState(() => marks.map((mark, key) => ({ key, mark })))
  const nextKey = useRef(draft.length)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  function add(mark: PlanDayMark) {
    const key = nextKey.current++
    setDraft(previous => [...previous, { key, mark }])
  }

  function update(key: number, patch: Partial<PlanDayMark>) {
    setDraft(previous => previous.map(row => row.key === key ? { key, mark: { ...row.mark, ...patch } } : row))
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      onSave(await request<PlanDayMarks>(`/config/plan-day-marks/${encodeURIComponent(date)}`, 'PUT', { marks: draft.map(row => row.mark) }))
    } catch (error) { setError(message(error)) }
    finally { setBusy(false) }
  }

  return <Dialog title="标记日期" note={date} onClose={() => { if (!busy) close() }}>
    <form className="edit-form plan-marks-form" onSubmit={save}>
      <div className="dialog-body">
        <div className="action-row">{presets.map(({ title, mark }) =>
          <button className="button compact" key={title} type="button" disabled={busy} onClick={() => add(mark)}><Plus size={15} />{title}</button>)}</div>
        {draft.map(({ key, mark }, index) => <fieldset className="plan-mark-fields" key={key} disabled={busy} aria-label={`标记 ${index + 1}`}>
          <div className="plan-mark-row-heading">
            <PlanMarkChip mark={mark.label.trim() ? mark : { ...mark, label: '标记' }} />
            <button className="icon-button danger-icon" type="button" aria-label={`移除标记 ${index + 1}`} title="移除标记"
              onClick={() => setDraft(previous => previous.filter(row => row.key !== key))}><X size={16} /></button>
          </div>
          <div className="plan-mark-inputs">
            <Field label="标记名称"><input value={mark.label} onChange={event => update(key, { label: event.target.value })}
              required maxLength={planMarkLabelMax} /></Field>
            <Field label="样式"><select value={mark.style} onChange={event => update(key, { style: event.target.value as PlanDayMark['style'] })}>
              <option value="border">边框</option><option value="fill">背景色</option>
            </select></Field>
            <Field label="颜色"><input type="color" value={mark.color} onChange={event => update(key, { color: event.target.value })} /></Field>
          </div>
          {mark.style === 'fill' && <p className="caption plan-mark-contrast">
            填充样式的文字会自动使用{markInk(mark.color) === '#000000' ? '黑色' : '白色'}，对比度约 {contrastRatio(mark.color, markInk(mark.color)).toFixed(1)}:1。
          </p>}
          <Field label="备注"><textarea rows={2} value={mark.notes ?? ''} onChange={event => update(key, { notes: event.target.value })} /></Field>
        </fieldset>)}
        <ErrorLine text={error} />
      </div>
      <div className="dialog-footer">
        <button className="button" type="button" disabled={busy} onClick={close}>取消</button>
        <button className="button primary" disabled={busy}>{busy ? '正在保存…' : '保存标记'}</button>
      </div>
    </form>
  </Dialog>
}
