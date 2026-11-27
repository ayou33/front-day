import { ArrowRight, FileDiff, FlaskConical } from 'lucide-react'
import { splitHandoff } from '../../shared/continuations.ts'
import type { Run, TestResult } from '../../shared/contracts.ts'
import { dateTime } from '../ui.tsx'
import { HandoffSummary, MessageText } from './Transcript.tsx'
import { readable } from './run-text.ts'
import { fileBreakdown, runEvidence } from './run-summary.ts'
import type { StageAttempt, StageEvidence } from './run-summary.ts'

const coverageLabels = {
  workspace: '已核对工作区',
  api: '已核对 API 工具写入',
  legacy: '来自阶段验收记录',
}

function stageLabel(run: Run, row: StageAttempt) {
  return run.templateName ? row.stage.name : '本次执行'
}

function testDetail(result: TestResult) {
  const duration = result.ms < 1000 ? `${result.ms} ms` : `${(result.ms / 1000).toFixed(1)} 秒`
  return [`退出码 ${result.code ?? '—'}`, duration, result.signal].filter(Boolean).join(' · ')
}

function FileSummaryCard({ run, rows, onInspect }: { run: Run; rows: StageEvidence[]; onInspect: (stage: number, tab: 'files') => void }) {
  if (rows.length > 1) {
    const changed = rows.filter(row => row.files.state === 'changed')
    const unavailable = rows.filter(row => row.files.state === 'unavailable')
    if (changed.length) {
      return <article className="run-evidence-card">
        <header><h5><FileDiff size={15} />文件变更</h5><span className="run-evidence-value">{changed.length} 个阶段有变更</span></header>
        <ul className="run-evidence-list">{changed.map(row => {
          const files = row.files
          if (files.state !== 'changed') return null
          return <li key={row.index}>
            <button type="button" className="run-evidence-row" aria-label={`查看${row.stage.name}的文件变更`}
              onClick={() => onInspect(row.index, 'files')}>
              <span className="run-evidence-row-stage">{row.stage.name}</span>
              <span className="run-evidence-row-value">{files.total} 个文件</span>
              <ArrowRight size={13} />
            </button>
          </li>
        })}</ul>
        {!!unavailable.length && <p className="run-evidence-meta">{unavailable.map(row => row.stage.name).join('、')}超出核对范围</p>}
      </article>
    }
    if (unavailable.length) {
      return <article className="run-evidence-card">
        <header><h5><FileDiff size={15} />文件变更</h5><span className="run-evidence-value is-warn">未核对</span></header>
        <p className="run-evidence-detail">{unavailable.length === rows.length ? '工作目录超出核对范围，或部分文件无法读取。' : '部分阶段的工作目录超出核对范围，无法确认全部改动。'}</p>
      </article>
    }
    if (rows.some(row => row.files.state === 'empty')) {
      return <article className="run-evidence-card">
        <header><h5><FileDiff size={15} />文件变更</h5><span className="run-evidence-value">无变更</span></header>
        <p className="run-evidence-detail">已核对的阶段都没有发现文件改动。</p>
      </article>
    }
    return <article className="run-evidence-card">
      <header><h5><FileDiff size={15} />文件变更</h5><span className="run-evidence-value">暂无记录</span></header>
      <p className="run-evidence-detail">各阶段最近一次尝试没有记录文件变更。</p>
    </article>
  }

  // 文件变更是相对每次尝试开始时的差异，因此以最近一次可核对的尝试为准。
  const usable = rows.filter(row => row.files.state === 'changed' || row.files.state === 'empty').at(-1)
  const unavailable = rows.findLast(row => row.files.state === 'unavailable')
  const row = usable ?? unavailable

  if (!row) {
    return <article className="run-evidence-card">
      <header><h5><FileDiff size={15} />文件变更</h5><span className="run-evidence-value">{rows.length ? '暂无记录' : '尚未执行'}</span></header>
      <p className="run-evidence-detail">{rows.length ? '本次尝试没有记录文件变更。' : '任务开始后可核对文件变更。'}</p>
    </article>
  }

  const files = row.files
  if (files.state === 'changed') {
    const counts = fileBreakdown(files.files)
    const breakdown = [
      counts.added ? `新增 ${counts.added}` : '',
      counts.modified ? `修改 ${counts.modified}` : '',
      counts.deleted ? `删除 ${counts.deleted}` : '',
      counts.unknown ? `变更 ${counts.unknown}` : '',
    ].filter(Boolean).join(' · ')
    return <article className="run-evidence-card">
      <header><h5><FileDiff size={15} />文件变更</h5><span className="run-evidence-value">{files.total} 个文件</span></header>
      <p className="run-evidence-detail">{breakdown || '已记录文件变更'}</p>
      <p className="run-evidence-meta">{[coverageLabels[files.coverage], run.templateName && row.stage.name,
        files.total > files.files.length && `仅统计列出的 ${files.files.length} 个`].filter(Boolean).join(' · ')}</p>
      <button type="button" className="run-evidence-action" onClick={() => onInspect(row.index, 'files')}>查看文件变更<ArrowRight size={13} /></button>
    </article>
  }

  if (files.state === 'empty') {
    return <article className="run-evidence-card">
      <header><h5><FileDiff size={15} />文件变更</h5><span className="run-evidence-value">无变更</span></header>
      <p className="run-evidence-detail">{coverageLabels[files.coverage]}，没有发现文件改动。</p>
      {run.templateName && <p className="run-evidence-meta">{row.stage.name}</p>}
    </article>
  }

  return <article className="run-evidence-card">
    <header><h5><FileDiff size={15} />文件变更</h5><span className="run-evidence-value is-warn">未核对</span></header>
    <p className="run-evidence-detail">工作目录超出核对范围，或部分文件无法读取。</p>
    {run.templateName && <p className="run-evidence-meta">{row.stage.name}</p>}
  </article>
}

