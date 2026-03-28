const base = ''

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? r.statusText)
  }
  return r.json() as Promise<T>
}

export type StudyCard = {
  id: string
  cardKind: string
  front: string | null
  back: string | null
  mcq: { question: string; options: { text: string; correct: boolean }[]; explanation?: string | null } | null
  due: number
  /** FSRS: 0 New, 1 Learning, 2 Review, 3 Relearning */
  state: number
  lapses: number
}

export type ImportResponseBody = {
  created: { items: number; cards: number }
  errors: { line: number; message: string }[]
}

export type ImportResult =
  | { ok: false; message: string }
  | { ok: true; status: number; created: { items: number; cards: number }; errors: { line: number; message: string }[] }

export type CreateItemBody =
  | { kind: 'flashcard'; folderId: string; front: string; back: string }
  | { kind: 'mcq'; folderId: string; question: string; correct: string; wrong: string[]; explanation?: string }
  | { kind: 'sequence'; folderId: string; title: string; eventsText: string }

/** Parses JSON even on 400 (validation-only failures). */
export async function importContent(text: string, defaultFolderId?: string): Promise<ImportResult> {
  try {
    const r = await fetch(`${base}/api/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, defaultFolderId }),
    })
    const data = (await r.json()) as Partial<ImportResponseBody> & { error?: string }
    const created = data.created ?? { items: 0, cards: 0 }
    const errors = data.errors ?? []
    return { ok: true, status: r.status, created, errors }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Network error' }
  }
}

export const api = {
  folders: () =>
    req<{ folders: { id: string; parent_id: string | null; name: string; sort_order: number }[] }>('/api/folders'),
  createFolder: (name: string, parentId?: string | null) =>
    req<{ id: string }>('/api/folders', {
      method: 'POST',
      body: JSON.stringify({ name, parentId: parentId ?? null }),
    }),
  deleteFolder: (id: string) => req<{ ok: boolean }>(`/api/folders/${id}`, { method: 'DELETE' }),
  createItem: (body: CreateItemBody) =>
    req<{ itemId: string; cardIds: string[]; cardsCreated: number }>('/api/items/create', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  settings: () => req<{ timezone: string }>('/api/settings'),
  patchSettings: (timezone: string) =>
    req<{ ok: boolean }>('/api/settings', { method: 'PATCH', body: JSON.stringify({ timezone }) }),
  studyDue: (folderId?: string, opts?: { reviewAhead?: boolean }) => {
    const p = new URLSearchParams()
    if (folderId) p.set('folderId', folderId)
    if (opts?.reviewAhead) p.set('reviewAhead', '1')
    const qs = p.toString()
    return req<{
      cards: StudyCard[]
      dueCount: number
      dueNowInQueue: number
      aheadInQueue: number
    }>(`/api/study/due${qs ? `?${qs}` : ''}`)
  },
  review: (cardId: string, rating: string, latencyMs?: number) =>
    req('/api/study/review', {
      method: 'POST',
      body: JSON.stringify({ cardId, rating, latencyMs }),
    }),
  statsSummary: (folderId?: string) => {
    const q = folderId ? `?folderId=${encodeURIComponent(folderId)}` : ''
    return req<{
      streak: number
      reviewsToday: number
      dueNow: number
      dueTomorrow: number
      totalCards: number
      timezone: string
    }>(`/api/stats/summary${q}`)
  },
  heatmap: (days?: number) =>
    req<{ days: { date: string; count: number }[] }>(`/api/stats/heatmap?days=${days ?? 370}`),
  upcomingHistogram: (days?: number) =>
    req<{ timezone: string; days: { date: string; count: number }[] }>(`/api/stats/upcoming?days=${days ?? 14}`),
  maturityHistogram: (folderId?: string) => {
    const q = folderId ? `?folderId=${encodeURIComponent(folderId)}` : ''
    return req<{ buckets: { id: string; count: number }[] }>(`/api/stats/maturity${q}`)
  },
}
