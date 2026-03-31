import { Hono } from "hono"
import { cors } from "hono/cors"
import { fsrs, createEmptyCard, Rating, State } from "ts-fsrs"
import type { Card } from "ts-fsrs"
import { parseLearnerImport } from "./import-parse.js"
import { enforceCloudflareAccess } from "./access-verify.js"

export type Env = {
  DB: D1Database
  ASSETS: Fetcher
  /** Cloudflare Zero Trust: Application Audience (AUD) tag from the Access application settings. */
  ACCESS_AUD?: string
  /** Cloudflare Zero Trust: team domain, e.g. `yourorg.cloudflareaccess.com` (no `https://`). */
  ACCESS_TEAM_DOMAIN?: string
}

const f = fsrs({ enable_fuzz: true })

function rowToCard(row: {
  due: number
  stability: number
  difficulty: number
  elapsed_days: number
  scheduled_days: number
  learning_steps: number
  reps: number
  lapses: number
  state: number
  last_review: number | null
}): Card {
  return {
    due: new Date(row.due),
    stability: row.stability,
    difficulty: row.difficulty,
    elapsed_days: row.elapsed_days,
    scheduled_days: row.scheduled_days,
    learning_steps: row.learning_steps,
    reps: row.reps,
    lapses: row.lapses,
    state: row.state as State,
    last_review: row.last_review != null ? new Date(row.last_review) : undefined,
  }
}

function parseGrade(s: string): Rating {
  switch (String(s).toLowerCase()) {
    case "again":
      return Rating.Again
    case "hard":
      return Rating.Hard
    case "good":
      return Rating.Good
    case "easy":
      return Rating.Easy
    default:
      throw new Error("Invalid rating")
  }
}

async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const r = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>()
  return r?.value ?? null
}

async function setSetting(db: D1Database, key: string, value: string) {
  await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value).run()
}

function dateKeyInTz(ms: number, timeZone: string): string {
  const d = new Date(ms)
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d)
  const y = parts.find((p) => p.type === "year")?.value
  const mo = parts.find((p) => p.type === "month")?.value
  const da = parts.find((p) => p.type === "day")?.value
  return y + "-" + mo + "-" + da
}

/** Calendar `dateKey` (YYYY-MM-DD) plus `delta` days; components are interpreted as a plain date (UTC math). */
function dateKeyPlusDays(dateKey: string, delta: number): string {
  const [y, m, d] = dateKey.split("-").map(Number)
  const t = Date.UTC(y, m - 1, d + delta)
  const dt = new Date(t)
  const yy = dt.getUTCFullYear()
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0")
  const dd = String(dt.getUTCDate()).padStart(2, "0")
  return `${yy}-${mm}-${dd}`
}

/** First UTC instant where the calendar date in `timeZone` is at least `dateKey`. */
function startOfDayUtcMs(dateKey: string, timeZone: string): number {
  const [y, m, d] = dateKey.split("-").map(Number)
  let low = Date.UTC(y, m - 1, d) - 48 * 3600 * 1000
  let high = Date.UTC(y, m - 1, d) + 48 * 3600 * 1000
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (dateKeyInTz(mid, timeZone) < dateKey) low = mid + 1
    else high = mid
  }
  return low
}

/** Timeline drill: title + current beat; answer is the next beat. */
function sequenceCardText(title: string, currentStep: string, nextStep: string): { front: string; back: string } {
  return { front: `${title}\n${currentStep}`, back: nextStep }
}

async function createFlashcardInFolder(
  db: D1Database,
  folderId: string,
  question: string,
  answer: string,
  now: number,
): Promise<{ itemId: string; cardIds: string[] }> {
  const iid = crypto.randomUUID()
  const content = JSON.stringify({ question, answer })
  await db.prepare("INSERT INTO items (id, folder_id, kind, title, content_json, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?)").bind(iid, folderId, "flashcard", content, now, now).run()
  const empty = createEmptyCard(new Date(now))
  const cid = crypto.randomUUID()
  await db
    .prepare(
      "INSERT INTO cards (id, item_id, folder_id, card_kind, front, back, mcq_json, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      cid,
      iid,
      folderId,
      "flashcard",
      question,
      answer,
      empty.due.getTime(),
      empty.stability,
      empty.difficulty,
      empty.elapsed_days,
      empty.scheduled_days,
      empty.learning_steps,
      empty.reps,
      empty.lapses,
      empty.state,
      empty.last_review ? empty.last_review.getTime() : null,
      now,
    )
    .run()
  return { itemId: iid, cardIds: [cid] }
}

