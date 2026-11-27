import { useEffect, useState } from 'react'
import { Pencil, Sparkles } from 'lucide-react'
import type { AgentPromptPreview, Run } from '../../shared/contracts.ts'
import { maxOptimizationInput } from '../../shared/prompt-optimizer.ts'
import type { PromptOptimizerSettings } from '../../shared/prompt-optimizer.ts'
import { request } from '../api.ts'
import { Dialog, EditForm, ErrorLine, Field, message } from '../ui.tsx'

export function AgentPrompt({ run, stageIndex, optimizer, onSaved, contextVersion }: {
  run: Run; stageIndex: number; optimizer?: PromptOptimizerSettings; onSaved: (run: Run) => void; contextVersion?: string
}) {
  const revision = run.revision ?? 0
  const base = `/runs/${encodeURIComponent(run.id)}`
  const path = `${base}/prompt?stage=${stageIndex}`
  const [preview, setPreview] = useState<AgentPromptPreview>()
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [resetting, setResetting] = useState(false)

  useEffect(() => {
    let active = true
    void request<AgentPromptPreview>(path).then(result => {
      if (active) { setPreview(result); setError('') }
    }).catch(error => { if (active) { setPreview(undefined); setError(message(error)) } })
    return () => { active = false }
  }, [path, contextVersion])

  async function restoreAutomatic() {
    setResetting(true)
    setError('')
    try { onSaved(await request<Run>(path, 'PUT', { text: null, revision })) }
    catch (error) { setError(message(error)) }
    finally { setResetting(false) }
  }

  return <>
    <ErrorLine text={error} />
    {preview ? <>
      {preview.edited && <div className="action-row">
        <button type="button" className="button compact" disabled={resetting} onClick={() => void restoreAutomatic()}>恢复自动生成</button>
      </div>}
      <details className="event-item agent-prompt-preview" open>
        <summary>
          <span>{preview.edited ? '自定义 Agent 提示词' : '发送给 Agent 的提示词预览'}</span>
          <button type="button" className="icon-button" aria-label="编辑提示词" title="编辑提示词" disabled={resetting} onClick={event => {
            event.preventDefault()
            setEditing(true)
          }}><Pencil size={15} aria-hidden="true" /></button>
        </summary>
        <pre>{preview.text}</pre>
      </details>
      <p className="caption">{preview.edited ? '执行时使用保存的正文，并补入适用的阶段结果。' : '在线要素在预览中以资料入口展示。执行时会补入适用的阶段结果。'}</p>
      {editing && <PromptEditor initial={preview.text} optimizer={optimizer}
        optimizePath={`${base}/optimize-prompt?stage=${stageIndex}`} close={() => setEditing(false)}
        save={async text => {
          const updated = await request<Run>(path, 'PUT', { text, revision })
          onSaved(updated)
          setEditing(false)
        }} />}
    </> : !error && <p className="caption">正在生成提示词预览…</p>}
  </>
}

function PromptEditor({ initial, optimizePath, optimizer, close, save }: {
  initial: string; optimizePath: string; optimizer?: PromptOptimizerSettings; close: () => void; save: (text: string) => Promise<void>
}) {
  const [text, setText] = useState(initial)
  const [suggestion, setSuggestion] = useState<string>()
  const [optimizing, setOptimizing] = useState(false)
  const [error, setError] = useState('')
  const tooLong = text.trim().length > maxOptimizationInput

  async function optimize() {
    if (!optimizer?.enabled || optimizing || tooLong || !text.trim()) return
    setOptimizing(true)
    setError('')
    setSuggestion(undefined)
    try { setSuggestion((await request<{ text: string }>(optimizePath, 'POST', { text, executorId: optimizer.executorId })).text) }
    catch (error) { setError(message(error)) }
    finally { setOptimizing(false) }
  }

  return <Dialog wide title="编辑 Agent 提示词" note="保存后，该阶段将使用这份正文。" onClose={close}>
    <EditForm onClose={close} submitLabel="保存提示词" submitDisabled={optimizing} onSubmit={() => save(text)}>
      <Field label="提示词正文"><textarea autoFocus required rows={14} value={text} disabled={optimizing}
        onChange={event => { setText(event.target.value); setSuggestion(undefined); setError('') }} /></Field>
      {optimizer?.enabled && <div className="goal-optimizer">
        <div className="action-row">
          <button type="button" className="button compact" disabled={optimizing || tooLong || !text.trim()} onClick={() => void optimize()}>
            <Sparkles size={15} />{optimizing ? '正在优化…' : '优化提示词'}
          </button>
          <span className="caption">{tooLong ? '优化支持最多 12000 字符。' : `将当前提示词正文发送给 ${optimizer.executorName}。`}</span>
        </div>
        <ErrorLine text={error} />
        {suggestion && <div className="optimizer-preview">
          <Field label="提示词优化建议"><textarea readOnly value={suggestion} rows={10} /></Field>
          <div className="action-row">
            <button type="button" className="button compact" onClick={() => setSuggestion(undefined)}>保留原文</button>
            <button type="button" className="button primary compact" onClick={() => { setText(suggestion); setSuggestion(undefined) }}>应用优化建议</button>
          </div>
        </div>}
      </div>}
    </EditForm>
  </Dialog>
}
