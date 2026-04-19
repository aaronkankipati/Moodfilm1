# 🎬 Moodfilm

Mood-based movie recommendations powered by Claude AI. Free for everyone.

**Hosted on:** GitHub Pages (frontend) + Cloudflare Workers (API proxy with secret keys)

## Files

- `index.html` — the entire app (single file, no build needed)
- `worker/index.js` — Cloudflare Worker (secret API proxy)

## Setup

See the step-by-step guide in the conversation where this was generated.

**Quick summary:**
1. Deploy `worker/index.js` to Cloudflare Workers, add `ANTHROPIC_API_KEY` and `TMDB_API_KEY` as secrets
2. Copy the Worker URL into `index.html` (replace `WORKER_URL` placeholder)
3. Push to GitHub, enable GitHub Pages → done