async function createMcqInFolder(
  db: D1Database,
  folderId: string,
  question: string,
  correct: string,
  wrong: string[],
  explanation: string | null,
  now: number,
): Promise<{ itemId: string; cardIds: string[] }> {
  const opts = [{ text: correct, correct: true }, ...wrong.map((t) => ({ text: t, correct: false }))]
  const payload = { question, options: opts, explanation }
  const content = JSON.stringify(payload)
  const iid = crypto.randomUUID()
  await db.prepare("INSERT INTO items (id, folder_id, kind, title, content_json, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?)").bind(iid, folderId, "mcq", content, now, now).run()
  const mcqJson = JSON.stringify(payload)
  const empty = createEmptyCard(new Date(now))
  const cid = crypto.randomUUID()
  await db
    .prepare(
      "INSERT INTO cards (id, item_id, folder_id, card_kind, front, back, mcq_json, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(cid, iid, folderId, "mcq", mcqJson, empty.due.getTime(), empty.stability, empty.difficulty, empty.elapsed_days, empty.scheduled_days, empty.learning_steps, empty.reps, empty.lapses, empty.state, empty.last_review ? empty.last_review.getTime() : null, now)
    .run()
  return { itemId: iid, cardIds: [cid] }
}

async function createSequenceInFolder(
  db: D1Database,
  folderId: string,
  title: string,
  events: string[],
  now: number,
): Promise<{ itemId: string; cardIds: string[] }> {
  const iid = crypto.randomUUID()
  const content = JSON.stringify({ title, events })
  await db.prepare("INSERT INTO items (id, folder_id, kind, title, content_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(iid, folderId, "timeline", title, content, now, now).run()
  const cardIds: string[] = []
  for (let i = 0; i < events.length - 1; i++) {
    const { front, back } = sequenceCardText(title, events[i], events[i + 1])
    const empty = createEmptyCard(new Date(now))
    const cid = crypto.randomUUID()
    await db
      .prepare(
        "INSERT INTO cards (id, item_id, folder_id, card_kind, front, back, mcq_json, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(cid, iid, folderId, "sequence", front, back, empty.due.getTime(), empty.stability, empty.difficulty, empty.elapsed_days, empty.scheduled_days, empty.learning_steps, empty.reps, empty.lapses, empty.state, empty.last_review ? empty.last_review.getTime() : null, now)
      .run()
    cardIds.push(cid)
  }
  return { itemId: iid, cardIds }
}

/** Replace all sequence cards for an item (FSRS state reset to new). */
async function replaceSequenceCards(
  db: D1Database,
  itemId: string,
  folderId: string,
  title: string,
  events: string[],
  now: number,
): Promise<void> {
  await db.prepare("DELETE FROM cards WHERE item_id = ?").bind(itemId).run()
  for (let i = 0; i < events.length - 1; i++) {
    const { front, back } = sequenceCardText(title, events[i], events[i + 1])
    const empty = createEmptyCard(new Date(now))
    const cid = crypto.randomUUID()
    await db
      .prepare(
        "INSERT INTO cards (id, item_id, folder_id, card_kind, front, back, mcq_json, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        cid,
        itemId,
        folderId,
        "sequence",
        front,
        back,
        empty.due.getTime(),
        empty.stability,
        empty.difficulty,
        empty.elapsed_days,
        empty.scheduled_days,
        empty.learning_steps,
        empty.reps,
        empty.lapses,
        empty.state,
        empty.last_review ? empty.last_review.getTime() : null,
        now,
      )
      .run()
  }
}

async function ensureFolderPath(
  db: D1Database,
  segments: string[],
  parentId: string | null,
  now: number,
): Promise<string> {
  let pid = parentId
  for (const name of segments) {
    const n = name.trim()
    if (!n) continue
    const found =
      pid === null
        ? await db.prepare("SELECT id FROM folders WHERE parent_id IS NULL AND name = ?").bind(n).first<{ id: string }>()
        : await db.prepare("SELECT id FROM folders WHERE parent_id = ? AND name = ?").bind(pid, n).first<{ id: string }>()
    if (found) {
      pid = found.id
      continue
    }
    const id = crypto.randomUUID()
    await db
      .prepare("INSERT INTO folders (id, parent_id, name, sort_order, created_at) VALUES (?, ?, ?, 0, ?)")
      .bind(id, pid, n, now)
      .run()
    pid = id
  }
  return pid!
}

const api = new Hono<{ Bindings: Env }>()
api.use("/*", cors({ origin: "*" }))

api.get("/folders", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, parent_id, name, sort_order, created_at FROM folders ORDER BY parent_id, sort_order, name").all()
  return c.json({ folders: results ?? [] })
})

api.post("/folders", async (c) => {
  const body = await c.req.json<{ name: string; parentId?: string | null }>()
  const now = Date.now()
  const id = crypto.randomUUID()
  const parentId = body.parentId ?? null
  await c.env.DB.prepare("INSERT INTO folders (id, parent_id, name, sort_order, created_at) VALUES (?, ?, ?, 0, ?)").bind(id, parentId, body.name, now).run()
  return c.json({ id })
})

api.patch("/folders/:id", async (c) => {
  const id = c.req.param("id")
  const body = await c.req.json<{ name?: string; parentId?: string | null; sortOrder?: number }>()
  if (body.name != null) await c.env.DB.prepare("UPDATE folders SET name = ? WHERE id = ?").bind(body.name, id).run()
  if (body.parentId !== undefined) await c.env.DB.prepare("UPDATE folders SET parent_id = ? WHERE id = ?").bind(body.parentId, id).run()
  if (body.sortOrder != null) await c.env.DB.prepare("UPDATE folders SET sort_order = ? WHERE id = ?").bind(body.sortOrder, id).run()
  return c.json({ ok: true })
})

api.delete("/folders/:id", async (c) => {
  const id = c.req.param("id")
  if (id === "inbox") return c.json({ error: "cannot delete inbox" }, 400)
  await c.env.DB.prepare("DELETE FROM folders WHERE id = ?").bind(id).run()
  return c.json({ ok: true })
})

api.get("/settings", async (c) => {
  const tz = (await getSetting(c.env.DB, "timezone")) ?? "UTC"
  return c.json({ timezone: tz })
})

api.patch("/settings", async (c) => {
  const body = await c.req.json<{ timezone: string }>()
  try {
    Intl.DateTimeFormat(undefined, { timeZone: body.timezone })
  } catch {
    return c.json({ error: "invalid IANA timezone" }, 400)
  }
  await setSetting(c.env.DB, "timezone", body.timezone)
  return c.json({ ok: true })
})

api.get("/items/:itemId", async (c) => {
  const itemId = c.req.param("itemId")
  const row = await c.env.DB
    .prepare("SELECT id, kind, folder_id, title, content_json, created_at, updated_at FROM items WHERE id = ?")
    .bind(itemId)
    .first<{ id: string; kind: string; folder_id: string; title: string | null; content_json: string; created_at: number; updated_at: number }>()
  if (!row) return c.json({ error: "item not found" }, 404)
  return c.json({ item: row })
})

api.get("/items", async (c) => {
  const folderId = c.req.query("folderId")
  if (!folderId) return c.json({ error: "folderId required" }, 400)
  const { results } = await c.env.DB.prepare("SELECT * FROM items WHERE folder_id = ? ORDER BY created_at DESC").bind(folderId).all()
  return c.json({ items: results ?? [] })
})

api.get("/cards", async (c) => {
  const folderId = c.req.query("folderId")
  const limitRaw = c.req.query("limit")
  const offsetRaw = c.req.query("offset")
  const paginate = limitRaw != null && limitRaw !== ""
  const limit = paginate ? Math.min(Math.max(Math.trunc(Number(limitRaw)) || 30, 1), 100) : null
  const offset = paginate ? Math.max(Math.trunc(Number(offsetRaw)) || 0, 0) : 0

  const baseFrom = " FROM cards c JOIN items i ON i.id = c.item_id"
  let whereClause = ""
  const binds: string[] = []
  if (folderId) {
    whereClause = " WHERE c.folder_id = ?"
    binds.push(folderId)
  }

  let total: number
  if (paginate) {
    const countSql = `SELECT COUNT(*) as n${baseFrom}${whereClause}`
    const countStmt = binds.length ? c.env.DB.prepare(countSql).bind(...binds) : c.env.DB.prepare(countSql)
    const countRow = await countStmt.first<{ n: number }>()
    total = Math.trunc(Number(countRow?.n ?? 0))
  } else {
    total = 0
  }

  const qBase = `SELECT c.*, i.kind as item_kind${baseFrom}${whereClause} ORDER BY c.due ASC`
  const { results } =
    paginate && limit != null
      ? await (binds.length > 0
          ? c.env.DB.prepare(`${qBase} LIMIT ? OFFSET ?`).bind(...binds, limit, offset)
          : c.env.DB.prepare(`${qBase} LIMIT ? OFFSET ?`).bind(limit, offset)
        ).all()
      : await (binds.length > 0 ? c.env.DB.prepare(qBase).bind(...binds) : c.env.DB.prepare(qBase)).all()
  const cards = results ?? []
  if (!paginate) total = cards.length
  return c.json(
    paginate
      ? { cards, total, limit, offset }
      : { cards, total },
  )
})

api.patch("/cards/:id", async (c) => {
  const id = c.req.param("id")
  const row = await c.env.DB
    .prepare(
      "SELECT c.id, c.item_id, c.folder_id, c.card_kind, i.kind as item_kind FROM cards c JOIN items i ON i.id = c.item_id WHERE c.id = ?",
    )
    .bind(id)
    .first<{ id: string; item_id: string; folder_id: string; card_kind: string; item_kind: string }>()
  if (!row) return c.json({ error: "card not found" }, 404)

  if (row.card_kind === "sequence" || row.item_kind === "timeline") {
    return c.json({ error: "use PATCH /api/items/:id to edit sequences" }, 400)
  }

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== "object") return c.json({ error: "invalid json" }, 400)
  const now = Date.now()

  if (row.card_kind === "flashcard") {
    const front = String(body.front ?? "").trim()
    const back = String(body.back ?? "").trim()
    if (!front || !back) return c.json({ error: "front and back required" }, 400)
    const content = JSON.stringify({ question: front, answer: back })
    await c.env.DB.prepare("UPDATE cards SET front = ?, back = ? WHERE id = ?").bind(front, back, id).run()
    await c.env.DB.prepare("UPDATE items SET content_json = ?, updated_at = ? WHERE id = ?").bind(content, now, row.item_id).run()
    return c.json({ ok: true })
  }

  if (row.card_kind === "mcq") {
    const question = String(body.question ?? "").trim()
    const correct = String(body.correct ?? "").trim()
    const wrongRaw = body.wrong
    const wrong = Array.isArray(wrongRaw) ? wrongRaw.map((w) => String(w ?? "").trim()).filter(Boolean) : []
    const expl = body.explanation != null ? String(body.explanation).trim() : ""
    const explanation = expl.length > 0 ? expl : null
    if (!question || !correct || wrong.length < 1) return c.json({ error: "question, correct, and at least one wrong option required" }, 400)
    const opts = [{ text: correct, correct: true }, ...wrong.map((t) => ({ text: t, correct: false }))]
    const payload = { question, options: opts, explanation }
    const mcqJson = JSON.stringify(payload)
    const content = JSON.stringify(payload)
    await c.env.DB.prepare("UPDATE cards SET mcq_json = ? WHERE id = ?").bind(mcqJson, id).run()
    await c.env.DB.prepare("UPDATE items SET content_json = ?, updated_at = ? WHERE id = ?").bind(content, now, row.item_id).run()
    return c.json({ ok: true })
  }

  return c.json({ error: "unsupported card kind" }, 400)
})

api.patch("/items/:id", async (c) => {
  const itemId = c.req.param("id")
  const item = await c.env.DB
    .prepare("SELECT id, kind, folder_id, title, content_json FROM items WHERE id = ?")
    .bind(itemId)
    .first<{ id: string; kind: string; folder_id: string; title: string | null; content_json: string }>()
  if (!item) return c.json({ error: "item not found" }, 404)
  if (item.kind !== "timeline") return c.json({ error: "only timeline (sequence) items can be updated here" }, 400)

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== "object") return c.json({ error: "invalid json" }, 400)
  const title = String(body.title ?? item.title ?? "Timeline").trim() || "Timeline"
  let events: string[] = []
  if (typeof body.eventsText === "string") {
    events = body.eventsText.split(/\n/).map((l) => l.trim()).filter(Boolean)
  }
  if (events.length < 2) return c.json({ error: "at least two sequence steps required" }, 400)

  const now = Date.now()
  const content = JSON.stringify({ title, events })
  await c.env.DB.prepare("UPDATE items SET title = ?, content_json = ?, updated_at = ? WHERE id = ?").bind(title, content, now, itemId).run()
  await replaceSequenceCards(c.env.DB, itemId, item.folder_id, title, events, now)
  return c.json({ ok: true })
})

