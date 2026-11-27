import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { AlertTriangle, CalendarRange, Check, ChevronLeft, ChevronRight, CircleDashed, LoaderCircle, Plus } from 'lucide-react'
import type { PlanDayMarks, PlanItem } from '../shared/contracts.ts'
import { localPlanDate, pastPlanDateError, planStatuses, planStatusLabels } from '../shared/plans.ts'
import type { PlanDates } from '../shared/plans.ts'
import { request, saveConfig } from './api.ts'
import { PlanCalendar } from './PlanCalendar.tsx'
import { PlanDateMarksEditor } from './PlanDateMarks.tsx'
import { earliestDate, latestDate, moveMonth, nextPlanDate, byPlanOrder } from './plan-calendar.ts'
import { Dialog, Empty, ErrorLine, Field, SectionHeading, message } from './ui.tsx'
import './styles/plans.css'

const earliestMonth = earliestDate.slice(0, 7)
const latestMonth = latestDate.slice(0, 7)
const planStatusIcons = { planned: CircleDashed, 'in-progress': LoaderCircle, done: Check }

export function PlansView({ onChange }: { onChange?: () => void }) {
  const today = localPlanDate()
  const [month, setMonth] = useState(() => today.slice(0, 7))
  const [items, setItems] = useState<PlanItem[] | null>(null)
  const [editing, setEditing] = useState<{ item: PlanItem; autoEnd?: boolean } | null>(null)
  const [markDate, setMarkDate] = useState('')
  const [marks, setMarks] = useState<PlanDayMarks[] | null>(null)
  const [markError, setMarkError] = useState('')
  const [markLoadAttempt, setMarkLoadAttempt] = useState(0)
  const [movingId, setMovingId] = useState('')
  const [error, setError] = useState('')
  const [loadAttempt, setLoadAttempt] = useState(0)
  const marksByDate = useMemo(() => new Map(marks?.map(entry => [entry.id, entry.marks])), [marks])

  useEffect(() => {
    let active = true
    void request<PlanItem[]>('/config/plan-items').then(list => {
      if (active) setItems(list)
    }).catch(error => {
      if (active) setError(message(error))
    })
    return () => { active = false }
  }, [loadAttempt])

  useEffect(() => {
    let active = true
    void request<PlanDayMarks[]>('/config/plan-day-marks').then(list => {
      if (active) setMarks(list)
    }).catch(error => {
      if (active) setMarkError(message(error))
    })
    return () => { active = false }
  }, [markLoadAttempt])

  function add(startDate: string, endDate?: string) {
    if (movingId || startDate < localPlanDate()) return
    const sameDay = (items ?? []).filter(entry => entry.startDate === startDate)
    const order = Math.max(-1, ...sameDay.map(entry => entry.order ?? 0)) + 1
    setEditing({ autoEnd: endDate === undefined, item: {
      id: '', name: '', startDate, endDate: endDate ?? nextPlanDate(startDate), status: startDate === today ? 'in-progress' : 'planned', notes: '', order,
    } })
  }

  function storeItem(item: PlanItem) {
    setItems(list => [...(list ?? []).filter(entry => entry.id !== item.id), item])
  }

  function saved(item: PlanItem) {
    storeItem(item)
    setEditing(null)
    onChange?.()
    if (editing?.item.id && editing.item.startDate === item.startDate && editing.item.endDate === item.endDate) return
    const startMonth = item.startDate.slice(0, 7)
    if (startMonth > month || item.endDate.slice(0, 7) < month) setMonth(startMonth)
  }

  async function reorder(item: PlanItem, targetIndex: number) {
    if (movingId) return
    const group = (items ?? []).filter(entry => entry.startDate === item.startDate).sort(byPlanOrder)
    const from = group.findIndex(entry => entry.id === item.id)
    if (from < 0 || targetIndex < 0 || targetIndex >= group.length || targetIndex === from) return
    const reordered = [...group]
    const [moved] = reordered.splice(from, 1)
    reordered.splice(targetIndex, 0, moved)
    setMovingId(item.id)
    setError('')
    try {
      for (const [index, entry] of reordered.entries()) {
        if ((entry.order ?? 0) === index) continue
        storeItem(await request<PlanItem>(`/config/plan-items/${encodeURIComponent(entry.id)}`, 'PATCH', { order: index }))
      }
    } catch (error) { setError(`调整计划顺序失败。${message(error)}`) }
    finally { setMovingId('') }
    onChange?.()
  }

  async function move(item: PlanItem, dates: PlanDates) {
    if (movingId) return
    const patch = {
      ...(item.startDate !== dates.startDate && { startDate: dates.startDate }),
      ...(item.endDate !== dates.endDate && { endDate: dates.endDate }),
    }
    setMovingId(item.id)
    setError('')
    try { storeItem(await request<PlanItem>(`/config/plan-items/${encodeURIComponent(item.id)}`, 'PATCH', patch)) }
    catch (error) { setError(`调整计划日期失败。${message(error)}`) }
    finally { setMovingId('') }
    onChange?.()
  }

  return <>
    <SectionHeading title="任务排期">
      <button className="button primary" type="button" disabled={!items || !!movingId}
        onClick={() => add(month <= today.slice(0, 7) ? today : `${month}-01`)}><Plus size={17} />添加计划项</button>
    </SectionHeading>
    {error && <ErrorLine text={error} />}
    <section className="panel" aria-label="任务排期月历">
      <div className="panel-header plan-toolbar">
        <div className="plan-month-controls">
          <button className="icon-button" type="button" aria-label="上个月" title="上个月" disabled={month === earliestMonth}
            onClick={() => setMonth(moveMonth(month, -1))}><ChevronLeft size={17} /></button>
          <input className="plan-month" type="month" aria-label="查看月份" min={earliestMonth} max={latestMonth} value={month} onChange={event => {
            if (event.target.value.length === 7 && event.target.validity.valid) setMonth(event.target.value)
          }} />
          <button className="icon-button" type="button" aria-label="下个月" title="下个月" disabled={month === latestMonth}
            onClick={() => setMonth(moveMonth(month, 1))}><ChevronRight size={17} /></button>
          <button className="button compact" type="button" onClick={() => setMonth(today.slice(0, 7))}>今天</button>
        </div>
        <ul className="plan-legend" aria-label="计划状态">{planStatuses.map(status => {
          const Icon = planStatusIcons[status]
          return <li className={`plan-status--${status}`} key={status}><Icon className="plan-legend-icon" size={12} aria-hidden="true" />{planStatusLabels[status]}</li>
        })}<li className="plan-status--overdue"><AlertTriangle className="plan-legend-icon" size={12} aria-hidden="true" />已逾期</li></ul>
      </div>
      {items ? <PlanCalendar key={month} month={month} today={today} items={items} movingId={movingId} marksByDate={marksByDate}
        onAdd={add} onMarkDate={setMarkDate} onReorder={(item, targetIndex) => void reorder(item, targetIndex)}
        onEdit={item => { if (!movingId) setEditing({ item }) }} onMove={(item, dates) => void move(item, dates)} /> :
        error ? <Empty icon={CalendarRange} title="无法读取计划项" action={<button className="button" type="button" onClick={() => {
          setError(''); setLoadAttempt(attempt => attempt + 1)
        }}>重试</button>} /> : <div className="loading" role="status">正在读取计划项…</div>}
    </section>
    {editing && <PlanItemEditor item={editing.item} defaultEnd={editing.autoEnd ?? false} today={today}
      close={() => setEditing(null)} onSave={saved} onDelete={id => {
      setItems(list => list?.filter(item => item.id !== id) ?? [])
      setEditing(null)
      onChange?.()
    }} />}
    {markDate && (marks ? <PlanDateMarksEditor key={markDate} date={markDate} marks={marksByDate.get(markDate) ?? []}
      close={() => setMarkDate('')} onSave={entry => {
        setMarks(list => [...(list ?? []).filter(day => day.id !== entry.id), ...(entry.marks.length ? [entry] : [])])
        setMarkDate('')
      }} /> : <Dialog title="标记日期" note={markDate} onClose={() => setMarkDate('')}>
      <div className="dialog-body">
        {markError ? <><ErrorLine text={markError} /><button className="button" type="button" onClick={() => {
          setMarkError(''); setMarkLoadAttempt(attempt => attempt + 1)
        }}>重试</button></> : <div className="loading" role="status">正在读取日期标记…</div>}
      </div>
    </Dialog>)}
  </>
}

