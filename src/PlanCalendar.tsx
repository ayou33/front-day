import { Fragment, useId, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent } from 'react'
import { AlertTriangle, Check, CircleDashed, LoaderCircle, Plus } from 'lucide-react'
import type { PlanDayMark, PlanItem } from '../shared/contracts.ts'
import { pastPlanDateError, isPlanOverdue, planStatusLabels } from '../shared/plans.ts'
import type { PlanDates } from '../shared/plans.ts'
import { calendarWeeks, layoutWeek, planLaneHeight, shiftPlan, weekdays, byPlanOrder } from './plan-calendar.ts'
import { PlanMarkChip } from './PlanDateMarks.tsx'
import { PlanTooltip } from './PlanTooltip.tsx'
import type { PlanTooltipContent } from './PlanTooltip.tsx'

type Operation = { kind: 'select' } | { kind: 'move' | 'start' | 'end'; item: PlanItem }
type Drag = { operation: Operation; pointerId: number; x: number; y: number; from: string; active: boolean; target?: string; mode?: 'dates' | 'order'; dy?: number }
type Preview = { id?: string; dates: PlanDates | null; target?: string }
const statusIcons = { planned: CircleDashed, 'in-progress': LoaderCircle, done: Check }

function dragDates({ operation, from }: Drag, target: string | undefined, today: string): PlanDates | null {
  if (!target || target < today) return null
  if (operation.kind === 'select') return from <= target ? { startDate: from, endDate: target } : { startDate: target, endDate: from }

  const { item } = operation
  const dates = operation.kind === 'move' ? shiftPlan(item, from, target) : {
    startDate: operation.kind === 'start' ? target : item.startDate,
    endDate: operation.kind === 'end' ? target : item.endDate,
  }
  return dates && dates.startDate <= dates.endDate && !pastPlanDateError(dates, today, item) ? dates : null
}

function dateAt(calendar: HTMLElement, event: PointerEvent) {
  const week = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.plan-week')
  if (!week || !calendar.contains(week)) return
  const bounds = week.getBoundingClientRect()
  const column = Math.floor((event.clientX - bounds.left) * 7 / bounds.width)
  return week.querySelectorAll<HTMLElement>('.plan-day')[column]?.dataset.date
}

