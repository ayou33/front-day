import { useState } from 'react'
import { Folder, Sparkles } from 'lucide-react'
import { projectFields, taskElements, taskFields, taskTypeDefinition } from '../shared/context.ts'
import { continuationLabels, sessionFrom } from '../shared/continuations.ts'
import { isApiExecutor } from '../shared/contracts.ts'
import type { Catalog, Dispatch, Iteration, Project, Run } from '../shared/contracts.ts'
import type { ApprovalMode } from '../shared/engines.ts'
import type { Preferences } from '../shared/preferences.ts'
import { maxOptimizationInput } from '../shared/prompt-optimizer.ts'
import { request } from './api.ts'
import { ContextScope } from './ContextScope.tsx'
import { ApprovalOptions, Dialog, EditForm, ErrorLine, ExecutorOptions, Field, hasExecutor, message, TaskTypeOptions } from './ui.tsx'

export function ContinueTaskDialog({ parent, close, onStart }: { parent: Run; close: () => void; onStart: (run: Run) => void }) {
  const [goal, setGoal] = useState('')
  const [requestIds] = useState(() => ({ resume: crypto.randomUUID(), handoff: crypto.randomUUID() }))
  const source = sessionFrom(parent)
  const canResume = parent.status === 'succeeded' && !!source && !isApiExecutor(source.engine)
  const empty = !goal.trim()

  async function start(mode: 'resume' | 'handoff') {
    onStart(await request<Run>('/runs', 'POST', {
      requestId: requestIds[mode], projectId: parent.project.id, iterationId: parent.iteration?.id, goal: goal.trim(), brief: '',
      taskType: parent.taskType ?? '', approvalMode: parent.approvalMode, continuation: { parentId: parent.id, mode },
    } satisfies Dispatch))
  }

  return <Dialog title="继续修改" onClose={close}>
    <EditForm onClose={close} submitLabel={continuationLabels[canResume ? 'resume' : 'handoff']} submitDisabled={empty}
      onSubmit={() => start(canResume ? 'resume' : 'handoff')}
      onSave={canResume ? () => start('handoff') : undefined} saveLabel={continuationLabels.handoff} saveDisabled={empty}>
      <Field label="任务目标"><textarea autoFocus required rows={4} maxLength={100_000} value={goal}
        placeholder="说明这次要修改什么" onChange={event => setGoal(event.target.value)} /></Field>
      <p className="caption">{canResume ? '续接会在当前 Agent 会话追加一轮。选用交接摘要会创建独立会话。'
        : '将使用交接摘要和最新项目资料开启新会话。'}</p>
    </EditForm>
  </Dialog>
}

