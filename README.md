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
For `@flashcard` and `@mcq`, you can also include `Image: https://...` to attach a public image URL during bulk import.

## Image storage options (Cloudflare-only)

If you want image support in flash cards while staying fully on Cloudflare, these are the practical options:

1. **R2 only (recommended default for cheapest/free start)**
   - Store original image files in an R2 bucket.
   - Keep only metadata in D1 (`image_key`, width/height, alt text, etc.).
   - Serve images either through an R2 custom domain or via a Worker endpoint.
   - Why this is usually best first:
     - generous free tier for small apps (10 GB storage, 1M Class A ops, 10M Class B ops per month),
     - no egress fees,
     - simple S3-compatible upload/download flows.
   - Watch-out: hot image traffic can consume Class B reads. Cache aggressively at Cloudflare edge.

2. **R2 + Images transformations (best balance for responsive images)**
   - Keep originals in R2.
   - Use Cloudflare Images transformations to generate size/format variants (e.g. `w=320`, `w=768`, `format=auto`).
   - Pricing behavior:
     - free plan includes 5,000 unique transformations/month,
     - above that, transformation usage is billed,
     - R2 storage/ops are still billed independently.
   - Good when you need mobile-friendly thumbnails, `srcset`, and WebP/AVIF without building your own image pipeline.

3. **Cloudflare Images storage + delivery (paid-first product)**
   - Upload directly into Cloudflare Images and serve variants/signed URLs from there.
   - Strong DX for image-centric products, but stored/delivered image billing is paid-plan oriented.
   - Best if you prioritize built-in image workflows over lowest possible cost.

4. **D1/KV for image binary data (not recommended)**
   - D1 row/BLOB limits make it unsuitable for general image file storage.
   - KV can technically store larger values, but it is usually a poor fit for user image binaries at scale.
   - Use D1/KV for metadata and indirection, not primary image blobs.

### Suggested path for this app

- Start with **R2 only** for originals + D1 metadata.
- Add **Images transformations** only once responsive variants are needed.
- Keep generated URLs cache-friendly and versioned (e.g. include an image hash in key names).
