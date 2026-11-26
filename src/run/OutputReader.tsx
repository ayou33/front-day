import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowDownToLine, ArrowUpToLine } from 'lucide-react'

export function OutputReader({ followInitially, children }: { followInitially: boolean; children: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(followInitially)

  useLayoutEffect(() => {
    const element = viewport.current
    if (following && element) element.scrollTop = element.scrollHeight
  }, [children, following])

  function jump(latest: boolean) {
    const element = viewport.current
    if (!element) return
    setFollowing(latest)
    element.scrollTop = latest ? element.scrollHeight : 0
  }

  return <>
    <div className="output-navigation">
      <button type="button" aria-label="跳到输出开头" onClick={() => jump(false)}><ArrowUpToLine size={15} />开头</button>
      <button type="button" aria-label="跳到最新输出" className={following ? 'following' : undefined} onClick={() => jump(true)}><ArrowDownToLine size={15} />{following ? '跟随最新' : '最新输出'}</button>
    </div>
    <div ref={viewport} className="output-viewport" role="region" aria-label="执行输出" tabIndex={0} onScroll={event => {
      const element = event.currentTarget
      setFollowing(element.scrollHeight - element.clientHeight - element.scrollTop <= 24)
    }}>{children}</div>
  </>
}