export function PlanCalendar({ month, today, items, movingId, marksByDate, onAdd, onEdit, onMove, onReorder, onMarkDate, onContextMenu }: {
  month: string; today: string; items: PlanItem[]; movingId: string
  marksByDate: ReadonlyMap<string, PlanDayMark[]>; onMarkDate: (date: string) => void
  onAdd: (startDate: string, endDate?: string) => void; onEdit: (item: PlanItem) => void; onMove: (item: PlanItem, dates: PlanDates) => void
  onReorder: (item: PlanItem, targetIndex: number) => void
  onContextMenu: (item: PlanItem, point: { x: number; y: number }) => void
}) {
  const calendar = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const suppressClick = useRef(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [orderPreview, setOrderPreview] = useState<{ id: string; dy: number } | null>(null)
  const [tooltip, setTooltip] = useState<PlanTooltipContent | null>(null)
  const tooltipId = useId()
  const weeks = useMemo(() => {
    const sorted = [...items].sort((a, b) => a.startDate.localeCompare(b.startDate) || byPlanOrder(a, b))
    return calendarWeeks(month).map(days => ({ days, ...layoutWeek(days, sorted) }))
  }, [items, month])
  const groupOf = (item: PlanItem) => items.filter(entry => entry.startDate === item.startDate).sort(byPlanOrder)

  function showTooltip(anchor: HTMLElement, notes?: string, key?: string) {
    if (drag.current || movingId) return
    const text = notes?.trim()
    setTooltip(text ? { anchor, notes: text, key } : null)
  }

  function hideTooltip(anchor: HTMLElement) {
    setTooltip(current => current?.anchor === anchor ? null : current)
  }

  function begin(event: PointerEvent<HTMLButtonElement>, operation: Operation, from = dateAt(calendar.current!, event)) {
    if (event.button !== 0 || !event.isPrimary || movingId) return
    setTooltip(null)
    setOrderPreview(null)
    suppressClick.current = false
    if (!from || (operation.kind === 'select' && from < today)) return
    drag.current = { operation, pointerId: event.pointerId, x: event.clientX, y: event.clientY, from, active: false }
    if (event.pointerType !== 'touch') event.currentTarget.setPointerCapture(event.pointerId)
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    const dx = event.clientX - current.x
    const dy = event.clientY - current.y
    if (!current.active && Math.hypot(dx, dy) < 6) return
    current.active = true
    suppressClick.current = true
    if (!current.mode) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return
      const reorderable = current.operation.kind === 'move' && Math.abs(dy) > Math.abs(dx)
        && groupOf(current.operation.item).length > 1
      current.mode = reorderable ? 'order' : 'dates'
    }
    if (current.mode === 'order') {
      current.dy = dy
      setPreview(null)
      setOrderPreview({ id: (current.operation as { item: PlanItem }).item.id, dy })
      return
    }
    const target = dateAt(event.currentTarget, event)
    if (current.target === target) return
    current.target = target
    setPreview({ id: current.operation.kind === 'select' ? undefined : current.operation.item.id, target, dates: dragDates(current, target, today) })
  }

  function cancel() {
    if (!drag.current) return
    drag.current = null
    setPreview(null)
    setOrderPreview(null)
  }

  function finish(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    cancel()
    if (!current.active) return
    if (current.mode === 'order' && current.operation.kind === 'move') {
      const { item } = current.operation
      const group = groupOf(item)
      const from = group.findIndex(entry => entry.id === item.id)
      if (from < 0) return
      const target = Math.max(0, Math.min(group.length - 1, from + Math.round((current.dy ?? 0) / planLaneHeight)))
      if (target !== from) onReorder(item, target)
      return
    }
    const dates = dragDates(current, dateAt(event.currentTarget, event), today)
    if (!dates) return
    const { operation } = current
    if (operation.kind === 'select') {
      // Open the dialog after the browser finishes releasing the captured pointer.
      requestAnimationFrame(() => onAdd(dates.startDate, dates.endDate))
    } else if (operation.item.startDate !== dates.startDate || operation.item.endDate !== dates.endDate) onMove(operation.item, dates)
  }

  return <div className="plan-calendar" ref={calendar} aria-busy={movingId ? true : undefined}
    onPointerMove={move} onPointerUp={finish} onPointerCancel={event => { if (drag.current?.pointerId === event.pointerId) cancel() }}
    onLostPointerCapture={event => { if (drag.current?.pointerId === event.pointerId) cancel() }} onKeyDown={event => {
      if (event.key !== 'Escape') return
      setTooltip(null)
      if (!drag.current) return
      suppressClick.current = true
      cancel()
    }}>
    <div className="plan-weekdays">{weekdays.map(day => <span key={day}>{day}</span>)}</div>
    {weeks.map(({ days, segments, lanes }) => <div className="plan-week" key={days.find(Boolean)}
      style={{ '--plan-lanes': Math.max(1, lanes) } as CSSProperties}>
      {days.map((date, column) => {
        const style = { gridColumn: column + 1 }
        const weekend = column >= 5 ? ' weekend' : ''
        const sunday = column === 6 ? ' sunday' : ''
        if (!date) return <span className={`plan-day outside-month${weekend}${sunday}`} key={column} style={style} />
        const rangePreview = preview?.dates && date >= preview.dates.startDate && date <= preview.dates.endDate
        const dropTarget = rangePreview && date === preview?.target
        const past = date < today
        const outside = date.startsWith(month) ? '' : ' outside-month'
        const label = past ? `${date} 已过去` : `在 ${date} 添加计划项`
        const marks = marksByDate.get(date) ?? []
        return <Fragment key={date}>
          <button className={`plan-day${weekend}${sunday}${outside}${rangePreview ? ' move-preview' : ''}${dropTarget ? ' drop-target' : ''}`}
            style={style} type="button" data-date={date} aria-label={label} title={past ? label : `${label}，拖动可框选日期`}
            disabled={past} onPointerDown={event => begin(event, { kind: 'select' }, date)}
            onClick={event => { if (!suppressClick.current || event.detail === 0) onAdd(date) }}>
            <Plus className="plan-day-add" size={13} aria-hidden="true" />
          </button>
          <div className={`plan-date-header${outside}${past ? ' past' : ''}`} style={style}>
            <button className="plan-date-trigger" type="button" aria-label={`标记日期 ${date}`}
              aria-description={marks.length ? marks.map(mark => mark.label).join('、') : undefined}
              aria-current={date === today ? 'date' : undefined} onPointerDown={event => begin(event, { kind: 'select' }, date)}
              onClick={event => { if (!suppressClick.current || event.detail === 0) onMarkDate(date) }}>
              <time dateTime={date} title={date}>{date === today ? '今' : Number(date.slice(8))}</time>
              {marks.map((mark, index) => <PlanMarkChip key={index} mark={mark}
                onPointerEnter={event => {
                  if (event.pointerType !== 'touch') showTooltip(event.currentTarget, mark.notes)
                }} onPointerLeave={event => hideTooltip(event.currentTarget)} />)}
            </button>
          </div>
        </Fragment>
      })}
      {segments.map(({ item, start, end, lane, startsBefore, endsAfter }) => {
        const range = item.startDate === item.endDate ? item.startDate : `${item.startDate} 至 ${item.endDate}`
        const overdue = isPlanOverdue(item, today)
        const status = overdue ? '已逾期' : planStatusLabels[item.status]
        const StatusIcon = overdue ? AlertTriangle : statusIcons[item.status]
        const tooltipKey = `${item.id}-${days.find(Boolean)}`
        const inactive = preview?.id === item.id || movingId === item.id || orderPreview?.id === item.id
        return <button key={item.id} type="button" className={`plan-event plan-status--${item.status}${overdue ? ' plan-overdue' : ''}${inactive ? ' moving' : ''}${orderPreview?.id === item.id ? ' reordering' : ''}${startsBefore ? ' continues-from' : ''}${endsAfter ? ' continues-to' : ''}`}
          style={{ gridColumn: `${start + 1} / ${end + 2}`, gridRow: lane + 2, ...(orderPreview?.id === item.id && { transform: `translateY(${orderPreview.dy}px)` }) }}
          aria-label={`编辑计划项 ${item.name}，${range}，${status}`} aria-describedby={tooltip?.key === tooltipKey ? tooltipId : undefined} aria-keyshortcuts="Shift+F10"
          onPointerEnter={event => { if (event.pointerType !== 'touch') showTooltip(event.currentTarget, item.notes, tooltipKey) }}
          onPointerLeave={event => hideTooltip(event.currentTarget)}
          onFocus={event => { if (event.currentTarget.matches(':focus-visible')) showTooltip(event.currentTarget, item.notes, tooltipKey) }}
          onBlur={event => hideTooltip(event.currentTarget)}
          onContextMenu={event => {
            event.preventDefault()
            event.stopPropagation()
            if (movingId) return
            setTooltip(null)
            onContextMenu(item, { x: event.clientX, y: event.clientY })
          }}
          onKeyDown={event => {
            if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
            event.preventDefault()
            event.stopPropagation()
            if (movingId) return
            setTooltip(null)
            const bounds = event.currentTarget.getBoundingClientRect()
            onContextMenu(item, { x: bounds.right - 8, y: bounds.bottom })
          }}
          onPointerDown={event => {
            const edge = (event.target as HTMLElement).closest<HTMLElement>('[data-plan-edge]')?.dataset.planEdge
            const kind = edge === 'start' || edge === 'end' ? edge : 'move'
            begin(event, { kind, item })
          }}
          onClick={event => {
            if (suppressClick.current && event.detail !== 0) return
            setTooltip(null)
            onEdit(item)
          }}>
          {!startsBefore && <span className="plan-event-edge" data-plan-edge="start" aria-hidden="true" />}
          <StatusIcon className="plan-event-icon" size={12} aria-hidden="true" /><span className="plan-event-label">{item.name}</span>
          {!endsAfter && <span className="plan-event-edge" data-plan-edge="end" aria-hidden="true" />}
        </button>
      })}
    </div>)}
    {tooltip && <PlanTooltip id={tooltipId} content={tooltip} />}
  </div>
}
