import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, Cable, ChevronRight, Folder, GitFork, KeyRound, Layers3, Settings } from 'lucide-react'
import type { Catalog, Iteration, Project, Run, RunSummary } from '../shared/contracts.ts'
import { defaultPreferences } from '../shared/preferences.ts'
import type { Preferences } from '../shared/preferences.ts'
import { request, runAction } from './api.ts'
import { AccountsView } from './AccountsView.tsx'
import { ProjectsView } from './catalog/ProjectsView.tsx'
import { TemplatesView } from './catalog/TemplatesView.tsx'
import { EnginesView } from './catalog/EnginesView.tsx'
import { PreferencesView } from './PreferencesView.tsx'
import { RunView } from './run/RunView.tsx'
import { TaskDialog } from './TaskDialog.tsx'
import { TaskHistory } from './TaskHistory.tsx'
import { applyTheme, watchSystemTheme } from './theme.ts'
import { ErrorLine, message } from './ui.tsx'

const pages = {
  projects: { label: '项目', icon: Folder }, runs: { label: '任务记录', icon: Activity },
  templates: { label: '流水线模板', icon: GitFork }, settings: { label: '引擎', icon: Cable },
  accounts: { label: '账户', icon: KeyRound }, preferences: { label: '配置', icon: Settings },
}
const navigation = ['projects', 'runs', 'templates', 'settings', 'accounts', 'preferences'] as const
type Page = keyof typeof pages

function location() {
  const [path, query] = window.location.hash.slice(1).split('?')
  const [page, id, branch, iterationId] = path.split('/').filter(Boolean)
  const validId = /^[a-z0-9-]{1,100}$/i
  return { page: (page && Object.hasOwn(pages, page) ? page : 'projects') as Page,
    id: ['projects', 'runs'].includes(page) && validId.test(id ?? '') ? id : '',
    iterationId: page === 'projects' && branch === 'iterations' && validId.test(iterationId ?? '') ? iterationId : '',
    focusElements: page === 'projects' && new URLSearchParams(query).get('section') === 'elements' }
}

const emptyCatalog: Catalog = { projects: [], iterations: [], resources: [], accounts: [], engines: [], templates: [] }

