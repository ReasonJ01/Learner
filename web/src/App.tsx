import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BrowserRouter,
  NavLink,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { api, importContent, type CreateItemBody, type ManageCard, type StudyCard } from './api'
import {
  CARDS_PAGE_SIZE,
  cardsListQueryKey,
  foldersQueryKey,
  settingsQueryKey,
  statsHeatmapQueryKey,
  statsMaturityQueryKey,
  statsSummaryQueryKey,
  statsUpcomingQueryKey,
  studyDueQueryKey,
} from './query-keys'

const SHELL_CLASS = 'mx-auto min-h-full max-w-[520px] px-4 pb-[5.25rem] pt-4 sm:pb-24'

/** Paths that count as “Library” for bottom nav highlight. */
const LIBRARY_PATHS = ['/library', '/folders', '/cards', '/create', '/import'] as const

function librarySectionActive(pathname: string): boolean {
  return LIBRARY_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

function LibraryBackLink() {
  const nav = useNavigate()
  return (
    <div className="mb-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ms-2 h-8 gap-1 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
        onClick={() => nav('/library')}
      >
        ← Library
      </Button>
    </div>
  )
}

const CARD_PANEL_CLASS =
  'gap-0 border-white/[0.06] bg-gradient-to-br from-[#24302a] to-[#1c2822] py-5 shadow-[var(--shadow)] ring-1 ring-white/10'

const FIELD_INPUT_CLASS = 'mt-1.5 bg-black/25 text-[0.9375rem] leading-normal md:text-sm'

const SELECT_FIELD_CLASS =
  'mt-1.5 flex h-9 w-full rounded-lg border border-input bg-black/25 px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'

type Folder = { id: string; parent_id: string | null; name: string; sort_order: number }

type BtnPhase = 'idle' | 'loading' | 'success' | 'error'

function primaryFeedbackClass(phase: BtnPhase): string {
  switch (phase) {
    case 'loading':
      return 'pointer-events-none cursor-wait opacity-80'
    case 'success':
      return '!bg-gradient-to-br !from-[#45e8b8] !to-[#18a070] !text-[#052016]'
    case 'error':
      return '!bg-gradient-to-br !from-[#e07070] !to-[#a02828] !text-white'
    default:
      return ''
  }
}

function ghostFeedbackClass(phase: BtnPhase): string {
  switch (phase) {
    case 'loading':
      return 'pointer-events-none cursor-wait opacity-80'
    case 'success':
      return 'border border-[rgba(61,214,198,0.35)] bg-[rgba(61,214,198,0.18)] text-[#9cf5e8]'
    case 'error':
      return 'border border-[rgba(232,93,93,0.35)] bg-[rgba(232,93,93,0.18)] text-[#ffb4b4]'
    default:
      return ''
  }
}

function shortErr(s: string, max = 52): string {
  const t = s.trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

/** Human phrase for when the next card becomes due (local time). */
function formatNextReviewPhrase(ts: number): string {
  const delta = ts - Date.now()
  if (delta <= 0) return 'now'
  const mins = Math.floor(delta / 60_000)
  if (mins < 1) return 'in less than a minute'
  if (mins < 60) return `in ${mins} minute${mins === 1 ? '' : 's'}`
  const hours = Math.floor(delta / 3_600_000)
  if (hours < 24) return `in ${hours} hour${hours === 1 ? '' : 's'}`
  const d = new Date(ts)
  const today = new Date()
  const timeStr = d.toLocaleTimeString(undefined, { timeStyle: 'short' })
  if (d.toDateString() === today.toDateString()) return `today at ${timeStr}`
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow at ${timeStr}`
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function ConfirmDeleteDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Delete',
  busy,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel?: string
  busy: boolean
  onConfirm: () => void | Promise<void>
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void onConfirm()}>
            {busy ? '…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
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

function useFolderPathById() {
  const foldersQuery = useQuery({
    queryKey: foldersQueryKey,
    queryFn: async () => (await api.folders()).folders as Folder[],
  })
  const folders = foldersQuery.data ?? []

  return useMemo(() => {
    const byId = new Map(folders.map((f) => [f.id, f]))
    const pathCache = new Map<string, string>()

    const pathFor = (id: string | null): string => {
      if (!id) return ''
      const cached = pathCache.get(id)
      if (cached != null) return cached
      const f = byId.get(id)
      if (!f) return id
      if (f.parent_id == null) {
        pathCache.set(id, f.name)
        return f.name
      }
      const parent = pathFor(f.parent_id)
      const val = parent ? `${parent}/${f.name}` : f.name
      pathCache.set(id, val)
      return val
    }

    return (id: string) => pathFor(id)
  }, [folders])
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
  const { pathname } = useLocation()
  const libOn = librarySectionActive(pathname)

  const tabCls = (active: boolean) =>
    cn(
      'flex min-h-[44px] min-w-0 flex-1 flex-col items-center justify-center rounded-xl px-1 py-1.5 text-[0.65rem] font-semibold leading-tight tracking-wide no-underline transition-[color,background-color,transform] duration-200 ease-out active:scale-[0.97] sm:text-[0.7rem]',
      active ? 'bg-[var(--accent-dim)] text-accent' : 'text-muted-foreground active:bg-white/5'
    )

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 flex justify-center border-t border-white/10 bg-[#0f1412]/94 px-2 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] backdrop-blur-[16px]"
      aria-label="Main"
    >
      <div className="flex w-full max-w-[520px] items-end gap-0.5 sm:gap-1">
        <NavLink to="/" end className={({ isActive }) => tabCls(isActive)} title="Home">
          <span className="max-w-full truncate">Home</span>
        </NavLink>
        <NavLink to="/study" className={({ isActive }) => tabCls(isActive)} title="Study">
          <span className="max-w-full truncate">Study</span>
        </NavLink>
        <NavLink to="/library" className={({ isActive }) => tabCls(isActive || libOn)} title="Library">
          <span className="max-w-full truncate">Library</span>
        </NavLink>
        <NavLink to="/stats" className={({ isActive }) => tabCls(isActive)} title="Statistics">
          <span className="max-w-full truncate">Stats</span>
        </NavLink>
        <NavLink to="/settings" className={({ isActive }) => tabCls(isActive)} title="Settings">
          <span className="max-w-full truncate">Settings</span>
        </NavLink>
      </div>
    </nav>
  )
}

function Layout() {
  const { pathname } = useLocation()
  const qc = useQueryClient()

  useEffect(() => {
    void qc.prefetchQuery({
      queryKey: studyDueQueryKey(undefined, false),
      queryFn: () => api.studyDue(undefined, { reviewAhead: false }),
    })
    void qc.prefetchQuery({
      queryKey: foldersQueryKey,
      queryFn: async () => (await api.folders()).folders as Folder[],
    })
    void qc.prefetchQuery({
      queryKey: statsSummaryQueryKey(),
      queryFn: () => api.statsSummary(),
    })
  }, [qc])

  return (
    <>
      <div key={pathname} className="page-enter">
        <Outlet />
      </div>
      <BottomNav />
    </>
  )
}

function LibraryPage() {
  const nav = useNavigate()
  const links = [
    { to: '/folders', title: 'Folders', hint: 'Create, nest, and open in Study' },
    { to: '/cards', title: 'Cards', hint: 'Browse, edit, or delete' },
    { to: '/create', title: 'New card', hint: 'Flashcard, MCQ, or sequence' },
    { to: '/import', title: 'Import', hint: 'Paste blocks in bulk' },
  ] as const

  return (
    <div className={SHELL_CLASS}>
      <h1 className="mt-0 font-heading text-2xl font-bold tracking-tight">Library</h1>
      <p className="muted mt-1 text-sm">Organize content and bring it into Learner.</p>
      <div className="library-stagger mt-5 grid gap-3">
        {links.map(({ to, title, hint }) => (
          <Button
            key={to}
            type="button"
            variant="outline"
            className="h-auto flex-col items-stretch gap-1 border-white/15 bg-black/20 py-4 text-left shadow-none motion-safe:hover:border-white/22 motion-safe:hover:bg-black/28"
            onClick={() => nav(to)}
          >
            <span className="text-base font-semibold">{title}</span>
            <span className="text-muted-foreground text-xs font-normal leading-snug">{hint}</span>
          </Button>
        ))}
      </div>
    </div>
  )
}

function StudyPage() {
  const [search] = useSearchParams()
  const folderId = search.get('folder') ?? undefined
  const qc = useQueryClient()
  const [queue, setQueue] = useState<StudyCard[]>([])
  /** Cards returned in the last `/study/due` fetch (0 if none). Used to tell “session done” vs “nothing due”. */
  const [batchSize, setBatchSize] = useState(0)
  const [moreDueAfterBatch, setMoreDueAfterBatch] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [reviewErr, setReviewErr] = useState<string | null>(null)
  const [flipped, setFlipped] = useState(false)
  const [mcqPicked, setMcqPicked] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  /** Bumped whenever the due-queue is (re)fetched so MCQ option order reshuffles even for the same card. */
  const [mcqShuffleKey, setMcqShuffleKey] = useState(0)
  const [nextAvailableAt, setNextAvailableAt] = useState<number | null>(null)
  const folderPathForId = useFolderPathById()

  const load = useCallback(
    (mode: 'normal' | 'ahead' = 'normal', opts?: { force?: boolean }) => {
      const reviewAhead = mode === 'ahead'
      const key = studyDueQueryKey(folderId, reviewAhead)
      setLoading(true)
      setLoadErr(null)
      const run = async () => {
        try {
          if (opts?.force) await qc.invalidateQueries({ queryKey: key })
          const r = await qc.fetchQuery({
            queryKey: key,
            queryFn: () => api.studyDue(folderId, { reviewAhead }),
          })
          setQueue(r.cards)
          setBatchSize(r.cards.length)
          setMoreDueAfterBatch(Math.max(0, r.dueCount - r.dueNowInQueue))
          setNextAvailableAt(r.nextAvailableAt ?? null)
          setFlipped(false)
          setMcqPicked(null)
          setMcqShuffleKey((k) => k + 1)
        } catch (e) {
          setLoadErr(e instanceof Error ? e.message : 'Failed')
        } finally {
          setLoading(false)
        }
      }
      void run()
    },
    [folderId, qc],
  )

  useEffect(() => {
    return () => {
      qc.removeQueries({ queryKey: ['study', 'due'] })
    }
  }, [qc])

  useEffect(() => {
    load('normal')
  }, [folderId, load])

  const studyRecapQuery = useQuery({
    queryKey: statsSummaryQueryKey(folderId),
    queryFn: () => api.statsSummary(folderId),
    enabled: !loading && queue.length === 0,
    select: (s) => ({ reviewsToday: s.reviewsToday, dueTomorrow: s.dueTomorrow }),
  })
  const studyRecap = studyRecapQuery.data ?? null

  const reviewMut = useMutation({
    mutationFn: ({ cardId, rating }: { cardId: string; rating: string }) => api.review(cardId, rating),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['stats', 'summary'] })
    },
  })

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
      await reviewMut.mutateAsync({ cardId: card.id, rating })
      const nextQ = queue.slice(1)
      setQueue(nextQ)
      setFlipped(false)
      setMcqPicked(null)
      if (nextQ.length === 0) {
        try {
          const r = await api.studyDue(folderId, { reviewAhead: false })
          setNextAvailableAt(r.nextAvailableAt ?? null)
        } catch {
          /* keep previous nextAvailableAt */
        }
      }
    } catch (e) {
      setReviewErr(e instanceof Error ? e.message : 'Review failed')
    } finally {
      setSubmitting(false)
    }
  }

  const mcqRevealed = mcqPicked != null

  return (
    <div className={SHELL_CLASS}>
      <h2 className="mt-0">Study</h2>
      {folderId && (
        <p className="muted" style={{ marginTop: '-0.25rem' }}>
          Filtered folder only
        </p>
      )}
      {card && (
        <p className="muted study-cards-left" style={{ marginTop: folderId ? '0.15rem' : '-0.25rem' }}>
          {queue.length} {queue.length === 1 ? 'card' : 'cards'} left
          {moreDueAfterBatch > 0 ? ` · ${moreDueAfterBatch} more due after this batch (refresh)` : ''}
          {nextAvailableAt != null && nextAvailableAt > Date.now() ? (
            <span className="mt-1 block text-[0.78rem] leading-snug text-muted-foreground">
              Soonest future due:{' '}
              <span className="font-medium text-foreground">{formatNextReviewPhrase(nextAvailableAt)}</span>
              <span className="opacity-85">
                {' '}
                ({new Date(nextAvailableAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })})
              </span>
            </span>
          ) : null}
        </p>
      )}
      {loading && !card && (
        <Card className={cn(CARD_PANEL_CLASS, 'px-0')}>
          <CardContent className="px-5 py-0">
            <Button variant="outline" className="h-auto min-h-11 w-full whitespace-normal py-3 shadow-none" disabled>
              Loading queue…
            </Button>
          </CardContent>
        </Card>
      )}
      {!loading && !card && (
        <Card className={cn(CARD_PANEL_CLASS, 'px-0')}>
          <CardContent className="space-y-3 px-5 py-0 pt-1">
            <p className="text-sm">{batchSize > 0 ? 'Session complete — nice work.' : 'No cards due right now.'}</p>
            {nextAvailableAt != null && nextAvailableAt > Date.now() ? (
              <p className="text-muted-foreground text-sm leading-snug">
                Next card due{' '}
                <span className="font-medium text-foreground">{formatNextReviewPhrase(nextAvailableAt)}</span>
                <span className="opacity-85">
                  {' '}
                  ({new Date(nextAvailableAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })})
                </span>
                .
              </p>
            ) : null}
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
            <Button
              variant="outline"
              className={cn(
                'mt-3 h-auto min-h-11 w-full whitespace-normal py-3 shadow-none',
                loadErr && ghostFeedbackClass('error')
              )}
              onClick={() => void load('normal', { force: true })}
            >
              {loadErr ? shortErr(loadErr, 120) : 'Refresh'}
            </Button>
            <Button
              variant="outline"
              className="mt-2 h-auto min-h-11 w-full shadow-none"
              title="Loads your normal due queue first, then up to 20 cards with the soonest future due times. FSRS grades at the real time you answer—early reviews usually shorten the next interval a bit."
              onClick={() => void load('ahead')}
            >
              Review ahead (up to 20)
            </Button>
          </CardContent>
        </Card>
      )}
      {card && (
        <Card className={cn(CARD_PANEL_CLASS, 'px-0')}>
          <CardContent className="space-y-3 px-5 py-0 pt-1">
          <div className="study-card-header">
            <div className="study-card-meta">
              <Badge variant="outline" className="border-accent/35 bg-[var(--accent-dim)] font-bold text-accent">
                {card.cardKind === 'mcq'
                  ? 'MCQ'
                  : card.cardKind === 'sequence'
                    ? 'Sequence'
                    : card.cardKind === 'flashcard'
                      ? 'Flashcard'
                      : card.cardKind}
              </Badge>
              <StudyCardMetaLine card={card} />
              <span className="muted" style={{ fontSize: '0.78rem' }}>
                Folder:{' '}
                <span className="text-foreground">
                  {folderPathForId(card.folderId)}
                </span>
              </span>
            </div>
          </div>
          {(card.cardKind === 'flashcard' || card.cardKind === 'sequence') && (
            <>
              {card.imageUrl ? (
                <img src={card.imageUrl} alt="Card prompt" className="max-h-64 w-full rounded-xl object-contain" loading="lazy" />
              ) : null}
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
                  <Separator className="bg-white/10" />
                  <p className="study-answer sequence-body">{card.back}</p>
                  <div className="grade-row">
                    {(['again', 'hard', 'good', 'easy'] as const).map((g) => (
                      <button
                        key={g}
                        type="button"
                        className={cn(
                          'grade-btn inline-flex min-h-11 items-center justify-center rounded-xl px-4 py-3 text-sm font-semibold capitalize active:scale-[0.98]',
                          submitting && 'pointer-events-none cursor-wait opacity-80'
                        )}
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
              {card.imageUrl ? (
                <img src={card.imageUrl} alt="MCQ prompt" className="max-h-64 w-full rounded-xl object-contain" loading="lazy" />
              ) : null}
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
                        className={cn(
                          'grade-btn inline-flex min-h-11 items-center justify-center rounded-xl px-4 py-3 text-sm font-semibold capitalize active:scale-[0.98]',
                          submitting && 'pointer-events-none cursor-wait opacity-80'
                        )}
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
            <Button
              variant="destructive"
              className="mt-3 h-auto min-h-11 w-full flex-col gap-0.5 whitespace-normal py-3"
              onClick={() => setReviewErr(null)}
            >
              <span>{shortErr(reviewErr, 220)}</span>
              <span className="text-[0.72rem] font-medium opacity-90">Tap to dismiss</span>
            </Button>
          )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function FoldersPage() {
  const nav = useNavigate()
  const qc = useQueryClient()
  const foldersQuery = useQuery({
    queryKey: foldersQueryKey,
    queryFn: async () => (await api.folders()).folders as Folder[],
  })
  const folders = foldersQuery.data ?? []
  const [name, setName] = useState('')
  const [parentId, setParentId] = useState<string | null>(null)
  const [createBtn, setCreateBtn] = useState<{ phase: BtnPhase; text?: string }>({ phase: 'idle' })
  const [delState, setDelState] = useState<{ id: string; phase: BtnPhase; text?: string } | null>(null)
  const [folderPendingDelete, setFolderPendingDelete] = useState<Folder | null>(null)
  const createTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const delTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tree = useFolderTree(folders)

  useEffect(() => {
    return () => {
      if (createTimer.current) clearTimeout(createTimer.current)
      if (delTimer.current) clearTimeout(delTimer.current)
    }
  }, [])

  const createMut = useMutation({
    mutationFn: ({ name: n, parentId: pid }: { name: string; parentId: string | null }) => api.createFolder(n, pid),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: foldersQueryKey })
      void qc.invalidateQueries({ queryKey: ['cards'] })
    },
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteFolder(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: foldersQueryKey })
      void qc.invalidateQueries({ queryKey: ['cards'] })
    },
  })

  const create = async () => {
    if (!name.trim()) return
    if (createTimer.current) clearTimeout(createTimer.current)
    setCreateBtn({ phase: 'loading' })
    try {
      await createMut.mutateAsync({ name: name.trim(), parentId })
      setName('')
      setCreateBtn({ phase: 'success' })
      createTimer.current = setTimeout(() => setCreateBtn({ phase: 'idle' }), 2200)
    } catch (e) {
      const text = shortErr(e instanceof Error ? e.message : 'Failed')
      setCreateBtn({ phase: 'error', text })
      createTimer.current = setTimeout(() => setCreateBtn({ phase: 'idle' }), 4000)
    }
  }

  const confirmFolderDelete = async () => {
    const f = folderPendingDelete
    if (!f) return
    if (delTimer.current) clearTimeout(delTimer.current)
    setDelState({ id: f.id, phase: 'loading' })
    try {
      await deleteMut.mutateAsync(f.id)
      setDelState(null)
      setFolderPendingDelete(null)
    } catch (e) {
      const text = shortErr(e instanceof Error ? e.message : 'Failed')
      setDelState({ id: f.id, phase: 'error', text })
      setFolderPendingDelete(null)
      delTimer.current = setTimeout(() => setDelState(null), 4000)
    }
  }

  const folderDeleteBusy = !!folderPendingDelete && delState?.id === folderPendingDelete.id && delState.phase === 'loading'

  const createLabel =
    createBtn.phase === 'loading'
      ? 'Creating…'
      : createBtn.phase === 'success'
        ? 'Created ✓'
        : createBtn.phase === 'error'
          ? createBtn.text ?? 'Failed'
          : 'Create'

  return (
    <div className={SHELL_CLASS}>
      <ConfirmDeleteDialog
        open={!!folderPendingDelete}
        onOpenChange={(o) => {
          if (!o) setFolderPendingDelete(null)
        }}
        title="Delete folder?"
        description={
          folderPendingDelete
            ? `Folder “${folderPendingDelete.name}” and everything in it will be removed. This cannot be undone.`
            : ''
        }
        busy={folderDeleteBusy}
        onConfirm={confirmFolderDelete}
      />
      <LibraryBackLink />
      <h2 className="mt-0">Folders</h2>
      <Card className={cn(CARD_PANEL_CLASS, 'mb-4 px-0')}>
        <CardContent className="space-y-1 px-5 py-0 pt-1">
          <Label htmlFor="fname" className="text-muted-foreground">
            New folder
          </Label>
          <Input
            id="fname"
            className={cn(FIELD_INPUT_CLASS, 'mb-2')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
          />
          <Label htmlFor="fpar" className="text-muted-foreground">
            Under (optional)
          </Label>
          <select
            id="fpar"
            className={SELECT_FIELD_CLASS}
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
          <Button
            type="button"
            className={cn(
              'mt-3 h-auto min-h-11 w-full whitespace-normal py-3 text-base font-semibold',
              primaryFeedbackClass(createBtn.phase)
            )}
            disabled={createBtn.phase === 'loading'}
            onClick={() => void create()}
          >
            {createLabel}
          </Button>
        </CardContent>
      </Card>
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
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  className={cn(
                    'h-7 rounded-lg px-2 text-[0.7rem]',
                    delState?.id === f.id && delState.phase === 'loading' && 'pointer-events-none cursor-wait opacity-65',
                    delState?.id === f.id && delState.phase === 'error' && 'bg-destructive/20 text-[#ffb4b4]'
                  )}
                  disabled={delState?.id === f.id && delState.phase === 'loading'}
                  onClick={() => setFolderPendingDelete(f)}
                >
                  {delState?.id === f.id && delState.phase === 'loading'
                    ? '…'
                    : delState?.id === f.id && delState.phase === 'error'
                      ? delState.text ?? 'Failed'
                      : 'Delete'}
                </Button>
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
Optional on @flashcard/@mcq: Image: https://... (public URL)

@flashcard
Folder: Shakespeare/Sonnets
Image: https://cdn.example.com/cards/sonnet-1.jpg
Q: From fairest creatures we desire increase,
A: That thereby beauty's rose might never die.

@mcq
Image: https://cdn.example.com/cards/prospero.jpg
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
  const qc = useQueryClient()
  const foldersQuery = useQuery({
    queryKey: foldersQueryKey,
    queryFn: async () => (await api.folders()).folders as Folder[],
  })
  const folders = foldersQuery.data ?? []
  const [folderId, setFolderId] = useState('inbox')
  const [kind, setKind] = useState<CreateKind>('flashcard')
  const [submitBtn, setSubmitBtn] = useState<{ phase: BtnPhase; text?: string }>({ phase: 'idle' })
  const submitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [fcFront, setFcFront] = useState('')
  const [fcBack, setFcBack] = useState('')
  const [imageUrl, setImageUrl] = useState('')

  const [mcqQ, setMcqQ] = useState('')
  const [mcqCorrect, setMcqCorrect] = useState('')
  const [mcqWrong, setMcqWrong] = useState<string[]>(['', ''])
  const [mcqExpl, setMcqExpl] = useState('')

  const [seqTitle, setSeqTitle] = useState('')
  const [seqLines, setSeqLines] = useState('')

  const createMut = useMutation({
    mutationFn: (body: CreateItemBody) => api.createItem(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: foldersQueryKey })
      void qc.invalidateQueries({ queryKey: ['cards'] })
      void qc.invalidateQueries({ queryKey: statsSummaryQueryKey() })
    },
  })

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
        await createMut.mutateAsync({
          kind: 'flashcard',
          folderId,
          front: fcFront,
          back: fcBack,
          ...(imageUrl.trim() ? { imageUrl: imageUrl.trim() } : {}),
        })
        setFcFront('')
        setFcBack('')
        setImageUrl('')
        setSubmitBtn({ phase: 'success', text: 'Flashcard saved ✓' })
      } else if (kind === 'mcq') {
        const wrong = mcqWrong.map((s) => s.trim()).filter(Boolean)
        await createMut.mutateAsync({
          kind: 'mcq',
          folderId,
          question: mcqQ,
          correct: mcqCorrect,
          wrong,
          ...(mcqExpl.trim() ? { explanation: mcqExpl.trim() } : {}),
          ...(imageUrl.trim() ? { imageUrl: imageUrl.trim() } : {}),
        })
        setMcqQ('')
        setMcqCorrect('')
        setMcqWrong(['', ''])
        setMcqExpl('')
        setImageUrl('')
        setSubmitBtn({ phase: 'success', text: 'MCQ saved ✓' })
      } else {
        const r = await createMut.mutateAsync({
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
    <div className={SHELL_CLASS}>
      <LibraryBackLink />
      <h2 className="mt-0">Create</h2>
      <p className="muted">Add one flashcard, MCQ, or sequence (timeline) at a time.</p>
      <Label htmlFor="create-folder" className="text-muted-foreground">
        Folder
      </Label>
      <select
        id="create-folder"
        className={cn(SELECT_FIELD_CLASS, 'mb-3')}
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
          <Button
            key={k}
            type="button"
            variant="outline"
            role="tab"
            aria-selected={kind === k}
            className={cn(
              'create-kind-tab min-w-[5.5rem] flex-1 justify-center border-white/10 shadow-none',
              kind === k && 'create-kind-tab-active border-accent/45 bg-accent/10 text-accent'
            )}
            onClick={() => {
              setKind(k)
              if (submitBtn.phase !== 'loading') setSubmitBtn({ phase: 'idle' })
            }}
          >
            {label}
          </Button>
        ))}
      </div>

      <Card className={cn(CARD_PANEL_CLASS, 'create-form-panel px-0')}>
        <CardContent className="space-y-3 px-5 py-0 pt-1">
          {kind === 'flashcard' && (
            <>
              <div>
                <Label htmlFor="fc-image" className="text-muted-foreground">
                  Image URL (optional)
                </Label>
                <Input
                  id="fc-image"
                  className={cn(FIELD_INPUT_CLASS, 'mt-1.5')}
                  value={imageUrl}
                  onChange={(e) => setImageUrl(e.target.value)}
                  placeholder="https://..."
                />
              </div>
              <div>
                <Label htmlFor="fc-front" className="text-muted-foreground">
                  Front (prompt)
                </Label>
                <Textarea
                  id="fc-front"
                  className={cn(FIELD_INPUT_CLASS, 'mt-1.5 min-h-[7rem] font-mono text-[0.82rem]')}
                  value={fcFront}
                  onChange={(e) => setFcFront(e.target.value)}
                  rows={4}
                  placeholder="Question or prompt…"
                />
              </div>
              <div>
                <Label htmlFor="fc-back" className="text-muted-foreground">
                  Back (answer)
                </Label>
                <Textarea
                  id="fc-back"
                  className={cn(FIELD_INPUT_CLASS, 'mt-1.5 min-h-[7rem] font-mono text-[0.82rem]')}
                  value={fcBack}
                  onChange={(e) => setFcBack(e.target.value)}
                  rows={4}
                  placeholder="Answer…"
                />
              </div>
            </>
          )}

          {kind === 'mcq' && (
            <>
              <div>
                <Label htmlFor="mcq-image" className="text-muted-foreground">
                  Image URL (optional)
                </Label>
                <Input
                  id="mcq-image"
                  className={cn(FIELD_INPUT_CLASS, 'mt-1.5')}
                  value={imageUrl}
                  onChange={(e) => setImageUrl(e.target.value)}
                  placeholder="https://..."
                />
              </div>
              <div>
                <Label htmlFor="mcq-q" className="text-muted-foreground">
                  Question
                </Label>
                <Textarea
                  id="mcq-q"
                  className={cn(FIELD_INPUT_CLASS, 'mt-1.5 min-h-[5rem] font-mono text-[0.82rem]')}
                  value={mcqQ}
                  onChange={(e) => setMcqQ(e.target.value)}
                  rows={3}
                  placeholder="Question…"
                />
              </div>
              <div>
                <Label htmlFor="mcq-correct" className="text-muted-foreground">
                  Correct option
                </Label>
                <Input
                  id="mcq-correct"
                  className={FIELD_INPUT_CLASS}
                  value={mcqCorrect}
                  onChange={(e) => setMcqCorrect(e.target.value)}
                  placeholder="The right answer"
                />
              </div>
              <p className="muted" style={{ margin: '0.75rem 0 0.35rem', fontSize: '0.82rem' }}>
                Wrong options (at least one)
              </p>
              {mcqWrong.map((w, i) => (
                <div key={i} className="create-mcq-wrong-row">
                  <Input
                    className={cn(FIELD_INPUT_CLASS, 'mt-0')}
                    aria-label={`Wrong option ${i + 1}`}
                    value={w}
                    onChange={(e) => setWrongAt(i, e.target.value)}
                    placeholder={`Distractor ${i + 1}`}
                  />
                  <Button type="button" variant="ghost" size="sm" disabled={mcqWrong.length <= 1} onClick={() => removeWrong(i)}>
                    Remove
                  </Button>
                </div>
              ))}
              <Button type="button" variant="ghost" className="mt-2 w-full" onClick={addWrong}>
                Add wrong option
              </Button>
              <div>
                <Label htmlFor="mcq-expl" className="text-muted-foreground">
                  Explanation (optional)
                </Label>
                <Textarea
                  id="mcq-expl"
                  className={cn(FIELD_INPUT_CLASS, 'mt-1.5 min-h-[5rem] font-mono text-[0.82rem]')}
                  value={mcqExpl}
                  onChange={(e) => setMcqExpl(e.target.value)}
                  rows={3}
                  placeholder="Shown after answering…"
                />
              </div>
            </>
          )}

          {kind === 'sequence' && (
            <>
              <div>
                <Label htmlFor="seq-title" className="text-muted-foreground">
                  Title
                </Label>
                <Input
                  id="seq-title"
                  className={FIELD_INPUT_CLASS}
                  value={seqTitle}
                  onChange={(e) => setSeqTitle(e.target.value)}
                  placeholder="e.g. Pacific theater"
                />
              </div>
              <div>
                <Label htmlFor="seq-lines" className="text-muted-foreground">
                  Steps (one per line, in order)
                </Label>
                <Textarea
                  id="seq-lines"
                  className={cn(FIELD_INPUT_CLASS, 'mt-1.5 min-h-[12rem] font-mono text-[0.82rem]')}
                  value={seqLines}
                  onChange={(e) => setSeqLines(e.target.value)}
                  rows={8}
                  placeholder={'Pearl Harbor\nMidway\nOkinawa'}
                />
              </div>
              <p className="muted text-[0.82rem]">
                Creates one sequence card per adjacent pair (each step → recall the next).
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <Button
        type="button"
        className={cn(
          'mt-4 h-auto min-h-11 w-full whitespace-normal py-3 text-base font-semibold',
          primaryFeedbackClass(submitBtn.phase)
        )}
        disabled={submitBtn.phase === 'loading'}
        onClick={() => void submit()}
      >
        {createSubmitLabel}
      </Button>
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
  const qc = useQueryClient()
  const foldersQuery = useQuery({
    queryKey: foldersQueryKey,
    queryFn: async () => (await api.folders()).folders as Folder[],
  })
  const folders = foldersQuery.data ?? []
  const [text, setText] = useState('')
  const [defaultFolder, setDefaultFolder] = useState('inbox')
  const [importBtn, setImportBtn] = useState<{ phase: BtnPhase; text?: string }>({ phase: 'idle' })
  const [copyBtn, setCopyBtn] = useState<{ phase: BtnPhase }>({ phase: 'idle' })
  const [errs, setErrs] = useState<{ line: number; message: string }[]>([])
  const [importErrDetail, setImportErrDetail] = useState<string | null>(null)
  const importTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    setImportErrDetail(null)
    const res = await importContent(text, defaultFolder)
    if (!res.ok) {
      setImportBtn({ phase: 'error', text: shortErr(res.message, 48) })
      setImportErrDetail(res.message)
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
    void qc.invalidateQueries({ queryKey: foldersQueryKey })
    void qc.invalidateQueries({ queryKey: ['cards'] })
    void qc.invalidateQueries({ queryKey: statsSummaryQueryKey() })
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
    <div className={SHELL_CLASS}>
      <LibraryBackLink />
      <h2 className="mt-0">Import</h2>
      <p className="muted">Paste text in the format below. Default folder applies when a block has no Folder: line.</p>
      <Label htmlFor="def" className="text-muted-foreground">
        Default folder
      </Label>
      <select id="def" className={cn(SELECT_FIELD_CLASS, 'mb-3')} value={defaultFolder} onChange={(e) => setDefaultFolder(e.target.value)}>
        {folders.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      <Textarea
        className={cn(FIELD_INPUT_CLASS, 'mt-0 min-h-[220px] font-mono text-[0.82rem]')}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste here…"
      />
      <details style={{ marginTop: '0.75rem' }}>
        <summary className="muted" style={{ cursor: 'pointer', listStyle: 'none' }}>
          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
            <span>Format reference</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn('shrink-0 px-2.5 py-1.5 text-xs', ghostFeedbackClass(copyBtn.phase))}
              disabled={copyBtn.phase !== 'idle'}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                void copyReference()
              }}
            >
              {copyLabel}
            </Button>
          </span>
        </summary>
        <pre className="help-pre">{formatReference}</pre>
      </details>
      <Button
        type="button"
        className={cn(
          'my-4 h-auto min-h-11 w-full whitespace-normal py-3 text-base font-semibold',
          primaryFeedbackClass(importBtn.phase)
        )}
        disabled={importBtn.phase === 'loading'}
        onClick={() => void run()}
      >
        {importLabel}
      </Button>
      {importErrDetail ? (
        <p className="mt-2 text-sm leading-snug text-destructive" style={{ whiteSpace: 'pre-wrap' }}>
          {importErrDetail}
        </p>
      ) : null}
      {errs.length > 0 && (
        <ul className="mt-2 list-disc pl-4 text-sm text-destructive">
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
  const [upcomingDays, setUpcomingDays] = useState(14)

  const summaryQuery = useQuery({
    queryKey: statsSummaryQueryKey(),
    queryFn: () => api.statsSummary(),
  })
  const heatQuery = useQuery({
    queryKey: statsHeatmapQueryKey(364),
    queryFn: () => api.heatmap(364).then((h) => h.days),
  })
  const maturityQuery = useQuery({
    queryKey: statsMaturityQueryKey(),
    queryFn: () => api.maturityHistogram().then((m) => m.buckets),
  })
  const upcomingQuery = useQuery({
    queryKey: statsUpcomingQueryKey(upcomingDays),
    queryFn: () => api.upcomingHistogram(upcomingDays).then((r) => r.days),
  })

  const summary = summaryQuery.data ?? null
  const heat = heatQuery.data ?? []
  const upcoming = upcomingQuery.data ?? []
  const maturity = maturityQuery.data ?? []
  const statsErr = summaryQuery.error ?? heatQuery.error ?? maturityQuery.error ?? upcomingQuery.error
  const err = statsErr instanceof Error ? statsErr.message : statsErr ? 'Failed' : null

  const max = useMemo(() => Math.max(1, ...heat.map((d) => d.count)), [heat])
  const upcomingMax = useMemo(() => Math.max(1, ...upcoming.map((d) => d.count)), [upcoming])
  const maturityMax = useMemo(() => Math.max(1, ...maturity.map((b) => b.count)), [maturity])

  return (
    <div className={SHELL_CLASS}>
      <h2 className="mt-0">Statistics</h2>
      {err && <p className="text-sm text-destructive">{err}</p>}
      {summary && (
        <p className="muted">
          Timezone: <strong className="text-foreground">{summary.timezone}</strong>
        </p>
      )}
      {summary && (
        <div className="stat-grid mb-5">
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
      <Card className={cn(CARD_PANEL_CLASS, 'mb-5 px-0')}>
        <CardContent className="px-5 py-0 pt-1">
        <div className="forecast-head">
          <h3 className="m-0">Upcoming due</h3>
          <label className="forecast-range-label muted" htmlFor="forecast-days">
            Days
          </label>
          <select
            id="forecast-days"
            className={cn(SELECT_FIELD_CLASS, 'forecast-range-select mt-0 min-w-[4.5rem]')}
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
          {upcoming.length > 7 ? ' Scroll sideways for more days; bar width stays as in a 7-day view.' : ''}
        </p>
        {upcoming.length > 0 && (
          <div className="forecast-hist-scroll">
            <div
              className="forecast-hist-inner"
              role="img"
              aria-label="Upcoming reviews by day"
              style={{ '--forecast-bar-count': upcoming.length } as React.CSSProperties}
            >
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
          </div>
        )}
        </CardContent>
      </Card>
      <Card className={cn(CARD_PANEL_CLASS, 'mb-5 px-0')}>
        <CardContent className="px-5 py-0 pt-1">
        <h3 className="mt-0">Card maturity</h3>
        <p className="muted mt-1.5 text-[0.82rem]">
          New / learning / relearning are FSRS phases. For <strong className="text-foreground">review</strong> cards, the
          number is <strong className="text-foreground">stability in days</strong>: the model’s estimate of how strong the
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
        </CardContent>
      </Card>
      <Card className={cn(CARD_PANEL_CLASS, 'px-0')}>
        <CardContent className="px-5 py-0 pt-1">
        <h3 className="mt-0">Activity</h3>
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
        </CardContent>
      </Card>
    </div>
  )
}

function SettingsPage() {
  const qc = useQueryClient()
  const settingsQuery = useQuery({
    queryKey: settingsQueryKey,
    queryFn: () => api.settings(),
  })
  const [tz, setTz] = useState('UTC')
  const [saveBtn, setSaveBtn] = useState<{ phase: BtnPhase; text?: string }>({ phase: 'idle' })
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (settingsQuery.data?.timezone) setTz(settingsQuery.data.timezone)
  }, [settingsQuery.data?.timezone])

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [])

  const patchMut = useMutation({
    mutationFn: (timezone: string) => api.patchSettings(timezone),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: settingsQueryKey })
      void qc.invalidateQueries({ queryKey: ['stats'] })
    },
  })

  const save = async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    setSaveBtn({ phase: 'loading' })
    try {
      await patchMut.mutateAsync(tz.trim())
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
    <div className={SHELL_CLASS}>
      <h2 className="mt-0">Settings</h2>
      <p className="muted">IANA timezone for streaks and heatmap days (e.g. Europe/London).</p>
      <Input className={FIELD_INPUT_CLASS} value={tz} onChange={(e) => setTz(e.target.value)} />
      <Button
        type="button"
        className={cn(
          'mt-3 h-auto min-h-11 w-full whitespace-normal py-3 text-base font-semibold',
          primaryFeedbackClass(saveBtn.phase)
        )}
        disabled={saveBtn.phase === 'loading'}
        onClick={() => void save()}
      >
        {saveLabel}
      </Button>
    </div>
  )
}

function cardPreviewText(c: ManageCard): string {
  if (c.cardKind === 'mcq' && c.mcq?.question) return c.mcq.question
  if (c.front) return c.front
  return '(no text)'
}

function truncatePreview(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`
}

function fsrsStateLabel(state: number): string {
  if (state === 0) return 'New'
  if (state === 1) return 'Learning'
  if (state === 3) return 'Relearning'
  return 'Review'
}

function CardsPage() {
  const qc = useQueryClient()
  const [folderFilter, setFolderFilter] = useState('')
  const [page, setPage] = useState(0)
  const [editing, setEditing] = useState<ManageCard | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [timelineLoad, setTimelineLoad] = useState<'idle' | 'loading' | 'error'>('idle')
  const [fcFront, setFcFront] = useState('')
  const [fcBack, setFcBack] = useState('')
  const [mcqQ, setMcqQ] = useState('')
  const [mcqCorrect, setMcqCorrect] = useState('')
  const [mcqWrong, setMcqWrong] = useState<string[]>(['', ''])
  const [mcqExpl, setMcqExpl] = useState('')
  const [seqTitle, setSeqTitle] = useState('')
  const [seqLines, setSeqLines] = useState('')
  const [savePhase, setSavePhase] = useState<BtnPhase>('idle')
  const [delId, setDelId] = useState<string | null>(null)
  const [cardPendingDelete, setCardPendingDelete] = useState<ManageCard | null>(null)

  const folderFilterOrU = folderFilter || undefined

  const foldersQuery = useQuery({
    queryKey: foldersQueryKey,
    queryFn: async () => (await api.folders()).folders as Folder[],
  })
  const folders = foldersQuery.data ?? []

  const cardsQuery = useQuery({
    queryKey: cardsListQueryKey(folderFilterOrU, page, CARDS_PAGE_SIZE),
    queryFn: () =>
      api.listCards(folderFilterOrU, { limit: CARDS_PAGE_SIZE, offset: page * CARDS_PAGE_SIZE }),
  })

  const cards = cardsQuery.data?.cards ?? []
  const totalCards = cardsQuery.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(totalCards / CARDS_PAGE_SIZE))
  const rangeStart = totalCards === 0 ? 0 : page * CARDS_PAGE_SIZE + 1
  const rangeEnd = totalCards === 0 ? 0 : Math.min(totalCards, (page + 1) * CARDS_PAGE_SIZE)
  const listErr = cardsQuery.error ?? foldersQuery.error
  const err = listErr instanceof Error ? listErr.message : listErr ? 'Failed to load' : null

  useEffect(() => {
    setPage(0)
  }, [folderFilter])

  useEffect(() => {
    if (totalCards === 0) return
    const maxPage = Math.max(0, Math.ceil(totalCards / CARDS_PAGE_SIZE) - 1)
    if (page > maxPage) setPage(maxPage)
  }, [totalCards, page])

  const folderName = useMemo(() => {
    const m = new Map(folders.map((f) => [f.id, f.name]))
    return (id: string) => m.get(id) ?? id
  }, [folders])

  const invalidateCardQueries = () => {
    void qc.invalidateQueries({ queryKey: ['cards'] })
  }

  const [opErr, setOpErr] = useState<string | null>(null)

  const openEdit = (c: ManageCard) => {
    setEditing(c)
    setDialogOpen(true)
    setSavePhase('idle')
    setTimelineLoad('idle')
    if (c.itemKind === 'timeline') {
      setSeqTitle('')
      setSeqLines('')
      setTimelineLoad('loading')
      api
        .getItem(c.itemId)
        .then(({ item }) => {
          try {
            const parsed = JSON.parse(item.content_json) as { title?: string; events?: string[] }
            setSeqTitle(parsed.title ?? item.title ?? 'Timeline')
            setSeqLines(Array.isArray(parsed.events) ? parsed.events.join('\n') : '')
            setTimelineLoad('idle')
          } catch {
            setTimelineLoad('error')
          }
        })
        .catch(() => setTimelineLoad('error'))
    } else if (c.cardKind === 'mcq' && c.mcq) {
      const correct = c.mcq.options.find((o) => o.correct)?.text ?? ''
      const wrong = c.mcq.options.filter((o) => !o.correct).map((o) => o.text)
      setMcqQ(c.mcq.question)
      setMcqCorrect(correct)
      setMcqWrong(wrong.length ? wrong : ['', ''])
      setMcqExpl(c.mcq.explanation?.trim() ?? '')
    } else {
      setFcFront(c.front ?? '')
      setFcBack(c.back ?? '')
    }
  }

  const closeDialog = () => {
    setDialogOpen(false)
    setEditing(null)
    setSavePhase('idle')
    setTimelineLoad('idle')
  }

  const saveEdit = async () => {
    if (!editing) return
    setSavePhase('loading')
    setOpErr(null)
    try {
      if (editing.itemKind === 'timeline') {
        await api.patchTimelineItem(editing.itemId, { title: seqTitle.trim() || 'Timeline', eventsText: seqLines })
      } else if (editing.cardKind === 'mcq') {
        const wrong = mcqWrong.map((s) => s.trim()).filter(Boolean)
        if (!mcqQ.trim() || !mcqCorrect.trim() || wrong.length < 1) {
          setSavePhase('error')
          return
        }
        await api.patchCard(editing.id, {
          question: mcqQ.trim(),
          correct: mcqCorrect.trim(),
          wrong,
          explanation: mcqExpl.trim() || undefined,
        })
      } else {
        if (!fcFront.trim() || !fcBack.trim()) {
          setSavePhase('error')
          return
        }
        await api.patchCard(editing.id, { front: fcFront.trim(), back: fcBack.trim() })
      }
      setSavePhase('idle')
      closeDialog()
      invalidateCardQueries()
      void qc.invalidateQueries({ queryKey: statsSummaryQueryKey() })
    } catch (e) {
      setOpErr(e instanceof Error ? e.message : 'Save failed')
      setSavePhase('error')
    }
  }

  const confirmCardDelete = async () => {
    const c = cardPendingDelete
    if (!c) return
    setDelId(c.id)
    setOpErr(null)
    try {
      const isTimeline = c.itemKind === 'timeline'
      if (isTimeline) await api.deleteItem(c.itemId)
      else await api.deleteCard(c.id)
      invalidateCardQueries()
      void qc.invalidateQueries({ queryKey: statsSummaryQueryKey() })
      setCardPendingDelete(null)
    } catch (e) {
      setOpErr(e instanceof Error ? e.message : 'Delete failed')
      setCardPendingDelete(null)
    } finally {
      setDelId(null)
    }
  }

  const cardDeleteDescription =
    cardPendingDelete?.itemKind === 'timeline'
      ? 'This removes the entire timeline and all its step cards. Progress on those cards will be lost. This cannot be undone.'
      : 'This card will be removed. Progress will be lost. This cannot be undone.'

  const cardDeleteBusy = !!cardPendingDelete && delId === cardPendingDelete.id

  const saveLabel =
    savePhase === 'loading' ? 'Saving…' : savePhase === 'error' ? 'Fix fields / retry' : 'Save changes'

  return (
    <div className={SHELL_CLASS}>
      <ConfirmDeleteDialog
        open={!!cardPendingDelete}
        onOpenChange={(o) => {
          if (!o) setCardPendingDelete(null)
        }}
        title={cardPendingDelete?.itemKind === 'timeline' ? 'Delete timeline?' : 'Delete card?'}
        description={cardPendingDelete ? cardDeleteDescription : ''}
        busy={cardDeleteBusy}
        onConfirm={confirmCardDelete}
      />
      <LibraryBackLink />
      <h2 className="mt-0">Cards</h2>
      <p className="muted">Browse, edit, or delete cards. Sequence timelines must be edited or removed as a whole.</p>
      <Label htmlFor="card-folder" className="text-muted-foreground">
        Folder
      </Label>
      <select
        id="card-folder"
        className={cn(SELECT_FIELD_CLASS, 'mb-4')}
        value={folderFilter}
        onChange={(e) => setFolderFilter(e.target.value)}
      >
        <option value="">All folders</option>
        {folders.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      {(err || opErr) && <p className="mb-3 text-sm text-destructive">{opErr ?? err}</p>}
      <div className="space-y-2">
        {cards.length === 0 && !err && !cardsQuery.isFetching && (
          <p className="muted text-sm">No cards in this view.</p>
        )}
        {cardsQuery.isFetching && cards.length === 0 && !err && (
          <p className="muted text-sm">Loading…</p>
        )}
        {cards.map((c) => (
          <div key={c.id} className="folder-row">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="shrink-0 text-[0.65rem]">
                  {c.cardKind === 'mcq' ? 'MCQ' : c.cardKind === 'sequence' ? 'Seq' : c.cardKind}
                </Badge>
                <span className="text-muted-foreground text-xs">{folderName(c.folderId)}</span>
                <span className="text-muted-foreground text-xs">
                  Due {new Date(c.due).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })} ·{' '}
                  {fsrsStateLabel(c.state)}
                </span>
              </div>
              <p className="mt-1 text-sm leading-snug">{truncatePreview(cardPreviewText(c), 140)}</p>
            </div>
            <div className="row-actions">
              <Button type="button" size="sm" variant="secondary" className="h-7 rounded-lg px-2 text-[0.7rem]" onClick={() => openEdit(c)}>
                Edit
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                className="h-7 rounded-lg px-2 text-[0.7rem]"
                disabled={delId === c.id}
                onClick={() => setCardPendingDelete(c)}
              >
                {delId === c.id ? '…' : 'Delete'}
              </Button>
            </div>
          </div>
        ))}
      </div>

      {totalCards > 0 && (
        <div className="mt-4 flex flex-col gap-2 border-t border-white/10 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-muted-foreground text-sm">
            {rangeStart}–{rangeEnd} of {totalCards}
            {cardsQuery.isFetching ? ' · …' : ''}
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shadow-none"
              disabled={page <= 0 || cardsQuery.isFetching}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shadow-none"
              disabled={page >= totalPages - 1 || cardsQuery.isFetching}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={(o) => !o && closeDialog()}>
        <DialogContent className="max-h-[min(90dvh,640px)] overflow-y-auto sm:max-w-lg" showCloseButton>
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.cardKind === 'mcq' ? 'MCQ' : editing.itemKind === 'timeline' ? 'timeline' : 'card'}` : ''}</DialogTitle>
          </DialogHeader>
          {editing && editing.itemKind === 'timeline' && (
            <div className="space-y-3">
              {timelineLoad === 'loading' && <p className="text-muted-foreground text-sm">Loading…</p>}
              {timelineLoad === 'error' && <p className="text-destructive text-sm">Could not load timeline.</p>}
              <div>
                <Label htmlFor="ec-seq-title">Title</Label>
                <Input id="ec-seq-title" className={FIELD_INPUT_CLASS} value={seqTitle} onChange={(e) => setSeqTitle(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="ec-seq-lines">Steps (one per line)</Label>
                <Textarea
                  id="ec-seq-lines"
                  className={cn(FIELD_INPUT_CLASS, 'min-h-[10rem] font-mono text-[0.82rem]')}
                  value={seqLines}
                  onChange={(e) => setSeqLines(e.target.value)}
                />
              </div>
              <p className="text-muted-foreground text-xs">Saving rebuilds all steps and resets FSRS progress on this timeline.</p>
            </div>
          )}
          {editing && editing.cardKind === 'mcq' && (
            <div className="space-y-3">
              <div>
                <Label htmlFor="ec-mcq-q">Question</Label>
                <Textarea id="ec-mcq-q" className={cn(FIELD_INPUT_CLASS, 'min-h-[4rem]')} value={mcqQ} onChange={(e) => setMcqQ(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="ec-mcq-c">Correct answer</Label>
                <Input id="ec-mcq-c" className={FIELD_INPUT_CLASS} value={mcqCorrect} onChange={(e) => setMcqCorrect(e.target.value)} />
              </div>
              <p className="text-muted-foreground text-sm">Wrong options</p>
              {mcqWrong.map((w, i) => (
                <div key={i} className="create-mcq-wrong-row">
                  <Input
                    className={cn(FIELD_INPUT_CLASS, 'mt-0')}
                    value={w}
                    onChange={(e) => setMcqWrong((arr) => arr.map((x, j) => (j === i ? e.target.value : x)))}
                    placeholder={`Option ${i + 1}`}
                  />
                  <Button type="button" variant="ghost" size="sm" disabled={mcqWrong.length <= 1} onClick={() => setMcqWrong((arr) => arr.filter((_, j) => j !== i))}>
                    Remove
                  </Button>
                </div>
              ))}
              <Button type="button" variant="ghost" size="sm" className="w-full" onClick={() => setMcqWrong((a) => [...a, ''])}>
                Add wrong option
              </Button>
              <div>
                <Label htmlFor="ec-mcq-e">Explanation (optional)</Label>
                <Textarea id="ec-mcq-e" className={cn(FIELD_INPUT_CLASS, 'min-h-[3rem]')} value={mcqExpl} onChange={(e) => setMcqExpl(e.target.value)} />
              </div>
            </div>
          )}
          {editing && editing.itemKind !== 'timeline' && editing.cardKind !== 'mcq' && (
            <div className="space-y-3">
              <div>
                <Label htmlFor="ec-fc-f">Front</Label>
                <Textarea id="ec-fc-f" className={cn(FIELD_INPUT_CLASS, 'min-h-[5rem]')} value={fcFront} onChange={(e) => setFcFront(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="ec-fc-b">Back</Label>
                <Textarea id="ec-fc-b" className={cn(FIELD_INPUT_CLASS, 'min-h-[5rem]')} value={fcBack} onChange={(e) => setFcBack(e.target.value)} />
              </div>
            </div>
          )}
          <DialogFooter className="border-t-0 bg-transparent p-0 pt-2 sm:justify-end">
            <Button type="button" variant="outline" onClick={closeDialog}>
              Cancel
            </Button>
            <Button type="button" disabled={savePhase === 'loading' || (editing?.itemKind === 'timeline' && timelineLoad === 'loading')} onClick={() => void saveEdit()}>
              {saveLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function HomePage() {
  const nav = useNavigate()
  const summaryQuery = useQuery({
    queryKey: statsSummaryQueryKey(),
    queryFn: () => api.statsSummary(),
  })
  const s = summaryQuery.data ?? null
  const err = summaryQuery.error instanceof Error ? summaryQuery.error.message : summaryQuery.error ? 'Failed to load' : null
  return (
    <div className={SHELL_CLASS}>
      <h1 className="mt-0">Learner</h1>
      <p className="muted">Spaced repetition with FSRS — text flashcards and MCQs.</p>
      {err && <p className="mt-2 text-sm text-destructive">{err}</p>}
      {s && (
        <div className="stat-grid mt-5">
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
      <div className="mt-6">
        <Button type="button" className="h-auto min-h-11 w-full py-3 text-base font-semibold" onClick={() => nav('/study')}>
          Start reviewing
        </Button>
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
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/folders" element={<FoldersPage />} />
          <Route path="/create" element={<CreatePage />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/cards" element={<CardsPage />} />
          <Route path="/stats" element={<StatsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
