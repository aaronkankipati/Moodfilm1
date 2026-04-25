// Moodfilm Worker — Sprint 2 (subrequest-safe)
// Redesigned to stay under Cloudflare free tier 50 subrequest limit (~22 max)
// Strategy: 2 discover calls/genre + 2 global theme searches. OMDb removed (saved 120 calls).
// Secrets (exact case): ANTHROPIC_API_KEY  TMDB_API_KEY

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

const GENRE_IDS = {
  Action: 28, Comedy: 35, Drama: 18, Horror: 27, Romance: 10749,
  Thriller: 53, Animation: 16, Documentary: 99, Fantasy: 14, "Sci-Fi": 878,
};

const LANG_CODES = { any: null, en: "en", hi: "hi", te: "te" };

const ok  = d => new Response(JSON.stringify(d), { status: 200, headers: CORS });
const err = (m, s = 500) => new Response(JSON.stringify({ error: m }), { status: s, headers: CORS });

function parseJson(text) {
  return JSON.parse(text.trim().replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim());
}

// Pre-score without language gate (gate applied when building shortlist)
function preScore(movie, themes) {
  const text = `${movie.title || ""} ${movie.overview || ""}`.toLowerCase();
  const kwHits = themes.filter(t => text.includes(t.toLowerCase())).length;
  const kwScore   = (kwHits / Math.max(themes.length, 1)) * 0.45;
  const qualScore = ((movie.vote_average || 5) / 10) * 0.40;
  const year      = parseInt(movie.release_date?.split("-")[0]) || 2000;
  const recScore  = Math.max(0, Math.min(1, (year - 1990) / 35)) * 0.15;
  return kwScore + qualScore + recScore;
}

// ── DISCOVERY: 2 strategies per genre (counts as 2 subrequests each) ─────────
async function discoverGenre(genreId, tmdbKey, langCode, sortBy, page, minVotes) {
  const lang = langCode ? `&with_original_language=${langCode}` : "";
  const url = `https://api.themoviedb.org/3/discover/movie?api_key=${tmdbKey}&with_genres=${genreId}&sort_by=${sortBy}&vote_count.gte=${minVotes}&page=${page}&include_adult=false&language=en-US${lang}`;
  try {
    const r = await fetch(url);
    const d = await r.json();
    return d.results || [];
  } catch { return []; }
}

// ── GLOBAL THEME SEARCH: 2 calls total across all genres ─────────────────────
async function themeSearch(query, tmdbKey, langCode) {
  const lang = langCode ? `&with_original_language=${langCode}` : "";
  const url = `https://api.themoviedb.org/3/search/movie?api_key=${tmdbKey}&query=${encodeURIComponent(query)}&include_adult=false&language=en-US${lang}`;
  try {
    const r = await fetch(url);
    const d = await r.json();
    let results = d.results || [];
    // Post-filter by language for search endpoint (doesn't support with_original_language)
    if (langCode) results = results.filter(m => m.original_language === langCode);
    return results.filter(m => m.poster_path);
  } catch { return []; }
}

// ── LANGUAGE WIDENING: 1 call per genre only when pool is critically small ────
async function widenPool(genreId, tmdbKey, langCode) {
  const lang = langCode ? `&with_original_language=${langCode}` : "";
  const url = `https://api.themoviedb.org/3/discover/movie?api_key=${tmdbKey}&with_genres=${genreId}&sort_by=popularity.desc&page=1&include_adult=false&language=en-US${lang}`;
  try {
    const r = await fetch(url);
    const d = await r.json();
    return (d.results || []).filter(m => m.poster_path);
  } catch { return []; }
}

// Build per-genre pool from all discovered movies
function buildPool(genreId, allDiscovered, globalThemeMovies, langCode) {
  const seen = new Set();
  const pool = [];

  const add = movies => {
    for (const m of movies) {
      if (!seen.has(m.id) && m.poster_path) {
        if (!langCode || m.original_language === langCode) {
          seen.add(m.id); pool.push(m);
        }
      }
    }
  };

  add(allDiscovered);

  // Add theme movies that match this genre
  const themeMatches = globalThemeMovies.filter(m => m.genre_ids?.includes(genreId));
  add(themeMatches);

  return pool;
}

