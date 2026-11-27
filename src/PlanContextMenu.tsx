import { useEffect, useLayoutEffect, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, CalendarClock, Play, Trash2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { PlanItem } from '../shared/contracts.ts'
import { isPlanOverdue, planCompleteBlockedReason, planStartBlockedReason } from '../shared/plans.ts'

export type PlanAction = 'start' | 'postpone' | 'complete' | 'delete'
export type PlanMenuPoint = { x: number; y: number }

export function PlanContextMenu({ item, point, today, onAction, onClose }: {
  item: PlanItem; point: PlanMenuPoint; today: string
  onAction: (action: PlanAction) => void; onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const overdue = isPlanOverdue(item, today)
  const startReason = planStartBlockedReason(item)
  const completeReason = planCompleteBlockedReason(item)

  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const gap = 8
    const { width, height } = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(gap, Math.min(point.x, window.innerWidth - width - gap))}px`
    menu.style.top = `${Math.max(gap, Math.min(point.y, window.innerHeight - height - gap))}px`
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [item.id, point.x, point.y])

  useEffect(() => {
    const close = (event: Event) => {
      if ((event.type === 'pointerdown' || event.type === 'contextmenu') && ref.current?.contains(event.target as Node)) return
      onClose()
    }
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('contextmenu', close)
    document.addEventListener('keydown', key)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('contextmenu', close)
      document.removeEventListener('keydown', key)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [onClose])

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    if (!buttons.length) return
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length : (index - 1 + buttons.length) % buttons.length
    buttons[next]?.focus()
  }

  const actions: { action: PlanAction; label: string; Icon: LucideIcon; reason?: string; danger?: boolean }[] = [
    { action: 'start', label: '开始', Icon: Play, reason: startReason },
    ...(overdue ? [{ action: 'postpone' as const, label: '延期到今天', Icon: CalendarClock }] : []),
    { action: 'complete', label: '完成', Icon: Check, reason: completeReason },
    { action: 'delete', label: '删除', Icon: Trash2, danger: true },
  ]

  return createPortal(<div ref={ref} className="plan-context-menu" role="menu" aria-label="计划操作"
    style={{ left: point.x, top: point.y }} onKeyDown={navigate} onContextMenu={event => event.preventDefault()}>
    {actions.map(({ action, label, Icon, reason, danger }) => <button key={action} type="button" role="menuitem"
      className={danger ? 'is-danger' : undefined} disabled={!!reason} title={reason || undefined} onClick={() => onAction(action)}>
      <Icon size={15} />{label}
    </button>)}
  </div>, document.body)
}