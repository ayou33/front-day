import { legacyIterationElements, projectFields, taskFields } from '../../shared/context.ts'
import type { Run } from '../../shared/contracts.ts'
import type { Handoff } from '../../shared/continuations.ts'

export function RunContext({ run, sentPrompt, handoff, historical }: {
  run: Run; sentPrompt: string; handoff?: Handoff; historical: boolean
}) {
  const projectRoute = `#/projects/${encodeURIComponent(run.project.id)}`
  const projectResources = run.resources.filter(resource => !resource.iterationId).map(resource => resource.name)
  const iterationResources = run.resources.filter(resource => !!resource.iterationId).map(resource => resource.name)
  return <section className="run-context">
    <div className="action-row"><a className="button compact" href={`${projectRoute}?section=elements`}>打开项目要素</a>
      {run.iteration && <a className="button compact" href={`${projectRoute}/iterations/${encodeURIComponent(run.iteration.id)}?section=elements`}>打开迭代要素</a>}
    </div>
    {sentPrompt && <details className="event-item" open={historical || undefined}><summary>本次发送给 Agent 的提示词</summary><pre>{sentPrompt}</pre></details>}
    {handoff && <details className="event-item"><summary>交接摘要</summary><dl className="project-facts handoff-facts">
      {[['已完成', handoff.changes], ['关键约束', handoff.constraints], ['相关文件', handoff.files], ['验证结果', handoff.verification]].map(([label, value]) =>
        <div key={label}><dt>{label}</dt><dd>{value || '未记录'}</dd></div>)}
    </dl></details>}
    {historical && !sentPrompt && <p className="caption">此尝试还没有发送给 Agent 的提示词记录。</p>}
    {!historical && <dl className="project-facts">
      <div><dt>任务目标</dt><dd>{run.goal ?? run.title}</dd></div><div><dt>工作目录</dt><dd className="mono path">{run.project.directory}</dd></div>
      {run.project.description && <div><dt>项目说明</dt><dd>{run.project.description}</dd></div>}
      {projectFields.map(({ key, label }) => run.project.context?.[key]?.trim() && <div key={key}><dt>{label}</dt><dd>{run.project.context[key]}</dd></div>)}
      {projectResources.length > 0 && <div><dt>项目要素</dt><dd>{projectResources.join('、')}</dd></div>}
      {run.iteration?.description && <div><dt>迭代说明</dt><dd>{run.iteration.description}</dd></div>}
      {legacyIterationElements(run.iteration).map(({ name, value }) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}
      {iterationResources.length > 0 && <div><dt>迭代要素</dt><dd>{iterationResources.join('、')}</dd></div>}
      {taskFields.map(({ key, label }) => run.details?.[key]?.trim() && <div key={`task-${key}`}><dt>{label}</dt><dd>{run.details[key]}</dd></div>)}
      {run.brief.trim() && <div><dt>其他补充</dt><dd>{run.brief}</dd></div>}
    </dl>}
  </section>
}
