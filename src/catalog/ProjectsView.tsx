import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, FileText, Folder, FolderOpen, KeyRound, Link2, Milestone, Pencil, Plus, Terminal } from 'lucide-react'
import { elementTypeGroups, elementTypeHints, projectFields, taskTypeLabel } from '../../shared/context.ts'
import type { Account, Iteration, Project, Resource, RunSummary } from '../../shared/contracts.ts'
import { DirectoryPicker } from '../DirectoryPicker.tsx'
import { blankAccount, httpOrigin, ResourceAccountEditor } from '../ResourceAccountEditor.tsx'
import { Check, CommandFields, Empty, ExternalLink, Field, SectionHeading, Status, dateTime } from '../ui.tsx'
import { Editor, ItemActions, blankProject, commandOrNull, filePickerStart, projectNameFromDirectory, remove } from './common.tsx'
import type { Props } from './common.tsx'

const resourceKinds = { url: 'URL', file: '本地文件', text: '文本' }
const builtInCategories = new Set(elementTypeGroups.flatMap(group => group.types))
const combinedCategories = new Set(['模板（参考）', '模板(参考)'])

export function ProjectsView({ catalog, refresh, projectId, iterationId, focusElements, select, startTask, runs, openRun, recentTaskLimit }: Props & {
  projectId: string; iterationId: string; focusElements: boolean; select: (id: string, iterationId?: string) => void; recentTaskLimit: number
  startTask: (project: Project, iteration?: Iteration) => void; runs: RunSummary[]; openRun: (id: string) => void
}) {
  const [projectEdit, setProjectEdit] = useState<Project | null>(null)
  const [pickingDirectory, setPickingDirectory] = useState(false)
  const [contextEdit, setContextEdit] = useState<Project | null>(null)
  const [iterationEdit, setIterationEdit] = useState<Iteration | null>(null)
  const [resourceEdit, setResourceEdit] = useState<Resource | null>(null)
  const [pickingFile, setPickingFile] = useState(false)
  const [customCategory, setCustomCategory] = useState(false)
  const [resourceAccount, setResourceAccount] = useState<Account | null>(null)
  const project = catalog.projects.find(project => project.id === projectId)
  const iterations = catalog.iterations.filter(item => item.projectId === project?.id)
  const iteration = iterations.find(item => item.id === iterationId)
  const elementsPanel = useRef<HTMLElement>(null)
  useEffect(() => {
    if (focusElements) elementsPanel.current?.scrollIntoView({ block: 'start' })
  }, [focusElements, project?.id, iteration?.id])
  const resources = catalog.resources.filter(resource => resource.projectId === project?.id && resource.iterationId === iteration?.id)
  const customCategories = [...new Set(catalog.resources.map(resource => resource.category))]
    .filter(category => !builtInCategories.has(category) && !combinedCategories.has(category))
  const recent = runs.filter(run => !run.archivedAt && run.projectId === project?.id && (!iteration || run.iterationId === iteration.id)).slice(0, recentTaskLimit)
  const fields = projectFields.filter(({ key }) => project?.context?.[key]?.trim())
  function openElement(element: Resource) {
    setCustomCategory(false)
    setPickingFile(false)
    setResourceEdit(element)
  }
  if (project && iterationId && !iteration) return <section className="panel"><Empty icon={Milestone} title="找不到此迭代"
    action={<button className="button" onClick={() => select(project.id)}>返回项目</button>} /></section>
  return <>
    <SectionHeading title={iteration ? '迭代' : '项目'} description={iteration ? undefined : '集中维护项目背景、要素和迭代。'}>
      {project && <button className="button primary" onClick={() => startTask(project, iteration)}><Plus size={17} />新建任务</button>}
      {iteration ? <button className="button" onClick={() => select(iteration.projectId)}><ArrowLeft size={16} />返回项目</button> :
        <button className={`button${!catalog.projects.length ? ' primary' : ''}`} onClick={() => setProjectEdit(blankProject)}><Plus size={17} />登记项目</button>}
    </SectionHeading>
    {!catalog.projects.length ? <section className="panel project-welcome"><Empty icon={Folder} title="从一个本地项目开始" action={<button className="button" onClick={() => setProjectEdit(blankProject)}><Plus size={16} />登记第一个项目</button>}>登记工作目录后，可以直接开始任务，也可以先补充项目背景。</Empty></section> :
      <div className="projects-layout">
        <section className="panel projects-menu"><div className="small-panel-header"><h2>本地项目</h2><span>{catalog.projects.length}</span></div>
          {catalog.projects.map(item => <button key={item.id} aria-current={item.id === project?.id ? 'page' : undefined} onClick={() => select(item.id)} className={item.id === project?.id ? 'project-choice active' : 'project-choice'}><Folder size={17} />{item.name}<ArrowRight size={15} /></button>)}
        </section>
        {!project ? <section className="panel project-welcome"><Empty icon={Folder} title="选择一个项目">选择项目后，查看它的工作目录、背景资料和任务。</Empty></section> : <div className="stack">
          {iteration ? <section className="panel project-summary"><div className="section-icon"><Milestone size={21} /></div><div className="project-info">
            <h2>{iteration.name}</h2><p>{project.name}</p>
            {iteration.description.trim() && <p className="iteration-description">{iteration.description}</p>}
          </div><ItemActions name={iteration.name} onEdit={() => setIterationEdit(iteration)} deletePrompt={`删除迭代「${iteration.name}」及其要素？`}
            onDelete={async () => { await remove('iterations', iteration.id, refresh); select(project.id) }} /></section> :
          <section className="panel project-summary"><div className="section-icon"><Folder size={21} /></div><div className="project-info">
            <h2>{project.name}</h2><p className="mono path">{project.directory}</p>
            {project.testCommand && <div className="command-chip mono"><Terminal size={14} />{[project.testCommand.program, ...project.testCommand.args].join(' ')}</div>}
          </div><ItemActions name={project.name} onEdit={() => setProjectEdit(project)} deletePrompt={`删除项目「${project.name}」及其迭代和要素？`} onDelete={() => remove('projects', project.id, refresh)} /></section>}
          {!iteration && <section className="panel"><div className="panel-header"><div><h2>项目背景</h2><p>保存一次，同项目的新任务会自动使用。</p></div>
            <button className="button" onClick={() => setContextEdit(project)}><Pencil size={15} />编辑项目背景</button></div>
            {project.description.trim() || fields.length ? <dl className="project-facts">
              {project.description.trim() && <div><dt>项目说明</dt><dd>{project.description}</dd></div>}
              {fields.map(({ key, label }) => <div key={key}><dt>{label}</dt><dd>{project.context?.[key]}</dd></div>)}
            </dl> : <div className="panel-note">项目背景可以留空。Agent 会从工作目录探索所需的约定和限制。</div>}
          </section>}
          <section ref={elementsPanel} className="panel elements-panel"><div className="panel-header"><div><h2>{iteration ? '迭代要素' : '项目要素'}</h2>
            <p>{iteration ? '补充本次迭代特有的需求、设计和其他信息。' : '集中管理活动或项目的需求、设计、接口和交付信息。'}</p></div>
            <button className="button" onClick={() => openElement({ id: '', projectId: project.id, iterationId: iteration?.id, name: '', category: '需求', kind: 'text', value: '', prompt: '', fetch: false, accountId: '' })}><Plus size={16} />添加要素</button>
          </div>
            {resources.length ? resources.map(item => <div className="list-row" key={item.id}><div className="list-icon">{item.kind === 'url' ? <Link2 size={18} /> : <FileText size={18} />}</div>
              <div className="list-description"><strong><span>{item.name}</span><span className="chip">{item.category}</span></strong>
                <div className="ellipsis muted">{item.kind === 'url' ? <ExternalLink href={item.value}>{item.value}</ExternalLink> : item.kind === 'file' ? item.value : null}</div>
                {(item.kind === 'text' || item.prompt) && <details className="resource-detail"><summary>{item.kind === 'text' ? '查看文本' : '查看说明'}</summary>
                  {item.kind === 'text' && <p>{item.value}</p>}{item.prompt && <p>说明 · {item.prompt}</p>}</details>}</div>
              <span className="caption">{resourceKinds[item.kind]}{item.fetch && item.kind === 'url' ? ' · 读取内容' : ''}</span>
              <ItemActions name={item.name} onEdit={() => openElement(item)} onDelete={() => remove('resources', item.id, refresh)} />
            </div>) : <div className="panel-note">支持文本、链接或项目内文件。</div>}
          </section>
          {!iteration && <section className="panel"><div className="panel-header"><h2>项目迭代</h2>
            <button className="button" onClick={() => setIterationEdit({ id: '', projectId: project.id, name: '', description: '' })}><Plus size={16} />新建迭代</button></div>
            {iterations.length ? iterations.map(item => <button type="button" className="list-row iteration-row" key={item.id} onClick={() => select(project.id, item.id)}>
              <div className="list-icon"><Milestone size={17} /></div><div className="list-description"><strong>{item.name}</strong>{item.description.trim() && <div className="ellipsis muted">{item.description}</div>}</div><ArrowRight size={16} />
            </button>) : <div className="panel-note">还没有迭代。</div>}
          </section>}
          <section className="panel"><div className="panel-header"><h2>最近任务</h2></div>
            {recent.length ? recent.map(run => <div className="list-row" key={run.id}><div className="list-description"><button className="row-link" onClick={() => openRun(run.id)}>{run.title}</button><div className="muted">{[!iteration && run.iterationName, taskTypeLabel(run.taskType), dateTime(run.createdAt)].filter(Boolean).join(' · ')}</div></div><Status status={run.status} /></div>) :
              <div className="panel-note">新建任务后，可从这里回看目标、使用的上下文和结果。</div>}
          </section>
        </div>}
      </div>}
    {projectEdit && <Editor kind="projects" value={projectEdit} close={() => setProjectEdit(null)} refresh={refresh} title={projectEdit.id ? '编辑项目' : '登记项目'}
      onSaved={project => select(project.id)}
      prepare={() => {
        if (!projectEdit.directory) throw new Error('请选择本地项目目录')
        return { ...projectEdit, testCommand: commandOrNull(projectEdit.testCommand) }
      }}>
      <div className="field"><label className="directory-label" htmlFor="project-directory">本地项目目录</label>
        <div className="directory-address"><input id="project-directory" className="mono" readOnly placeholder="请选择文件夹" value={projectEdit.directory} />
          <button type="button" className="button" onClick={() => setPickingDirectory(true)}><FolderOpen size={16} />选择目录</button></div>
      </div>
      <Field label="项目名称"><input required maxLength={150} value={projectEdit.name} onChange={event => setProjectEdit({ ...projectEdit, name: event.target.value })} /></Field>
      <details className="optional-fields"><summary>配置测试命令（可选）</summary><div className="optional-body"><CommandFields value={projectEdit.testCommand} onChange={testCommand => setProjectEdit({ ...projectEdit, testCommand })} /></div></details>
    </Editor>}
    {projectEdit && pickingDirectory && <DirectoryPicker initial={projectEdit.directory} close={() => setPickingDirectory(false)} select={directory => {
      setProjectEdit(current => {
        if (!current) return current
        const automatic = !current.id && (!current.name.trim() || current.name === projectNameFromDirectory(current.directory))
        return { ...current, directory, name: automatic ? projectNameFromDirectory(directory) : current.name }
      })
      setPickingDirectory(false)
    }} />}
    {contextEdit && <Editor kind="projects" value={contextEdit} close={() => setContextEdit(null)} refresh={refresh} title="编辑项目背景">
      <Field label="项目说明"><textarea rows={3} placeholder="项目做什么，主要使用者是谁" value={contextEdit.description} onChange={event => setContextEdit({ ...contextEdit, description: event.target.value })} /></Field>
      {projectFields.map(({ key, label, hint }) => <Field key={key} label={label}><textarea rows={2} placeholder={hint} value={contextEdit.context?.[key] ?? ''}
        onChange={event => setContextEdit({ ...contextEdit, context: { ...contextEdit.context, [key]: event.target.value } })} /></Field>)}
    </Editor>}
    {iterationEdit && <Editor kind="iterations" value={iterationEdit} close={() => setIterationEdit(null)} refresh={refresh} title={iterationEdit.id ? '编辑迭代' : '新建迭代'}
      onSaved={item => select(item.projectId, item.id)}>
      <Field label="迭代名称"><input required value={iterationEdit.name} onChange={event => setIterationEdit({ ...iterationEdit, name: event.target.value })} /></Field>
      <Field label="说明"><textarea rows={3} value={iterationEdit.description} onChange={event => setIterationEdit({ ...iterationEdit, description: event.target.value })} /></Field>
    </Editor>}
    {resourceEdit && resourceEdit.projectId === project?.id && resourceEdit.iterationId === iteration?.id && <Editor kind="resources" value={resourceEdit} close={() => setResourceEdit(null)} refresh={refresh} title={resourceEdit.id ? '编辑要素' : '添加要素'} prepare={() => {
      if (resourceEdit.kind === 'file' && !resourceEdit.value) throw new Error('请选择本地文件')
      return resourceEdit
    }}>
      <Field label="要素名称"><input required value={resourceEdit.name} onChange={event => setResourceEdit({ ...resourceEdit, name: event.target.value })} /></Field>
      <div className="form-columns"><Field label="要素类型" detail={!customCategory && Object.hasOwn(elementTypeHints, resourceEdit.category) ? elementTypeHints[resourceEdit.category] : undefined}><select value={customCategory ? '' : resourceEdit.category} onChange={event => {
        setCustomCategory(!event.target.value)
        setResourceEdit({ ...resourceEdit, category: event.target.value })
      }}>
        {elementTypeGroups.map(group => <optgroup key={group.label} label={group.label}>
          {group.types.map(value => <option key={value} value={value}>{value}</option>)}</optgroup>)}
        {combinedCategories.has(resourceEdit.category) && <option value={resourceEdit.category}>{resourceEdit.category} · 原类型</option>}
        {customCategories.length > 0 && <optgroup label="已添加的类型">{customCategories.map(value => <option key={value} value={value}>{value}</option>)}</optgroup>}
        <option value="">自定义类型</option>
      </select></Field>
        <Field label="来源类型"><select value={resourceEdit.kind} onChange={event => setResourceEdit({ ...resourceEdit, kind: event.target.value as Resource['kind'], fetch: false, accountId: '', value: '' })}>
          {Object.entries(resourceKinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></Field></div>
      {customCategory && <Field label="自定义要素类型"><input required maxLength={150} value={resourceEdit.category} onChange={event => setResourceEdit({ ...resourceEdit, category: event.target.value })} /></Field>}
      {resourceEdit.kind === 'file' ? <div className="field"><label className="directory-label" htmlFor="resource-file">本地文件</label>
        <div className="directory-address"><input id="resource-file" className="mono" readOnly value={resourceEdit.value} placeholder="请选择文件" />
          <button type="button" className="button" onClick={() => setPickingFile(true)}><FolderOpen size={16} />选择文件</button></div>
      </div> : <Field label={resourceKinds[resourceEdit.kind]}>
        {resourceEdit.kind === 'text' ? <textarea required rows={4} value={resourceEdit.value} onChange={event => setResourceEdit({ ...resourceEdit, value: event.target.value })} /> :
          <input required className="mono" type="url" placeholder="https://…" value={resourceEdit.value} onChange={event => setResourceEdit({ ...resourceEdit, value: event.target.value })} />}
      </Field>}
      {resourceEdit.kind === 'url' && <Check checked={resourceEdit.fetch} onChange={fetch => setResourceEdit({ ...resourceEdit, fetch })}>任务开始时读取内容</Check>}
      {resourceEdit.fetch && <>
        <Field label="HTTP 账户"><select value={resourceEdit.accountId} onChange={event => setResourceEdit({ ...resourceEdit, accountId: event.target.value })}>
          <option value="">无需账户</option>{catalog.accounts.map(account => <option key={account.id} value={account.id}>{account.name} · {account.origin}</option>)}
        </select></Field>
        <button type="button" className="button" disabled={!httpOrigin(resourceEdit.value)} onClick={() => setResourceAccount({ ...blankAccount,
          origin: httpOrigin(resourceEdit.value), type: 'basic', credentialSource: 'saved' })}><KeyRound size={16} />为此要素保存账号密码</button>
      </>}
      <Field label="说明" detail="可选，说明 Agent 应关注什么。"><textarea rows={3} value={resourceEdit.prompt} onChange={event => setResourceEdit({ ...resourceEdit, prompt: event.target.value })} /></Field>
    </Editor>}
    {pickingFile && project && resourceEdit?.kind === 'file' && resourceEdit.projectId === project.id && resourceEdit.iterationId === iteration?.id && <DirectoryPicker fileMode title="选择本地文件" projectDirectory={project.directory}
      initial={filePickerStart(project.directory, resourceEdit.value)} close={() => setPickingFile(false)} select={value => {
        setResourceEdit(current => current && { ...current, value })
        setPickingFile(false)
      }} />}
    {resourceAccount && <ResourceAccountEditor account={resourceAccount} close={() => setResourceAccount(null)} lockOrigin onSaved={async account => {
      await refresh()
      setResourceEdit(current => current && { ...current, accountId: account.id })
    }} />}
  </>
}
