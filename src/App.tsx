import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, Cable, CalendarRange, ChevronRight, Folder, GitFork, KeyRound, Layers3, LifeBuoy, LoaderCircle, Settings } from 'lucide-react'
import type { Catalog, Iteration, PlanItem, Project, Run, RunSummary } from '../shared/contracts.ts'
import { localPlanDate } from '../shared/plans.ts'
import { defaultPreferences } from '../shared/preferences.ts'
import type { Preferences } from '../shared/preferences.ts'
import { request, runAction } from './api.ts'
import { AccountsView } from './AccountsView.tsx'
import { ProjectsView } from './catalog/ProjectsView.tsx'
import { TemplatesView } from './catalog/TemplatesView.tsx'
import { EnginesView } from './catalog/EnginesView.tsx'
import { PlanBrief } from './PlanBrief.tsx'
import { planBriefing } from './plan-summary.ts'
import { PlansView } from './PlansView.tsx'
import { PreferencesView } from './PreferencesView.tsx'
import { RunView } from './run/RunView.tsx'
import { TaskDialog } from './TaskDialog.tsx'
import { TaskHistory } from './TaskHistory.tsx'
import { applyTheme, watchSystemTheme } from './theme.ts'
import { ErrorLine, message } from './ui.tsx'

const pages = {
  projects: { label: '项目', icon: Folder }, plans: { label: '计划', icon: CalendarRange }, runs: { label: '任务记录', icon: Activity },
  templates: { label: '流水线模板', icon: GitFork }, settings: { label: '引擎与 API', icon: Cable },
  accounts: { label: '资源账户', icon: KeyRound }, preferences: { label: '配置', icon: Settings },
  help: { label: '帮助', icon: LifeBuoy },
}
const navigation = ['projects', 'plans', 'runs', 'templates', 'settings', 'accounts', 'preferences', 'help'] as const
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
const HelpView = lazy(() => import('./HelpView.tsx').then(module => ({ default: module.HelpView })))