api.delete("/items/:id", async (c) => {
  const itemId = c.req.param("id")
  const found = await c.env.DB.prepare("SELECT 1 as x FROM items WHERE id = ?").bind(itemId).first<{ x: number }>()
  if (!found) return c.json({ error: "item not found" }, 404)
  await c.env.DB.prepare("DELETE FROM items WHERE id = ?").bind(itemId).run()
  return c.json({ ok: true })
})

api.delete("/cards/:id", async (c) => {
  const id = c.req.param("id")
  const row = await c.env.DB.prepare("SELECT id, item_id FROM cards WHERE id = ?").bind(id).first<{ id: string; item_id: string }>()
  if (!row) return c.json({ error: "card not found" }, 404)
  const countRow = await c.env.DB.prepare("SELECT COUNT(*) as n FROM cards WHERE item_id = ?").bind(row.item_id).first<{ n: number }>()
  const n = Math.trunc(Number(countRow?.n ?? 0))
  if (n > 1) {
    return c.json({ error: "this card is part of a multi-card item — delete the whole item from the card row menu" }, 400)
  }
  await c.env.DB.prepare("DELETE FROM items WHERE id = ?").bind(row.item_id).run()
  return c.json({ ok: true })
})

api.post("/import", async (c) => {
  const body = await c.req.json<{ text: string; defaultFolderId?: string }>()
  const parsed = parseLearnerImport(body.text ?? "")
  if (parsed.errors.length && !parsed.blocks.length) {
    return c.json({ errors: parsed.errors, created: { items: 0, cards: 0 } }, 400)
  }
  const now = Date.now()
  const defaultF = body.defaultFolderId ?? "inbox"
  let items = 0
  let cards = 0
  for (const b of parsed.blocks) {
    let folderId = defaultF
    if (b.folderPath) {
      const segs = b.folderPath.split("/").filter(Boolean)
      if (segs.length) folderId = await ensureFolderPath(c.env.DB, segs, null, now)
    }
    if (b.type === "flashcard") {
      const r = await createFlashcardInFolder(c.env.DB, folderId, b.question, b.answer, now)
      items++
      cards += r.cardIds.length
    } else if (b.type === "mcq") {
      const explanation = b.explanation?.trim() ? b.explanation.trim() : null
      const r = await createMcqInFolder(c.env.DB, folderId, b.question, b.correct, b.wrong, explanation, now)
      items++
      cards += r.cardIds.length
    } else if (b.type === "timeline") {
      const title = b.title ?? "Timeline"
      const r = await createSequenceInFolder(c.env.DB, folderId, title, b.events, now)
      items++
      cards += r.cardIds.length
    }
  }
  return c.json({ created: { items, cards }, errors: parsed.errors })
})

