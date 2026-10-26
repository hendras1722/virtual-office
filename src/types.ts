export type Provider = 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'ollama' | 'custom' | 'omp' | 'hermes' | 'codex' | 'antigravity' | 'claude'
export type TaskStatus = 'running' | 'completed' | 'failed'

export interface AgentCharacter {
  skin: number
  hairStyle: number
  hairColor: number
  glasses: boolean
  hood: boolean
}

export interface Agent {
  id: string
  name: string
  role: string
  provider: Provider
  model: string
  color: string
  createdAt: string
  workspace: string
  allowTools: boolean
  /** Chosen look; null or missing means a stable look derived from the id. */
  character?: AgentCharacter | null
}

export interface AgentSettings extends Agent {
  baseUrl: string
  hasApiKey: boolean
}

export interface AgentDraft {
  name: string
  role: string
  provider: Provider
  model: string
  color: string
  apiKey: string
  baseUrl: string
  workspace: string
  allowTools: boolean
  character?: AgentCharacter | null
}

export interface TodoPrompt {
  id: string
  agentId: string
  prompt: string
  createdAt: string
}

export interface Task {
  id: string
  agentId: string
  replyToId: string | null
  prompt: string
  status: TaskStatus
  output: string
  error: string
  createdAt: string
  completedAt: string | null
  activity: string
  autoApprove: boolean
  permission: TaskPermission | null
}

export interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface TaskPermission {
  requestId: string
  title: string
  details: string
  options: { id: string; label: string }[]
}

export interface LocalRuntime {
  provider: 'omp' | 'hermes' | 'codex' | 'antigravity' | 'claude'
  available: boolean
  message: string
}

export interface RuntimeStatus {
  workspace: string
  runtimes: LocalRuntime[]
}

export interface ApiResponse<T> {
  success: boolean
  data: T
  message: string
}

export const PROVIDERS: { id: Provider; label: string; model: string; initials: string }[] = [
  { id: 'openai', label: 'OpenAI · API key', model: 'gpt-4.1-mini', initials: 'O' },
  { id: 'anthropic', label: 'Anthropic · API key', model: 'claude-sonnet-4-6', initials: 'A' },
  { id: 'gemini', label: 'Google Gemini', model: 'gemini-2.5-flash', initials: 'G' },
  { id: 'deepseek', label: 'DeepSeek', model: 'deepseek-chat', initials: 'D' },
  { id: 'ollama', label: 'Ollama', model: 'llama3.2', initials: 'L' },
  { id: 'custom', label: 'OpenAI-compatible', model: '', initials: '+' },
  { id: 'omp', label: 'OMP · Local agent', model: '', initials: 'O' },
  { id: 'hermes', label: 'Hermes · Local agent', model: '', initials: 'H' },
  { id: 'codex', label: 'Codex · Login ChatGPT', model: '', initials: 'C' },
  { id: 'antigravity', label: 'Antigravity · Local agent', model: '', initials: 'A' },
  { id: 'claude', label: 'Claude Code · Local agent', model: '', initials: 'C' },
]

export const AGENT_COLORS = ['#8c9eff', '#e4a587', '#74c9ac', '#d7b56d', '#b99ae2', '#78bcd6']
export const DEFAULT_SEATS = 12
export const MAX_SEATS = 24

export function isLocalProvider(provider: Provider): provider is LocalRuntime['provider'] {
  return provider === 'omp' || provider === 'hermes' || provider === 'codex' || provider === 'antigravity' || provider === 'claude'
}
