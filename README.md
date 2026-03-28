# Learner

Personal text-only spaced repetition app: **Cloudflare Workers** + **D1**, **FSRS** (`ts-fsrs`), React (Vite), mobile-first UI.

## Development

1. Install dependencies: `npm install` at repo root, plus `npm install` in `web/` and `worker/` if needed.
2. Apply local D1 schema: `npm run db:local` (from root) or `npm run db:local` in `worker/`. Migrations include a **Sample** folder with demo flashcard, MCQ, and timeline cards.
3. Run API + SPA together: `npm run dev` from root (Worker on `:8787`, Vite proxies `/api`).

## Production (Cloudflare)

1. Create the D1 database: `cd worker && npx wrangler d1 create learner` and copy the `database_id` into [`worker/wrangler.toml`](worker/wrangler.toml).
2. Apply migrations remotely: `npx wrangler d1 migrations apply learner --remote`.
3. Deploy: `npm run deploy` from repo root (builds `web/dist`, deploys the Worker with static assets).

Protect the site with [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/) on your zone if you want a solo gate without app-level auth.

## Import format

See the in-app **Import → Format reference**, or use blocks starting with `@flashcard`, `@mcq`, or `@timeline` plus optional `Folder: path/subfolder` lines.
