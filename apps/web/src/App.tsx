import { useEffect, useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { api, type InputScore, type StyleReport } from './api'
import './App.css'

type Tab = 'playground' | 'style'

const SAMPLE_WEAK =
  'Hi, please carefully and thoroughly explain everything about binary search trees in as much detail as possible. Be comprehensive and thanks so much!'

function scoreClass(score: number) {
  if (score < 40) return 'weak'
  if (score < 70) return 'ok'
  return 'strong'
}

export default function App() {
  const [tab, setTab] = useState<Tab>('playground')
  const [prompt, setPrompt] = useState(SAMPLE_WEAK)
  const [context, setContext] = useState('')
  const [improveOn, setImproveOn] = useState(true)
  const [score, setScore] = useState<InputScore | null>(null)
  const [improved, setImproved] = useState<string | null>(null)
  const [changes, setChanges] = useState<string[]>([])
  const [improveMeta, setImproveMeta] = useState('')
  const [tokenInfo, setTokenInfo] = useState('')
  const [prepared, setPrepared] = useState('')
  const [assistant, setAssistant] = useState('')
  const [metrics, setMetrics] = useState<Record<string, unknown> | null>(null)
  const [report, setReport] = useState<StyleReport | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [apiOk, setApiOk] = useState(false)

  useEffect(() => {
    api
      .health()
      .then(() => setApiOk(true))
      .catch(() => setApiOk(false))
  }, [])

  const chartData = useMemo(
    () =>
      report?.top_patterns.map((p) => ({
        name: p.name,
        count: p.count,
      })) ?? [],
    [report],
  )

  async function onScore() {
    setError('')
    setBusy('Scoring…')
    try {
      const s = await api.scoreInput(prompt, context || undefined)
      setScore(s)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy('')
    }
  }

  async function onImprove() {
    setError('')
    setBusy('Improving…')
    try {
      const r = await api.improve(prompt, context || undefined)
      setImproved(r.improved)
      setChanges(r.changes)
      setImproveMeta(
        `${r.input_score_before} → ${r.input_score_after} (${r.mode}, Δ tokens ${r.est_token_delta})`,
      )
      setPrompt(r.improved)
      const s = await api.scoreInput(r.improved, context || undefined)
      setScore(s)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy('')
    }
  }

  async function onSend() {
    setError('')
    setBusy('Preparing & calling…')
    try {
      const messages = [
        {
          role: 'system' as const,
          content: context || 'You are a concise, practical assistant.',
        },
        { role: 'user' as const, content: prompt },
      ]
      const prep = await api.prepare({
        messages,
        improve: improveOn,
      })
      if (improveOn && prep.changes.length) setChanges(prep.changes)
      setPrepared(prep.messages.map((m) => `### ${m.role}\n${m.content}`).join('\n\n'))
      setTokenInfo(`~${prep.tokens_after} tokens after prepare`)
      setScore({
        input_score: prep.input_score,
        dimensions: score?.dimensions || {
          clarity: 0,
          specificity: 0,
          structure: 0,
          concision: 0,
          context_fit: 0,
        },
        findings: prep.findings,
        est_tokens: prep.tokens_after,
        band: scoreClass(prep.input_score),
      })

      const chat = await api.chat({
        messages: prep.messages,
        improve: false, // already prepared
      })
      setAssistant(chat.choices[0]?.message?.content || '')
      setMetrics(chat.promptlens)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy('')
    }
  }

  async function onLoadFixture() {
    setError('')
    setBusy('Importing sample history…')
    try {
      const res = await fetch('/sample_history.json')
      if (!res.ok) {
        throw new Error('Place fixtures in public/ or use Load via API button')
      }
      const payload = await res.json()
      const r = await api.importHistory(payload)
      const next = await api.styleReport()
      setReport(next)
      setTab('style')
      setBusy('')
      setImproveMeta(`Imported ${r.turns_ingested} turns`)
    } catch {
      try {
        const payload = await (await fetch('/fixtures/sample_history.json')).json()
        const r = await api.importHistory(payload)
        setReport(await api.styleReport())
        setTab('style')
        setImproveMeta(`Imported ${r.turns_ingested} turns`)
      } catch (e2) {
        setError(String(e2))
      } finally {
        setBusy('')
      }
    }
  }

  async function onRefreshReport() {
    setError('')
    setBusy('Loading style report…')
    try {
      setReport(await api.styleReport())
      setTab('style')
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="app">
      <header className="top">
        <div>
          <p className="brand">PromptLens</p>
          <p className="tag">Coach your prompting. Score every ask.</p>
        </div>
        <div className="status">
          <span className={apiOk ? 'dot on' : 'dot off'} />
          API {apiOk ? 'online' : 'offline'} · :8000
        </div>
      </header>

      <nav className="tabs">
        <button className={tab === 'playground' ? 'active' : ''} onClick={() => setTab('playground')}>
          Playground
        </button>
        <button className={tab === 'style' ? 'active' : ''} onClick={() => setTab('style')}>
          Style report
        </button>
        <button className="ghost" onClick={onLoadFixture} disabled={!!busy}>
          Import sample history
        </button>
      </nav>

      {error && <div className="banner error">{error}</div>}
      {busy && <div className="banner info">{busy}</div>}

      {tab === 'playground' && (
        <main className="grid">
          <section className="panel compose">
            <h2>Compose</h2>
            <label>
              Context (optional)
              <textarea
                value={context}
                onChange={(e) => setContext(e.target.value)}
                rows={6}
                placeholder="Optional background for scoring / the model call…"
              />
            </label>
            <label>
              Prompt
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={8} />
            </label>

            <div className="toggles">
              <label className="switch">
                <input type="checkbox" checked={improveOn} onChange={(e) => setImproveOn(e.target.checked)} />
                Improve (cheap model / heuristic)
              </label>
            </div>

            <div className="actions">
              <button onClick={onScore} disabled={!!busy}>
                Score
              </button>
              <button onClick={onImprove} disabled={!!busy}>
                Improve now
              </button>
              <button className="primary" onClick={onSend} disabled={!!busy}>
                Prepare & send
              </button>
            </div>
          </section>

          <section className="panel scorecard">
            <h2>Input score</h2>
            {score ? (
              <>
                <div className={`hero-score ${scoreClass(score.input_score)}`}>
                  {Math.round(score.input_score)}
                  <span>/100</span>
                </div>
                <p className="band">{score.band} · ~{score.est_tokens} tokens</p>
                <ul className="dims">
                  {Object.entries(score.dimensions).map(([k, v]) => (
                    <li key={k}>
                      <span>{k.replace('_', ' ')}</span>
                      <strong>{v}</strong>
                    </li>
                  ))}
                </ul>
                <h3>Findings</h3>
                <ul className="findings">
                  {score.findings.length === 0 && <li>No anti-patterns detected.</li>}
                  {score.findings.map((f, i) => (
                    <li key={`${f.id}-${i}`}>
                      <strong>{f.id}</strong> {f.message}
                      <em>{f.suggestion}</em>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="muted">Score a prompt to see the 0–100 breakdown.</p>
            )}
            {improveMeta && <p className="meta">{improveMeta}</p>}
            {changes.length > 0 && (
              <ul className="changes">
                {changes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel output">
            <h2>Prepared / response</h2>
            {tokenInfo && <p className="meta">{tokenInfo}</p>}
            {prepared && (
              <>
                <h3>After prepare</h3>
                <pre>{prepared}</pre>
              </>
            )}
            {assistant && (
              <>
                <h3>Model output</h3>
                <pre>{assistant}</pre>
              </>
            )}
            {metrics && (
              <>
                <h3>PromptLens metrics</h3>
                <pre>{JSON.stringify(metrics, null, 2)}</pre>
              </>
            )}
            {improved && !prepared && (
              <>
                <h3>Improved draft</h3>
                <pre>{improved}</pre>
              </>
            )}
          </section>
        </main>
      )}

      {tab === 'style' && (
        <main className="style">
          <div className="panel">
            <div className="style-head">
              <h2>Style report</h2>
              <button onClick={onRefreshReport} disabled={!!busy}>
                Refresh
              </button>
            </div>
            {!report || report.turns_analyzed === 0 ? (
              <p className="muted">Import sample history to generate your prompting fingerprint.</p>
            ) : (
              <>
                <p className="headline">{report.coaching_headline}</p>
                <div className="stat-row">
                  <div>
                    <span>Turns</span>
                    <strong>{report.turns_analyzed}</strong>
                  </div>
                  <div>
                    <span>Avg input score</span>
                    <strong className={scoreClass(report.avg_input_score)}>
                      {report.avg_input_score}
                    </strong>
                  </div>
                  <div>
                    <span>Est. tokens wasted</span>
                    <strong>{report.est_tokens_wasted}</strong>
                  </div>
                  <div>
                    <span>Est. $ wasted</span>
                    <strong>${report.est_usd_wasted.toFixed(4)}</strong>
                  </div>
                </div>
                <div className="chart-wrap">
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#d5ddd6" />
                      <XAxis dataKey="name" tick={{ fill: '#3d4a42', fontSize: 12 }} />
                      <YAxis allowDecimals={false} tick={{ fill: '#3d4a42', fontSize: 12 }} />
                      <Tooltip />
                      <Bar dataKey="count" fill="#0f7a5a" radius={[6, 6, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <h3>Sample findings</h3>
                <ul className="findings">
                  {report.sample_findings.map((f, i) => (
                    <li key={`${f.id}-${i}`}>
                      <strong>{f.id}</strong> {f.message}
                      <em>{f.suggestion}</em>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </main>
      )}

      <footer>
        Hackathon MVP · Stack R · Heuristic Improve works offline · Add OPENAI_API_KEY for live LLM
      </footer>
    </div>
  )
}
