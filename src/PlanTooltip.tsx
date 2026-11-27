import { useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

export type PlanTooltipContent = { anchor: HTMLElement; notes: string; key?: string }

export function PlanTooltip({ id, content }: { id: string; content: PlanTooltipContent }) {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const bubble = ref.current!
    const anchor = content.anchor
    const gap = 8

    function position() {
      const target = anchor.getBoundingClientRect()
      const { width, height } = bubble.getBoundingClientRect()
      const { clientWidth, clientHeight } = document.documentElement
      const center = target.left + target.width / 2
      const left = Math.max(gap, Math.min(center - width / 2, clientWidth - width - gap))
      const above = target.top - height - gap
      const below = target.bottom + gap
      const top = above >= gap ? above : Math.min(below, Math.max(gap, clientHeight - height - gap))
      const visible = anchor.isConnected && target.bottom > 0 && target.top < clientHeight && target.right > 0 && target.left < clientWidth

      bubble.style.left = `${left}px`
      bubble.style.top = `${top}px`
      bubble.style.visibility = visible ? 'visible' : 'hidden'
      bubble.style.setProperty('--tooltip-arrow-x', `${Math.max(12, Math.min(center - left, width - 12))}px`)
      bubble.dataset.side = top + height <= target.top ? 'above' : top >= target.bottom ? 'below' : ''
    }

    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, { capture: true, passive: true })
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [content])

  return createPortal(<div id={id} className="plan-tooltip" role="tooltip" ref={ref}>
    <div className="plan-tooltip-content">{content.notes}</div>
  </div>, document.body)
}
