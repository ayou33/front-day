import { useMemo, useState } from 'react'
import { Activity, Archive, ArchiveRestore, ArrowLeft, ArrowRight, CircleAlert, CircleCheck, CircleDashed, FlaskConical, GitFork, Hourglass, LoaderCircle, Radio, RotateCcw, Send, Square, Terminal } from 'lucide-react'
import { statusLabels, terminalStatuses } from '../../shared/contracts.ts'
import { taskTypeLabel } from '../../shared/context.ts'
import type { Run } from '../../shared/contracts.ts'
import { runAction } from '../api.ts'
import { approvalLabels } from '../../shared/engines.ts'
import { continuationLabels } from '../../shared/continuations.ts'
import { ApprovalOptions, Check, dateTime, Empty, ErrorLine, message, Status } from '../ui.tsx'
import { InteractionCard } from './InteractionCard.tsx'
import { OutputReader } from './OutputReader.tsx'
import { RunContext } from './RunContext.tsx'
import { MessageText, Transcript } from './Transcript.tsx'
import { details, textOf, timeline } from './run-text.ts'
import type { RecordData } from './run-text.ts'
import { useRun } from './useRun.ts'

export function RunView({ id, back, followOutput, setArchived, onContinue }: {
  id: string; back: (projectId?: string, iterationId?: string) => void; followOutput: boolean
  setArchived: (id: string, archived: boolean) => Promise<Run>
  onContinue: (run: Run) => void
}) {
  const { run, events, connected, error: loadError, accept } = useRun(id)
  const [stageOverride, setStageOverride] = useState<number | null>(null)
  const [attemptOverride, setAttemptOverride] = useState<number | null>(null)
  const [tab, setTab] = useState<'timeline' | 'context' | 'result' | 'tools' | 'test' | 'native'>('timeline')
  const [followup, setFollowup] = useState('')
  const [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState(false)
  const [refreshResources, setRefreshResources] = useState(true)
  const [pendingId, setPendingId] = useState('')
  const stageIndex = stageOverride ?? run?.stageIndex ?? 0
  const attempt = attemptOverride ?? (run?.status === 'queued' && stageIndex === run.stageIndex ? 0 : run?.attempts[stageIndex]?.length ?? 0)
  const filtered = useMemo(() => events.filter(event => event.stageIndex === stageIndex && event.attempt === attempt && event.kind !== 'state'), [events, stageIndex, attempt])
  const frames = useMemo(() => timeline(filtered), [filtered])
  const toolFrames = useMemo(() => frames.filter(frame => frame.kind === 'agent_item' || frame.kind === 'test_output'), [frames])
  const messageFrames = useMemo(() => frames.filter(frame => frame.kind !== 'agent_item' && frame.kind !== 'test_output'), [frames])

  async function action(action: string, body: RecordData = {}) {
    if (busy) return false
    setBusy(true)
    setActionError('')
    try {
      const updated = action === 'archive' || action === 'unarchive' ? await setArchived(id, action === 'archive') : await runAction(id, action, body)
      accept(updated)
      return true
    }
    catch (error) { setActionError(message(error)); return false }
    finally { setBusy(false) }
  }

  if (!run) return <><button className="back-button" onClick={() => back()}><ArrowLeft size={16} />项目</button>{loadError ? <ErrorLine text={loadError} /> : <div className="loading">正在读取任务…</div>}</>
  const status = run.status
  const stage = run.stages[stageIndex]
  const current = run.attempts[stageIndex]?.[attempt - 1]
  const actionable = !terminalStatuses.has(status) && status !== 'stopping'
  const retry = ['failed', 'stopped', 'interrupted'].includes(status)
  const canFollowup = actionable && !!run.attempts[run.stageIndex]?.at(-1)?.sessionId && status !== 'queued'
  const result = current?.output?.trim()
  const visibleTabs = ([['timeline', '执行过程'], ['context', '任务上下文'], ['result', '执行结果'], ['test', '测试结果'], ['tools', '工具与日志'], ['native', '原始事件']] as const)
    .filter(([key]) => (key !== 'test' || stage.kind === 'test') && (key !== 'result' || result))
  const activeTab = visibleTabs.some(([key]) => key === tab) ? tab : 'timeline'
  const liveStage = run.stages[run.stageIndex]
  const liveAttempt = status === 'queued' ? undefined : run.attempts[run.stageIndex]?.at(-1)
  const contextMode = liveAttempt?.contextMode ?? run.attempts.flat().findLast(item => item.contextMode)?.contextMode
  const processing = status === 'running' || status === 'stopping'
  const waiting = ['waiting_approval', 'waiting_input', 'waiting_stage', 'queued'].includes(status)
  const StateIcon = processing ? LoaderCircle : waiting ? Hourglass : status === 'succeeded' ? CircleCheck : CircleAlert
  const pending = run.pending.find(item => item.id === pendingId) ?? run.pending[0]
  const hasInteractions = status === 'waiting_stage' || !!pending
  const historical = stageIndex < run.stageIndex || (attempt > 0 && (status === 'queued' || attempt !== run.attempts[stageIndex]?.length))
  const sentPrompt = textOf(details(filtered.find(event => event.kind === 'input' && event.name !== '补充消息')?.data).text)
  return <div className={`run-detail${hasInteractions ? ' has-interactions' : ''}`}>
    <div className="run-back action-row">
      <button className="back-button" onClick={() => back(run.project.id, run.iteration?.id)}><ArrowLeft size={16} />{run.iteration ? '返回迭代' : '返回项目'}</button>
      <a className="back-button" href="#/runs">返回任务记录</a>
    </div>
    <div className="run-heading"><div><h1>{run.title}</h1>
      <div className="run-meta"><span>{run.project.name}</span>{run.iteration && <span>{run.iteration.name}</span>}{run.goal && <span>{taskTypeLabel(run.taskType)}</span>}
        {run.templateName && <span><GitFork size={15} />{run.templateName}</span>}<span>开始于 {dateTime(run.createdAt)}</span>
        {run.archivedAt && <span className="chip"><Archive size={13} />已归档</span>}
        {run.continuation && <a href={`#/runs/${encodeURIComponent(run.continuation.parentId)}`}>来源任务 · {run.continuation.parentTitle}</a>}
        {contextMode && <span className="chip">{continuationLabels[contextMode]}</span>}</div></div>
      <div className="action-row">
        {status === 'succeeded' && !run.archivedAt && <button className="button primary" onClick={() => {
          setActionError('')
          try { onContinue(run) } catch (error) { setActionError(message(error)) }
        }}><GitFork size={15} />继续修改</button>}
        <button className="button" disabled={busy} onClick={() => void action(run.archivedAt ? 'unarchive' : 'archive')}>
          {run.archivedAt ? <ArchiveRestore size={15} /> : <Archive size={15} />}{run.archivedAt ? '恢复任务' : '归档任务'}</button>
        {actionable && <button className="button" disabled={busy} onClick={() => void action('stop')}><Square size={14} />停止</button>}
        {retry && <><Check checked={refreshResources} onChange={setRefreshResources}>使用最新项目、迭代和要素</Check>
          <button className="button primary" disabled={busy} onClick={() => { setStageOverride(null); setAttemptOverride(null); setTab('timeline'); void action('retry', { refreshResources }) }}><RotateCcw size={15} />{run.templateName ? '重试当前阶段' : '重试任务'}</button></>}
      </div>
    </div>
    <div className={`run-status-bar status--${status}`}>
      <div className="run-status-text" role="status"><StateIcon className={processing ? 'run-status-spinner' : undefined} size={20} aria-hidden="true" />
        <strong>{statusLabels[status]}</strong><span>{[liveStage?.name, liveAttempt && `第 ${liveAttempt.number} 次尝试`, liveAttempt?.endedAt && `结束于 ${dateTime(liveAttempt.endedAt)}`].filter(Boolean).join(' · ')}</span>
      </div>
      {actionable && run.stages.slice(run.stageIndex).some(item => item.engine) && <label className="run-approval-mode"><span>授权模式</span>
        <select disabled={busy} value={run.approvalMode ?? ''} title={`当前模式：${approvalLabels[run.approvalMode ?? liveStage?.engine?.approvalMode ?? 'manual']}`}
          onChange={event => void action('approval', { mode: event.target.value || undefined })}><ApprovalOptions inherit /></select>
      </label>}
    </div>
    <ErrorLine text={actionError || (terminalStatuses.has(status) ? run.error : '') || ''} />
    {hasInteractions && <div className="run-interactions" aria-label="待处理的交互">
      {status === 'waiting_stage' && <section className="gate panel"><Hourglass size={21} /><div><h3>等待人工放行</h3><p>「{liveStage.name}」已完成，可确认结果后继续。</p></div><button className="button primary" disabled={busy} onClick={() => { setStageOverride(null); setAttemptOverride(null); setTab('timeline'); void action('advance') }}>放行下一阶段<ArrowRight size={16} /></button></section>}
      {run.pending.length > 1 && <label className="pending-select">待处理请求 <select value={pending?.id} onChange={event => setPendingId(event.target.value)}>
        {run.pending.map((item, index) => <option value={item.id} key={item.id}>{index + 1} / {run.pending.length} · {item.title}</option>)}
      </select></label>}
      {pending && <InteractionCard key={pending.id} interaction={pending} disabled={busy || !actionable} onAnswer={body => void action(`interactions/${encodeURIComponent(pending.id)}`, body)} />}
    </div>}
    <div className={`run-layout${run.templateName ? '' : ' direct-task'}`}>
      {run.templateName && <aside className="panel run-stages"><div className="panel-header"><div><h2>阶段</h2><p className="mono path" title={run.project.directory}>{run.project.directory}</p></div></div>
        {run.stages.map((stage, index) => {
          const last = run.attempts[index].at(-1)
          const Icon = last?.status === 'succeeded' ? CircleCheck : index === run.stageIndex && actionable ? Activity : CircleDashed
          return <button key={index} className={`run-stage ${stageIndex === index ? 'active' : ''}`} onClick={() => { setStageOverride(index === run.stageIndex ? null : index); setAttemptOverride(null); setTab('timeline') }}>
            <Icon size={17} /><div><strong>{stage.name}</strong><small>{stage.engine?.name || '本地测试命令'}</small></div>{index === run.stageIndex && <i />}
          </button>
        })}
      </aside>}
      <div className="run-output-column">
        <section className="panel event-panel"><div className="panel-header"><div><h2>{run.templateName ? stage.name : 'Agent 执行'}</h2><p>{stage.kind === 'test' ? '退出码、日志与 Agent 解读' : stage.engine?.name}</p></div><div className="action-row">
          {actionable && <span className={`connection ${connected ? 'online' : ''}`}><Radio size={14} />{connected ? '实时连接' : '正在重连'}</span>}
          {(run.attempts[stageIndex].length > 1 || (!attempt && run.attempts[stageIndex].length > 0)) && <select aria-label="尝试记录" value={attempt} onChange={event => setAttemptOverride(Number(event.target.value) || null)}>
            {status === 'queued' && stageIndex === run.stageIndex && <option value={0}>正在排队</option>}
            {run.attempts[stageIndex].map(attempt => <option value={attempt.number} key={attempt.number}>第 {attempt.number} 次</option>)}
          </select>}
        </div></div>
          <div className="tabs" role="tablist" aria-label="任务执行详情">{visibleTabs.map(([key, label]) =>
            <button role="tab" aria-selected={key === activeTab} key={key} className={key === activeTab ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</div>
          <OutputReader key={`${stageIndex}:${attempt}:${activeTab}`} followInitially={followOutput && (activeTab === 'timeline' || activeTab === 'tools')}>
            {historical && current?.error && <div className="attempt-error"><ErrorLine text={current.error} /></div>}
            {activeTab === 'timeline' && (messageFrames.length ? <Transcript frames={messageFrames} /> : <Empty icon={Activity} title="暂无执行消息">开始执行后将在这里显示进度。</Empty>)}
            {activeTab === 'context' && <RunContext run={run} sentPrompt={sentPrompt} handoff={current?.handoff} historical={historical} />}
            {activeTab === 'result' && result && <div className="output-result"><MessageText text={result} /></div>}
            {activeTab === 'tools' && (toolFrames.length ? <Transcript frames={toolFrames} /> : <Empty icon={Terminal} title="暂无工具日志" />)}
            {activeTab === 'test' && (current?.test ? <div className="test-detail"><div className="test-header"><Status status={current.test.code === 0 ? 'succeeded' : 'failed'} />
              <span>退出码 {current.test.code ?? '—'}</span><span>{current.test.ms} ms</span>{current.test.signal && <span>{current.test.signal}</span>}</div>
              <ErrorLine text={current.test.error ?? current.analysisError ?? ''} /><Transcript frames={toolFrames.filter(frame => frame.kind === 'test_output')} />
            </div> : <Empty icon={FlaskConical} title="暂无测试结果">测试命令结束后会在这里记录结果。</Empty>)}
            {activeTab === 'native' && (filtered.some(event => event.kind === 'native') ? <div className="raw-events">{filtered.filter(event => event.kind === 'native').map(event => <details className="event-item" key={event.seq}><summary><code>{event.name}</code><small>#{event.seq}</small></summary><pre>{JSON.stringify(event.data, null, 2)}</pre></details>)}</div> : <Empty icon={Terminal} title="暂无原始事件" />)}
          </OutputReader>
          {canFollowup && <form className="followup" onSubmit={event => { event.preventDefault(); if (followup.trim()) void action('followup', { text: followup }).then(sent => { if (sent) setFollowup('') }) }}>
            <input placeholder="补充给当前阶段的 Agent…" aria-label="补充消息" value={followup} onChange={event => setFollowup(event.target.value)} />
            <button className="button primary" disabled={!followup.trim() || busy}><Send size={15} />发送</button>
          </form>}
        </section>
      </div>
    </div>
  </div>
}
