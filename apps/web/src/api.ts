/** Thin API client for PromptLens backend. */

// Dev default: direct API. Docker/nginx build sets VITE_API_BASE="" for same-origin proxy.
const API_BASE =
  import.meta.env.VITE_API_BASE === undefined
    ? 'http://127.0.0.1:8000'
    : import.meta.env.VITE_API_BASE

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || res.statusText)
  }
  return res.json() as Promise<T>
}

export type Finding = {
  id: string
  severity: string
  span: number[]
  message: string
  suggestion: string
}

export type InputScore = {
  input_score: number
  dimensions: {
    clarity: number
    specificity: number
    structure: number
    concision: number
    context_fit: number
  }
  findings: Finding[]
  est_tokens: number
  band: string
}

export type StyleReport = {
  turns_analyzed: number
  avg_input_score: number
  est_tokens_wasted: number
  est_usd_wasted: number
  top_patterns: { id: string; name: string; count: number; share: number }[]
  coaching_headline: string
  sample_findings: Finding[]
}

export const api = {
  health: () => request<{ status: string }>('/health'),
  config: () => request<Record<string, unknown>>('/v1/config'),
  scoreInput: (prompt: string, context?: string) =>
    request<InputScore>('/v1/score/input', {
      method: 'POST',
      body: JSON.stringify({ prompt, context: context || null }),
    }),
  improve: (prompt: string, context?: string) =>
    request<{
      improved: string
      changes: string[]
      risk_flags: string[]
      input_score_before: number
      input_score_after: number
      est_token_delta: number
      mode: string
    }>('/v1/improve', {
      method: 'POST',
      body: JSON.stringify({ prompt, context: context || null }),
    }),
  prepare: (body: {
    messages: { role: string; content: string }[]
    improve: boolean
  }) =>
    request<{
      messages: { role: string; content: string }[]
      input_score: number
      findings: Finding[]
      improved: boolean
      tokens_before: number
      tokens_after: number
      changes: string[]
      improve_mode: string | null
    }>('/v1/prepare', {
      method: 'POST',
      body: JSON.stringify({ ...body, strip: false }),
    }),
  chat: (body: { messages: { role: string; content: string }[]; improve: boolean }) =>
    request<{
      choices: { message: { content: string } }[]
      usage: { prompt_tokens: number; completion_tokens: number }
      promptlens: Record<string, unknown>
    }>('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        messages: body.messages,
        stream: false,
        promptlens: {
          improve: body.improve,
          strip: false,
          score: true,
        },
      }),
    }),
  importHistory: (payload: unknown) =>
    request<{ conversation_ids: string[]; turns_ingested: number }>('/v1/history/import', {
      method: 'POST',
      body: JSON.stringify({ source: 'generic', payload }),
    }),
  styleReport: () => request<StyleReport>('/v1/analytics/style-report'),
}
