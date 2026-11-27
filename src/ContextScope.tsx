import type { Dispatch, Project, Resource, Stage } from '../shared/contracts.ts'
import { resourceConflicts, sharing, usesProjectFiles } from '../shared/task-context.ts'
import { Check } from './ui.tsx'

type ScopeStage = Pick<Stage, 'name' | 'allResources' | 'resourceIds'> & { api: boolean; promptOverride?: string }
type ScopeTask = Pick<Dispatch, 'apiFiles' | 'apiExcluded'>
const labels = { auto: '初始发送', 'on-demand': '按需读取', excluded: '已排除' }

export function ContextScope({ project, resources, stages, task, edit }: {
  project: Project; resources: Resource[]; stages: ScopeStage[]; task: ScopeTask; edit?: (value: ScopeTask) => void
}) {
  const cloud = stages.some(stage => stage.api)
  const conflicts = resourceConflicts(resources)
  return <details className="event-item">
    <summary>{cloud ? '厂商 API 资料发送范围' : '要素来源与适用阶段'} · {resources.length} 项</summary>
    <div className="scope-body">
      {cloud && <p className="caption">API 阶段发送任务目标、背景和阶段要求，也可能发送交接摘要、测试日志及上一阶段结果。排除要素后会略去这些衍生正文，仅保留适用的测试退出码。自定义提示词按保存内容发送。</p>}
      {cloud && edit && project.apiFiles !== false && <Check checked={usesProjectFiles(project, task)}
        onChange={value => edit({ ...task, apiFiles: value })}>允许 API 浏览及修改项目工作区</Check>}
      {cloud && <p className="caption">{usesProjectFiles(project, task)
        ? '工作区文件按需访问，写入遵循任务授权。'
        : '仅按需读取已关联的文件要素。项目工作区工具已关闭。'}</p>}
      {!!resources.length && <div className="table-scroll"><table className="scope-table">
        <thead><tr><th>要素</th><th>用于阶段</th>{cloud && <th>API 发送方式</th>}</tr></thead>
        <tbody>{resources.map(resource => {
          const included = stages.filter(stage => stage.allResources || stage.resourceIds.includes(resource.id))
          return <tr key={resource.id}><td><strong>{resource.name}</strong>
            <small>{resource.iterationId ? '迭代要素' : '项目要素 · 继承自项目'} · {resource.category}</small>
            {conflicts.has(resource.id) && <small className="scope-conflict">同名要素内容不同，请核对适用范围</small>}
          </td><td>{included.map(stage => stage.name).join('、') || '未选用'}</td>
            {cloud && <td>{stages.filter(stage => stage.api).map((stage, index) => {
              const share = sharing(resource, task, stage)
              const mode = share === 'auto' && stage.promptOverride ? 'on-demand' : share
              return <small key={index}>{stage.name} · {labels[mode]}{resource.kind === 'url' && !resource.fetch && mode === 'auto' ? '链接' : ''}</small>
            })}
              {edit && resource.apiShare !== 'excluded' && included.some(stage => stage.api) && <Check
                checked={!task.apiExcluded?.includes(resource.id)} onChange={checked => edit({ ...task, apiExcluded: checked
                  ? task.apiExcluded?.filter(id => id !== resource.id) : [...(task.apiExcluded ?? []), resource.id] })}>本任务允许发送</Check>}
            </td>}
          </tr>
        })}</tbody>
      </table></div>}
    </div>
  </details>
}