api.post("/items/create", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== "object") return c.json({ error: "invalid json" }, 400)
  const now = Date.now()
  const folderId = typeof body.folderId === "string" ? body.folderId.trim() : ""
  if (!folderId) return c.json({ error: "folderId required" }, 400)
  const folderOk = await c.env.DB.prepare("SELECT 1 as x FROM folders WHERE id = ?").bind(folderId).first<{ x: number }>()
  if (!folderOk) return c.json({ error: "folder not found" }, 400)

  const kind = body.kind
  if (kind === "flashcard") {
    const front = String(body.front ?? "").trim()
    const back = String(body.back ?? "").trim()
    if (!front || !back) return c.json({ error: "front and back required" }, 400)
    const r = await createFlashcardInFolder(c.env.DB, folderId, front, back, now)
    return c.json({ itemId: r.itemId, cardIds: r.cardIds, cardsCreated: r.cardIds.length })
  }
  if (kind === "mcq") {
    const question = String(body.question ?? "").trim()
    const correct = String(body.correct ?? "").trim()
    const wrongRaw = body.wrong
    const wrong = Array.isArray(wrongRaw) ? wrongRaw.map((w) => String(w ?? "").trim()).filter(Boolean) : []
    if (!question || !correct) return c.json({ error: "question and correct answer required" }, 400)
    if (wrong.length < 1) return c.json({ error: "at least one wrong option required" }, 400)
    const expl = body.explanation != null ? String(body.explanation).trim() : ""
    const explanation = expl.length > 0 ? expl : null
    const r = await createMcqInFolder(c.env.DB, folderId, question, correct, wrong, explanation, now)
    return c.json({ itemId: r.itemId, cardIds: r.cardIds, cardsCreated: r.cardIds.length })
  }
  if (kind === "sequence") {
    const title = String(body.title ?? "").trim() || "Timeline"
    let events: string[] = []
    if (Array.isArray(body.events)) events = body.events.map((e) => String(e ?? "").trim()).filter(Boolean)
    else if (typeof body.eventsText === "string") {
      events = body.eventsText.split(/\n/).map((l) => l.trim()).filter(Boolean)
    }
    if (events.length < 2) return c.json({ error: "at least two sequence steps required" }, 400)
    const r = await createSequenceInFolder(c.env.DB, folderId, title, events, now)
    return c.json({ itemId: r.itemId, cardIds: r.cardIds, cardsCreated: r.cardIds.length })
  }
  return c.json({ error: "kind must be flashcard, mcq, or sequence" }, 400)
})

