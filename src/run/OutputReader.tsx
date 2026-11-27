import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowDownToLine, ArrowUpToLine } from 'lucide-react'

export function OutputReader({ viewKey, followInitially, toolbar, children }: {
  viewKey: string; followInitially: boolean; toolbar: (navigation: ReactNode) => ReactNode; children: ReactNode
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const [scroll, setScroll] = useState({ viewKey, following: followInitially })
  const following = scroll.viewKey === viewKey ? scroll.following : followInitially

  useLayoutEffect(() => {
    if (scroll.viewKey !== viewKey) setScroll({ viewKey, following: followInitially })
    const element = viewport.current
    if (following && element) element.scrollTop = element.scrollHeight
  }, [children, followInitially, following, scroll.viewKey, viewKey])

  function jump(latest: boolean) {
    const element = viewport.current
    if (!element) return
    setScroll({ viewKey, following: latest })
    element.scrollTop = latest ? element.scrollHeight : 0
  }

  return <>
    {toolbar(<div className="output-navigation" role="group" aria-label="跳转执行输出">
      <button type="button" aria-label="跳到输出开头" title="跳到输出开头" onClick={() => jump(false)}><ArrowUpToLine size={16} /></button>
      <button type="button" aria-label="跳到最新输出" aria-pressed={following} title={following ? '正在跟随最新输出' : '跳到最新输出'}
        className={following ? 'following' : undefined} onClick={() => jump(true)}><ArrowDownToLine size={16} /></button>
    </div>)}
    <div key={viewKey} ref={viewport} className="output-viewport" role="region" aria-label="执行输出" tabIndex={0} onScroll={event => {
      const element = event.currentTarget
      const next = element.scrollHeight - element.clientHeight - element.scrollTop <= 24
      if (following !== next) setScroll({ viewKey, following: next })
    }}>{children}</div>
  </>
}
