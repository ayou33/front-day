import { legacyIterationElements, projectFields, taskElements, taskFields } from '../../shared/context.ts'
import { canEditTask, isApiExecutor } from '../../shared/contracts.ts'
import type { Catalog, ContextDifference, Run } from '../../shared/contracts.ts'
import type { Handoff } from '../../shared/continuations.ts'
import type { PromptOptimizerSettings } from '../../shared/prompt-optimizer.ts'
import { AgentPrompt } from './AgentPrompt.tsx'
import { ContextScope } from '../ContextScope.tsx'
import { HandoffSummary } from './Transcript.tsx'

export function RunContext({ run, stageIndex, sentPrompt, handoff, historical, optimizer, onSaved, difference, catalog }: {
  run: Run; stageIndex: number; sentPrompt: string; handoff?: Handoff; historical: boolean; optimizer?: PromptOptimizerSettings; onSaved: (run: Run) => void
  difference?: ContextDifference
  catalog: Catalog
}) {
  const editable = !historical && canEditTask(run)
  const latestProject = editable && catalog.projects.find(project => project.id === run.project.id)
  const latestIteration = editable && catalog.iterations.find(iteration => iteration.id === run.iteration?.id && iteration.projectId === run.project.id)
  const hasLatest = latestProject && (!run.iteration || latestIteration)
  const project = hasLatest ? latestProject : run.project
  const iteration = hasLatest ? latestIteration || undefined : run.iteration
  const resources = hasLatest ? taskElements(catalog.resources, project.id, iteration?.id) : run.resources
  const projectRoute = `#/projects/${encodeURIComponent(run.project.id)}`
  const projectResources = resources.filter(resource => !resource.iterationId).map(resource => resource.name)
  const iterationResources = resources.filter(resource => !!resource.iterationId).map(resource => resource.name)
  return <section className="run-context">
    <div className="action-row">
      <a className="button compact" href={`${projectRoute}?section=elements`}>打开项目要素</a>
      {run.iteration && <a className="button compact" href={`${projectRoute}/iterations/${encodeURIComponent(run.iteration.id)}?section=elements`}>打开迭代要素</a>}
    </div>
    {editable && run.stages[stageIndex]?.engine && <AgentPrompt key={run.revision ?? 0} run={run} stageIndex={stageIndex} optimizer={optimizer} onSaved={onSaved}
      contextVersion={difference?.version} />}
    {!historical && <ContextScope project={project} resources={resources} task={run}
      stages={run.stages.filter(stage => stage.engine).map(stage => ({ ...stage, api: isApiExecutor(stage.engine!) }))} />}
    {difference?.unavailable && <p className="caption">{difference.unavailable}</p>}
    {!!difference?.changes.length && <details className="event-item" open><summary>保存后资料有变化 · {difference.changes.length} 项</summary>
      <div className="scope-body"><p className="caption">开始任务时会自动使用最新资料。</p>
        {difference.changes.map(({ kind, label, before, after }, index) => <details className="resource-detail" key={index}>
        <summary>{{ added: '新增', removed: '移除', updated: '更新' }[kind]} · {label}</summary>
        <div className="form-columns">
          {before && <div><span className="caption">保存时</span><pre>{before}</pre></div>}
          {after && <div><span className="caption">当前</span><pre>{after}</pre></div>}
        </div>
      </details>)}
        {run.stages.some(stage => stage.promptOverride) && <p className="caption">自定义提示词会保留。请先核对正文中引用的旧内容。</p>}</div>
    </details>}
    {run.savedContext && <details className="event-item"><summary>初次保存时的上下文</summary><div className="scope-body">
      <p>{run.savedContext.project.name}{run.savedContext.iteration && ` / ${run.savedContext.iteration.name}`}</p>
      <p className="mono path">{run.savedContext.project.directory}</p>
      <pre>{JSON.stringify({ 项目背景: run.savedContext.project.context, 项目说明: run.savedContext.project.description,
        迭代说明: run.savedContext.iteration?.description, 要素: run.savedContext.resources.map(({ name, value, prompt }) => ({ name, value, prompt })) }, null, 2)}</pre>
    </div></details>}
    {sentPrompt && <details className="event-item" open={historical || undefined}><summary>本次发送给 Agent 的提示词</summary><pre>{sentPrompt}</pre></details>}
    {handoff && <HandoffSummary handoff={handoff} />}
    {!sentPrompt && (run.stages[stageIndex]?.engine
      ? !editable && <p className="caption">暂无发送给 Agent 的提示词记录。</p>
      : <p className="caption">此阶段仅执行测试命令。可选择 Agent 阶段查看提示词。</p>)}
    {!historical && <dl className="project-facts">
      <div><dt>任务目标</dt><dd>{run.goal ?? run.title}</dd></div><div><dt>工作目录</dt><dd className="mono path">{project.directory}</dd></div>
      {project.description && <div><dt>项目说明</dt><dd>{project.description}</dd></div>}
      {projectFields.map(({ key, label }) => project.context?.[key]?.trim() && <div key={key}><dt>{label}</dt><dd>{project.context[key]}</dd></div>)}
      {projectResources.length > 0 && <div><dt>项目要素</dt><dd>{projectResources.join('、')}</dd></div>}
      {iteration?.description && <div><dt>迭代说明</dt><dd>{iteration.description}</dd></div>}
      {legacyIterationElements(iteration).map(({ name, value }) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}
      {iterationResources.length > 0 && <div><dt>迭代要素</dt><dd>{iterationResources.join('、')}</dd></div>}
      {taskFields.map(({ key, label }) => run.details?.[key]?.trim() && <div key={`task-${key}`}><dt>{label}</dt><dd>{run.details[key]}</dd></div>)}
      {run.brief.trim() && <div><dt>其他补充</dt><dd>{run.brief}</dd></div>}
    </dl>}
  </section>
}