export function App() {
  const [route, setRoute] = useState(location)
  const [catalog, setCatalog] = useState(emptyCatalog)
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [preferences, setPreferences] = useState<Preferences>(defaultPreferences)
  const [service, setService] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [taskTarget, setTaskTarget] = useState<{ projectId: string; iterationId?: string; parent?: Run } | null>(null)
  const runsRequest = useRef(0)
  const refresh = useCallback(async () => setCatalog(await request<Catalog>('/catalog')), [])
  const refreshRuns = useCallback(async () => {
    const generation = ++runsRequest.current
    const list = await request<RunSummary[]>('/runs')
    if (generation === runsRequest.current) setRuns(list)
  }, [])
  const setArchived = useCallback(async (id: string, archived: boolean) => {
    const updated = await runAction(id, archived ? 'archive' : 'unarchive')
    setRuns(current => current.map(run => run.id === id ? { ...run, archivedAt: updated.archivedAt } : run))
    void refreshRuns().catch(() => {})
    return updated
  }, [refreshRuns])

  useEffect(() => {
    const update = () => { setRoute(location()); setTaskTarget(null); void refreshRuns().catch(() => {}) }
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [refreshRuns])
  useEffect(() => {
    let active = true
    const update = async () => {
      try {
        await Promise.all([refresh(), refreshRuns(), request<Preferences>('/preferences').then(setPreferences)])
        if (active) { setService('ready'); setError('') }
      } catch (error) {
        if (active) { setService('error'); setError(message(error)) }
      }
    }
    void update()
    const timer = window.setInterval(() => { void update() }, 5000)
    return () => { active = false; window.clearInterval(timer) }
  }, [refresh, refreshRuns])

  useEffect(() => {
    const theme = preferences.theme ?? 'auto'
    applyTheme(theme)
    try { localStorage.setItem('front-day-theme', theme) } catch { /* private mode */ }
    if (theme !== 'auto') return
    return watchSystemTheme(() => applyTheme('auto'))
  }, [preferences.theme])
  const go = (page: Page, id = '', iterationId?: string) => { window.location.hash = `/${page}${id ? `/${id}` : ''}${id && page === 'projects' && iterationId ? `/iterations/${iterationId}` : ''}` }
  const openRun = (id: string) => go('runs', id)
  const project = catalog.projects.find(project => project.id === route.id && route.page === 'projects')
  const iteration = catalog.iterations.find(item => item.id === route.iterationId && item.projectId === project?.id)
  const taskProject = catalog.projects.find(project => project.id === taskTarget?.projectId)
  const taskIteration = catalog.iterations.find(item => item.id === taskTarget?.iterationId && item.projectId === taskProject?.id)

  function continueTask(parent: Run) {
    if (!catalog.projects.some(item => item.id === parent.project.id) || (parent.iteration && !catalog.iterations.some(item => item.id === parent.iteration?.id))) {
      throw new Error('来源项目或迭代已删除，无法继续修改')
    }
    setTaskTarget({ projectId: parent.project.id, iterationId: parent.iteration?.id, parent })
  }

  return <div className="app">
    <aside className="sidebar"><a className="brand" href="#/projects"><span className="brand-mark"><Layers3 size={23} strokeWidth={1.8} /></span><span><strong>Front Day<span className="brand-dot">.</span></strong><small>前端的一天</small></span></a>
      <nav aria-label="工作区"><div className="nav-label">工作区</div>{navigation.map(page => {
        const { label, icon: Icon } = pages[page]
        const active = route.page === page
        return <a key={page} href={`#/${page}`} aria-current={active ? 'page' : undefined} className={active ? 'active' : ''}><Icon size={18} strokeWidth={1.8} /><span>{label}</span>{active && <ChevronRight size={15} className="nav-chevron" />}</a>
      })}</nav>
      <div className="sidebar-footer"><div className="service-indicator"><i className={service} /><div><strong>{service === 'ready' ? '本机服务在线' : service === 'loading' ? '正在连接' : '本机服务未连接'}</strong><small>本地数据</small></div></div></div>
    </aside>
    <div className="workspace"><header className="topbar"><div className="crumbs"><span>工作区</span><ChevronRight size={14} /><strong>{pages[route.page].label}</strong>
      {project && <><ChevronRight size={14} /><strong>{project.name}</strong></>}{iteration && <><ChevronRight size={14} /><strong>{iteration.name}</strong></>}
      {route.page === 'runs' && route.id && <><ChevronRight size={14} /><strong>任务详情</strong></>}</div></header>
      <main className={`main-content${route.page === 'runs' && route.id ? ' run-main' : ''}`}>
        <ErrorLine text={error} />
        {service === 'loading' ? <div className="loading">正在读取项目…</div> : <>
          {route.page === 'projects' && <ProjectsView catalog={catalog} refresh={refresh} projectId={route.id} iterationId={route.iterationId} focusElements={route.focusElements} select={(id, iterationId) => go('projects', id, iterationId)} recentTaskLimit={preferences.recentTaskLimit}
            startTask={(project: Project, iteration?: Iteration) => setTaskTarget({ projectId: project.id, iterationId: iteration?.id })} runs={runs} openRun={openRun} />}
          {route.page === 'runs' && <>
            {route.id && <RunView key={route.id} id={route.id} followOutput={preferences.followOutput} setArchived={setArchived} onContinue={continueTask} back={(projectId, iterationId) => go('projects', projectId,
              catalog.iterations.some(item => item.id === iterationId && item.projectId === projectId) ? iterationId : undefined)} />}
            <TaskHistory visible={!route.id} runs={runs} catalog={catalog} projects={() => go('projects')} open={openRun} setArchived={setArchived} />
          </>}
          {route.page === 'templates' && <TemplatesView catalog={catalog} refresh={refresh} />}
          {route.page === 'settings' && <EnginesView catalog={catalog} refresh={refresh} />}
          {route.page === 'accounts' && <AccountsView key={preferences.dataDirectory} catalog={catalog} refresh={refresh} />}
          {route.page === 'preferences' && <PreferencesView preferences={preferences} engines={catalog.engines} availability={catalog.engineAvailability}
            onSave={value => { setPreferences(value); void refresh().catch(() => {}) }} />}
        </>}
      </main>
    </div>
    {taskProject && (!taskTarget?.iterationId || taskIteration) && <TaskDialog project={taskProject} iteration={taskIteration} parent={taskTarget?.parent} catalog={catalog} preferences={preferences} close={() => setTaskTarget(null)}
      onStart={run => { setTaskTarget(null); openRun(run.id); void refreshRuns().catch(() => {}) }} />}
  </div>
}
