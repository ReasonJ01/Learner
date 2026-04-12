export type ImportBlock =
  | { type: "flashcard"; folderPath: string | null; question: string; answer: string; imageUrl: string | null; startLine: number }
  | {
      type: "mcq"
      folderPath: string | null
      question: string
      correct: string
      wrong: string[]
      explanation: string | null
      imageUrl: string | null
      startLine: number
    }
  | { type: "timeline"; folderPath: string | null; title: string | null; events: string[]; startLine: number }

export type ImportError = { line: number; message: string }

export type ImportParseResult = { blocks: ImportBlock[]; errors: ImportError[] }

export function parseLearnerImport(text: string): ImportParseResult {
  const errors: ImportError[] = []
  const blocks: ImportBlock[] = []
  const rawLines = text.split(/\r?\n/)
  let i = 0
  while (i < rawLines.length) {
    const line = rawLines[i]
    const m = line.trim().match(/^@(\w+)\s*$/)
    if (m) {
      const kind = m[1].toLowerCase()
      const startLine = i + 1
      i++
      const body: string[] = []
      while (i < rawLines.length && !rawLines[i].trim().match(/^@\w+\s*$/)) {
        body.push(rawLines[i])
        i++
      }
      let folderPath: string | null = null
      const consumeFolder = (l: string) => {
        const fm = l.match(/^\s*Folder:\s*(.+)\s*$/i)
        if (fm) return fm[1].trim()
        return null
      }
      if (kind === "flashcard") {
        const joined = body.join("\n").trim()
        const folderM = joined.match(/^\s*Folder:\s*(.+)$/im)
        if (folderM) folderPath = folderM[1].trim()
        const imageM = joined.match(/^\s*Image:\s*(.+)$/im)
        const imageUrl = imageM ? imageM[1].trim() : null
        const qm = joined.match(/^\s*Q:\s*(.+)$/im)
        const am = joined.match(/^\s*A:\s*(.+)$/im)
        if (!qm || !am) {
          errors.push({ line: startLine, message: "flashcard needs Q: and A: lines" })
          continue
        }
        let question = qm[1].trim()
        let answer = am[1].trim()
        const qMultiline = joined.split(/\n/)
        let qi = -1, ai = -1
        for (let k = 0; k < qMultiline.length; k++) {
          if (/^\s*Q:\s*/i.test(qMultiline[k])) qi = k
          if (/^\s*A:\s*/i.test(qMultiline[k])) ai = k
        }
        if (qi >= 0 && ai > qi + 1) {
          question = qMultiline
            .slice(qi, ai)
            .filter((l) => !/^\s*(Folder|Image):\s*/i.test(l))
            .join("\n")
            .replace(/^\s*Q:\s*/i, "")
            .trim()
          answer = qMultiline
            .slice(ai)
            .filter((l) => !/^\s*(Folder|Image):\s*/i.test(l))
            .join("\n")
            .replace(/^\s*A:\s*/i, "")
            .trim()
        }
        blocks.push({ type: "flashcard", folderPath, question, answer, imageUrl, startLine })
        continue
      }
      if (kind === "mcq") {
        const joined = body.join("\n")
        const folderM = joined.match(/^\s*Folder:\s*(.+)$/im)
        if (folderM) folderPath = folderM[1].trim()
        const imageM = joined.match(/^\s*Image:\s*(.+)$/im)
        const imageUrl = imageM ? imageM[1].trim() : null
        const qm = joined.match(/^\s*Q:\s*(.+)$/im)
        if (!qm) {
          errors.push({ line: startLine, message: "mcq needs Q: line" })
          continue
        }
        const lines = body.filter((l) => !/^\s*(Folder|Image):\s*/i.test(l.trim()))
        const qLineIdx = lines.findIndex((l) => /^\s*Q:\s*/i.test(l))
        let question = ""
        const opts: { correct: boolean; text: string }[] = []
        if (qLineIdx < 0) {
          errors.push({ line: startLine, message: "mcq needs Q:" })
          continue
        }
        question = lines[qLineIdx].replace(/^\s*Q:\s*/i, "").trim()
        let expLineIdx = -1
        for (let j = qLineIdx + 1; j < lines.length; j++) {
          const raw = lines[j]
          if (/^\s*E:\s*/i.test(raw) || /^\s*Explain:\s*/i.test(raw)) {
            expLineIdx = j
            break
          }
        }
        const optEnd = expLineIdx >= 0 ? expLineIdx : lines.length
        for (let j = qLineIdx + 1; j < optEnd; j++) {
          const tl = lines[j].trim()
          if (/^\*(\s+|$)/.test(tl)) opts.push({ correct: true, text: tl.replace(/^\*\s*/, "").trim() })
          else if (/^-\s+/.test(tl)) opts.push({ correct: false, text: tl.replace(/^-\s+/, "").trim() })
        }
        const correct = opts.filter((o) => o.correct)
        const wrong = opts.filter((o) => !o.correct)
        if (correct.length !== 1 || wrong.length < 1) {
          errors.push({ line: startLine, message: "mcq needs exactly one * correct and at least one - wrong option" })
          continue
        }
        let explanation: string | null = null
        if (expLineIdx >= 0) {
          const first = lines[expLineIdx]
            .replace(/^\s*E:\s*/i, "")
            .replace(/^\s*Explain:\s*/i, "")
            .trimEnd()
          const tail = lines.slice(expLineIdx + 1)
          explanation = [first, ...tail].join("\n").trim() || null
        }
        blocks.push({
          type: "mcq",
          folderPath,
          question,
          correct: correct[0].text,
          wrong: wrong.map((w) => w.text),
          explanation,
          imageUrl,
          startLine,
        })
        continue
      }
      if (kind === "timeline") {
        const joined = body.join("\n")
        const folderM = joined.match(/^\s*Folder:\s*(.+)$/im)
        if (folderM) folderPath = folderM[1].trim()
        let title: string | null = null
        const tm = joined.match(/^\s*Title:\s*(.+)$/im)
        if (tm) title = tm[1].trim()
        const events: string[] = []
        for (const l of body) {
          const em = l.match(/^\s*\d+\.\s*(.+)$/)
          if (em) events.push(em[1].trim())
        }
        if (events.length < 2) {
          errors.push({ line: startLine, message: "timeline needs at least two numbered lines like 1. event" })
          continue
        }
        blocks.push({ type: "timeline", folderPath, title, events, startLine })
        continue
      }
      errors.push({ line: startLine, message: "unknown block @" + kind })
      continue
    }
    i++
  }
  return { blocks, errors }
}
