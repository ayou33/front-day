import { useEffect, useMemo, useState } from 'react'
import { Activity, Archive, ArchiveRestore, ArrowLeft, ArrowRight, CircleAlert, CircleCheck, CircleDashed, FlaskConical, GitFork, Hourglass, LoaderCircle, Pencil, Play, Radio, RotateCcw, Square, Terminal } from 'lucide-react'
import { canArchiveTask, canEditTask, isApiExecutor, statusLabels, terminalStatuses } from '../../shared/contracts.ts'
import { taskTypeLabel } from '../../shared/context.ts'
import type { Catalog, ContextDifference, Conversation, Run, RunRecord } from '../../shared/contracts.ts'
import { apiTaskLimits } from '../../shared/prompt-optimizer.ts'
import type { PromptOptimizerSettings } from '../../shared/prompt-optimizer.ts'
import { request, runAction } from '../api.ts'
import { approvalLabels } from '../../shared/engines.ts'
import { ApprovalOptions, Check, dateTime, Empty, ErrorLine, formatDuration, message, Status } from '../ui.tsx'
import { InteractionCard } from './InteractionCard.tsx'
import { FileChanges } from './FileChanges.tsx'
import { ExecutionRecords } from './Conversation.tsx'
import { DesktopHandoff } from './DesktopHandoff.tsx'
import { OutputReader } from './OutputReader.tsx'
import { RunContext } from './RunContext.tsx'
import { RunOverview } from './RunOverview.tsx'
import { AgentResult, Transcript } from './Transcript.tsx'
import { splitHandoff } from '../../shared/continuations.ts'
import { useElapsed } from './useElapsed.ts'
import { details, textOf, timeline } from './run-text.ts'
import type { RecordData } from './run-text.ts'
import { useRun } from './useRun.ts'