function studyCardFromRow(row: Record<string, unknown>) {
  const mcq_json = row.mcq_json as string | null
  let mcq: unknown = null
  if (mcq_json) try { mcq = JSON.parse(mcq_json) } catch { mcq = null }
  return {
    id: row.id,
    itemId: row.item_id,
    folderId: row.folder_id,
    cardKind: row.card_kind,
    front: row.front,
    back: row.back,
    mcq,
    due: row.due,
    state: row.state,
    lapses: row.lapses,
  }
}

api.get("/study/due", async (c) => {
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? "30")))
  const folderId = c.req.query("folderId")
  const reviewAhead = c.req.query("reviewAhead") === "1" || c.req.query("reviewAhead") === "true"
  const aheadLimit = Math.min(20, Math.max(0, Number(c.req.query("aheadLimit") ?? "20")))
  const now = Date.now()

  const folderSql = folderId ? " AND c.folder_id = ?" : ""
  const folderBinds: (string | number)[] = folderId ? [folderId] : []

  const countRow = await c.env.DB
    .prepare(`SELECT COUNT(*) as n FROM cards c WHERE c.due <= ?${folderSql}`)
    .bind(now, ...folderBinds)
    .first<{ n: number }>()
  const dueCount = countRow?.n ?? 0

  const { results: dueNowRows } = await c.env.DB
    .prepare(`SELECT c.* FROM cards c WHERE c.due <= ?${folderSql} ORDER BY c.due ASC LIMIT ?`)
    .bind(now, ...folderBinds, limit)
    .all()

  const nowRows = (dueNowRows ?? []) as Record<string, unknown>[]
  let aheadRows: Record<string, unknown>[] = []
  if (reviewAhead && aheadLimit > 0) {
    const { results: futureRows } = await c.env.DB
      .prepare(`SELECT c.* FROM cards c WHERE c.due > ?${folderSql} ORDER BY c.due ASC LIMIT ?`)
      .bind(now, ...folderBinds, aheadLimit)
      .all()
    aheadRows = (futureRows ?? []) as Record<string, unknown>[]
  }

  const nextDueRow = await c.env.DB
    .prepare(`SELECT MIN(c.due) as next_due FROM cards c WHERE c.due > ?${folderSql}`)
    .bind(now, ...folderBinds)
    .first<{ next_due: number | null }>()
  const nextAvailableAt =
    nextDueRow?.next_due != null && !Number.isNaN(Number(nextDueRow.next_due))
      ? Math.trunc(Number(nextDueRow.next_due))
      : null

  const out = [...nowRows.map(studyCardFromRow), ...aheadRows.map(studyCardFromRow)]
  return c.json({
    cards: out,
    dueCount,
    dueNowInQueue: nowRows.length,
    aheadInQueue: aheadRows.length,
    nextAvailableAt,
  })
})

