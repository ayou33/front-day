import { useState } from 'react'
import { Folder, Sparkles } from 'lucide-react'
import { continuationLabels, continuationModes } from '../shared/continuations.ts'
import type { ContinuationMode } from '../shared/continuations.ts'
import { projectFields, taskElements, taskFields, taskTypeDefinition } from '../shared/context.ts'
import { isApiExecutor } from '../shared/contracts.ts'
import type { Catalog, Dispatch, Iteration, Project, Run } from '../shared/contracts.ts'
import type { ApprovalMode } from '../shared/engines.ts'
import type { Preferences } from '../shared/preferences.ts'
import { maxOptimizationInput } from '../shared/prompt-optimizer.ts'
import { request } from './api.ts'
import { ContextScope } from './ContextScope.tsx'
import { ApprovalOptions, Dialog, EditForm, ErrorLine, ExecutorOptions, Field, hasExecutor, message, TaskTypeOptions } from './ui.tsx'

export function TaskDialog({ project, iteration, parent, run, catalog, preferences, close, onStart }: {
  project: Project; iteration?: Iteration; catalog: Catalog; preferences: Preferences; close: () => void; onStart: (run: Run) => void
  parent?: Run; run?: Run
}) {
  const source = parent?.stages.findLast((stage, index) => stage.kind === 'agent' && parent.attempts[index]?.some(attempt => attempt.status === 'succeeded' && attempt.sessionId))
  const runEngine = run?.stages.find(stage => stage.engine)?.engine?.id
  const preferredEngine = runEngine ?? source?.engine?.id ?? (parent && parent.stages[parent.stageIndex]?.engine?.id) ?? preferences.defaultEngineId
  const knownType = run?.taskType && taskTypeDefinition(run.taskType) ? run.taskType : ''
  const [form, setForm] = useState<Dispatch>(() => ({ requestId: run?.id ?? crypto.randomUUID(), projectId: project.id, iterationId: iteration?.id, goal: run?.goal ?? '', brief: run?.brief ?? '',
    details: run?.details, approvalMode: run?.approvalMode, engineId: hasExecutor(catalog, preferredEngine) ? preferredEngine : '',
    apiFiles: (run ?? parent)?.apiFiles, apiExcluded: (run ?? parent)?.apiExcluded, acceptance: run?.stages[0]?.acceptance,
    templateId: run?.templateId ?? catalog.templates.find(template => template.name === run?.templateName)?.id,
    continuation: parent ? { parentId: parent.id, mode: parent.status === 'succeeded' ? 'auto' : 'handoff' } : undefined }))
  const [type, setType] = useState<string>(run ? knownType || (run.taskType ? 'custom' : '') : parent ? '' : preferences.defaultTaskType)
  const [customType, setCustomType] = useState(run?.taskType && !knownType ? run.taskType : '')
  const [optimizing, setOptimizing] = useState(false)
  const [optimization, setOptimization] = useState<{ original: string; goal: string } | null>(null)
  const [optimizationError, setOptimizationError] = useState('')
  const resumeAllowed = parent?.status === 'succeeded' && !!source?.engine && !isApiExecutor(source.engine)
    && (!form.engineId || form.engineId === source.engine.id) && !form.templateId
  const resources = taskElements(catalog.resources, project.id, iteration?.id)
  const elements = resources.length
  const template = catalog.templates.find(item => item.id === form.templateId)
  const defaultId = form.engineId || preferredEngine
  const stages = template ? template.stages.filter(stage => stage.kind === 'agent' || stage.analyzeTest)
    .map(stage => ({ ...stage, api: (stage.engineId || defaultId).startsWith('api:') }))
    : [{ name: '任务执行', allResources: true, resourceIds: [], api: defaultId.startsWith('api:') }]
  const hasProjectNotes = !!project.description.trim() || projectFields.some(({ key }) => project.context?.[key]?.trim())
  const scope = iteration ? '项目和迭代' : '项目'
  const contextNote = parent ? '将创建一条关联的新任务，并使用当前项目和迭代配置。' : hasProjectNotes || iteration?.description || elements
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

  return <Dialog title={run ? '编辑任务' : parent ? '继续修改' : '新建任务'} onClose={close}>
    <EditForm onClose={close} submitLabel={run ? '保存修改' : '开始任务'} onSave={run || parent ? undefined : () => submit(false)} onSubmit={() => submit(!run)}>
      <div className="task-project">
        <div className="list-icon"><Folder size={18} /></div>
        <div><strong>{[project.name, iteration?.name].filter(Boolean).join(' / ')}</strong><p className="mono path">{project.directory}</p></div>
      </div>
      {parent && form.continuation && <>
        <p className="caption">来源任务 · {parent.title}</p>
        <Field label="续改方式" detail="自动选择会根据原会话大小、上下文变更和引擎兼容性决定如何继续。">
          <select value={form.continuation.mode} onChange={event => setForm({ ...form, continuation: { parentId: parent.id, mode: event.target.value as ContinuationMode } })}>
            {continuationModes.filter(mode => resumeAllowed || mode !== 'resume').map(mode => <option key={mode} value={mode}>{continuationLabels[mode]}</option>)}
          </select>
        </Field>
      </>}
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
        <Field label="执行器"><select value={form.engineId} onChange={event => {
          const engineId = event.target.value
          setForm({ ...form, engineId, continuation: form.continuation?.mode === 'resume' && engineId && engineId !== source?.engine?.id
            ? { ...form.continuation, mode: 'auto' } : form.continuation })
        }}>
          <option value="">自动选择执行器</option><ExecutorOptions catalog={catalog} />
        </select></Field>
        <Field label="授权模式"><select value={form.approvalMode ?? ''} onChange={event => setForm({ ...form, approvalMode: (event.target.value || undefined) as ApprovalMode | undefined })}>
          <ApprovalOptions inherit />
        </select></Field>
        <Field label="流水线模板"><select value={form.templateId ?? ''} onChange={event => {
          const templateId = event.target.value || undefined
          setForm({ ...form, templateId, continuation: templateId && form.continuation?.mode === 'resume'
            ? { ...form.continuation, mode: 'auto' } : form.continuation })
        }}>
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