export function RunView({ id, back, followOutput, setArchived, onContinue, onEdit, optimizer, catalog, focusTurn, executionFocus, showRecords }: {
  id: string; back: (projectId?: string, iterationId?: string) => void; followOutput: boolean
  setArchived: (id: string, archived: boolean) => Promise<RunRecord>
  onContinue: (run: Run) => void
  onEdit: (run: Run) => void
  optimizer?: PromptOptimizerSettings
  catalog: Catalog
  focusTurn?: string; executionFocus?: string; showRecords?: boolean
}) {
  const { run, archived, events, connected, error: loadError, accept } = useRun(id)
  const [stageOverride, setStageOverride] = useState<number | null>(null)
  const [attemptOverride, setAttemptOverride] = useState<number | null>(null)
  const [tab, setTab] = useState<'overview' | 'timeline' | 'context' | 'result' | 'files' | 'tools' | 'test' | 'native' | null>(null)
  const [recordsOpen, setRecordsOpen] = useState(!!showRecords)
  const [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState(false)
  const [refreshResources, setRefreshResources] = useState(true)
  const [pendingId, setPendingId] = useState('')
  const [difference, setDifference] = useState<ContextDifference>()
  const [conversation, setConversation] = useState<Conversation>()
  const unarchived = !!run
  const hasStarted = !!run && run.status !== 'saved'
  const turnRevision = recordsOpen || executionFocus ? events.findLast(event => event.kind === 'turn')?.seq : undefined
  useEffect(() => {
    if (!unarchived || !hasStarted) return
    let active = true
    void request<Conversation>(`/runs/${id}/conversation`).then(result => { if (active) setConversation(result) }).catch(() => {})
    return () => { active = false }
  }, [id, unarchived, hasStarted, run?.status, turnRevision])
  const branch = conversation?.branches.find(item => item.id === conversation.activeBranchId)
  const records = recordsOpen && conversation && branch ? { conversation, branch } : undefined
  const selectedTurn = executionFocus ? branch?.turns.find(turn => turn.runId === id && turn.id === focusTurn) : undefined
  const focusStage = selectedTurn?.stage
  const focusAttempt = selectedTurn?.attempt
  useEffect(() => {
    if (focusStage !== undefined) {
      setStageOverride(focusStage)
      setAttemptOverride(focusAttempt || null)
      setTab(executionFocus === 'files' || executionFocus === 'test' || executionFocus === 'tools' || executionFocus === 'native' ? executionFocus : 'timeline')
    } else if (!executionFocus && (focusTurn || showRecords)) {
      setRecordsOpen(true)
      setTab('overview')
    }
  }, [focusStage, focusAttempt, focusTurn, executionFocus, showRecords])
  const editable = !!run && canEditTask(run)
  const revision = run?.revision
  useEffect(() => {
    if (!editable) { setDifference(undefined); return }
    let active = true
    const refresh = () => {
      if (document.hidden) return
      void request<ContextDifference>(`/runs/${id}/context-difference`).then(value => { if (active) setDifference(value) })
        .catch(error => { if (active) setDifference({ changes: [], unavailable: message(error) }) })
    }
    refresh()
    const timer = window.setInterval(refresh, 5000)
    return () => { active = false; window.clearInterval(timer) }
  }, [editable, id, revision])
  const stageIndex = stageOverride ?? run?.stageIndex ?? 0
  const attempt = attemptOverride ?? (run?.status === 'queued' && stageIndex === run.stageIndex ? 0 : run?.attempts[stageIndex]?.length ?? 0)
  const stageEvents = useMemo(() => events.filter(event => event.stageIndex === stageIndex && event.attempt === attempt && event.kind !== 'state'), [events, stageIndex, attempt])
  const scopedTurn = selectedTurn?.stage === stageIndex && selectedTurn.attempt === attempt ? selectedTurn : undefined
  const filtered = useMemo(() => !scopedTurn?.seq || scopedTurn.legacy ? stageEvents : stageEvents.filter(event =>
    event.seq > scopedTurn.seq! && (!scopedTurn.end || event.seq < scopedTurn.end)), [stageEvents, scopedTurn?.seq, scopedTurn?.end, scopedTurn?.legacy])
  const frames = useMemo(() => timeline(filtered), [filtered])
  const toolFrames = useMemo(() => frames.filter(frame => frame.kind === 'agent_item' || frame.kind === 'test_output'), [frames])
  const messageFrames = useMemo(() => frames.filter(frame => frame.kind !== 'agent_item' && frame.kind !== 'test_output'), [frames])
  const elapsed = useElapsed(run)

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

  if (archived) return <div className="run-detail">
    <div className="run-back action-row"><a className="back-button" href="#/runs">返回任务记录</a></div>
    <div className="run-heading"><div><h1>{archived.title}</h1><div className="run-meta"><span>{archived.project.name}</span>
      {archived.iteration && <span>{archived.iteration.name}</span>}<span className="chip"><Archive size={13} />已归档</span></div></div>
      <button className="button primary" disabled={busy} onClick={() => void action('unarchive')}><ArchiveRestore size={15} />恢复任务</button>
    </div>
    <p className="caption">恢复任务后可以查看详情或继续操作。</p>
    <ErrorLine text={actionError} />
  </div>
  if (!run) return <><button className="back-button" onClick={() => back()}><ArrowLeft size={16} />项目</button>{loadError ? <ErrorLine text={loadError} /> : <div className="loading">正在读取任务…</div>}</>
  const status = run.status
  const stage = run.stages[stageIndex]
  const current = run.attempts[stageIndex]?.[attempt - 1]
  const saved = status === 'saved'
  const actionable = !terminalStatuses.has(status) && status !== 'stopping' && !saved
  const lastAcceptance = run.attempts[run.stageIndex]?.at(-1)?.acceptance
  const retry = ['failed', 'stopped', 'interrupted'].includes(status) || (status === 'succeeded' && ['failed', 'blocked'].includes(lastAcceptance?.status ?? ''))
  const atBranchTip = !branch || branch.latestRunId === id
  const canContinue = atBranchTip && (status === 'succeeded' || status === 'interrupted')
  const result = current?.output?.trim()
  const visibleTabs = ([['overview', '任务概览'], ['timeline', '执行过程'], ['context', '任务上下文'], ['result', '执行结果'], ['files', '文件变更'], ['test', '测试结果'], ['tools', '工具与日志'], ['native', '原始事件']] as const)
    .filter(([key]) => (key !== 'test' || stage.kind === 'test' || stage.acceptance === 'test') && (key !== 'result' || result) && (key !== 'files' || current))
  const preferredTab = tab ?? (saved ? 'context' : executionFocus ? 'timeline' : 'overview')
  const activeTab = visibleTabs.some(([key]) => key === preferredTab) ? preferredTab : 'timeline'
  const liveStage = run.stages[run.stageIndex]
  const liveAttempt = status === 'queued' ? undefined : run.attempts[run.stageIndex]?.at(-1)
  const processing = status === 'running' || status === 'stopping'
  const waiting = ['waiting_approval', 'waiting_input', 'waiting_stage', 'queued'].includes(status)
  const StateIcon = processing ? LoaderCircle : saved ? CircleDashed : waiting ? Hourglass : status === 'succeeded' ? CircleCheck : CircleAlert
  const pending = run.pending.find(item => item.id === pendingId) ?? run.pending[0]
  const hasInteractions = status === 'waiting_stage' || !!pending
  const historical = stageIndex < run.stageIndex || (attempt > 0 && (status === 'queued' || attempt !== run.attempts[stageIndex]?.length))
  const sentPrompt = textOf(details(stageEvents.find(event => event.kind === 'input' && event.name !== '补充消息')?.data).text)
  const handoffStage = stage.engine ? stageIndex : run.stages.findLastIndex((item, index) => item.engine && index < stageIndex)
  const contextStage = handoffStage < 0 ? stageIndex : handoffStage
  const desktopAttempt = contextStage === stageIndex ? current : run.attempts[contextStage]?.at(-1)
  return <div className={`run-detail${hasInteractions ? ' has-interactions' : ''}`}>
    <div className="run-back action-row">
      <button className="back-button" onClick={() => back(run.project.id, run.iteration?.id)}><ArrowLeft size={16} />{run.iteration ? '返回迭代' : '返回项目'}</button>
      <a className="back-button" href="#/runs">返回任务记录</a>
    </div>
    <div className="run-heading"><div><h1>{conversation?.title ?? run.title}</h1>
      <div className="run-meta"><span>{run.project.name}</span>{run.iteration && <span>{run.iteration.name}</span>}{run.goal && <span>{taskTypeLabel(run.taskType)}</span>}
        {run.templateName && <span><GitFork size={15} />{run.templateName}</span>}<span>开始于 {dateTime(run.createdAt)}</span>
        {run.durationMs !== undefined && <span>耗时 {formatDuration(run.durationMs)}</span>}</div></div>
      <div className="action-row">
        {saved && <button className="button primary" disabled={busy} onClick={() => { setStageOverride(null); setAttemptOverride(null); setTab('overview'); void action('start', { revision }) }}><Play size={15} />开始任务</button>}
        {canContinue && <button className="button primary" type="button" disabled={busy} onClick={() => {
          setActionError('')
          try { onContinue(run) } catch (error) { setActionError(message(error)) }
        }}><RotateCcw size={15} />继续修改</button>}
        {!atBranchTip && <a className="button" href={`#/runs/${encodeURIComponent(branch!.latestRunId)}`}>查看本分支最新任务</a>}
        {editable && <button className="button" disabled={busy} onClick={() => onEdit(run)}><Pencil size={15} />编辑任务</button>}
        {canArchiveTask(run) && !run.continuation && <button className="button" disabled={busy} onClick={() => void action('archive')}><Archive size={15} />归档任务</button>}
        {actionable && <button className="button" disabled={busy} onClick={() => void action('stop')}><Square size={14} />停止</button>}
        {retry && <><Check checked={refreshResources} onChange={setRefreshResources}>使用最新项目、迭代和要素</Check>
          <button className="button primary" disabled={busy} onClick={() => { setStageOverride(null); setAttemptOverride(null); setTab('overview'); void action('retry', { refreshResources }) }}><RotateCcw size={15} />{run.templateName ? '重试当前阶段' : '重试任务'}</button></>}
      </div>
    </div>
    <div className={`run-status-bar status--${status}`}>
      <div className="run-status-text" role="status"><StateIcon className={processing ? 'run-status-spinner' : undefined} size={20} aria-hidden="true" />
        <strong>{statusLabels[status]}</strong><span>{[liveStage?.name, liveAttempt && `第 ${liveAttempt.number} 次尝试`, liveAttempt?.endedAt && `结束于 ${dateTime(liveAttempt.endedAt)}`].filter(Boolean).join(' · ')}</span>
        {elapsed !== undefined && elapsed > 0 && !terminalStatuses.has(status) && status !== 'saved' && <span>已执行 {formatDuration(elapsed)}</span>}
      </div>
      {actionable && run.stages.slice(run.stageIndex).some(item => item.engine) && <label className="run-approval-mode"><span>授权模式</span>
        <select disabled={busy} value={run.approvalMode ?? ''} title={`当前模式：${approvalLabels[run.approvalMode ?? liveStage?.engine?.approvalMode ?? 'manual']}`}
          onChange={event => void action('approval', { mode: event.target.value || undefined })}><ApprovalOptions inherit /></select>
      </label>}
    </div>
    <ErrorLine text={actionError || (terminalStatuses.has(status) ? run.error : '') || ''} />
    {current?.acceptance && <section className="acceptance-note" aria-label="阶段目标验收">
      <strong>{{ passed: '验收通过', failed: '验收未通过', blocked: '验收受阻', unchecked: '未自动验收' }[current.acceptance.status]}</strong>
      <span>{current.acceptance.message}</span>
      {!!current.acceptance.files?.length && <button className="row-link" onClick={() => setTab('files')}>查看文件变更</button>}
    </section>}
    {stage.engine && isApiExecutor(stage.engine) && <details className="event-item api-usage"><summary>API 用量与执行限制</summary>
      <div className="scope-body">
        {current?.apiMetrics && <p>已调用 {current.apiMetrics.rounds} / {apiTaskLimits.rounds} 轮 · 厂商请求累计 {current.apiMetrics.elapsedMs.toLocaleString()} ms
          {current.apiMetrics.inputTokens !== undefined && ` · 输入 ${current.apiMetrics.inputTokens.toLocaleString()} tokens`}
          {current.apiMetrics.outputTokens !== undefined && ` · 输出 ${current.apiMetrics.outputTokens.toLocaleString()} tokens`}
          {current.apiMetrics.totalTokens !== undefined && ` · 总计 ${current.apiMetrics.totalTokens.toLocaleString()} tokens`}</p>}
        {current?.apiMetrics && current.apiMetrics.measuredRounds < current.apiMetrics.rounds && <p className="caption">部分调用未收到厂商 token 统计。</p>}
        <p className="caption">每阶段 {apiTaskLimits.rounds} 轮，上报用量预算 {apiTaskLimits.tokens.toLocaleString()} tokens，输入上限 {apiTaskLimits.inputChars.toLocaleString()} 字符。文件上限 2 MB，每次读取 16 KB，单次补丁 8 KB。</p>
      </div>
    </details>}
    {hasInteractions && <div className="run-interactions" aria-label="待处理的交互">
      {status === 'waiting_stage' && <section className="gate panel"><Hourglass size={21} /><div><h3>等待人工放行</h3><p>
        「{liveStage.name}」已完成，请核对验收结果后继续。</p></div><button className="button primary" disabled={busy} onClick={() => { setStageOverride(null); setAttemptOverride(null); setTab('overview'); void action('advance') }}>放行下一阶段<ArrowRight size={16} /></button></section>}
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
          return <button key={index} className={`run-stage ${stageIndex === index ? 'active' : ''}`} onClick={() => {
            setStageOverride(index === run.stageIndex ? null : index)
            setAttemptOverride(null)
            setTab(currentTab => currentTab === 'files' ? 'files' : saved ? 'context' : 'timeline')
          }}>
            <Icon size={17} /><div><strong>{stage.name}</strong><small>{stage.engine?.name || '本地测试命令'}</small></div>{index === run.stageIndex && <i />}
          </button>
        })}
      </aside>}
      <div className="run-output-column">
        <section className="panel event-panel"><div className="panel-header"><div><h2>{run.templateName ? stage.name : '任务执行'}</h2><p>{stage.kind === 'test' ? '退出码、日志与 Agent 解读' : stage.engine?.name}</p></div><div className="action-row">
          {activeTab === 'overview' && conversation && branch && <button className="button compact" type="button" aria-expanded={recordsOpen}
            onClick={() => setRecordsOpen(value => !value)}>
            <GitFork size={15} />{recordsOpen ? '收起执行记录' : '展开执行记录'}
          </button>}
          <DesktopHandoff key={contextStage} run={run} stageIndex={contextStage} attempt={desktopAttempt} />
          {actionable && <span className={`connection ${connected ? 'online' : ''}`}><Radio size={14} />{connected ? '实时连接' : '正在重连'}</span>}
          {(run.attempts[stageIndex].length > 1 || (!attempt && run.attempts[stageIndex].length > 0)) && <select aria-label="尝试记录" value={attempt} onChange={event => setAttemptOverride(Number(event.target.value) || null)}>
            {status === 'queued' && stageIndex === run.stageIndex && <option value={0}>正在排队</option>}
            {run.attempts[stageIndex].map(attempt => <option value={attempt.number} key={attempt.number}>第 {attempt.number} 次</option>)}
          </select>}
        </div></div>
          <OutputReader viewKey={`${stageIndex}:${attempt}:${activeTab}:${activeTab === 'overview' && recordsOpen}:${focusTurn ?? ''}`} followInitially={followOutput && !focusTurn && (activeTab === 'timeline' || activeTab === 'tools')}
            toolbar={navigation => <div className="run-toolbar">
              <div className="tabs" role="tablist" aria-label="任务执行详情">{visibleTabs.map(([key, label]) =>
                <button role="tab" aria-selected={key === activeTab} key={key} className={key === activeTab ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</div>
              {navigation}
            </div>}>
            {historical && current?.error && <div className="attempt-error"><ErrorLine text={current.error} /></div>}
            {activeTab === 'overview' && <div className={`run-overview-page${records ? ' with-records' : ''}`}>
              {records && <section className="run-records" aria-label="执行记录">
                <ExecutionRecords conversation={records.conversation} branch={records.branch} focus={focusTurn} />
              </section>}
              <section className="run-overview-panel" aria-label="任务概览">
                {records && <header className="run-zone-head">
                  <div><h2>任务概览</h2><p>当前任务的目标、变更与最终结果</p></div>
                </header>}
                <RunOverview run={run} onInspect={(index, selected) => { setStageOverride(index); setAttemptOverride(null); setTab(selected) }} />
              </section>
            </div>}
            {activeTab === 'timeline' && (messageFrames.length ? <Transcript frames={messageFrames} /> : <Empty icon={Activity} title="暂无执行消息">开始执行后将在这里显示进度。</Empty>)}
            {activeTab === 'context' && <RunContext run={run} stageIndex={stageIndex} sentPrompt={sentPrompt} handoff={current?.handoff ?? (result ? splitHandoff(result).handoff : undefined)} historical={historical} optimizer={optimizer}
              onSaved={accept} difference={difference} catalog={catalog} />}
            {activeTab === 'result' && result && <div className="output-result"><AgentResult text={result} handoff={current?.handoff} /></div>}
            {activeTab === 'files' && current && <FileChanges attempt={current} />}
            {activeTab === 'tools' && (toolFrames.length ? <Transcript frames={toolFrames} /> : <Empty icon={Terminal} title="暂无工具日志" />)}
            {activeTab === 'test' && (current?.test ? <div className="test-detail"><div className="test-header"><Status status={current.test.code === 0 ? 'succeeded' : 'failed'} />
              <span>退出码 {current.test.code ?? '—'}</span><span>{current.test.ms} ms</span>{current.test.signal && <span>{current.test.signal}</span>}</div>
              <ErrorLine text={current.test.error ?? current.analysisError ?? ''} /><Transcript frames={toolFrames.filter(frame => frame.kind === 'test_output')} />
            </div> : <Empty icon={FlaskConical} title="暂无测试结果">测试命令结束后会在这里记录结果。</Empty>)}
            {activeTab === 'native' && (filtered.some(event => event.kind === 'native') ? <div className="raw-events">{filtered.filter(event => event.kind === 'native').map(event => <details className="event-item" key={event.seq}><summary><code>{event.name}</code><small>#{event.seq}</small></summary><pre>{JSON.stringify(event.data, null, 2)}</pre></details>)}</div> : <Empty icon={Terminal} title="暂无原始事件" />)}
          </OutputReader>
        </section>
      </div>
    </div>
  </div>
}