api.post("/study/review", async (c) => {
  const body = await c.req.json<{ cardId: string; rating: string; latencyMs?: number }>()
  const now = new Date()
  let grade: Rating
  try {
    grade = parseGrade(body.rating)
  } catch {
    return c.json({ error: "invalid rating" }, 400)
  }
  const row = await c.env.DB.prepare("SELECT * FROM cards WHERE id = ?").bind(body.cardId).first<{
    id: string
    due: number
    stability: number
    difficulty: number
    elapsed_days: number
    scheduled_days: number
    learning_steps: number
    reps: number
    lapses: number
    state: number
    last_review: number | null
  }>()
  if (!row) return c.json({ error: "card not found" }, 404)
  const card = rowToCard(row)
  const sched = f.next(card, now, grade as Exclude<Rating, Rating.Manual>)
  const next = sched.card
  await c.env.DB
    .prepare(
      "UPDATE cards SET due = ?, stability = ?, difficulty = ?, elapsed_days = ?, scheduled_days = ?, learning_steps = ?, reps = ?, lapses = ?, state = ?, last_review = ? WHERE id = ?",
    )
    .bind(
      next.due.getTime(),
      next.stability,
      next.difficulty,
      next.elapsed_days,
      next.scheduled_days,
      next.learning_steps,
      next.reps,
      next.lapses,
      next.state,
      next.last_review ? next.last_review.getTime() : null,
      body.cardId,
    )
    .run()
  const logId = crypto.randomUUID()
  await c.env.DB.prepare("INSERT INTO review_log (id, card_id, rating, reviewed_at, latency_ms) VALUES (?, ?, ?, ?, ?)").bind(logId, body.cardId, grade, now.getTime(), body.latencyMs ?? null).run()
  return c.json({
    card: {
      id: body.cardId,
      due: next.due.getTime(),
      state: next.state,
      reps: next.reps,
      lapses: next.lapses,
    },
  })
})

