import { Fragment, useEffect, useState } from 'react'
import { Activity, Archive, ArchiveRestore, ArrowRight, ChevronRight, GitFork, Search } from 'lucide-react'
import { canArchiveTask, statusLabels } from '../shared/contracts.ts'
import type { Catalog, RunPage, RunSummary } from '../shared/contracts.ts'
import { continuationLabels } from '../shared/continuations.ts'
import { taskTypeLabel } from '../shared/context.ts'
import { request } from './api.ts'
import { dateTime, Empty, ErrorLine, formatDuration, message, SectionHeading, Status } from './ui.tsx'

const viewModes = { list: '列表', project: '按项目', iteration: '按迭代' } as const
type ViewMode = keyof typeof viewModes

export function TaskHistory({ visible, catalog, projects, open, setArchived }: {
  visible: boolean; catalog: Catalog; projects: () => void; open: (id: string) => void
  setArchived: (id: string, archived: boolean) => Promise<unknown>
}) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [projectId, setProjectId] = useState('')
  const [iterationId, setIterationId] = useState('')
  const [mode, setMode] = useState<ViewMode>('list')
  const [archived, showArchived] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [version, refreshPage] = useState(0)
  const [page, setPage] = useState<{ key: string; value: RunPage }>()
  const [pages, setPages] = useState<{ filter: string; cursors: string[] }>({ filter: '', cursors: [] })
  const filter = new URLSearchParams({ archived: archived ? '1' : '0', ...(projectId && { projectId }), ...(iterationId && { iterationId }),
    ...(status !== 'all' && { status }), ...(query.trim() && { query: query.trim() }) }).toString()
  const cursors = pages.filter === filter ? pages.cursors : []
  const cursor = cursors.at(-1)
  const key = filter + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')
  useEffect(() => {
    if (!visible) return
    let active = true
    const update = () => {
      if (document.hidden) return
      void request<RunPage>(`/runs/page?${key}`).then(value => {
        if (active) { setPage({ key, value }); setLoadError('') }
      }).catch(error => { if (active) setLoadError(message(error)) })
    }
    const debounce = window.setTimeout(update, 120)
    const timer = window.setInterval(update, 5000)
    document.addEventListener('visibilitychange', update)
    return () => { active = false; window.clearTimeout(debounce); window.clearInterval(timer); document.removeEventListener('visibilitychange', update) }
  }, [key, version, visible])
  if (!visible) return null
  const current = page?.key === key ? page.value : undefined
  const projectNames = new Map([...(page?.value.projects ?? []), ...catalog.projects].map(item => [item.id, item.name]))
  const iterations = new Map([...(page?.value.iterations ?? []), ...catalog.iterations].map(item => [item.id, item]))
  const iterationNames = new Map([...iterations].map(([id, item]) => [id, item.name]))
  const projectName = (run: RunSummary) => projectNames.get(run.projectId) ?? run.projectName
  const iterationName = (run: RunSummary) => iterationNames.get(run.iterationId ?? '') ?? run.iterationName
  const iterationChoices = [...iterations.values()].filter(item => !projectId || item.projectId === projectId)
    .map(item => [item.id, projectId ? item.name : `${projectNames.get(item.projectId) ?? '项目'} · ${item.name}`] as const)
  const matchedRecords = (current?.records ?? []).map(({ source, runs }) => {
    const run = runs.find(item => item.id === source.id) ?? runs[0]
    return { source, run, related: runs.filter(item => item.id !== run.id), latest: runs[0] }
  })
  const groups = new Map<string, { label?: string; records: typeof matchedRecords }>()
  for (const record of matchedRecords) {
    const { run } = record
    const key = mode === 'list' ? '' : mode === 'project' ? run.projectId : `${run.projectId}/${run.iterationId ?? ''}`
    const existing = groups.get(key)
    if (existing) { existing.records.push(record); continue }
    const label = mode === 'project' ? projectName(run) : mode === 'iteration' ? `${projectName(run)} · ${iterationName(run) ?? '未关联迭代'}` : undefined
    groups.set(key, { label, records: [record] })
  }

  async function toggleArchive(run: RunSummary) {
    setBusy(true)
    setError('')
    try { await setArchived(run.id, !run.archivedAt); refreshPage(value => value + 1) }
    catch (error) { setError(message(error)) }
    finally { setBusy(false) }
  }

  function renderRow(run: RunSummary, record?: (typeof matchedRecords)[number]) {
    const isExpanded = !!record && expanded.has(record.source.id)
    return <tr key={run.id} className={record ? undefined : 'history-followup'}>
      <td>{run.archivedAt ? <strong>{run.title}</strong> : <button className="row-link" onClick={() => open(run.id)}>{run.title}</button>}
        {record && mode === 'list' && <small>{[projectName(run), iterationName(run)].filter(Boolean).join(' · ')}</small>}
        {record && mode === 'project' && iterationName(run) && <small>{iterationName(run)}</small>}
        {run.continuation && <small>{[record && run.id !== record.source.id && `源任务 · ${record.source.title}`,
          `续改自 ${run.continuation.parentTitle}`, run.contextMode && continuationLabels[run.contextMode]].filter(Boolean).join(' · ')}</small>}
        {record && record.latest.id !== run.id && <small>最近续改 · {record.latest.title} · {statusLabels[record.latest.status]}</small>}
        {record && record.related.length > 0 && <button className="button compact history-expand" aria-expanded={isExpanded}
          onClick={() => setExpanded(previous => {
            const updated = new Set(previous)
            if (updated.has(record.source.id)) updated.delete(record.source.id)
            else updated.add(record.source.id)
            return updated
          })}><GitFork size={14} />续改记录 {record.related.length} 条</button>}
      </td>
      <td>{taskTypeLabel(run.taskType)}</td><td><Status status={run.status} /></td>
      <td className="date-cell">{dateTime(run.createdAt)}{run.archivedAt && <small>归档于 {dateTime(run.archivedAt)}</small>}</td>
      <td className="date-cell">{formatDuration(run.durationMs) || '—'}</td>
      <td><div className="action-row history-actions">
        {(run.archivedAt || canArchiveTask(run)) && !run.continuation && <button className="button compact" disabled={busy} aria-label={`${run.archivedAt ? '恢复' : '归档'}${run.title}`}
          onClick={() => void toggleArchive(run)}>{run.archivedAt ? <ArchiveRestore size={15} /> : <Archive size={15} />}{run.archivedAt ? '恢复' : '归档'}</button>}
        {!run.archivedAt && <button className="icon-button" aria-label={`查看${run.title}`} onClick={() => open(run.id)}><ChevronRight size={17} /></button>}
      </div></td>
    </tr>
  }

  return <>
    <SectionHeading title="任务记录" description="回看各项目的任务目标、上下文和执行结果。"><button className="button" onClick={projects}>前往项目<ArrowRight size={16} /></button></SectionHeading>
    <ErrorLine text={error || loadError} />
    <section className="panel runs-panel">
      <div className="panel-header history-toolbar">
        <div className="history-switch" role="group" aria-label="归档范围">
          <button type="button" className="button compact" aria-pressed={!archived} onClick={() => showArchived(false)}>未归档</button>
          <button type="button" className="button compact" aria-pressed={archived} onClick={() => showArchived(true)}><Archive size={14} />已归档</button>
        </div>
        <div className="history-switch" role="group" aria-label="查看方式">
          {Object.entries(viewModes).map(([value, label]) => <button type="button" key={value} className="button compact" aria-pressed={value === mode}
            onClick={() => setMode(value as ViewMode)}>{label}</button>)}
        </div>
        <div className="action-row history-filters">
          <label className="search"><Search size={17} /><input aria-label="搜索任务" placeholder="搜索任务、项目或迭代" maxLength={200} value={query} onChange={event => setQuery(event.target.value)} /></label>
          <select aria-label="筛选项目" value={projectId} onChange={event => { setProjectId(event.target.value); setIterationId('') }}>
            <option value="">所有项目</option>{[...projectNames].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <select aria-label="筛选迭代" value={iterationId} onChange={event => setIterationId(event.target.value)}>
            <option value="">所有迭代</option><option value="unassigned">未关联迭代</option>
            {[...iterationChoices].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <select aria-label="筛选状态" value={status} onChange={event => setStatus(event.target.value)}><option value="all">所有状态</option>
            {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        </div>
        <h2 className="history-count">{matchedRecords.length} 条任务</h2>
      </div>
      {matchedRecords.length ? <div className="table-scroll"><table><thead><tr><th>任务</th><th>任务类型</th><th>状态</th><th>开始时间</th><th>耗时</th><th aria-label="操作" /></tr></thead>
        {[...groups].map(([key, group]) => <tbody key={key}>
          {group.label && <tr><th colSpan={6} scope="rowgroup" className="history-group"><h3>{group.label}</h3></th></tr>}
          {group.records.map(record => <Fragment key={record.source.id}>{renderRow(record.run, record)}
            {expanded.has(record.source.id) && record.related.map(run => renderRow(run))}
          </Fragment>)}
        </tbody>)}
      </table></div> : current ? <Empty icon={archived ? Archive : Activity}
        title={current.scopeHasRuns ? '没有匹配的任务' : archived ? '还没有归档任务' : '还没有未归档任务'} />
        : !loadError && <div className="scope-body caption">正在读取任务记录…</div>}
      {(cursors.length > 0 || current?.next) && <div className="scope-body history-pages">
        <button className="button compact" disabled={!cursors.length} onClick={() => setPages({ filter, cursors: cursors.slice(0, -1) })}>上一页</button>
        <span className="caption">第 {cursors.length + 1} 页</span>
        <button className="button compact" disabled={!current?.next} onClick={() => {
          if (current?.next) setPages({ filter, cursors: [...cursors, current.next] })
        }}>下一页</button>
      </div>}
    </section>
  </>
}
