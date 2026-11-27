import { useState } from 'react'
import { Clipboard, ExternalLink } from 'lucide-react'
import { terminalStatuses } from '../../shared/contracts.ts'
import type { Attempt, Run } from '../../shared/contracts.ts'
import { request } from '../api.ts'
import { Dialog, ErrorLine, Field, message } from '../ui.tsx'

export function DesktopHandoff({ run, stageIndex, attempt }: { run: Run; stageIndex: number; attempt?: Attempt }) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'copied'>('idle')
  const [error, setError] = useState('')
  const [manualCopy, setManualCopy] = useState('')
  const stage = run.stages[stageIndex]
  const thread = stage.engine?.provider === 'codex' && terminalStatuses.has(run.status)
    ? attempt?.sessionId : undefined
  const url = thread && /^[a-z0-9_-]{1,128}$/i.test(thread) && thread !== 'new' && /Windows|Macintosh/.test(navigator.userAgent)
    ? `codex://threads/${thread}` : undefined

  async function copy() {
    setStatus('loading')
    setError('')
    try {
      const { text } = await request<{ text: string }>(`/runs/${encodeURIComponent(run.id)}/desktop-prompt?stage=${stageIndex}`)
      try { await navigator.clipboard.writeText(text); setStatus('copied') }
      catch { setManualCopy(text); setStatus('idle') }
    } catch (error) { setError(message(error)); setStatus('idle') }
  }

  return <>
    {url && <a className="button" href={url}><ExternalLink size={15} />在 Codex 桌面端打开</a>}
    <button type="button" className="button" onClick={() => void copy()} disabled={status === 'loading'}>
      <Clipboard size={15} />{status === 'loading' ? '正在整理…' : '复制任务与上下文'}
    </button>
    {status === 'copied' && <span className="caption" role="status">已复制</span>}
    <ErrorLine text={error} />
    {manualCopy && <Dialog title="任务与上下文" note="选择文本后复制到原生应用。" onClose={() => setManualCopy('')}>
      <div className="dialog-body"><Field label="交接文本"><textarea autoFocus rows={14} readOnly value={manualCopy} onFocus={event => event.currentTarget.select()} /></Field></div>
    </Dialog>}
  </>
}
