import { FileDiff } from 'lucide-react'
import type { Attempt } from '../../shared/contracts.ts'
import { Empty } from '../ui.tsx'

const labels = { added: '新增', modified: '修改', deleted: '删除', unknown: '有变更' }

export function FileChanges({ attempt }: { attempt: Attempt }) {
  const changes = attempt.fileChanges
  const legacy = attempt.acceptance?.files?.map(path => ({ path, kind: 'unknown' as const }))
  const files = changes?.files ?? legacy ?? []
  if (!files.length) {
    if (changes?.coverage === 'workspace' || changes?.coverage === 'api') {
      return <Empty icon={FileDiff} title="本次尝试暂无文件变更" />
    }
    if (changes?.coverage === 'unavailable') {
      return <Empty icon={FileDiff} title="未能核对工作区">工作目录可能超出扫描范围，或部分文件无法读取。</Empty>
    }
    return <Empty icon={FileDiff} title={attempt.status === 'running' ? '执行结束后记录文件变更' : '本次尝试暂无文件变更记录'} />
  }
  const total = changes?.total ?? files.length
  return <section className="run-file-changes" aria-label="本次尝试的文件变更">
    <div className="file-change-summary"><strong>{total} 个变更文件</strong>
      {changes?.coverage === 'api' && <span className="caption">已核对 API 工具写入的文件</span>}
      {total > files.length && <span className="caption">显示前 {files.length} 个</span>}
    </div>
    <ul>{files.map(({ path, kind }) => <li key={path}>
      <span className={`file-change-kind ${kind}`}>{labels[kind]}</span>
      <code>{path}</code>
    </li>)}</ul>
  </section>
}
