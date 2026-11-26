import { useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import type { Interaction } from '../../shared/contracts.ts'
import { Field } from '../ui.tsx'
import type { RecordData } from './run-text.ts'

export function InteractionCard({ interaction, disabled, onAnswer }: { interaction: Interaction; disabled: boolean; onAnswer: (body: RecordData) => void }) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState<Record<string, boolean>>({})
  const [form, setForm] = useState(interaction.defaultValue ?? '')
  const update = (id: string, value: string[]) => setAnswers(current => ({ ...current, [id]: value }))
  const legacyRaw = interaction.type === 'approval' && !interaction.raw && /^[\[{]/.test(interaction.detail.trim())
  const raw = interaction.raw || (legacyRaw ? interaction.detail : '')
  return <section className="interaction" aria-label={interaction.title}><div className="icon-heading"><ShieldCheck size={20} /><h3>{interaction.title}</h3></div>
    <div className="interaction-body">
    {interaction.detail && !legacyRaw && <p className="interaction-description">{interaction.detail}</p>}
    {!!interaction.fields?.length && <dl className="approval-fields">{interaction.fields.map(({ label, value, code }) =>
      <div key={label}><dt>{label}</dt><dd className={code ? 'mono' : undefined}>{value}</dd></div>)}</dl>}
    {raw && <details className="resource-detail"><summary>查看原始请求</summary><pre>{raw}</pre></details>}
    {interaction.type === 'form' && <Field label="JSON 回复"><textarea rows={5} className="mono" value={form} onChange={event => setForm(event.target.value)} /></Field>}
    {interaction.questions?.map(question => <div className="question" key={question.id}>
      <strong>{question.label}</strong>
      {question.choices.map(choice => <label className="checkbox" key={choice.id}>
        <input type={question.multiple ? 'checkbox' : 'radio'} name={`${interaction.id}-${question.id}`}
          checked={!custom[question.id] && (answers[question.id] ?? []).includes(choice.id)} onChange={event => {
            setCustom(current => ({ ...current, [question.id]: false }))
            const current = custom[question.id] ? [] : answers[question.id] ?? []
            update(question.id, question.multiple ? event.target.checked ? [...current, choice.id] : current.filter(id => id !== choice.id) : [choice.id])
          }} />{choice.label}</label>)}
      {question.freeText && <input type={question.secret ? 'password' : 'text'} aria-label={`${question.label} · 文字回复`} placeholder="输入回复" value={custom[question.id] ? answers[question.id]?.[0] ?? '' : ''} onChange={event => {
        setCustom(current => ({ ...current, [question.id]: true })); update(question.id, [event.target.value])
      }} />}
    </div>)}
    </div>
    <div className="action-row interaction-actions">{interaction.type === 'question' ? <button className="button primary" disabled={disabled || interaction.questions?.some(question => !answers[question.id]?.some(value => value.trim()))}
      onClick={() => onAnswer({ answers })}>发送回复</button> : interaction.choices?.map((choice, index) => <button key={choice.id} disabled={disabled} className={`button ${index === 0 ? 'primary' : ''}`} onClick={() => onAnswer({ choice: choice.id, value: form })}>{choice.label}</button>)}</div>
  </section>
}
