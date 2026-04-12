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
  /** Folder this card belongs to (raw id). */
  folderId: string
  cardKind: string
  front: string | null
  back: string | null
  imageUrl: string | null
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
  | { kind: 'flashcard'; folderId: string; front: string; back: string; imageUrl?: string }
  | { kind: 'mcq'; folderId: string; question: string; correct: string; wrong: string[]; explanation?: string; imageUrl?: string }
  | { kind: 'sequence'; folderId: string; title: string; eventsText: string }

export type ManageCard = {
  id: string
  itemId: string
  folderId: string
  cardKind: string
  itemKind: string
  front: string | null
  back: string | null
  imageUrl: string | null
  mcq: StudyCard['mcq']
  due: number
  state: number
  lapses: number
}

function mapManageCardRow(r: Record<string, unknown>): ManageCard {
  let mcq: StudyCard['mcq'] = null
  const mj = r.mcq_json
  if (mj != null && String(mj).length > 0) {
    try {
      mcq = JSON.parse(String(mj)) as StudyCard['mcq']
    } catch {
      mcq = null
    }
  }
  return {
    id: String(r.id),
    itemId: String(r.item_id),
    folderId: String(r.folder_id),
    cardKind: String(r.card_kind),
    itemKind: String(r.item_kind),
    front: r.front != null ? String(r.front) : null,
    back: r.back != null ? String(r.back) : null,
    imageUrl: r.image_url != null ? String(r.image_url) : null,
    mcq,
    due: Number(r.due),
    state: Number(r.state),
    lapses: Number(r.lapses),
  }
}

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
  getItem: (itemId: string) =>
    req<{ item: { id: string; kind: string; folder_id: string; title: string | null; content_json: string } }>(
      `/api/items/${encodeURIComponent(itemId)}`,
    ),
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
      /** Earliest `due` in the future (ms); null if no cards or everything is already due now. */
      nextAvailableAt: number | null
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
  listCards: async (folderId?: string, opts?: { limit?: number; offset?: number }) => {
    const p = new URLSearchParams()
    if (folderId) p.set('folderId', folderId)
    if (opts?.limit != null) {
      p.set('limit', String(opts.limit))
      p.set('offset', String(opts.offset ?? 0))
    }
    const qs = p.toString()
    const raw = await req<{
      cards: Record<string, unknown>[]
      total: number
      limit?: number
      offset?: number
    }>(`/api/cards${qs ? `?${qs}` : ''}`)
    return {
      cards: (raw.cards ?? []).map(mapManageCardRow),
      total: raw.total ?? (raw.cards?.length ?? 0),
      limit: raw.limit,
      offset: raw.offset,
    }
  },
  patchCard: (
    cardId: string,
    body:
      | { front: string; back: string; imageUrl?: string }
      | { question: string; correct: string; wrong: string[]; explanation?: string; imageUrl?: string },
  ) => req<{ ok: boolean }>(`/api/cards/${encodeURIComponent(cardId)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  patchTimelineItem: (itemId: string, body: { title: string; eventsText: string }) =>
    req<{ ok: boolean }>(`/api/items/${encodeURIComponent(itemId)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteCard: (cardId: string) => req<{ ok: boolean }>(`/api/cards/${encodeURIComponent(cardId)}`, { method: 'DELETE' }),
  deleteItem: (itemId: string) => req<{ ok: boolean }>(`/api/items/${encodeURIComponent(itemId)}`, { method: 'DELETE' }),
}
