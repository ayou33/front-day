import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Check, ChevronRight, File, Folder, HardDrive } from 'lucide-react'
import type { DirectoryBrowser } from '../shared/contracts.ts'
import { request } from './api.ts'
import { Dialog, ErrorLine, message } from './ui.tsx'

export function DirectoryPicker({ initial, close, select, title = '选择项目目录', fileMode = false, allowFolder = false, projectDirectory }: {
  initial: string; close: () => void; select: (path: string) => void; title?: string; fileMode?: boolean; allowFolder?: boolean; projectDirectory?: string
}) {
  const [view, setView] = useState<DirectoryBrowser>()
  const [address, setAddress] = useState(initial)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [selectedFile, setSelectedFile] = useState('')
  const requestId = useRef(0)

  const browse = useCallback(async (path?: string) => {
    const id = ++requestId.current
    setBusy(true)
    setError('')
    try {
      const query = new URLSearchParams()
      if (path) query.set('path', path)
      if (fileMode) query.set('files', '1')
      const result = await request<DirectoryBrowser>(`/directories?${query}`)
      if (requestId.current !== id) return
      setView(result)
      setAddress(result.kind === 'directory' ? result.path : '')
      setSelectedFile(result.kind === 'directory' ? result.selectedFile ?? '' : '')
    } catch (error) {
      if (requestId.current === id) setError(message(error))
    } finally {
      if (requestId.current === id) setBusy(false)
    }
  }, [fileMode])

  useEffect(() => {
    void browse(initial || undefined)
    return () => { requestId.current++ }
  }, [initial, browse])

  const directory = view?.kind === 'directory' ? view : undefined
  const selected = fileMode ? selectedFile : directory?.path
  return <Dialog title={title} onClose={close} wide>
    <div className="dialog-body">
      <div className="action-row directory-nav">
        {projectDirectory && <button type="button" className="button" onClick={() => { void browse(projectDirectory) }}><Folder size={16} />项目目录</button>}
        <button type="button" className="button" disabled={view?.kind === 'locations' && !busy} onClick={() => { void browse() }}><HardDrive size={16} />本机位置</button>
        {directory?.parent && <button type="button" className="button" disabled={busy} onClick={() => { void browse(directory.parent!) }}><ArrowUp size={16} />上一级</button>}
      </div>
      <form className="directory-address" onSubmit={event => { event.preventDefault(); if (address.trim()) void browse(address.trim()) }}>
        <input className="mono" aria-label={fileMode ? '文件或目录地址' : '目录地址'} placeholder="输入绝对路径快速跳转" value={address} disabled={busy} onChange={event => setAddress(event.target.value)} />
        <button className="button" disabled={busy || !address.trim()}>前往</button>
      </form>
      <ErrorLine text={error} />
      <div className="directory-entries" aria-busy={busy}>
        {busy ? <p className="caption">正在读取目录…</p> : view?.entries.length ? view.entries.map(entry =>
          <button type="button" className={`directory-entry${entry.path === selectedFile ? ' selected' : ''}`} key={entry.path}
            aria-pressed={entry.kind === 'file' ? entry.path === selectedFile : undefined}
            onClick={() => { if (entry.kind === 'file') setSelectedFile(entry.path); else void browse(entry.path) }}>
            {entry.kind === 'file' ? <File size={17} /> : view.kind === 'locations' ? <HardDrive size={17} /> : <Folder size={17} />}
            <span>{entry.name}{view.kind === 'locations' && entry.name !== entry.path && <small className="mono">{entry.path}</small>}</span>
            {entry.path === selectedFile ? <Check size={15} /> : entry.kind === 'directory' ? <ChevronRight size={15} /> : null}
          </button>) : view && <p className="caption">{fileMode && directory ? '这个目录没有可选文件，可进入子文件夹后使用当前文件夹。' : '这个目录没有子文件夹。'}</p>}
      </div>
    </div>
    <div className="dialog-footer"><button type="button" className="button" onClick={close}>取消</button>
      {fileMode && allowFolder && directory && <button type="button" className="button" disabled={busy} onClick={() => select(directory.path)}>使用此文件夹</button>}
      <button type="button" className="button primary" disabled={busy || !selected} onClick={() => { if (selected) select(selected) }}>{fileMode ? '使用此文件' : '使用此目录'}</button></div>
  </Dialog>
}