api.get("/stats/summary", async (c) => {
  const tz = (await getSetting(c.env.DB, "timezone")) ?? "UTC"
  const folderId = c.req.query("folderId") ?? null
  const now = Date.now()
  const cutoff = now - 400 * 24 * 60 * 60 * 1000
  const { results } = await c.env.DB.prepare("SELECT reviewed_at FROM review_log WHERE reviewed_at >= ?").bind(cutoff).all()
  const days = new Map<string, number>()
  for (const r of results ?? []) {
    const rt = (r as { reviewed_at: number }).reviewed_at
    const k = dateKeyInTz(rt, tz)
    days.set(k, (days.get(k) ?? 0) + 1)
  }
  const todayKey = dateKeyInTz(now, tz)
  let streak = 0
  let startOffset = 0
  if ((days.get(todayKey) ?? 0) === 0) startOffset = 1
  for (let d = startOffset; d < 400; d++) {
    const key = dateKeyInTz(now - d * 24 * 60 * 60 * 1000, tz)
    if ((days.get(key) ?? 0) > 0) streak++
    else break
  }
  const reviewsToday = days.get(todayKey) ?? 0

  const tomorrowKey = dateKeyPlusDays(todayKey, 1)
  const dayAfterTomorrowKey = dateKeyPlusDays(todayKey, 2)
  const tomorrowStart = startOfDayUtcMs(tomorrowKey, tz)
  const tomorrowEnd = startOfDayUtcMs(dayAfterTomorrowKey, tz)

  let dueSql = "SELECT COUNT(*) as n FROM cards WHERE due <= ?"
  const dueBinds: (string | number)[] = [now]
  if (folderId) {
    dueSql += " AND folder_id = ?"
    dueBinds.push(folderId)
  }
  const dueRow = await c.env.DB.prepare(dueSql).bind(...dueBinds).first<{ n: number }>()

  let dueTomorrowSql = "SELECT COUNT(*) as n FROM cards WHERE due >= ? AND due < ?"
  const dueTomorrowBinds: (string | number)[] = [tomorrowStart, tomorrowEnd]
  if (folderId) {
    dueTomorrowSql += " AND folder_id = ?"
    dueTomorrowBinds.push(folderId)
  }
  const dueTomorrowRow = await c.env.DB.prepare(dueTomorrowSql).bind(...dueTomorrowBinds).first<{ n: number }>()

  const totalCards = await c.env.DB.prepare("SELECT COUNT(*) as n FROM cards").first<{ n: number }>()
  return c.json({
    timezone: tz,
    streak,
    reviewsToday,
    dueNow: dueRow?.n ?? 0,
    dueTomorrow: dueTomorrowRow?.n ?? 0,
    totalCards: totalCards?.n ?? 0,
  })
})