function TestSummaryCard({ run, rows, onInspect }: { run: Run; rows: StageEvidence[]; onInspect: (stage: number, tab: 'test') => void }) {
  const results = rows.flatMap(row => row.test.state === 'passed' || row.test.state === 'failed'
    ? [{ row, state: row.test.state, result: row.test.result }]
    : [])

  if (results.length) {
    const latest = results.at(-1)!
    const failed = results.filter(item => item.state === 'failed')
    const value = results.length === 1 ? (latest.state === 'passed' ? '通过' : '未通过')
      : failed.length ? `${failed.length} 项未通过` : '全部通过'
    return <article className="run-evidence-card">
      <header><h5><FlaskConical size={15} />测试结论</h5><span className={`run-evidence-value ${failed.length ? 'is-fail' : 'is-ok'}`}>{value}</span></header>
      {results.length === 1 ? <>
        <p className="run-evidence-detail">{testDetail(latest.result)}</p>
        {run.templateName && <p className="run-evidence-meta">{stageLabel(run, latest.row)}</p>}
        <button type="button" className="run-evidence-action" onClick={() => onInspect(latest.row.index, 'test')}>查看测试结果<ArrowRight size={13} /></button>
      </> : <ul className="run-evidence-list">{results.map(item => <li key={item.row.index}>
        <button type="button" className="run-evidence-row" aria-label={`查看${stageLabel(run, item.row)}的测试结果`}
          onClick={() => onInspect(item.row.index, 'test')}>
          <span className="run-evidence-row-stage">{stageLabel(run, item.row)}</span>
          <span className={`run-evidence-row-value ${item.state === 'passed' ? 'is-ok' : 'is-fail'}`}>{item.state === 'passed' ? '通过' : '未通过'} · {item.result.code ?? '—'}</span>
          <ArrowRight size={13} />
        </button>
      </li>)}</ul>}
    </article>
  }

  const running = rows.some(row => row.test.state === 'running')
  const missing = rows.some(row => row.test.state === 'missing')
  const value = running ? '测试中' : missing ? '未执行' : rows.length ? '未配置' : '尚未执行'
  const detail = running ? '测试命令正在执行，完成后显示结论。'
    : missing ? '测试没有返回结果，可能尚未执行或已中断。'
      : rows.length ? '当前任务没有配置测试命令。' : '任务开始后显示测试结论。'
  return <article className="run-evidence-card">
    <header><h5><FlaskConical size={15} />测试结论</h5><span className={`run-evidence-value${running ? ' is-warn' : ''}`}>{value}</span></header>
    <p className="run-evidence-detail">{detail}</p>
  </article>
}

function emptyResultText(run: Run) {
  if (run.status === 'saved') return '任务开始后，Agent 的最终结论会显示在这里。'
  if (!['succeeded', 'failed', 'stopped', 'interrupted'].includes(run.status)) return '任务尚未结束，最终结论将在完成后显示。'
  return '本次执行没有留下结果，可查看「执行过程」或「工具与日志」。'
}

export function RunOverview({ run, onInspect }: { run: Run; onInspect: (stage: number, tab: 'files' | 'test') => void }) {
  const rows = runEvidence(run)
  const latestResult = rows.findLast(({ stage, attempt }) => stage.engine && attempt.output?.trim())
  const output = latestResult ? splitHandoff(readable(latestResult.attempt.output!)) : undefined
  const handoff = latestResult?.attempt.handoff ?? output?.handoff
  return <div className="run-overview">
    <section className="run-overview-section run-overview-goal-section" aria-label="任务目标">
      <div className="run-overview-section-head run-overview-goal-head"><h3>任务目标</h3></div>
      <div className="run-overview-goal"><MessageText text={run.goal || run.title} /></div>
    </section>
    <section className="run-overview-section" aria-label="执行结果">
      <div className="run-overview-section-head">
        <h3>执行结果</h3>
        {latestResult && <span className="caption">
          {run.templateName && `${latestResult.stage.name} · `}第 {latestResult.attempt.number} 次尝试
          {latestResult.attempt.endedAt && ` · 结束于 ${dateTime(latestResult.attempt.endedAt)}`}
        </span>}
      </div>
      {latestResult
        ? <div className="run-overview-result">{output?.text && <MessageText text={output.text} />}</div>
        : <p className="run-overview-empty">{emptyResultText(run)}</p>}
      <div className="run-result-evidence">
        <div className="run-overview-section-head"><h4>变更与验证</h4><span className="caption">各阶段最近一次尝试</span></div>
        <div className="run-evidence-summary">
          <FileSummaryCard run={run} rows={rows} onInspect={onInspect} />
          <TestSummaryCard run={run} rows={rows} onInspect={onInspect} />
        </div>
      </div>
      {handoff && <div className="run-result-handoff"><HandoffSummary handoff={handoff} /></div>}
    </section>
  </div>
}