export function App() {
  const [route, setRoute] = useState(location)
  const [catalog, setCatalog] = useState(emptyCatalog)
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [running, setRunning] = useState(false)
  const [preferences, setPreferences] = useState<Preferences>(defaultPreferences)
  const [plans, setPlans] = useState<PlanItem[]>([])
  const [service, setService] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [runVersion, setRunVersion] = useState(0)
  const [taskTarget, setTaskTarget] = useState<{ projectId: string; iterationId?: string; parent?: Run; edit?: Run } | null>(null)
  const refresh = useCallback(async () => setCatalog(await request<Catalog>('/catalog')), [])
  const refreshPlans = useCallback(async () => setPlans(await request<PlanItem[]>('/config/plan-items')), [])
  const setArchived = useCallback((id: string, archived: boolean) => runAction(id, archived ? 'archive' : 'unarchive'), [])
  const today = localPlanDate()
  const briefing = useMemo(() => planBriefing(plans, today), [plans, today])

  useEffect(() => {
    const update = () => { setRoute(location()); setTaskTarget(null) }
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])
  useEffect(() => {
    let active = true
    const update = async () => {
      if (document.hidden) return
      try {
        await Promise.all([refresh(), refreshPlans(), request<{ active: boolean }>('/runs/activity').then(result => setRunning(result.active)),
          request<Preferences>('/preferences').then(setPreferences)])
        if (active) { setService('ready'); setError('') }
      } catch (error) {
        if (active) { setService('error'); setError(message(error)) }
      }
    }
    void update()
    const timer = window.setInterval(() => { void update() }, 5000)
    document.addEventListener('visibilitychange', update)
    return () => { active = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', update) }
  }, [refresh])

  useEffect(() => {
    setRuns([])
    if (route.page !== 'projects' || !route.id) return
    let active = true
    const params = new URLSearchParams({ project: route.id, limit: String(preferences.recentTaskLimit),
      ...(route.iterationId && { iteration: route.iterationId }) })
    const update = () => {
      if (document.hidden) return
      void request<RunSummary[]>(`/runs/recent?${params}`).then(list => { if (active) setRuns(list) }).catch(() => {})
    }
    update()
    const timer = window.setInterval(update, 5000)
    document.addEventListener('visibilitychange', update)
    return () => { active = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', update) }
  }, [route.page, route.id, route.iterationId, preferences.recentTaskLimit])

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

  function editTask(run: Run) {
    setTaskTarget({ projectId: run.project.id, iterationId: run.iteration?.id, edit: run })
  }

  return <div className="app">
    <aside className="sidebar"><a className="brand" href="#/projects"><span className="brand-mark"><Layers3 size={23} strokeWidth={1.8} /></span><span><strong>Front Day<span className="brand-dot">.</span></strong><small>前端的一天</small></span></a>
      <nav aria-label="工作区"><div className="nav-label">工作区</div>{navigation.map(page => {
        const { label, icon: Icon } = pages[page]
        const live = page === 'runs' && running
        const active = route.page === page
        return <a key={page} href={`#/${page}`} aria-current={active ? 'page' : undefined} className={active ? 'active' : ''}>
          {live ? <LoaderCircle size={18} strokeWidth={1.8} className="nav-spinner" /> : <Icon size={18} strokeWidth={1.8} />}
          <span>{label}</span>{active && <ChevronRight size={15} className="nav-chevron" />}</a>
      })}</nav>
      <div className="sidebar-footer"><div className="service-indicator"><i className={service} /><div><strong>{service === 'ready' ? '本机服务在线' : service === 'loading' ? '正在连接' : '本机服务未连接'}</strong><small>本地数据</small></div></div></div>
    </aside>
    <div className="workspace"><header className="topbar"><div className="crumbs"><span>工作区</span><ChevronRight size={14} /><strong>{pages[route.page].label}</strong>
      {project && <><ChevronRight size={14} /><strong>{project.name}</strong></>}{iteration && <><ChevronRight size={14} /><strong>{iteration.name}</strong></>}
      {route.page === 'runs' && route.id && <><ChevronRight size={14} /><strong>任务详情</strong></>}</div>
      <PlanBrief briefing={briefing} /></header>
      <main className={`main-content${route.page === 'runs' && route.id ? ' run-main' : ''}`}>
        <ErrorLine text={error} />
        {service === 'loading' ? <div className="loading">正在读取项目…</div> : <>
          {route.page === 'projects' && <ProjectsView catalog={catalog} refresh={refresh} projectId={route.id} iterationId={route.iterationId} focusElements={route.focusElements} select={(id, iterationId) => go('projects', id, iterationId)} recentTaskLimit={preferences.recentTaskLimit}
            startTask={(project: Project, iteration?: Iteration) => setTaskTarget({ projectId: project.id, iterationId: iteration?.id })} runs={runs} openRun={openRun} />}
          {route.page === 'plans' && <PlansView key={preferences.dataDirectory} onChange={() => void refreshPlans()} />}
          {route.page === 'runs' && <>
            {route.id && <RunView key={`${route.id}-${runVersion}`} id={route.id} followOutput={preferences.followOutput} setArchived={setArchived} onContinue={continueTask} onEdit={editTask} optimizer={catalog.promptOptimizer} catalog={catalog}
              back={(projectId, iterationId) => go('projects', projectId,
              catalog.iterations.some(item => item.id === iterationId && item.projectId === projectId) ? iterationId : undefined)} />}
            <TaskHistory visible={!route.id} catalog={catalog} projects={() => go('projects')} open={openRun} setArchived={setArchived} />
          </>}
          {route.page === 'templates' && <TemplatesView catalog={catalog} refresh={refresh} />}
          {route.page === 'settings' && <EnginesView catalog={catalog} refresh={refresh} />}
          {route.page === 'accounts' && <AccountsView key={preferences.dataDirectory} catalog={catalog} refresh={refresh} />}
          {route.page === 'preferences' && <PreferencesView preferences={preferences} catalog={catalog} refresh={refresh}
            onSave={value => { setPreferences(value); void refresh().catch(() => {}) }} />}
          {route.page === 'help' && <Suspense fallback={<div className="loading">正在读取帮助…</div>}><HelpView /></Suspense>}
        </>}
      </main>
    </div>
    {taskProject && (!taskTarget?.iterationId || taskIteration) && <TaskDialog project={taskProject} iteration={taskIteration} parent={taskTarget?.parent} run={taskTarget?.edit} catalog={catalog} preferences={preferences} close={() => setTaskTarget(null)}
      onStart={run => { const editing = !!taskTarget?.edit; setTaskTarget(null); if (editing) setRunVersion(value => value + 1); if (run.status !== 'saved') setRunning(true); openRun(run.id) }} />}
  </div>
}
