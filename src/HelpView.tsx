import { BookOpen, Cable, CalendarRange, Database, FolderKanban, GitBranch, KeyRound, ListTodo, Rocket, Sparkles } from 'lucide-react'
import { SectionHeading } from './ui.tsx'
import './styles/help.css'

const topics = [
  { id: 'start', label: '快速开始' },
  { id: 'projects', label: '项目与要素' },
  { id: 'tasks', label: '任务' },
  { id: 'continuations', label: '续改与归档' },
  { id: 'plans', label: '计划' },
  { id: 'engines', label: '引擎与 API' },
  { id: 'accounts', label: '资源账户' },
  { id: 'optimizer', label: '提示词优化' },
  { id: 'data', label: '数据与偏好' },
  { id: 'faq', label: '常见问题' },
]

export function HelpView() {
  const jump = (id: string) => document.getElementById(`help-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  return <>
    <SectionHeading title="帮助" description="按工作流了解 Front Day 的主要功能与常见问题。" />
    <div className="help-layout">
      <nav className="panel help-nav" aria-label="帮助目录">
        {topics.map(topic => <button key={topic.id} type="button" onClick={() => jump(topic.id)}>{topic.label}</button>)}
      </nav>
      <div className="help-content">
        <section className="panel help-section" id="help-start">
          <div className="panel-header"><div className="icon-heading"><div className="section-icon"><Rocket size={20} /></div>
            <div><h2>快速开始</h2><p>从登记项目到看到 Agent 输出，通常只需要四步。</p></div></div></div>
          <div className="help-body">
            <ol className="help-steps">
              <li><div><strong>登记项目</strong><p>在「项目」选择本地目录。项目背景（范围、技术约定、限制、验收）会被同项目任务复用。</p></div></li>
              <li><div><strong>补充要素</strong><p>按需求、设计、模板、参考、接口、测试等分组添加要素。支持文本、URL、本地文件或文件夹，并可填写说明。</p></div></li>
              <li><div><strong>新建任务</strong><p>填写目标、选择任务类型；需要时指定引擎、授权模式或流水线模板。默认自动选择本机可用引擎。</p></div></li>
              <li><div><strong>跟进执行</strong><p>任务详情会实时显示消息、工具调用和测试结果；审批、提问或阶段放行会暂停等待处理。</p></div></li>
            </ol>
          </div>
        </section>

        <section className="panel help-section" id="help-projects">
          <div className="panel-header"><div className="icon-heading"><div className="section-icon"><FolderKanban size={20} /></div>
            <div><h2>项目与要素</h2><p>项目保存长期背景，迭代保存本次范围。</p></div></div></div>
          <div className="help-body">
            <ul className="help-list">
              <li>项目内文件或文件夹以相对路径关联，项目外路径以本机绝对路径关联；执行时把路径交给 Agent 按需读取。</li>
              <li>URL 要素可以开启「任务开始时读取内容」，也可以填写说明，让 Agent 知道该关注什么。</li>
              <li>迭代用于把一组需求限定在明确范围内；迭代任务同时使用项目和迭代两层背景。</li>
              <li>要素类型支持自定义；项目或迭代被删除时，其下的迭代与要素会一起清理。</li>
            </ul>
          </div>
        </section>

        <section className="panel help-section" id="help-tasks">
          <div className="panel-header"><div className="icon-heading"><div className="section-icon"><ListTodo size={20} /></div>
            <div><h2>任务</h2><p>任务只需填写目标，其余背景会自动组装。</p></div></div></div>
          <div className="help-body">
            <ul className="help-list">
              <li>任务类型会作为执行指引写入提示词：需求整理、功能开发、设计还原、接口联调、移植、Bug 修复、重构优化、测试验收，也可以自定义。</li>
              <li>「开始任务」立即进入队列；「保存」只登记为待开始，之后在任务详情点「开始任务」。待开始的任务会优先显示在任务记录顶部。</li>
              <li>在「任务上下文」可以回看实际发送给 Agent 的提示词；「文件变更」按阶段列出新增、修改和删除的文件。</li>
              <li>同一或目录重叠的任务会串行排队；不同目录可以并行执行。</li>
              <li>非执行中的任务可以点「编辑任务」修改目标、类型和补充信息；已经执行过的任务会锁定引擎与流水线模板。</li>
            </ul>
          </div>
        </section>

        <section className="panel help-section" id="help-continuations">
          <div className="panel-header"><div className="icon-heading"><div className="section-icon"><GitBranch size={20} /></div>
            <div><h2>续改与归档</h2><p>在已有结果上继续工作，而不是重新描述一遍背景。</p></div></div></div>
          <div className="help-body">
            <ul className="help-list">
              <li>任务概览按「任务目标 → 执行结果」组织：目标以输入消息样式靠右显示；执行结果包含变更与验证（文件变更、测试结论）和最终输出，交接摘要位于最下方。</li>
              <li>展开执行记录可查看轮次、来源和已有分支；正在查看的轮次会高亮，执行记录标题在滚动时保持可见。</li>
              <li>点击「继续修改」并填写目标。「继续当前会话」会在原 Agent 会话追加一轮，「用交接摘要开启新会话」会创建独立会话。</li>
              <li>已结束的本地 Codex 会话可在桌面端打开。其他引擎可通过「复制任务与上下文」把目标和资料交给原生应用。</li>
              <li>在任务记录中可以归档和恢复整组相关执行。归档前需等活动中的执行结束。</li>
            </ul>
          </div>
        </section>

        <section className="panel help-section" id="help-plans">
          <div className="panel-header"><div className="icon-heading"><div className="section-icon"><CalendarRange size={20} /></div>
            <div><h2>计划</h2><p>独立于任务的排期模块，计划数据需要自行维护。</p></div></div></div>
          <div className="help-body">
            <ul className="help-list">
              <li>计划是独立模块：计划项不是任务，不会触发 Agent 执行，也不会与任务记录、续改或归档产生关联。</li>
              <li>计划项的名称、日期、状态、备注和顺序都需要手动维护；任务开始或完成不会自动同步到计划。</li>
              <li>开始日期为今天的新计划默认「进行中」；选择未来日期默认「未开始」。只有进行中的计划在结束日期早于今天时自动显示为红色「已逾期」；未开始计划即使结束日期已过，仍按未开始显示。</li>
              <li>右键计划项（或聚焦后按 Shift+F10）打开快捷菜单；菜单只保留图标和操作名，禁用原因在悬停提示中显示。</li>
            </ul>
            <div className="help-table-wrap">
              <table className="help-table">
                <thead><tr><th>状态</th><th>开始</th><th>完成</th><th>延期到今天</th><th>删除</th></tr></thead>
                <tbody>
                  <tr><td>未开始</td><td>可用，开始日期改为今天</td><td>不可用</td><td>不显示</td><td>可用</td></tr>
                  <tr><td>进行中</td><td>不可用</td><td>可用</td><td>仅在已逾期时显示</td><td>可用</td></tr>
                  <tr><td>已完成</td><td>不可用</td><td>不可用</td><td>不显示</td><td>可用</td></tr>
                  <tr><td>进行中 · 已逾期</td><td>不可用</td><td>可用</td><td>可用，结束日期改为今天</td><td>可用</td></tr>
                </tbody>
              </table>
            </div>
            <ul className="help-list">
              <li>「开始」只对未开始的计划开放；执行时把开始日期改为今天，如果结束日期已过则同时改为今天，并转为进行中。</li>
              <li>「延期到今天」只对已逾期（进行中）计划出现；执行时把结束日期改为今天，开始日期保持不变。</li>
              <li>「完成」只对进行中的计划可用；未开始计划需要先开始，已完成计划只能删除。</li>
              <li>同一天开始的多个计划可以按住条目上下拖动排序；横向拖动仍然用于调整起止日期。</li>
              <li>鼠标停在月历上滚动滚轮可以切换月份：向下滚看下个月，向上滚看上个月；做了节流，快速滚动不会连续跳月。工具栏可翻转滚轮方向，选择会保存在本机。</li>
              <li>顶部会汇总待交付（今天、明天、本周、一周内 5 个工作日）和进行中的计划数量，点击可回到计划页。</li>
              <li>日期上可以添加标记（例如休假、学习日），标记支持颜色、样式和备注；背景色样式会自动选择黑色或白色文字以保证对比度。</li>
            </ul>
          </div>
        </section>

        <section className="panel help-section" id="help-engines">
          <div className="panel-header"><div className="icon-heading"><div className="section-icon"><Cable size={20} /></div>
            <div><h2>引擎与 API</h2><p>本机 CLI 和厂商 API 都可以作为执行器。</p></div></div></div>
          <div className="help-body">
            <ul className="help-list">
              <li>进入页面只查找 CLI 文件；点「检查连接」才会启动协议与认证诊断，并给出可复制的终端命令。</li>
              <li>默认模型留空沿用 CLI 设置；授权模式可设为手动确认、自动允许本次操作或自动拒绝。</li>
              <li>厂商 API 保存模型、用途和加密的 API Key；每行提供编辑、检查连接和删除入口。</li>
              <li>删除的 API 如果正在被提示词优化使用，会自动关闭提示词优化并清空执行器。</li>
              <li>自动派发优先选择已连接且认证就绪的引擎；手动指定的引擎始终优先。</li>
            </ul>
          </div>
        </section>

        <section className="panel help-section" id="help-accounts">
          <div className="panel-header"><div className="icon-heading"><div className="section-icon"><KeyRound size={20} /></div>
            <div><h2>资源账户</h2><p>集中管理读取受保护 URL 资料时使用的凭据。</p></div></div></div>
          <div className="help-body">
            <ul className="help-list">
              <li>支持 Basic、Bearer 和自定义请求头；账户与 URL 的协议、主机和端口必须一致。</li>
              <li>凭据可以保存在本机（加密），也可以只填写环境变量名，执行时从启动终端读取。</li>
              <li>账户的「说明」会在读取绑定资料时一并交给 Agent，说明这个账户的用途。</li>
              <li>URL 读取只接受文本和 JSON，单个响应最多 96 KB；密码和抓取内容中的密钥不会出现在日志中。</li>
            </ul>
          </div>
        </section>

        <section className="panel help-section" id="help-optimizer">
          <div className="panel-header"><div className="icon-heading"><div className="section-icon"><Sparkles size={20} /></div>
            <div><h2>提示词优化</h2><p>在「配置 → 提示词优化」选择执行器并开启。</p></div></div></div>
          <div className="help-body">
            <ul className="help-list">
              <li>执行器可以是本机 CLI 或厂商 API；厂商 API 的模型和密钥在「引擎与 API」中管理。</li>
              <li>优化只发送任务目标和任务类型，不会附带项目资料或要素内容。</li>
              <li>生成结果需要人工确认后才会应用到任务目标；最多 12000 字符输入。</li>
              <li>删除正在使用的 API 会自动关闭提示词优化，需要重新选择执行器并开启。</li>
            </ul>
          </div>
        </section>

        <section className="panel help-section" id="help-data">
          <div className="panel-header"><div className="icon-heading"><div className="section-icon"><Database size={20} /></div>
            <div><h2>数据与偏好</h2><p>所有数据都保存在本机，默认目录是项目下的 .front-day。</p></div></div></div>
          <div className="help-body">
            <ul className="help-list">
              <li>workbench.sqlite 保存配置、任务和事件；workbench.sqlite.key 保存账户与 API Key 的加密密钥。</li>
              <li>备份或迁移时，两个文件必须一起保留；只复制 SQLite 会导致已保存的密钥无法读取。</li>
              <li>在「配置」可以切换数据目录；切换会等待运行中的任务结束，并保留旧目录作为备份。</li>
              <li>外观支持跟随系统、浅色和深色；主题、默认引擎、默认任务类型等偏好保存在本机。</li>
            </ul>
          </div>
        </section>

        <section className="panel help-section" id="help-faq">
          <div className="panel-header"><div className="icon-heading"><div className="section-icon"><BookOpen size={20} /></div>
            <div><h2>常见问题</h2><p>遇到问题时先看这里。</p></div></div></div>
          <div className="help-body help-faq">
            <details><summary>服务重启后，运行中的任务去哪了？</summary><p>未完成的任务会标记为「已中断」并保留历史记录，可在任务详情重试当前阶段。</p></details>
            <details><summary>终端里已登录引擎，工作台却显示未登录？</summary><p>先核对 CLI 路径、启动终端的环境变量和 CODEX_HOME 是否一致；修改 PATH 后请从对应终端重启工作台。</p></details>
            <details><summary>为什么新任务没有立刻执行？</summary><p>同一或目录重叠的任务需要排队，避免同时修改同一工作目录；不同目录会并行执行。</p></details>
            <details><summary>为什么计划的「开始」或「完成」不可用？</summary><p>开始只对未开始计划开放，完成只对进行中计划开放。只有进行中的计划会在结束日期过去后标记逾期，可「延期到今天」；未开始计划即使结束日期已过仍按未开始处理，开始时会把结束日期顺延到今天。</p></details>
            <details><summary>提示词优化突然关闭了？</summary><p>如果它使用的厂商 API 被删除，系统会自动关闭优化并清空执行器；重新配置 API 后再次开启即可。</p></details>
            <details><summary>页面样式或主题没有更新？</summary><p>服务端代码不会热更新。更新代码后需要重启服务；浏览器可先强制刷新一次。</p></details>
          </div>
        </section>
      </div>
    </div>
  </>
}
