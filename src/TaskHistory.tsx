import { useState } from 'react'
import { Activity, Archive, ArchiveRestore, ArrowRight, ChevronRight, Search } from 'lucide-react'
import { statusLabels } from '../shared/contracts.ts'
import type { Catalog, RunSummary } from '../shared/contracts.ts'
import { taskTypeLabel } from '../shared/context.ts'
import { dateTime, Empty, ErrorLine, message, SectionHeading, Status } from './ui.tsx'

const viewModes = { list: '列表', project: '按项目', iteration: '按迭代' } as const
type ViewMode = keyof typeof viewModes

export function TaskHistory({ visible, runs, catalog, projects, open, setArchived }: {
  visible: boolean; runs: RunSummary[]; catalog: Catalog; projects: () => void; open: (id: string) => void
  setArchived: (id: string, archived: boolean) => Promise<unknown>
}) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [projectId, setProjectId] = useState('')
  const [iterationId, setIterationId] = useState('')
  const [mode, setMode] = useState<ViewMode>('list')
  const [archived, showArchived] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!visible) return null

  const projectNames = new Map([...runs].reverse().map(run => [run.projectId, run.projectName]))
  const iterationNames = new Map([...runs].reverse().flatMap(run => run.iterationId ? [[run.iterationId, run.iterationName ?? '迭代'] as const] : []))
  for (const project of catalog.projects) if (projectNames.has(project.id)) projectNames.set(project.id, project.name)
  for (const iteration of catalog.iterations) if (iterationNames.has(iteration.id)) iterationNames.set(iteration.id, iteration.name)
  const projectName = (run: RunSummary) => projectNames.get(run.projectId) ?? run.projectName
  const iterationName = (run: RunSummary) => iterationNames.get(run.iterationId ?? '') ?? run.iterationName
  const iterationsInScope = runs.filter(run => !projectId || projectId === run.projectId)
  const iterationChoices = new Map(iterationsInScope.flatMap(run => run.iterationId ? [[run.iterationId,
    projectId ? iterationName(run) : `${projectName(run)} · ${iterationName(run)}`] as const] : []))
  const inCurrentScope = runs.filter(run => !!run.archivedAt === archived)
  const search = query.trim().toLowerCase()
  const filtered = inCurrentScope.filter(run =>
    (!projectId || projectId === run.projectId) && (!iterationId || iterationId === (run.iterationId ?? 'unassigned')) &&
    (status === 'all' || status === run.status) &&
    `${run.title} ${projectName(run)} ${iterationName(run) ?? ''} ${taskTypeLabel(run.taskType)}`.toLowerCase().includes(search))
  if (archived) filtered.sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''))

  const groups = new Map<string, { label?: string; runs: RunSummary[] }>()
  for (const run of filtered) {
    const key = mode === 'list' ? '' : mode === 'project' ? run.projectId : `${run.projectId}/${run.iterationId ?? ''}`
    const existing = groups.get(key)
    if (existing) { existing.runs.push(run); continue }
    const label = mode === 'project' ? projectName(run) : mode === 'iteration' ? `${projectName(run)} · ${iterationName(run) ?? '未关联迭代'}` : undefined
    groups.set(key, { label, runs: [run] })
  }

  async function toggleArchive(run: RunSummary) {
    setBusy(true)
    setError('')
    try { await setArchived(run.id, !run.archivedAt) }
    catch (error) { setError(message(error)) }
    finally { setBusy(false) }
  }

  return <>
    <SectionHeading title="任务记录" description="回看各项目的任务目标、上下文和执行结果。"><button className="button" onClick={projects}>前往项目<ArrowRight size={16} /></button></SectionHeading>
    <ErrorLine text={error} />
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
          <label className="search"><Search size={17} /><input aria-label="搜索任务" placeholder="搜索任务、项目或迭代" value={query} onChange={event => setQuery(event.target.value)} /></label>
          <select aria-label="筛选项目" value={projectId} onChange={event => { setProjectId(event.target.value); setIterationId('') }}>
            <option value="">所有项目</option>{[...projectNames].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <select aria-label="筛选迭代" value={iterationId} onChange={event => setIterationId(event.target.value)}>
            <option value="">所有迭代</option>{iterationsInScope.some(run => !run.iterationId) && <option value="unassigned">未关联迭代</option>}
            {[...iterationChoices].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <select aria-label="筛选状态" value={status} onChange={event => setStatus(event.target.value)}><option value="all">所有状态</option>
            {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        </div>
        <h2 className="history-count">{filtered.length} 条任务</h2>
      </div>
      {filtered.length ? <div className="table-scroll"><table><thead><tr><th>任务</th><th>任务类型</th><th>状态</th><th>开始时间</th><th aria-label="操作" /></tr></thead>
        {[...groups].map(([key, group]) => <tbody key={key}>
          {group.label && <tr><th colSpan={5} scope="rowgroup" className="history-group"><h3>{group.label}</h3></th></tr>}
          {group.runs.map(run => <tr key={run.id}>
            <td><button className="row-link" onClick={() => open(run.id)}>{run.title}</button>
              {mode === 'list' && <small>{[projectName(run), iterationName(run)].filter(Boolean).join(' · ')}</small>}
              {mode === 'project' && iterationName(run) && <small>{iterationName(run)}</small>}
            </td>
            <td>{taskTypeLabel(run.taskType)}</td><td><Status status={run.status} /></td>
            <td className="date-cell">{dateTime(run.createdAt)}{run.archivedAt && <small>归档于 {dateTime(run.archivedAt)}</small>}</td>
            <td><div className="action-row history-actions">
              <button className="button compact" disabled={busy} aria-label={`${run.archivedAt ? '恢复' : '归档'}${run.title}`}
                onClick={() => void toggleArchive(run)}>{run.archivedAt ? <ArchiveRestore size={15} /> : <Archive size={15} />}{run.archivedAt ? '恢复' : '归档'}</button>
              <button className="icon-button" aria-label={`查看${run.title}`} onClick={() => open(run.id)}><ChevronRight size={17} /></button>
            </div></td>
          </tr>)}
        </tbody>)}
      </table></div> : <Empty icon={archived ? Archive : Activity} title={inCurrentScope.length ? '没有匹配的任务' : archived ? '还没有归档任务' : '还没有未归档任务'}>
        {inCurrentScope.length ? '试试调整搜索词或筛选条件。' : undefined}
      </Empty>}
    </section>
  </>
}
