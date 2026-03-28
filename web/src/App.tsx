import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BrowserRouter, NavLink, Outlet, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom'
import { api, importContent, type CreateItemBody, type StudyCard } from './api'

type Folder = { id: string; parent_id: string | null; name: string; sort_order: number }

type BtnPhase = 'idle' | 'loading' | 'success' | 'error'

function btnPhaseClass(phase: BtnPhase): string {
  if (phase === 'loading') return ' btn-state-loading'
  if (phase === 'success') return ' btn-state-success'
  if (phase === 'error') return ' btn-state-error'
  return ''
}

function shortErr(s: string, max = 52): string {
  const t = s.trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

/** X-axis copy for the upcoming-due histogram (offset from today in the user’s stats timezone). */
function upcomingRelativeLabel(dayOffset: number): string {
  if (dayOffset === 0) return 'Today'
  if (dayOffset === 1) return 'Tomorrow'
  return `${dayOffset} days`
}

const MATURITY_BUCKET_LABEL: Record<string, string> = {
  new: 'New',
  learning: 'Learning',
  relearning: 'Relearning',
  review_lt_14d: '< 14 d',
  review_14_60d: '14–60 d',
  review_gte_60d: '60 d+',
}

/** Slash-separated path from root for each folder (e.g. `Shakespeare/Sonnets`). */
function allFolderPaths(folders: Folder[]): string[] {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const pathFor = (id: string): string => {
    const f = byId.get(id)
    if (!f) return ''
    if (f.parent_id == null) return f.name
    const parent = pathFor(f.parent_id)
    return parent ? `${parent}/${f.name}` : f.name
  }
  return [...new Set(folders.map((f) => pathFor(f.id)))].sort((a, b) => a.localeCompare(b))
}

function useFolderTree(folders: Folder[]) {
  return useMemo(() => {
    const byParent = new Map<string | null, Folder[]>()
    for (const f of folders) {
      const p = f.parent_id
      if (!byParent.has(p)) byParent.set(p, [])
      byParent.get(p)!.push(f)
    }
    for (const list of byParent.values()) list.sort((a, b) => a.name.localeCompare(b.name))
    const out: { folder: Folder; depth: number }[] = []
    const walk = (pid: string | null, depth: number) => {
      for (const f of byParent.get(pid) ?? []) {
        out.push({ folder: f, depth })
        walk(f.id, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }, [folders])
}

/** Short subtitle for study header: FSRS phase + lapse hint (reps removed as low-signal for learners). */
function studyCardMeta(card: { state: number; lapses: number }): string | null {
  const parts: string[] = []
  if (card.state === 0) parts.push('New')
  else if (card.state === 1) parts.push('Learning')
  else if (card.state === 3) parts.push('Relearning')
  if (card.lapses > 0) parts.push(card.lapses === 1 ? '1 lapse' : `${card.lapses} lapses`)
  return parts.length > 0 ? parts.join(' · ') : null
}

function StudyCardMetaLine({ card }: { card: StudyCard }) {
  const m = studyCardMeta(card)
  if (!m) return null
  return <span className="muted" style={{ fontSize: '0.78rem' }}>{m}</span>
}

function shuffleOptions<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function BottomNav() {
  const linkCls = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : '')
  return (
    <nav className="bottom-nav" aria-label="Main">
      <div className="bottom-nav-inner">
        <NavLink to="/" end className={linkCls}>
          Home
        </NavLink>
        <NavLink to="/study" className={linkCls}>
          Study
        </NavLink>
        <NavLink to="/folders" className={linkCls}>
          Folders
        </NavLink>
        <NavLink to="/create" className={linkCls}>
          Create
        </NavLink>
        <NavLink to="/import" className={linkCls}>
          Import
        </NavLink>
        <NavLink to="/stats" className={linkCls}>
          Stats
        </NavLink>
        <NavLink to="/settings" className={linkCls}>
          Settings
        </NavLink>
      </div>
    </nav>
  )
}

function Layout() {
  return (
    <>
      <Outlet />
      <BottomNav />
    </>
  )
}

function StudyPage() {
  const [search] = useSearchParams()
  const folderId = search.get('folder') ?? undefined
  const [queue, setQueue] = useState<StudyCard[]>([])
  /** Cards returned in the last `/study/due` fetch (0 if none). Used to tell “session done” vs “nothing due”. */
  const [batchSize, setBatchSize] = useState(0)
  const [moreDueAfterBatch, setMoreDueAfterBatch] = useState(0)
  const [studyRecap, setStudyRecap] = useState<{ reviewsToday: number; dueTomorrow: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [reviewErr, setReviewErr] = useState<string | null>(null)
  const [flipped, setFlipped] = useState(false)
  const [mcqPicked, setMcqPicked] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  /** Bumped whenever the due-queue is (re)fetched so MCQ option order reshuffles even for the same card. */
  const [mcqShuffleKey, setMcqShuffleKey] = useState(0)

  const load = useCallback((mode: 'normal' | 'ahead' = 'normal') => {
    setLoading(true)
    setLoadErr(null)
    setStudyRecap(null)
    const reviewAhead = mode === 'ahead'
    api
      .studyDue(folderId, { reviewAhead })
      .then((r) => {
        setQueue(r.cards)
        setBatchSize(r.cards.length)
        setMoreDueAfterBatch(Math.max(0, r.dueCount - r.dueNowInQueue))
        setFlipped(false)
        setMcqPicked(null)
        setMcqShuffleKey((k) => k + 1)
      })
      .catch((e) => setLoadErr(e instanceof Error ? e.message : 'Failed'))
      .finally(() => setLoading(false))
  }, [folderId])

  useEffect(() => {
    load('normal')
  }, [load])

  useEffect(() => {
    if (loading || queue[0]) return
    let cancelled = false
    api
      .statsSummary(folderId)
      .then((s) => {
        if (!cancelled) setStudyRecap({ reviewsToday: s.reviewsToday, dueTomorrow: s.dueTomorrow })
      })
      .catch(() => {
        if (!cancelled) setStudyRecap(null)
      })
    return () => {
      cancelled = true
    }
  }, [loading, queue, folderId])

  const card = queue[0]
  const shuffledMcq = useMemo(() => {
    if (!card || card.cardKind !== 'mcq' || !card.mcq) return []
    return shuffleOptions(card.mcq.options)
  }, [card?.id, card?.cardKind, card?.mcq, mcqShuffleKey])

  useEffect(() => {
    setReviewErr(null)
  }, [card?.id])

  const onGrade = async (rating: string) => {
    if (!card || submitting) return
    setSubmitting(true)
    setReviewErr(null)
    try {
      await api.review(card.id, rating)
      setQueue((q) => q.slice(1))
      setFlipped(false)
      setMcqPicked(null)
    } catch (e) {
      setReviewErr(e instanceof Error ? e.message : 'Review failed')
    } finally {
      setSubmitting(false)
    }
  }

  const mcqRevealed = mcqPicked != null

  return (
    <div className="shell">
      <h2 style={{ marginTop: 0 }}>Study</h2>
      {folderId && (
        <p className="muted" style={{ marginTop: '-0.25rem' }}>
          Filtered folder only
        </p>
      )}
      {card && (
        <p className="muted study-cards-left" style={{ marginTop: folderId ? '0.15rem' : '-0.25rem' }}>
          {queue.length} {queue.length === 1 ? 'card' : 'cards'} left
          {moreDueAfterBatch > 0 ? ` · ${moreDueAfterBatch} more due after this batch (refresh)` : ''}
        </p>
      )}
      {loading && !card && (
        <div className="card-panel">
          <button type="button" className="btn btn-ghost btn-block btn-state-loading btn-feedback-label" disabled>
            Loading queue…
          </button>
        </div>
      )}
      {!loading && !card && (
        <div className="card-panel">
          <p>{batchSize > 0 ? 'Session complete — nice work.' : 'No cards due right now.'}</p>
          {studyRecap && (
            <dl className="study-recap">
              <div>
                <dt>Reviews today</dt>
                <dd>{studyRecap.reviewsToday}</dd>
              </div>
              <div>
                <dt>Due tomorrow</dt>
                <dd>{studyRecap.dueTomorrow}</dd>
              </div>
            </dl>
          )}
          <button
            type="button"
            className={`btn btn-ghost btn-block btn-feedback-label${loadErr ? ' btn-state-error' : ''}`}
            style={{ marginTop: '0.75rem' }}
            onClick={() => void load('normal')}
          >
            {loadErr ? shortErr(loadErr, 120) : 'Refresh'}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-block"
            style={{ marginTop: '0.5rem' }}
            title="Loads your normal due queue first, then up to 20 cards with the soonest future due times. FSRS grades at the real time you answer—early reviews usually shorten the next interval a bit."
            onClick={() => void load('ahead')}
          >
            Review ahead (up to 20)
          </button>
        </div>
      )}
      {card && (
        <div className="card-panel">
          <div className="study-card-header">
            <div className="study-card-meta">
              <span className="pill">
                {card.cardKind === 'mcq'
                  ? 'MCQ'
                  : card.cardKind === 'sequence'
                    ? 'Sequence'
                    : card.cardKind === 'flashcard'
                      ? 'Flashcard'
                      : card.cardKind}
              </span>
              <StudyCardMetaLine card={card} />
            </div>
          </div>
          {(card.cardKind === 'flashcard' || card.cardKind === 'sequence') && (
            <>
              {!flipped ? (
                <button
                  type="button"
                  className="study-flip"
                  aria-label="Reveal answer"
                  onClick={() => setFlipped(true)}
                >
                  <div className="study-flip-inner">
                    <div className="study-prompt sequence-body">{card.front}</div>
                    <div className="study-flip-cta">Reveal answer</div>
                  </div>
                </button>
              ) : (
                <div className="study-reveal">
                  <p className="study-prompt-back sequence-body">{card.front}</p>
                  <div className="study-reveal-divider" aria-hidden />
                  <p className="study-answer sequence-body">{card.back}</p>
                  <div className="grade-row">
                    {(['again', 'hard', 'good', 'easy'] as const).map((g) => (
                      <button
                        key={g}
                        type="button"
                        className={`btn grade-btn${submitting ? ' btn-state-loading' : ''}`}
                        disabled={submitting}
                        onClick={() => onGrade(g)}
                      >
                        {submitting ? '…' : g}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
          {card.cardKind === 'mcq' && card.mcq && (
            <>
              <p className="study-mcq-q">{card.mcq.question}</p>
              {shuffledMcq.map((opt, idx) => {
                let cls = 'option-btn'
                if (mcqRevealed) {
                  if (opt.correct) cls += ' correct-pick'
                  else if (idx === mcqPicked && !opt.correct) cls += ' wrong-pick'
                }
                return (
                  <button
                    key={`${idx}-${opt.text}`}
                    type="button"
                    className={cls}
                    disabled={mcqRevealed || submitting}
                    onClick={() => setMcqPicked(idx)}
                  >
                    {opt.text}
                  </button>
                )
              })}
              {mcqRevealed && (
                <>
                  {card.mcq.explanation?.trim() ? (
                    <p className="study-mcq-explanation">{card.mcq.explanation.trim()}</p>
                  ) : null}
                  <div className="grade-row" style={{ marginTop: '1rem' }}>
                    {(['again', 'hard', 'good', 'easy'] as const).map((g) => (
                      <button
                        key={g}
                        type="button"
                        className={`btn grade-btn${submitting ? ' btn-state-loading' : ''}`}
                        disabled={submitting}
                        onClick={() => onGrade(g)}
                      >
                        {submitting ? '…' : g}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
          {reviewErr && (
            <button
              type="button"
              className="btn btn-danger btn-block btn-feedback-label"
              style={{ marginTop: '0.75rem', flexDirection: 'column', gap: '0.2rem' }}
              onClick={() => setReviewErr(null)}
            >
              <span>{shortErr(reviewErr, 220)}</span>
              <span style={{ fontSize: '0.72rem', fontWeight: 500, opacity: 0.92 }}>Tap to dismiss</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function FoldersPage() {
  const nav = useNavigate()
  const [folders, setFolders] = useState<Folder[]>([])
  const [name, setName] = useState('')
  const [parentId, setParentId] = useState<string | null>(null)
  const [createBtn, setCreateBtn] = useState<{ phase: BtnPhase; text?: string }>({ phase: 'idle' })
  const [delState, setDelState] = useState<{ id: string; phase: BtnPhase; text?: string } | null>(null)
  const createTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const delTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tree = useFolderTree(folders)

  useEffect(() => {
    return () => {
      if (createTimer.current) clearTimeout(createTimer.current)
      if (delTimer.current) clearTimeout(delTimer.current)
    }
  }, [])

  const refresh = () => api.folders().then((r) => setFolders(r.folders as Folder[]))

  useEffect(() => {
    refresh().catch(() => {})
  }, [])

  const create = async () => {
    if (!name.trim()) return
    if (createTimer.current) clearTimeout(createTimer.current)
    setCreateBtn({ phase: 'loading' })
    try {
      await api.createFolder(name.trim(), parentId)
      setName('')
      await refresh()
      setCreateBtn({ phase: 'success' })
      createTimer.current = setTimeout(() => setCreateBtn({ phase: 'idle' }), 2200)
    } catch (e) {
      const text = shortErr(e instanceof Error ? e.message : 'Failed')
      setCreateBtn({ phase: 'error', text })
      createTimer.current = setTimeout(() => setCreateBtn({ phase: 'idle' }), 4000)
    }
  }

  const remove = async (id: string) => {
    if (!confirm('Delete folder and its contents?')) return
    if (delTimer.current) clearTimeout(delTimer.current)
    setDelState({ id, phase: 'loading' })
    try {
      await api.deleteFolder(id)
      await refresh()
      setDelState(null)
    } catch (e) {
      const text = shortErr(e instanceof Error ? e.message : 'Failed')
      setDelState({ id, phase: 'error', text })
      delTimer.current = setTimeout(() => setDelState(null), 4000)
    }
  }

  const createLabel =
    createBtn.phase === 'loading'
      ? 'Creating…'
      : createBtn.phase === 'success'
        ? 'Created ✓'
        : createBtn.phase === 'error'
          ? createBtn.text ?? 'Failed'
          : 'Create'

  return (
    <div className="shell">
      <h2 style={{ marginTop: 0 }}>Folders</h2>
      <div className="card-panel" style={{ marginBottom: '1rem' }}>
        <label className="muted" htmlFor="fname">
          New folder
        </label>
        <input
          id="fname"
          className="text-inp"
          style={{ marginTop: '0.35rem', marginBottom: '0.5rem' }}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
        />
        <label className="muted" htmlFor="fpar">
          Under (optional)
        </label>
        <select
          id="fpar"
          className="text-inp"
          style={{ marginTop: '0.35rem' }}
          value={parentId ?? ''}
          onChange={(e) => setParentId(e.target.value || null)}
        >
          <option value="">— top level —</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={`btn btn-primary btn-block btn-feedback-label${btnPhaseClass(createBtn.phase)}`}
          style={{ marginTop: '0.75rem' }}
          disabled={createBtn.phase === 'loading'}
          onClick={() => void create()}
        >
          {createLabel}
        </button>
      </div>
      <div>
        {tree.map(({ folder: f, depth }) => (
          <div key={f.id} className="folder-row" style={{ marginLeft: depth * 14 }}>
            <button
              type="button"
              className="link"
              onClick={() => nav(`/study?folder=${encodeURIComponent(f.id)}`)}
            >
              {f.name}
            </button>
            <div className="row-actions">
              {f.id !== 'inbox' && (
                <button
                  type="button"
                  className={
                    delState?.id === f.id && delState.phase === 'loading'
                      ? 'del-state-loading'
                      : delState?.id === f.id && delState.phase === 'error'
                        ? 'del-state-error'
                        : undefined
                  }
                  disabled={delState?.id === f.id && delState.phase === 'loading'}
                  onClick={() => void remove(f.id)}
                >
                  {delState?.id === f.id && delState.phase === 'loading'
                    ? '…'
                    : delState?.id === f.id && delState.phase === 'error'
                      ? delState.text ?? 'Failed'
                      : 'Del'}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

const FORMAT_HELP_BODY = `Each block starts with a line like @flashcard, @mcq, or @timeline.
Optional: Folder: path/with/slashes (match an “Available folder” below, or a new path is created)

@flashcard
Folder: Shakespeare/Sonnets
Q: From fairest creatures we desire increase,
A: That thereby beauty's rose might never die.

@mcq
Q: Which play features Prospero?
* The Tempest
- Hamlet
- Macbeth
E: Optional note after you answer (Explain: works too). Place after options; extra lines count as part of E:.

@timeline
Numbered events in order; each card asks for the next line after the one shown (Sequence).
Folder: History/WW2
Title: Pacific
1. Pearl Harbor
2. Midway
3. Okinawa`

type CreateKind = CreateItemBody['kind']

function CreatePage() {
  const [folders, setFolders] = useState<Folder[]>([])
  const [folderId, setFolderId] = useState('inbox')
  const [kind, setKind] = useState<CreateKind>('flashcard')
  const [submitBtn, setSubmitBtn] = useState<{ phase: BtnPhase; text?: string }>({ phase: 'idle' })
  const submitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [fcFront, setFcFront] = useState('')
  const [fcBack, setFcBack] = useState('')

  const [mcqQ, setMcqQ] = useState('')
  const [mcqCorrect, setMcqCorrect] = useState('')
  const [mcqWrong, setMcqWrong] = useState<string[]>(['', ''])
  const [mcqExpl, setMcqExpl] = useState('')

  const [seqTitle, setSeqTitle] = useState('')
  const [seqLines, setSeqLines] = useState('')

  const refreshFolders = useCallback(() => {
    api.folders().then((r) => setFolders(r.folders as Folder[]))
  }, [])

  useEffect(() => {
    refreshFolders()
  }, [refreshFolders])

  useEffect(() => {
    return () => {
      if (submitTimer.current) clearTimeout(submitTimer.current)
    }
  }, [])

  const addWrong = () => setMcqWrong((w) => [...w, ''])
  const setWrongAt = (i: number, v: string) => setMcqWrong((w) => w.map((x, j) => (j === i ? v : x)))
  const removeWrong = (i: number) => setMcqWrong((w) => (w.length <= 1 ? w : w.filter((_, j) => j !== i)))

  const submit = async () => {
    if (submitTimer.current) clearTimeout(submitTimer.current)
    setSubmitBtn({ phase: 'loading' })
    try {
      if (kind === 'flashcard') {
        await api.createItem({ kind: 'flashcard', folderId, front: fcFront, back: fcBack })
        setFcFront('')
        setFcBack('')
        setSubmitBtn({ phase: 'success', text: 'Flashcard saved ✓' })
      } else if (kind === 'mcq') {
        const wrong = mcqWrong.map((s) => s.trim()).filter(Boolean)
        await api.createItem({
          kind: 'mcq',
          folderId,
          question: mcqQ,
          correct: mcqCorrect,
          wrong,
          ...(mcqExpl.trim() ? { explanation: mcqExpl.trim() } : {}),
        })
        setMcqQ('')
        setMcqCorrect('')
        setMcqWrong(['', ''])
        setMcqExpl('')
        setSubmitBtn({ phase: 'success', text: 'MCQ saved ✓' })
      } else {
        const r = await api.createItem({
          kind: 'sequence',
          folderId,
          title: seqTitle.trim() || 'Timeline',
          eventsText: seqLines,
        })
        setSeqLines('')
        setSeqTitle('')
        setSubmitBtn({
          phase: 'success',
          text: `Saved — ${r.cardsCreated} ${r.cardsCreated === 1 ? 'card' : 'cards'}`,
        })
      }
      submitTimer.current = setTimeout(() => setSubmitBtn({ phase: 'idle' }), 2200)
    } catch (e) {
      const text = shortErr(e instanceof Error ? e.message : 'Failed')
      setSubmitBtn({ phase: 'error', text })
      submitTimer.current = setTimeout(() => setSubmitBtn({ phase: 'idle' }), 4500)
    }
  }

  const createSubmitLabel =
    submitBtn.phase === 'loading'
      ? 'Saving…'
      : submitBtn.phase === 'success'
        ? submitBtn.text ?? 'Saved ✓'
        : submitBtn.phase === 'error'
          ? submitBtn.text ?? 'Failed'
          : 'Create'

  return (
    <div className="shell">
      <h2 style={{ marginTop: 0 }}>Create</h2>
      <p className="muted">Add one flashcard, MCQ, or sequence (timeline) at a time.</p>
      <label className="muted" htmlFor="create-folder">
        Folder
      </label>
      <select
        id="create-folder"
        className="text-inp"
        style={{ marginTop: '0.35rem', marginBottom: '0.75rem' }}
        value={folderId}
        onChange={(e) => setFolderId(e.target.value)}
      >
        {folders.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>

      <div className="create-kind-bar" role="tablist" aria-label="Card type">
        {(
          [
            ['flashcard', 'Flashcard'],
            ['mcq', 'MCQ'],
            ['sequence', 'Sequence'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={kind === k}
            className={`btn btn-ghost create-kind-tab${kind === k ? ' create-kind-tab-active' : ''}`}
            onClick={() => {
              setKind(k)
              if (submitBtn.phase !== 'loading') setSubmitBtn({ phase: 'idle' })
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="card-panel create-form-panel">
        {kind === 'flashcard' && (
          <>
            <label className="muted" htmlFor="fc-front">
              Front (prompt)
            </label>
            <textarea id="fc-front" className="mono" style={{ marginTop: '0.35rem' }} value={fcFront} onChange={(e) => setFcFront(e.target.value)} rows={4} placeholder="Question or prompt…" />
            <label className="muted" htmlFor="fc-back" style={{ display: 'block', marginTop: '0.75rem' }}>
              Back (answer)
            </label>
            <textarea id="fc-back" className="mono" style={{ marginTop: '0.35rem' }} value={fcBack} onChange={(e) => setFcBack(e.target.value)} rows={4} placeholder="Answer…" />
          </>
        )}

        {kind === 'mcq' && (
          <>
            <label className="muted" htmlFor="mcq-q">
              Question
            </label>
            <textarea id="mcq-q" className="mono" style={{ marginTop: '0.35rem' }} value={mcqQ} onChange={(e) => setMcqQ(e.target.value)} rows={3} placeholder="Question…" />
            <label className="muted" htmlFor="mcq-correct" style={{ display: 'block', marginTop: '0.75rem' }}>
              Correct option
            </label>
            <input id="mcq-correct" className="text-inp" style={{ marginTop: '0.35rem' }} value={mcqCorrect} onChange={(e) => setMcqCorrect(e.target.value)} placeholder="The right answer" />
            <p className="muted" style={{ margin: '0.75rem 0 0.35rem', fontSize: '0.82rem' }}>
              Wrong options (at least one)
            </p>
            {mcqWrong.map((w, i) => (
              <div key={i} className="create-mcq-wrong-row">
                <input
                  className="text-inp"
                  aria-label={`Wrong option ${i + 1}`}
                  value={w}
                  onChange={(e) => setWrongAt(i, e.target.value)}
                  placeholder={`Distractor ${i + 1}`}
                />
                <button type="button" className="btn btn-ghost" disabled={mcqWrong.length <= 1} onClick={() => removeWrong(i)}>
                  Remove
                </button>
              </div>
            ))}
            <button type="button" className="btn btn-ghost btn-block" style={{ marginTop: '0.5rem' }} onClick={addWrong}>
              Add wrong option
            </button>
            <label className="muted" htmlFor="mcq-expl" style={{ display: 'block', marginTop: '0.75rem' }}>
              Explanation (optional)
            </label>
            <textarea id="mcq-expl" className="mono" style={{ marginTop: '0.35rem' }} value={mcqExpl} onChange={(e) => setMcqExpl(e.target.value)} rows={3} placeholder="Shown after answering…" />
          </>
        )}

        {kind === 'sequence' && (
          <>
            <label className="muted" htmlFor="seq-title">
              Title
            </label>
            <input id="seq-title" className="text-inp" style={{ marginTop: '0.35rem' }} value={seqTitle} onChange={(e) => setSeqTitle(e.target.value)} placeholder="e.g. Pacific theater" />
            <label className="muted" htmlFor="seq-lines" style={{ display: 'block', marginTop: '0.75rem' }}>
              Steps (one per line, in order)
            </label>
            <textarea
              id="seq-lines"
              className="mono"
              style={{ marginTop: '0.35rem' }}
              value={seqLines}
              onChange={(e) => setSeqLines(e.target.value)}
              rows={8}
              placeholder={'Pearl Harbor\nMidway\nOkinawa'}
            />
            <p className="muted" style={{ marginTop: '0.5rem', fontSize: '0.82rem' }}>
              Creates one sequence card per adjacent pair (each step → recall the next).
            </p>
          </>
        )}
      </div>

      <button
        type="button"
        className={`btn btn-primary btn-block btn-feedback-label${btnPhaseClass(submitBtn.phase)}`}
        style={{ marginTop: '1rem' }}
        disabled={submitBtn.phase === 'loading'}
        onClick={() => void submit()}
      >
        {createSubmitLabel}
      </button>
    </div>
  )
}

function buildFormatReference(paths: string[]): string {
  const folderLines =
    paths.length === 0
      ? '(No folders loaded yet.)'
      : ['Available folders:', ...paths.map((p) => `  • ${p}`)].join('\n')
  return [folderLines, '', FORMAT_HELP_BODY].join('\n')
}

function ImportPage() {
  const [folders, setFolders] = useState<Folder[]>([])
  const [text, setText] = useState('')
  const [defaultFolder, setDefaultFolder] = useState('inbox')
  const [importBtn, setImportBtn] = useState<{ phase: BtnPhase; text?: string }>({ phase: 'idle' })
  const [copyBtn, setCopyBtn] = useState<{ phase: BtnPhase }>({ phase: 'idle' })
  const [errs, setErrs] = useState<{ line: number; message: string }[]>([])
  const importTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refreshFolders = useCallback(() => {
    api.folders().then((r) => setFolders(r.folders as Folder[]))
  }, [])

  useEffect(() => {
    refreshFolders()
  }, [refreshFolders])

  useEffect(() => {
    return () => {
      if (importTimer.current) clearTimeout(importTimer.current)
      if (copyTimer.current) clearTimeout(copyTimer.current)
    }
  }, [])

  const formatReference = useMemo(() => buildFormatReference(allFolderPaths(folders)), [folders])

  const copyReference = async () => {
    if (copyTimer.current) clearTimeout(copyTimer.current)
    try {
      await navigator.clipboard.writeText(formatReference)
      setCopyBtn({ phase: 'success' })
      copyTimer.current = setTimeout(() => setCopyBtn({ phase: 'idle' }), 2000)
    } catch {
      setCopyBtn({ phase: 'error' })
      copyTimer.current = setTimeout(() => setCopyBtn({ phase: 'idle' }), 2800)
    }
  }

  const run = async () => {
    if (importTimer.current) clearTimeout(importTimer.current)
    setImportBtn({ phase: 'loading' })
    setErrs([])
    const res = await importContent(text, defaultFolder)
    if (!res.ok) {
      setImportBtn({ phase: 'error', text: shortErr(res.message, 48) })
      importTimer.current = setTimeout(() => setImportBtn({ phase: 'idle' }), 4500)
      return
    }
    setErrs(res.errors)
    const w = res.errors.length ? ` · ${res.errors.length} warnings` : ''
    setImportBtn({
      phase: 'success',
      text: shortErr(`Imported ${res.created.items} items, ${res.created.cards} cards${w}`, 52),
    })
    importTimer.current = setTimeout(() => setImportBtn({ phase: 'idle' }), 3200)
    refreshFolders()
  }

  const importLabel =
    importBtn.phase === 'loading'
      ? 'Importing…'
      : importBtn.phase === 'success'
        ? importBtn.text ?? 'Imported ✓'
        : importBtn.phase === 'error'
          ? importBtn.text ?? 'Import failed'
          : 'Import'

  const copyLabel =
    copyBtn.phase === 'success' ? 'Copied!' : copyBtn.phase === 'error' ? 'Copy blocked' : 'Copy'

  return (
    <div className="shell">
      <h2 style={{ marginTop: 0 }}>Import</h2>
      <p className="muted">Paste text in the format below. Default folder applies when a block has no Folder: line.</p>
      <label className="muted" htmlFor="def">
        Default folder
      </label>
      <select id="def" className="text-inp" style={{ marginTop: '0.35rem', marginBottom: '0.75rem' }} value={defaultFolder} onChange={(e) => setDefaultFolder(e.target.value)}>
        {folders.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      <textarea className="mono" value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste here…" />
      <details style={{ marginTop: '0.75rem' }}>
        <summary className="muted" style={{ cursor: 'pointer', listStyle: 'none' }}>
          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
            <span>Format reference</span>
            <button
              type="button"
              className={`btn btn-ghost${btnPhaseClass(copyBtn.phase)}`}
              style={{ padding: '0.35rem 0.65rem', fontSize: '0.75rem', flexShrink: 0 }}
              disabled={copyBtn.phase !== 'idle'}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                void copyReference()
              }}
            >
              {copyLabel}
            </button>
          </span>
        </summary>
        <pre className="help-pre">{formatReference}</pre>
      </details>
      <button
        type="button"
        className={`btn btn-primary btn-block btn-feedback-label${btnPhaseClass(importBtn.phase)}`}
        style={{ margin: '1rem 0' }}
        disabled={importBtn.phase === 'loading'}
        onClick={() => void run()}
      >
        {importLabel}
      </button>
      {errs.length > 0 && (
        <ul className="err-list">
          {errs.map((e, i) => (
            <li key={i}>
              Line {e.line}: {e.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function StatsPage() {
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof api.statsSummary>> | null>(null)
  const [heat, setHeat] = useState<{ date: string; count: number }[]>([])
  const [upcoming, setUpcoming] = useState<{ date: string; count: number }[]>([])
  const [upcomingDays, setUpcomingDays] = useState(14)
  const [maturity, setMaturity] = useState<{ id: string; count: number }[]>([])
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([api.statsSummary(), api.heatmap(364), api.maturityHistogram()])
      .then(([s, h, m]) => {
        setSummary(s)
        setHeat(h.days)
        setMaturity(m.buckets)
      })
      .catch((e) => setErr(e instanceof Error ? e.message : 'Failed'))
  }, [])

  useEffect(() => {
    api
      .upcomingHistogram(upcomingDays)
      .then((r) => setUpcoming(r.days))
      .catch(() => setUpcoming([]))
  }, [upcomingDays])

  const max = useMemo(() => Math.max(1, ...heat.map((d) => d.count)), [heat])
  const upcomingMax = useMemo(() => Math.max(1, ...upcoming.map((d) => d.count)), [upcoming])
  const maturityMax = useMemo(() => Math.max(1, ...maturity.map((b) => b.count)), [maturity])

  return (
    <div className="shell">
      <h2 style={{ marginTop: 0 }}>Statistics</h2>
      {err && <p style={{ color: '#ffb4b4' }}>{err}</p>}
      {summary && (
        <p className="muted">
          Timezone: <strong style={{ color: 'var(--text)' }}>{summary.timezone}</strong>
        </p>
      )}
      {summary && (
        <div className="stat-grid" style={{ marginBottom: '1.25rem' }}>
          <div className="stat-tile">
            Streak
            <strong>{summary.streak}</strong>
          </div>
          <div className="stat-tile">
            Reviews today
            <strong>{summary.reviewsToday}</strong>
          </div>
        </div>
      )}
      <div className="card-panel" style={{ marginBottom: '1.25rem' }}>
        <div className="forecast-head">
          <h3 style={{ margin: 0 }}>Upcoming due</h3>
          <label className="muted forecast-range-label" htmlFor="forecast-days">
            Days
          </label>
          <select
            id="forecast-days"
            className="text-inp forecast-range-select"
            value={upcomingDays}
            onChange={(e) => setUpcomingDays(Number(e.target.value))}
          >
            {[7, 14, 21, 30, 45, 60].map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
        <p className="muted" style={{ fontSize: '0.82rem', marginTop: '0.35rem' }}>
          Cards due per calendar day ({summary?.timezone ?? 'your timezone'}). Older backlog is counted on today.
        </p>
        {upcoming.length > 0 && (
          <div className="forecast-hist" role="img" aria-label="Upcoming reviews by day">
            {upcoming.map((d, i) => {
              const h = upcomingMax > 0 ? Math.round((d.count / upcomingMax) * 100) : 0
              const lab = upcomingRelativeLabel(i)
              return (
                <div key={d.date} className="forecast-bar-wrap" title={`${lab} (${d.date}) · ${d.count} card${d.count === 1 ? '' : 's'}`}>
                  <div className="forecast-bar-track">
                    <div
                      className="forecast-bar-fill"
                      style={{
                        height: `${Math.max(h, d.count > 0 ? 8 : 0)}%`,
                        minHeight: d.count > 0 ? 14 : undefined,
                      }}
                    >
                      {d.count > 0 ? <span className="forecast-bar-value">{d.count}</span> : null}
                    </div>
                    {d.count === 0 ? <span className="forecast-bar-value forecast-bar-value--track">0</span> : null}
                  </div>
                  <span className="forecast-bar-label">{lab}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
      <div className="card-panel" style={{ marginBottom: '1.25rem' }}>
        <h3 style={{ marginTop: 0 }}>Card maturity</h3>
        <p className="muted" style={{ fontSize: '0.82rem', marginTop: '0.35rem' }}>
          New / learning / relearning are FSRS phases. For <strong style={{ color: 'var(--text)' }}>review</strong> cards, the
          number is <strong style={{ color: 'var(--text)' }}>stability in days</strong>: the model’s estimate of how strong the
          memory is—the typical spacing scale before recall gets difficult. Higher days ≈ more mature; it’s not a fixed due date.
        </p>
        {maturity.length > 0 && (
          <div className="forecast-hist maturity-hist" role="img" aria-label="Cards by maturity">
            {maturity.map((b) => {
              const h = maturityMax > 0 ? Math.round((b.count / maturityMax) * 100) : 0
              const lab = MATURITY_BUCKET_LABEL[b.id] ?? b.id
              return (
                <div key={b.id} className="forecast-bar-wrap" title={`${lab} · ${b.count} card${b.count === 1 ? '' : 's'}`}>
                  <div className="forecast-bar-track">
                    <div
                      className="forecast-bar-fill maturity-bar-fill"
                      style={{
                        height: `${Math.max(h, b.count > 0 ? 8 : 0)}%`,
                        minHeight: b.count > 0 ? 14 : undefined,
                      }}
                    >
                      {b.count > 0 ? <span className="forecast-bar-value">{b.count}</span> : null}
                    </div>
                    {b.count === 0 ? <span className="forecast-bar-value forecast-bar-value--track">0</span> : null}
                  </div>
                  <span className="forecast-bar-label maturity-bar-label">{lab}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
      <div className="card-panel">
        <h3 style={{ marginTop: 0 }}>Activity</h3>
        <p className="muted" style={{ fontSize: '0.82rem' }}>
          Last ~52 weeks (scroll horizontally on small screens)
        </p>
        <div className="heatmap-wrap">
          <div className="heatmap">
            {heat.map((d) => {
              const i = d.count / max
              const bg = d.count === 0 ? 'rgba(255,255,255,0.04)' : `rgba(61,214,198,${0.2 + i * 0.65})`
              return <div key={d.date} className="heatmap-cell" style={{ background: bg }} title={`${d.date}: ${d.count}`} />
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

function SettingsPage() {
  const [tz, setTz] = useState('UTC')
  const [saveBtn, setSaveBtn] = useState<{ phase: BtnPhase; text?: string }>({ phase: 'idle' })
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    api.settings().then((s) => setTz(s.timezone))
  }, [])

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [])

  const save = async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    setSaveBtn({ phase: 'loading' })
    try {
      await api.patchSettings(tz.trim())
      setSaveBtn({ phase: 'success', text: 'Saved ✓' })
      saveTimer.current = setTimeout(() => setSaveBtn({ phase: 'idle' }), 2200)
    } catch (e) {
      const text = shortErr(e instanceof Error ? e.message : 'Failed')
      setSaveBtn({ phase: 'error', text })
      saveTimer.current = setTimeout(() => setSaveBtn({ phase: 'idle' }), 4500)
    }
  }

  const saveLabel =
    saveBtn.phase === 'loading'
      ? 'Saving…'
      : saveBtn.phase === 'success'
        ? saveBtn.text ?? 'Saved ✓'
        : saveBtn.phase === 'error'
          ? saveBtn.text ?? 'Failed'
          : 'Save timezone'

  return (
    <div className="shell">
      <h2 style={{ marginTop: 0 }}>Settings</h2>
      <p className="muted">IANA timezone for streaks and heatmap days (e.g. Europe/London).</p>
      <input className="text-inp" value={tz} onChange={(e) => setTz(e.target.value)} />
      <button
        type="button"
        className={`btn btn-primary btn-block btn-feedback-label${btnPhaseClass(saveBtn.phase)}`}
        style={{ marginTop: '0.75rem' }}
        disabled={saveBtn.phase === 'loading'}
        onClick={() => void save()}
      >
        {saveLabel}
      </button>
    </div>
  )
}

function HomePage() {
  const nav = useNavigate()
  const [s, setS] = useState<Awaited<ReturnType<typeof api.statsSummary>> | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    api
      .statsSummary()
      .then(setS)
      .catch((e) => setErr(e instanceof Error ? e.message : 'Failed to load'))
  }, [])
  return (
    <div className="shell">
      <h1 style={{ marginTop: 0 }}>Learner</h1>
      <p className="muted">Spaced repetition with FSRS — text flashcards and MCQs.</p>
      {err && <p className="err-list">{err}</p>}
      {s && (
        <div className="stat-grid" style={{ marginTop: '1.25rem' }}>
          <div className="stat-tile">
            Due now
            <strong>{s.dueNow}</strong>
          </div>
          <div className="stat-tile">
            Streak
            <strong>{s.streak}</strong>
          </div>
          <div className="stat-tile">
            Today
            <strong>{s.reviewsToday}</strong>
          </div>
          <div className="stat-tile">
            Cards
            <strong>{s.totalCards}</strong>
          </div>
        </div>
      )}
      <div style={{ marginTop: '1.5rem' }}>
        <button type="button" className="btn btn-primary btn-block" onClick={() => nav('/study')}>
          Start reviewing
        </button>
      </div>
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/study" element={<StudyPage />} />
          <Route path="/folders" element={<FoldersPage />} />
          <Route path="/create" element={<CreatePage />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/stats" element={<StatsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