api.get("/stats/heatmap", async (c) => {
  const tz = (await getSetting(c.env.DB, "timezone")) ?? "UTC"
  const daysBack = Math.min(400, Math.max(30, Number(c.req.query("days") ?? "370")))
  const now = Date.now()
  const cutoff = now - daysBack * 24 * 60 * 60 * 1000
  const { results } = await c.env.DB.prepare("SELECT reviewed_at FROM review_log WHERE reviewed_at >= ?").bind(cutoff).all()
  const counts = new Map<string, number>()
  for (const r of results ?? []) {
    const k = dateKeyInTz((r as { reviewed_at: number }).reviewed_at, tz)
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const out: { date: string; count: number }[] = []
  for (let i = daysBack - 1; i >= 0; i--) {
    const t = now - i * 24 * 60 * 60 * 1000
    const key = dateKeyInTz(t, tz)
    out.push({ date: key, count: counts.get(key) ?? 0 })
  }
  return c.json({ days: out })
})

api.get("/stats/upcoming", async (c) => {
  const tz = (await getSetting(c.env.DB, "timezone")) ?? "UTC"
  const n = Math.min(60, Math.max(3, Number(c.req.query("days") ?? "14")))
  const folderId = c.req.query("folderId") ?? null
  const now = Date.now()
  const todayKey = dateKeyInTz(now, tz)
  const rangeEndUtc = startOfDayUtcMs(dateKeyPlusDays(todayKey, n), tz)

  let sql = "SELECT due FROM cards WHERE due < ?"
  const binds: (string | number)[] = [rangeEndUtc]
  if (folderId) {
    sql += " AND folder_id = ?"
    binds.push(folderId)
  }
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all()

  const counts = new Map<string, number>()
  for (let i = 0; i < n; i++) {
    counts.set(dateKeyPlusDays(todayKey, i), 0)
  }

  for (const row of results ?? []) {
    const due = (row as { due: number }).due
    let key = dateKeyInTz(due, tz)
    if (key < todayKey) key = todayKey
    if (!counts.has(key)) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  const days: { date: string; count: number }[] = []
  for (let i = 0; i < n; i++) {
    const date = dateKeyPlusDays(todayKey, i)
    days.push({ date, count: counts.get(date) ?? 0 })
  }

  return c.json({ timezone: tz, days })
})

/** FSRS state: 0 New, 1 Learning, 2 Review, 3 Relearning — plus stability bins for Review (days). */
api.get("/stats/maturity", async (c) => {
  const folderId = c.req.query("folderId") ?? null
  let sql = `SELECT
    SUM(CASE WHEN state = 0 THEN 1 ELSE 0 END) AS new_c,
    SUM(CASE WHEN state = 1 THEN 1 ELSE 0 END) AS learning_c,
    SUM(CASE WHEN state = 3 THEN 1 ELSE 0 END) AS relearning_c,
    SUM(CASE WHEN state = 2 AND stability < 14 THEN 1 ELSE 0 END) AS review_lt_14,
    SUM(CASE WHEN state = 2 AND stability >= 14 AND stability < 60 THEN 1 ELSE 0 END) AS review_14_60,
    SUM(CASE WHEN state = 2 AND stability >= 60 THEN 1 ELSE 0 END) AS review_gte_60
  FROM cards`
  const stmt = folderId ? c.env.DB.prepare(`${sql} WHERE folder_id = ?`).bind(folderId) : c.env.DB.prepare(sql)
  const row = await stmt.first<{
    new_c: number | null
    learning_c: number | null
    relearning_c: number | null
    review_lt_14: number | null
    review_14_60: number | null
    review_gte_60: number | null
  }>()
  const n = (v: number | null | undefined) => Math.trunc(Number(v ?? 0))
  const buckets = [
    { id: "new", count: n(row?.new_c) },
    { id: "learning", count: n(row?.learning_c) },
    { id: "relearning", count: n(row?.relearning_c) },
    { id: "review_lt_14d", count: n(row?.review_lt_14) },
    { id: "review_14_60d", count: n(row?.review_14_60) },
    { id: "review_gte_60d", count: n(row?.review_gte_60) },
  ]
  return c.json({ buckets })
})

const app = new Hono<{ Bindings: Env }>()
app.route("/api", api)

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const denied = await enforceCloudflareAccess(request, env)
    if (denied) return denied

    const url = new URL(request.url)
    if (url.pathname.startsWith("/api")) {
      return app.fetch(request, env, ctx)
    }
    return env.ASSETS.fetch(request)
  },
}
