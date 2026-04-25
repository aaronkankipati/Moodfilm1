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

---

## Sprint 2 changes

**Worker:**
- Psychological mood mapping using Circumplex Model + Plutchik's Wheel
- ID-based poster resolution — Claude returns TMDb ID, poster fetched directly, no string matching
- Language hard filter applied to ALL discovery strategies (not just genre browse)
- Pool widening for small language libraries (te/hi + niche genre)
- OMDb enrichment layer — IMDb rating, Rotten Tomatoes %, full plot synopsis
- Pre-scoring algorithm before Claude selection (keyword overlap + quality + recency)
- Cross-genre deduplication enforced in Claude prompt
- Graceful OMDb degradation (app continues if rate-limited)
- Guard check: if Claude returns unknown TMDb ID, safety-net TMDb title search runs

**Frontend:**
- 9 loading stages with cycling (stages loop from stage 3 after completing)
- Stage interval reduced 9s → 7s for more responsive feel at 50-80s waits
- Reassurance note appears at 22s instead of 30s

**Assets:**
- og-image.png added to repo root — LinkedIn/social preview now shows branded card

**Cloudflare secrets required:**
- ANTHROPIC_API_KEY
- TMDB_API_KEY  
- OMDb_API_KEY  (exact case — mixed capital O-M-D-b)
