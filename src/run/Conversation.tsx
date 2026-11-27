import { useEffect } from 'react'
import { GitFork, MessageSquare } from 'lucide-react'
import type { Conversation, ConversationBranch, ConversationTurn } from '../../shared/contracts.ts'
import { statusLabels } from '../../shared/contracts.ts'
import { dateTime, Empty } from '../ui.tsx'
import { AgentResult, MessageText } from './Transcript.tsx'

export function turnLink(turn: ConversationTurn, execution?: string) {
  return `#/runs/${encodeURIComponent(turn.runId)}?turn=${encodeURIComponent(turn.id)}${execution ? `&execution=${execution}` : ''}`
}

function recordsLink(id: string) {
  return `#/runs/${encodeURIComponent(id)}?records=1`
}

function branchPath(conversation: Conversation, branch: ConversationBranch): ConversationTurn[] {
  if (branch.source?.kind !== 'fork') return branch.turns
  const parent = conversation.branches.find(item => item.id === branch.source?.branchId)
  if (!parent) return branch.turns
  const previous = branchPath(conversation, parent)
  const index = previous.findIndex(turn => turn.id === branch.source?.turnId)
  return index < 0 ? branch.turns : [...previous.slice(0, index + 1), ...branch.turns]
}

function BranchSelector({ conversation, branch }: { conversation: Conversation; branch: ConversationBranch }) {
  if (conversation.branches.length < 2) return null
  return <label className="conversation-branch-select"><GitFork size={15} /><span>查看分支</span>
    <select aria-label="查看分支" value={branch.id} onChange={event => {
      const next = conversation.branches.find(item => item.id === event.target.value)
      if (next) window.location.hash = recordsLink(next.latestRunId)
    }}>{conversation.branches.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select>
  </label>
}

export function ExecutionRecords({ conversation, branch, focus }: {
  conversation: Conversation; branch: ConversationBranch; focus?: string
}) {
  const turns = branchPath(conversation, branch)
  const sourceBranch = conversation.branches.find(item => item.id === branch.source?.branchId)
  const sourcePath = sourceBranch ? branchPath(conversation, sourceBranch) : []
  const sourceIndex = sourcePath.findIndex(turn => turn.id === branch.source?.turnId)
  const sourceTurn = sourcePath[sourceIndex]
  const focused = turns.some(turn => turn.id === focus) ? focus : undefined
  useEffect(() => {
    if (focused) document.getElementById(`conversation-turn-${focused}`)?.scrollIntoView({ block: 'nearest' })
  }, [focused, branch.id])
  return <section className="execution-records" aria-label="执行轮次">
    <header className="run-zone-head">
      <div><h2>执行记录</h2><p>回看每轮的目标和结果</p></div>
      <BranchSelector conversation={conversation} branch={branch} />
    </header>
    <div className="execution-records-body">
      {branch.source && sourceBranch && <p className="conversation-origin">
        {branch.source.kind === 'fork' ? '创建于' : branch.source.kind === 'handoff' ? '通过交接摘要继续自' : '来源记录'}
        {' '}{sourceTurn ? <a href={turnLink(sourceTurn)}>{sourceBranch.title} · 第 {sourceIndex + 1} 轮</a> : sourceBranch.title}
        {branch.source.kind === 'handoff' && ' · 另开的会话'}
      </p>}
      {!turns.length && <Empty icon={MessageSquare} title="暂无会话轮次" />}
      {turns.map((turn, index) => {
        const related = conversation.branches.filter(item => item.source?.turnId === turn.id)
        return <article key={turn.id} id={`conversation-turn-${turn.id}`} className={`conversation-turn${focused === turn.id ? ' focused' : ''}`}>
          <header className="conversation-turn-header">
            <h3>{turn.legacy ? '早期执行记录' : `第 ${index + 1} 轮`} · {turn.input.split('\n', 1)[0]}</h3>
            {focused === turn.id && <span className="chip">正在查看</span>}
            <span className="caption">{[turn.stageName, dateTime(turn.at), statusLabels[turn.status]].filter(Boolean).join(' · ')}</span>
          </header>
          <details className="conversation-evidence" open={focused === turn.id ? true : undefined}>
            <summary>执行详情</summary>
            <div>
              <a href={`#/runs/${encodeURIComponent(turn.runId)}`}>任务概览</a>
              <a href={turnLink(turn, 'timeline')}>执行过程</a>
              <a href={turnLink(turn, 'tools')}>工具与日志</a>
              <a href={turnLink(turn, 'native')}>审批与原始事件</a>
              {turn.files !== undefined && <a href={turnLink(turn, 'files')}>{turn.files} 个文件变化</a>}
              {turn.test && <a href={turnLink(turn, 'test')}>测试退出码 {turn.test.code ?? '—'}</a>}
            </div>
            <section><h4>目标</h4><MessageText text={turn.input} /></section>
            {!!turn.supplements?.length && <section><h4>补充要求</h4>{turn.supplements.map((text, index) => <MessageText key={index} text={text} />)}</section>}
            {turn.reply && <section><h4>结果</h4><AgentResult text={turn.reply} /></section>}
          </details>
          {related.map(item => <a className="conversation-child" key={item.id} href={recordsLink(item.latestRunId)}>
            <GitFork size={15} />{item.source?.kind === 'fork' ? '分支' : '另开的会话'} · {item.title}
          </a>)}
        </article>
      })}
    </div>
  </section>
}