function buildContext(genreShortlists) {
  return genreShortlists.map(({ genre, candidates }) => {
    if (!candidates.length) return `${genre}: No candidates`;
    return `${genre} (${candidates.length} options):\n` + candidates.map(m =>
      `  ID:${m.id} | "${m.title}" (${m.release_date?.split("-")[0] || "?"}) [${m.original_language}] | TMDb:${(m.vote_average || 0).toFixed(1)} | "${(m.overview || "").slice(0, 120)}"`
    ).join("\n");
  }).join("\n\n");
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "POST") return err("Only POST allowed", 405);

    let body;
    try { body = await request.json(); }
    catch { return err("Invalid JSON", 400); }

    const { mood, moodChips, intent, filmLanguage = "any", explanationLang = "English" } = body;

    if (!env.ANTHROPIC_API_KEY || !env.TMDB_API_KEY)
      return err("Worker secrets not configured. Add ANTHROPIC_API_KEY and TMDB_API_KEY in Cloudflare dashboard.");

    if (!mood?.trim() && !moodChips?.length)
      return err("Please describe your mood.", 400);

    const langCode  = LANG_CODES[filmLanguage] ?? null;
    const langLabel = filmLanguage === "hi" ? "Hindi" : filmLanguage === "te" ? "Telugu" : filmLanguage === "en" ? "English" : "Any language";

    const moodCtx = mood?.trim() ? `User mood: "${mood.trim()}"` : "No description — infer from chips.";
    const chipCtx = moodChips?.length ? `Mood chips: ${moodChips.join(", ")}` : "No chips.";

    try {
      // ── STEP 1: Claude — psychological mood analysis (1 subrequest) ─────────
      const moodRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 900,
          messages: [{
            role: "user",
            content: `You are an expert film therapist. Apply the Circumplex Model (valence + arousal) and Plutchik's Wheel.

${moodCtx}
${chipCtx}
Intent: ${intent || "Feel better"}
Film language: ${langLabel}

Return ONLY valid JSON:
{
  "emotions": ["detected", "emotions"],
  "dominantEmotion": "strongest emotion",
  "intensity": "low|medium|high",
  "valence": "positive|negative|mixed",
  "arousal": "high|medium|low",
  "moodSummary": "1-2 warm empathetic sentences",
  "searchThemes": ["8-10 SPECIFIC cinematic themes: e.g. 'found family', 'quiet redemption', 'heist comedy', 'survival against odds', 'small town warmth' — NOT generic words"],
  "recommendedGenres": ["Genre1","Genre2","Genre3","Genre4","Genre5","Genre6"],
  "avoidDark": false
}

Genres: Drama, Comedy, Romance, Thriller, Action, Horror, Animation, Fantasy, Sci-Fi, Documentary.
Anxious/stressed → avoid Thriller/Horror; prefer Comedy/Animation/Fantasy.
Sad/lonely → Drama/Romance, catharsis arc.
Excited → Action/Comedy, kinetic.
Cozy/content → warm tone, connection arc.
Intent Escape → Fantasy/Sci-Fi/Action. Relate → Drama/Romance. Feel better → Comedy/Animation. Motivate → Action/Documentary.
avoidDark:true for intense sadness/grief.`
          }],
        }),
      });

      if (!moodRes.ok) {
        const e = await moodRes.json();
        throw new Error(`Claude mood: ${e.error?.message || moodRes.status}`);
      }

      const moodData = await moodRes.json();
      let MA;
      try { MA = parseJson(moodData.content[0].text); }
      catch {
        MA = {
          emotions: ["curious"], dominantEmotion: "neutral", intensity: "medium",
          valence: "mixed", arousal: "medium",
          moodSummary: "You're ready for a great film.",
          searchThemes: ["character study", "emotional journey", "human connection", "compelling story", "self-discovery", "friendship bond", "life changing"],
          recommendedGenres: ["Drama", "Comedy", "Action", "Romance", "Thriller", "Animation"],
          avoidDark: false,
        };
      }

      // ── Build genre list ───────────────────────────────────────────────────
      let genres = (MA.recommendedGenres || []).slice(0, 6);
      if (MA.avoidDark) {
        genres = genres.filter(g => g !== "Horror" && g !== "Thriller");
        const fill = ["Comedy", "Animation", "Romance", "Fantasy", "Drama"].filter(g => !genres.includes(g));
        genres = [...genres, ...fill].slice(0, 6);
      }
      const themes = MA.searchThemes || ["emotional journey", "compelling story"];

      // ── STEP 2: Discover movies — 2 calls per genre + 2 global theme searches
      // All fired in parallel. Total: 12 discover + 2 theme = 14 subrequests ──
      const genreIds = genres.map(g => GENRE_IDS[g] || 18);

      const discoverCalls = genres.flatMap((g, i) => {
        const id  = genreIds[i];
        const pA  = Math.floor(Math.random() * 8)  + 1;
        const pB  = Math.floor(Math.random() * 15) + 1;
        return [
          discoverGenre(id, env.TMDB_API_KEY, langCode, "popularity.desc",   pA, 50),
          discoverGenre(id, env.TMDB_API_KEY, langCode, "vote_average.desc",  pB, 30),
        ];
      }); // 12 calls

      const themeQuery1 = themes.slice(0, 3).join(" ");
      const themeQuery2 = themes.slice(3, 6).join(" ");

      const [
        ...discoverResults
      ] = await Promise.all([
        ...discoverCalls,                                          // 12
        themeSearch(themeQuery1, env.TMDB_API_KEY, langCode),     // 1
        themeSearch(themeQuery2, env.TMDB_API_KEY, langCode),     // 1
      ]); // Total so far: 1 (Claude) + 14 = 15 subrequests

      // Split discover results back to per-genre pairs
      const themeMovies1 = discoverResults[12];
      const themeMovies2 = discoverResults[13];
      const globalThemeMovies = [...(themeMovies1 || []), ...(themeMovies2 || [])];

      // ── STEP 3: Build per-genre pools ─────────────────────────────────────
      const masterPool = new Map();

      const genrePoolsRaw = genres.map((genre, i) => {
        const id   = genreIds[i];
        const resA = discoverResults[i * 2]     || [];
        const resB = discoverResults[i * 2 + 1] || [];
        const pool = buildPool(id, [...resA, ...resB], globalThemeMovies, langCode);
        return { genre, id, pool };
      });

      // Track all movies in master pool for ID-based poster resolution
      for (const { pool } of genrePoolsRaw) {
        for (const m of pool) masterPool.set(m.id, m);
      }

      // ── STEP 4: Language widening — 1 extra call per starved genre (max 6) ─
      // Only fires for language-filtered sessions with thin pools
      const widenCalls = [];
      for (const gp of genrePoolsRaw) {
        if (langCode && gp.pool.length < 5) {
          widenCalls.push(
            widenPool(gp.id, env.TMDB_API_KEY, langCode).then(extra => ({ genre: gp.genre, extra }))
          );
        }
      }

      if (widenCalls.length > 0) {
        const widenResults = await Promise.all(widenCalls); // up to 6 subrequests
        for (const { genre, extra } of widenResults) {
          const gp = genrePoolsRaw.find(g => g.genre === genre);
          if (gp) {
            const seen = new Set(gp.pool.map(m => m.id));
            for (const m of extra) {
              if (!seen.has(m.id)) { seen.add(m.id); gp.pool.push(m); masterPool.set(m.id, m); }
            }
          }
        }
      }
      // Subrequest count so far: 15 + up to 6 = max 21

      // ── STEP 5: Pre-score and shortlist top 10 per genre ──────────────────
      const shortlists = genrePoolsRaw.map(({ genre, pool }) => {
        const scored = pool
          .map(m => ({ m, s: preScore(m, themes) }))
          .sort((a, b) => b.s - a.s);
        return { genre, candidates: scored.slice(0, 10).map(x => x.m) };
      });

      // ── STEP 6: Claude — pick best film per genre (1 subrequest) ──────────
      const ctx = buildContext(shortlists);
      const langRule = langCode
        ? `\nCRITICAL: Only select films where [${langCode}] appears in the language field. Do NOT pick English films if a language filter is active. If pool is thin, pick the best available.\n`
        : "";
      const langOutput = explanationLang !== "English"
        ? `\nWrite all "explanation" and "tagline" values in ${explanationLang}.\n`
        : "";

      const pickRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 2500,
          messages: [{
            role: "user",
            content: `You are a warm, psychologically-informed film curator.

User emotional profile:
- Mood: ${MA.moodSummary}
- Dominant: ${MA.dominantEmotion} (${MA.intensity} intensity) | Valence: ${MA.valence} | Arousal: ${MA.arousal}
- Intent: ${intent || "Feel better"}
${langRule}${langOutput}
Candidates by genre (ID | title | year | language | TMDb rating | overview):
${ctx}

Return ONLY a valid JSON array — no markdown:
[{
  "genre": "exact genre name",
  "tmdbId": 12345,
  "title": "exact title from candidates",
  "releaseYear": "YYYY",
  "explanation": "2-3 warm sentences speaking to this user's emotional state. Be personal and specific.",
  "matchScore": 0.87,
  "isTopPick": false,
  "tagline": "6-8 word poetic tagline"
}]

Rules:
- tmdbId MUST be the numeric ID from candidates above — never invent
- isTopPick: true for exactly ONE film
- matchScore: 0.60–0.97
- No two picks from same director or franchise
- No film in more than one genre slot
- Prefer emotionally precise picks over obvious blockbusters
- Exactly 6 entries`
          }],
        }),
      });
      // Total subrequests: max 21 + 1 = 22 ✓

      if (!pickRes.ok) {
        const e = await pickRes.json();
        throw new Error(`Claude picks: ${e.error?.message || pickRes.status}`);
      }

      const pickData = await pickRes.json();
      let picks;
      try { picks = parseJson(pickData.content[0].text); }
      catch {
        picks = shortlists.map(({ genre, candidates }, i) => ({
          genre, tmdbId: candidates[0]?.id,
          title: candidates[0]?.title || "No recommendation",
          releaseYear: candidates[0]?.release_date?.split("-")[0] || null,
          explanation: "A film that suits your current mood.",
          matchScore: 0.75, isTopPick: i === 0, tagline: "A film worth your time",
        }));
      }

      // ── STEP 7: ID-based poster resolution — zero extra subrequests ────────
      const validIds = new Set(masterPool.keys());

      const results = picks.map(pick => {
        let id = typeof pick.tmdbId === "number" ? pick.tmdbId : parseInt(pick.tmdbId);
        if (!id || isNaN(id)) id = null;

        // If Claude returned an ID not in pool, find by title in pool (no extra API call)
        if (id && !validIds.has(id)) {
          const titleLower = pick.title?.toLowerCase().trim();
          for (const [pid, m] of masterPool) {
            if (m.title?.toLowerCase().trim() === titleLower) { id = pid; break; }
          }
          if (!validIds.has(id)) id = null;
        }

        const movie = id ? masterPool.get(id) : null;

        return {
          genre:       pick.genre,
          title:       pick.title,
          releaseYear: pick.releaseYear || movie?.release_date?.split("-")[0] || null,
          explanation: pick.explanation,
          matchScore:  pick.matchScore,
          isTopPick:   pick.isTopPick,
          tagline:     pick.tagline,
          poster:      movie?.poster_path   ? `https://image.tmdb.org/t/p/w500${movie.poster_path}`   : null,
          backdrop:    movie?.backdrop_path ? `https://image.tmdb.org/t/p/w780${movie.backdrop_path}` : null,
          rating:      movie?.vote_average  ? parseFloat(movie.vote_average.toFixed(1)) : null,
          tmdbUrl:     id                  ? `https://www.themoviedb.org/movie/${id}`                : null,
        };
      });

      return ok({ recommendations: results, moodAnalysis: MA });

    } catch (e) {
      console.error(e);
      return err(e.message || "Something went wrong. Please try again.");
    }
  },
};
