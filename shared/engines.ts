export const engineProviders = ['cursor', 'codex', 'claude', 'copilot', 'opencode'] as const
export type Provider = typeof engineProviders[number]

export const approvalModes = ['manual', 'auto-approve', 'auto-deny'] as const
export type ApprovalMode = typeof approvalModes[number]
export const approvalLabels: Record<ApprovalMode, string> = {
  manual: '手动确认', 'auto-approve': '自动允许本次操作', 'auto-deny': '自动拒绝',
}

type ProviderGuide = {
  name: string; commands: string[]; args: string[]; docs: string; setup: string; login: string; status?: string
}

export const engineGuides: Record<Provider, ProviderGuide> = {
  cursor: { name: 'Cursor', commands: ['agent', 'cursor-agent'], args: ['acp'], docs: 'https://cursor.com/docs/cli/reference/authentication',
    setup: '安装 Cursor Agent CLI。在启动工作台的本机账户下登录 CLI，或通过环境变量配置 Cursor 凭据。', login: 'agent login', status: 'agent status' },
  codex: { name: 'Codex', commands: ['codex'], args: ['app-server', '--listen', 'stdio://'], docs: 'https://developers.openai.com/codex/app-server',
    setup: '使用 Codex CLI 自带的 App Server。若已在另一终端登录，请核对 CLI 路径、操作系统账户和 CODEX_HOME。', login: 'codex login', status: 'codex login status' },
  claude: { name: 'Claude Code', commands: ['claude-agent-acp', 'claude-code-acp'], args: [], docs: 'https://github.com/agentclientprotocol/claude-agent-acp',
    setup: '安装 Claude Agent ACP 适配器，并使用该适配器对应的 Claude CLI 登录。', login: 'claude auth login', status: 'claude auth status' },
  copilot: { name: 'GitHub Copilot', commands: ['copilot'], args: ['--acp', '--stdio'], docs: 'https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server',
    setup: '安装支持 ACP 的 GitHub Copilot CLI。可使用 CLI 登录或在本机配置 Copilot 支持的凭据。', login: 'copilot login' },
  opencode: { name: 'OpenCode', commands: ['opencode'], args: ['acp'], docs: 'https://opencode.ai/docs/cli/acp/',
    setup: '安装 OpenCode CLI，连接模型供应商并在 OpenCode 中配置可用模型。', login: 'opencode auth login', status: 'opencode auth list' },
}
