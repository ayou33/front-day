import { useState } from 'react'
import { ClipboardList, KeyRound, Plus } from 'lucide-react'
import type { Account, Catalog } from '../shared/contracts.ts'
import { ItemActions, remove } from './catalog/common.tsx'
import { blankAccount, ResourceAccountEditor } from './ResourceAccountEditor.tsx'
import { Empty, SectionHeading } from './ui.tsx'

export function AccountsView({ catalog, refresh }: { catalog: Catalog; refresh: () => Promise<void> }) {
  const [accountEdit, setAccountEdit] = useState<Account | null>(null)
  return <>
    <SectionHeading title="资源账户" description="管理读取受保护资源时使用的 HTTP 账户。" />
    <div className="stack">
      <section className="panel"><div className="panel-header"><div className="icon-heading"><div className="section-icon"><KeyRound size={20} /></div>
        <div><h2>HTTP 资源账户</h2><p>账户可绑定到同源 URL，读取资料时按需使用。</p></div></div>
        <button className="button" onClick={() => setAccountEdit(blankAccount)}><Plus size={16} />添加账户</button></div>
        {catalog.accounts.map(account => <div className="list-row" key={account.id}><div className="list-icon"><KeyRound size={17} /></div>
          <div className="list-description"><strong>{account.name}</strong><div className="ellipsis muted">{account.origin} · {account.type === 'basic' ? '账号密码' : account.type} · {account.credentialSource === 'saved' ? '本机保存' : <code>{account.secretEnv}</code>}</div>
            {account.usage?.trim() && <div className="ellipsis muted">说明 · {account.usage}</div>}</div>
          <ItemActions name={account.name} onEdit={() => setAccountEdit(account)} onDelete={() => remove('accounts', account.id, refresh)} /></div>)}
        {!catalog.accounts.length && <Empty icon={ClipboardList} title="暂无 HTTP 账户">为需要认证的资源添加账户。</Empty>}
      </section>
    </div>
    {accountEdit && <ResourceAccountEditor account={accountEdit} close={() => setAccountEdit(null)} onSaved={refresh} />}
  </>
}
