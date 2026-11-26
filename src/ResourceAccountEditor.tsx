import { useState } from 'react'
import type { Account } from '../shared/contracts.ts'
import { request } from './api.ts'
import { Dialog, EditForm, Field } from './ui.tsx'

export const blankAccount: Account = { id: '', name: '', origin: '', type: 'bearer', secretEnv: '', username: '', header: '', usage: '' }

export function httpOrigin(value: string) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.origin : ''
  } catch { return '' }
}

export function ResourceAccountEditor({ account, close, onSaved, lockOrigin }: {
  account: Account; close: () => void; onSaved: (account: Account) => Promise<void>; lockOrigin?: boolean
}) {
  const [draft, setDraft] = useState(account)
  const [password, setPassword] = useState('')
  const saved = draft.type === 'basic' && draft.credentialSource === 'saved'
  const keepPassword = !!account.id && account.credentialSource === 'saved' && account.username === draft.username && account.origin === httpOrigin(draft.origin)

  return <Dialog title={account.id ? '编辑资源账户' : '添加资源账户'} onClose={close}>
    <EditForm onClose={close} submitLabel="保存账户" onSubmit={async () => {
      const route = draft.id ? `/config/accounts/${encodeURIComponent(draft.id)}` : '/config/accounts'
      const created = await request<Account>(route, draft.id ? 'PUT' : 'POST', { ...draft, password: saved && password ? password : undefined })
      await onSaved(created)
      close()
    }}>
      <Field label="账户名称"><input required value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></Field>
      <Field label="来源" detail="仅填写协议、主机和端口，例如 https://api.example.com。"><input required type="url" className="mono" readOnly={lockOrigin} value={draft.origin}
        onChange={event => setDraft({ ...draft, origin: event.target.value })} /></Field>
      <Field label="认证方式"><select value={draft.type} onChange={event => {
        const type = event.target.value as Account['type']
        setDraft({ ...draft, type, credentialSource: type === 'basic' ? 'saved' : 'environment' })
        setPassword('')
      }}><option value="bearer">Bearer</option><option value="basic">账号密码（HTTP Basic）</option><option value="header">自定义请求头</option></select></Field>
      {draft.type === 'basic' && <div className="form-columns">
        <Field label="账号"><input required autoComplete="username" value={draft.username} onChange={event => setDraft({ ...draft, username: event.target.value })} /></Field>
        <Field label="密码来源"><select value={draft.credentialSource ?? 'environment'} onChange={event => {
          setDraft({ ...draft, credentialSource: event.target.value as Account['credentialSource'] })
          setPassword('')
        }}><option value="saved">加密保存在本机</option><option value="environment">环境变量</option></select></Field>
      </div>}
      {saved ? <Field label="密码" detail={keepPassword ? '留空继续使用已保存的密码。' : '读取绑定的资料时，后端会按需取用密码。'}>
        <input type="password" autoComplete="new-password" required={!keepPassword} value={password} onChange={event => setPassword(event.target.value)} />
      </Field> : <Field label="凭据环境变量"><input required className="mono" placeholder="MY_RESOURCE_TOKEN" value={draft.secretEnv}
        onChange={event => setDraft({ ...draft, secretEnv: event.target.value })} /></Field>}
      {draft.type === 'header' && <Field label="请求头名称"><input required className="mono" placeholder="X-Figma-Token" value={draft.header}
        onChange={event => setDraft({ ...draft, header: event.target.value })} /></Field>}
      <Field label="说明" detail="可选，说明这个账户的用途；读取资料时会一并交给 Agent。">
        <textarea rows={2} value={draft.usage ?? ''} onChange={event => setDraft({ ...draft, usage: event.target.value })} />
      </Field>
    </EditForm>
  </Dialog>
}