export function TaskDialog({ project, iteration, run, catalog, preferences, close, onStart }: {
  project: Project; iteration?: Iteration; catalog: Catalog; preferences: Preferences; close: () => void; onStart: (run: Run) => void
  run?: Run
}) {
  const runEngine = run?.stages.find(stage => stage.engine)?.engine?.id
  const preferredEngine = runEngine ?? preferences.defaultEngineId
  const knownType = run?.taskType && taskTypeDefinition(run.taskType) ? run.taskType : ''
  const [form, setForm] = useState<Dispatch>(() => ({ requestId: run?.id ?? crypto.randomUUID(), projectId: project.id, iterationId: iteration?.id, goal: run?.goal ?? '', brief: run?.brief ?? '',
    details: run?.details, approvalMode: run?.approvalMode, engineId: hasExecutor(catalog, preferredEngine) ? preferredEngine : '',
    apiFiles: run?.apiFiles, apiExcluded: run?.apiExcluded, acceptance: run?.stages[0]?.acceptance,
    templateId: run?.templateId ?? catalog.templates.find(template => template.name === run?.templateName)?.id }))
  const [type, setType] = useState<string>(run ? knownType || (run.taskType ? 'custom' : '') : preferences.defaultTaskType)
  const [customType, setCustomType] = useState(run?.taskType && !knownType ? run.taskType : '')
  const [optimizing, setOptimizing] = useState(false)
  const [optimization, setOptimization] = useState<{ original: string; goal: string } | null>(null)
  const [optimizationError, setOptimizationError] = useState('')
  const resources = taskElements(catalog.resources, project.id, iteration?.id)
  const elements = resources.length
  const template = catalog.templates.find(item => item.id === form.templateId)
  const defaultId = form.engineId || preferredEngine
  const stages = template ? template.stages.filter(stage => stage.kind === 'agent' || stage.analyzeTest)
    .map(stage => ({ ...stage, api: (stage.engineId || defaultId).startsWith('api:') }))
    : [{ name: '任务执行', allResources: true, resourceIds: [], api: defaultId.startsWith('api:') }]
  const hasProjectNotes = !!project.description.trim() || projectFields.some(({ key }) => project.context?.[key]?.trim())
  const scope = iteration ? '项目和迭代' : '项目'
  const contextNote = hasProjectNotes || iteration?.description || elements
    ? `自动使用${scope}上下文。${form.templateId ? '要素由模板各阶段选择。' : `已关联 ${elements} 个要素。`}`
    : 'Agent 会从工作目录探索相关背景。'

  async function optimize() {
    const original = form.goal ?? ''
    setOptimizing(true)
    setOptimization(null)
    setOptimizationError('')
    try {
      const { goal } = await request<{ goal: string }>('/prompt-optimizer', 'POST', {
        goal: original, taskType: type === 'custom' ? customType : type, executorId: catalog.promptOptimizer?.executorId,
      })
      setOptimization({ original, goal })
    } catch (error) { setOptimizationError(message(error)) }
    finally { setOptimizing(false) }
  }

  async function submit(start: boolean) {
    if (type === 'custom' && !customType.trim()) throw new Error('请输入自定义任务类型')
    if (!form.goal?.trim()) throw new Error('请输入任务目标')
    const taskType = type === 'custom' ? customType : type
    onStart(run
      ? await request<Run>(`/runs/${run.id}`, 'PUT', { ...form, requestId: run.id, taskType, start: false })
      : await request<Run>('/runs', 'POST', { ...form, taskType, start }))
  }

  return <Dialog title={run ? '编辑任务' : '新建任务'} onClose={close}>
    <EditForm onClose={close} submitLabel={run ? '保存修改' : '开始任务'} onSave={run ? undefined : () => submit(false)} onSubmit={() => submit(!run)}>
      <div className="task-project">
        <div className="list-icon"><Folder size={18} /></div>
        <div><strong>{[project.name, iteration?.name].filter(Boolean).join(' / ')}</strong><p className="mono path">{project.directory}</p></div>
      </div>
      <Field label="任务目标"><textarea autoFocus required rows={4} placeholder="例如：修复报名页重复提交的问题" value={form.goal}
        onChange={event => { setForm({ ...form, goal: event.target.value }); setOptimization(null); setOptimizationError('') }} /></Field>
      {catalog.promptOptimizer?.enabled && <div className="goal-optimizer">
        <div className="action-row"><button type="button" className="button compact" disabled={optimizing || !form.goal?.trim() || form.goal.trim().length > maxOptimizationInput}
          onClick={() => void optimize()}><Sparkles size={15} />{optimizing ? '正在优化…' : '优化任务目标'}</button><span className="caption">将任务目标和类型发送给 {catalog.promptOptimizer.executorName}。最多 12000 字符。</span></div>
        <ErrorLine text={optimizationError} />
        {optimization && optimization.original === form.goal && <div className="optimizer-preview">
          <Field label="优化建议"><textarea rows={5} value={optimization.goal} onChange={event => setOptimization({ ...optimization, goal: event.target.value })} /></Field>
          <div className="action-row"><button type="button" className="button compact" onClick={() => setOptimization(null)}>保留原目标</button>
            <button type="button" className="button primary compact" disabled={!optimization.goal.trim()} onClick={() => { setForm({ ...form, goal: optimization.goal }); setOptimization(null) }}>应用优化结果</button></div>
        </div>}
      </div>}
      <Field label="任务类型（可选）" detail={taskTypeDefinition(type)?.hint}><select value={type} onChange={event => setType(event.target.value)}>
        <option value="">由 Agent 根据目标判断</option>
        <TaskTypeOptions />
        <option value="custom">自定义类型</option>
      </select></Field>
      {type === 'custom' && <Field label="自定义任务类型"><input required maxLength={100} value={customType} onChange={event => setCustomType(event.target.value)} /></Field>}
      <details className="optional-fields"><summary>补充本次任务信息（可选）</summary><div className="optional-body">
        {taskFields.map(({ key, label, hint }) => <Field key={key} label={label}><textarea rows={2} placeholder={hint} value={form.details?.[key] ?? ''}
          onChange={event => setForm({ ...form, details: { ...form.details, [key]: event.target.value } })} /></Field>)}
        <Field label="其他补充"><textarea rows={2} value={form.brief} onChange={event => setForm({ ...form, brief: event.target.value })} /></Field>
      </div></details>
      <details className="optional-fields"><summary>执行设置（可选）</summary><div className="optional-body">
        <Field label="执行器"><select value={form.engineId} onChange={event => setForm({ ...form, engineId: event.target.value })}>
          <option value="">自动选择执行器</option><ExecutorOptions catalog={catalog} />
        </select></Field>
        <Field label="授权模式"><select value={form.approvalMode ?? ''} onChange={event => setForm({ ...form, approvalMode: (event.target.value || undefined) as ApprovalMode | undefined })}>
          <ApprovalOptions inherit />
        </select></Field>
        <Field label="流水线模板"><select value={form.templateId ?? ''} onChange={event => setForm({ ...form, templateId: event.target.value || undefined })}>
          <option value="">由 Agent 直接执行</option>{catalog.templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
        </select></Field>
        {!template && <Field label="目标验收" detail="可核对实际改动，或执行项目配置中的测试命令。"><select value={form.acceptance ?? ''}
          onChange={event => setForm({ ...form, acceptance: (event.target.value || undefined) as Dispatch['acceptance'] })}>
          <option value="">手动验收</option><option value="changes">验证文件改动</option><option value="test">运行项目测试</option>
        </select></Field>}
      </div></details>
      {stages.some(stage => stage.api) && <ContextScope project={project} resources={resources} stages={stages} task={form}
        edit={value => setForm(current => ({ ...current, ...value }))} />}
      <p className="caption">{contextNote}</p>
    </EditForm>
  </Dialog>
}
