import { useState } from 'react'
import { ArrowDown, ArrowRight, ArrowUp, Braces, FlaskConical, GitFork, Plus, Trash2 } from 'lucide-react'
import type { Stage, Template } from '../../shared/contracts.ts'
import { Check, CommandFields, Empty, EngineOptions, Field, SectionHeading } from '../ui.tsx'
import { Editor, ItemActions, blankStage, commandOrNull, modes, remove } from './common.tsx'
import type { Props } from './common.tsx'

export function TemplatesView({ catalog, refresh }: Props) {
  const [edit, setEdit] = useState<Template | null>(null)
  const create = () => setEdit({ id: '', name: '', description: '', stages: [{ ...blankStage }] })
  function changeStage(index: number, patch: Partial<Stage>) {
    setEdit(current => current && { ...current, stages: current.stages.map((stage, i) => i === index ? { ...stage, ...patch } : stage) })
  }
  function moveStage(index: number, step: number) {
    if (!edit) return
    const stages = [...edit.stages]
    const other = index + step
    if (other < 0 || other >= stages.length) return
    const [stage] = stages.splice(index, 1)
    stages.splice(other, 0, stage)
    setEdit({ ...edit, stages })
  }
  return <>
    <SectionHeading title="流水线模板" description="按执行顺序组合 Agent 阶段和测试命令。"><button className="button primary" onClick={create}><Plus size={17} />新建模板</button></SectionHeading>
    <div className="stack">
      {catalog.templates.map(template => <section className="panel template-card" key={template.id}>
        <div className="panel-header"><div className="icon-heading"><div className="section-icon"><GitFork size={20} /></div><div><h2>{template.name}</h2>{template.description && <p>{template.description}</p>}</div></div>
          <ItemActions name={template.name} onEdit={() => setEdit(template)} onDelete={() => remove('templates', template.id, refresh)} /></div>
        <div className="template-flow">{template.stages.map((stage, index) => <div className="template-step" key={index}>
          <div className="list-icon">{stage.kind === 'test' ? <FlaskConical size={16} /> : <Braces size={16} />}</div>
          <div><strong>{stage.name}</strong><small>{stage.kind === 'test' ? '测试命令' : 'Agent'} · {stage.advance === 'manual' && index < template.stages.length - 1 ? '人工放行' : '自动'}</small></div>
          {index < template.stages.length - 1 && <ArrowRight size={16} className="flow-arrow" />}
        </div>)}</div>
      </section>)}
      {!catalog.templates.length && <section className="panel"><Empty icon={GitFork} title="还没有流水线模板" action={<button className="button" onClick={create}>新建模板</button>} /></section>}
    </div>
    {edit && <Editor kind="templates" value={edit} close={() => setEdit(null)} refresh={refresh} title={edit.id ? '编辑流水线模板' : '新建流水线模板'} wide
      prepare={() => ({ ...edit, stages: edit.stages.map(stage => ({ ...stage, testCommand: stage.kind === 'test' ? commandOrNull(stage.testCommand) : null })) })}>
      <Field label="模板名称"><input required value={edit.name} onChange={event => setEdit({ ...edit, name: event.target.value })} /></Field>
      <Field label="模板说明"><input value={edit.description} onChange={event => setEdit({ ...edit, description: event.target.value })} /></Field>
      {edit.stages.map((stage, index) => <fieldset className="stage-editor" key={index}>
        <legend>阶段 {index + 1}</legend>
        <div className="stage-toolbar"><div className="caption">{stage.name || '未命名阶段'}</div><div className="item-actions">
          <button className="icon-button" type="button" title="上移" aria-label={`上移阶段 ${index + 1}`} disabled={!index} onClick={() => moveStage(index, -1)}><ArrowUp size={15} /></button>
          <button className="icon-button" type="button" title="下移" aria-label={`下移阶段 ${index + 1}`} disabled={index === edit.stages.length - 1} onClick={() => moveStage(index, 1)}><ArrowDown size={15} /></button>
          <button className="icon-button danger-icon" type="button" aria-label={`删除阶段 ${index + 1}`} disabled={edit.stages.length === 1} onClick={() => setEdit({ ...edit, stages: edit.stages.filter((_, i) => i !== index) })}><Trash2 size={15} /></button>
        </div></div>
        <div className="form-columns"><Field label="阶段名称"><input required value={stage.name} onChange={event => changeStage(index, { name: event.target.value })} /></Field>
          <Field label="类型"><select value={stage.kind} onChange={event => changeStage(index, { kind: event.target.value as Stage['kind'] })}><option value="agent">Agent</option><option value="test">测试命令</option></select></Field></div>
        {stage.kind === 'test' && <><CommandFields value={stage.testCommand} onChange={testCommand => changeStage(index, { testCommand })} />
          <p className="caption">留空时使用项目的测试命令。</p><Check checked={stage.analyzeTest} onChange={analyzeTest => changeStage(index, { analyzeTest })}>由 Agent 以只读模式解读测试日志</Check></>}
        {(stage.kind === 'agent' || stage.analyzeTest) && <>
          <div className="form-columns"><Field label="Agent 配置"><select value={stage.engineId} onChange={event => changeStage(index, { engineId: event.target.value })}>
            <option value="">沿用派发设置</option><EngineOptions engines={catalog.engines} availability={catalog.engineAvailability} />
          </select></Field>{stage.kind === 'agent' && <Field label="运行模式"><select value={stage.mode} onChange={event => changeStage(index, { mode: event.target.value as Stage['mode'] })}>
            <option value="">沿用引擎设置</option>{Object.entries(modes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></Field>}</div>
          <Field label="阶段提示词"><textarea rows={3} value={stage.prompt} onChange={event => changeStage(index, { prompt: event.target.value })} /></Field>
          <Check checked={stage.allResources} onChange={allResources => changeStage(index, { allResources })}>使用任务所属项目和迭代的全部要素</Check>
          {!stage.allResources && <div className="resource-options">{catalog.resources.length ? catalog.resources.map(resource => <Check key={resource.id} checked={stage.resourceIds.includes(resource.id)} onChange={checked =>
            changeStage(index, { resourceIds: checked ? [...stage.resourceIds, resource.id] : stage.resourceIds.filter(id => id !== resource.id) })}>
            {[resource.name, catalog.projects.find(project => project.id === resource.projectId)?.name, catalog.iterations.find(item => item.id === resource.iterationId)?.name].filter(Boolean).join(' · ')}
          </Check>) : <p className="caption">暂无可选资源。</p>}</div>}
        </>}
        <Field label="进入下一阶段"><select value={stage.advance} onChange={event => changeStage(index, { advance: event.target.value as Stage['advance'] })}><option value="auto">成功后自动继续</option><option value="manual">等待人工放行</option></select></Field>
      </fieldset>)}
      <button type="button" className="button" disabled={edit.stages.length >= 25} onClick={() => setEdit({ ...edit, stages: [...edit.stages, { ...blankStage }] })}><Plus size={16} />添加阶段</button>
    </Editor>}
  </>
}
