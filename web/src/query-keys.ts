/** Stable keys for `/api/study/due` — used with prefetch + fetchQuery so one in-flight request is shared. */
export function studyDueQueryKey(folderId: string | undefined, reviewAhead: boolean) {
  return ['study', 'due', folderId ?? 'all', reviewAhead ? 'ahead' : 'normal'] as const
}

export const foldersQueryKey = ['folders'] as const

export function statsSummaryQueryKey(folderId?: string) {
  return ['stats', 'summary', folderId ?? 'all'] as const
}

export const settingsQueryKey = ['settings'] as const

export function statsHeatmapQueryKey(days: number) {
  return ['stats', 'heatmap', days] as const
}

export function statsMaturityQueryKey(folderId?: string) {
  return ['stats', 'maturity', folderId ?? 'all'] as const
}

export function statsUpcomingQueryKey(days: number) {
  return ['stats', 'upcoming', days] as const
}

/** Library card list (paginated). */
export function cardsListQueryKey(folderId: string | undefined, page: number, pageSize: number) {
  return ['cards', 'list', folderId ?? 'all', page, pageSize] as const
}

export const CARDS_PAGE_SIZE = 30
