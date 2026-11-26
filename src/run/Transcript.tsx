import { Activity, Braces, FlaskConical, Send, Terminal } from 'lucide-react'
import Markdown from 'react-markdown'
import { details, readable, textOf } from './run-text.ts'
import type { Frame } from './run-text.ts'

const itemLabels: Record<string, string> = {
  commandExecution: '执行命令', fileChange: '文件变更', mcpToolCall: 'MCP 工具', dynamicToolCall: '工具调用',
  reasoning: '推理摘要', plan: '执行计划', tool_call: '工具调用', tool_call_update: '工具更新',
  'turn/diff/updated': '文件差异', 'turn/plan/updated': '执行计划', 'cursor/update_todos': '执行计划',
  agent_thought_chunk: '思考摘要', error: 'Agent 事件',
}

function AgentItem({ frame }: { frame: Frame }) {
  const { data, title, text } = frame
  const type = textOf(data.type ?? data.sessionUpdate) || title
  const label = itemLabels[type] || type
  const name = textOf(data.title || data.command || data.tool || data.kind)
  const status = textOf(data.status)
  const content = Array.isArray(data.content) ? data.content.map(value => {
    const item = details(value)
    return item.type === 'diff' ? [item.path, item.newText].filter(Boolean).join('\n') : textOf(details(item.content).text)
  }).filter(Boolean).join('\n') : textOf(details(data.content).text)
  const rawOutput = details(data.rawOutput)
  const output = text || textOf(data.aggregatedOutput ?? data.diff) || content || [textOf(rawOutput.stdout), textOf(rawOutput.stderr)].filter(Boolean).join('\n')
  return <details className="event-item"><summary><Terminal size={16} /><strong>{label}</strong>{name && <code className="ellipsis">{name}</code>}{status && <span className="chip">{status}</span>}</summary>
    {output && <pre className="console">{readable(output)}</pre>}
    <pre>{JSON.stringify(data, null, 2)}</pre>
  </details>
}

export function MessageText({ text }: { text: string }) {
  return <div className="markdown"><Markdown skipHtml components={{ img: ({ alt }) => <span>{alt}</span>, a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}>{text}</Markdown></div>
}

export function Transcript({ frames }: { frames: Frame[] }) {
  return <div className="transcript">{frames.map(frame => {
    if (frame.kind === 'agent_text') return frame.text && <div className="message-card" key={frame.id}><div className="message-label"><Braces size={15} />Agent</div>
      <MessageText text={frame.text} /></div>
    if (frame.kind === 'agent_item') return <AgentItem key={frame.id} frame={frame} />
    if (frame.kind === 'test_output') return <div className="output-card" key={frame.id}><span>{frame.title}</span><pre className="console">{readable(frame.text ?? '')}</pre></div>
    if (frame.kind === 'test_result') return <div className="system-event" key={frame.id}><FlaskConical size={15} /><strong>测试结果</strong><span>{frame.data.code === 0 ? '通过' : '未通过'} · 退出码 {String(frame.data.code ?? '—')}</span></div>
    if (frame.kind === 'input') return <details className="event-item" key={frame.id}><summary><Send size={15} /><strong>{frame.title}</strong></summary><pre>{frame.text}</pre></details>
    return <div className="system-event" key={frame.id}><Activity size={15} /><strong>{frame.title}</strong><span>{frame.text}</span></div>
  })}</div>
}