function PlanItemEditor({ item, defaultEnd, today, close, onSave, onDelete }: {
  item: PlanItem; defaultEnd: boolean; today: string; close: () => void; onSave: (item: PlanItem) => void; onDelete: (id: string) => void
}) {
  const [draft, setDraft] = useState(item)
  const [autoEnd, setAutoEnd] = useState(defaultEnd)
  const [statusTouched, setStatusTouched] = useState(item.id !== '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = <K extends keyof PlanItem>(key: K, value: PlanItem[K]) => setDraft(previous => ({ ...previous, [key]: value }))
  const dateMinimum = (field: keyof PlanDates) => item.id && draft[field] === item[field] && item[field] < today ? item[field] : today
  const endMinimum = dateMinimum('endDate')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const pastError = pastPlanDateError(draft, localPlanDate(), item.id ? item : undefined)
    if (pastError) { setError(pastError); return }
    setBusy(true)
    setError('')
    try { onSave(await saveConfig('plan-items', draft)) }
    catch (error) { setError(message(error)) }
    finally { setBusy(false) }
  }

  async function remove() {
    if (busy || !window.confirm(`删除计划项「${item.name}」？`)) return
    setBusy(true)
    setError('')
    try {
      await request(`/config/plan-items/${encodeURIComponent(item.id)}`, 'DELETE')
      onDelete(item.id)
    } catch (error) { setError(message(error)) }
    finally { setBusy(false) }
  }

  return <Dialog title={item.id ? '编辑计划项' : '添加计划项'} onClose={() => { if (!busy) close() }}>
    <form className="edit-form" onSubmit={submit}>
      <div className="dialog-body">
        <Field label="名称"><input value={draft.name} onChange={event => set('name', event.target.value)} required maxLength={150} disabled={busy} /></Field>
        <div className="form-columns">
          <Field label="开始日期"><input type="date" value={draft.startDate} onChange={event => {
            const startDate = event.target.value
            setDraft(previous => ({ ...previous, startDate, ...(autoEnd && startDate && { endDate: nextPlanDate(startDate) }),
              ...(!item.id && !statusTouched && startDate && { status: startDate === today ? 'in-progress' : 'planned' }) }))
          }} required min={dateMinimum('startDate')} max={latestDate} disabled={busy} /></Field>
          <Field label="结束日期"><input type="date" value={draft.endDate} onChange={event => {
            setAutoEnd(false)
            set('endDate', event.target.value)
          }} required min={draft.startDate > endMinimum ? draft.startDate : endMinimum} max={latestDate} disabled={busy} /></Field>
        </div>
        <Field label="状态"><select value={draft.status} onChange={event => { setStatusTouched(true); set('status', event.target.value as PlanItem['status']) }} disabled={busy}>
          {planStatuses.map(status => <option key={status} value={status}>{planStatusLabels[status]}</option>)}
        </select></Field>
        <Field label="备注"><textarea value={draft.notes} onChange={event => set('notes', event.target.value)} rows={3} disabled={busy} /></Field>
        <ErrorLine text={error} />
      </div>
      <div className="dialog-footer plan-editor-footer">
        {item.id && <button className="button plain plan-delete" type="button" disabled={busy} onClick={() => void remove()}>删除计划项</button>}
        <button className="button" type="button" disabled={busy} onClick={close}>取消</button>
        <button className="button primary" disabled={busy}>{busy ? '正在提交…' : '保存'}</button>
      </div>
    </form>
  </Dialog>
}
