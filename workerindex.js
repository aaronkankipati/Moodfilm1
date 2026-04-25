// Moodfilm Worker — Sprint 2
// Fixes: B-01 ID-based posters, language hard filter, psychological mood model, OMDb enrichment
// New: pre-scoring, cross-genre deduplication, pool widening for small libraries
// Secrets in Cloudflare (exact case): ANTHROPIC_API_KEY  TMDB_API_KEY  OMDb_API_KEY

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

const GENRE_IDS = {
  Action:28, Comedy:35, Drama:18, Horror:27, Romance:10749,
  Thriller:53, Animation:16, Documentary:99, Fantasy:14, "Sci-Fi":878,
};

const GENRE_ADJACENTS = {
  Action:["Thriller","Drama"], Comedy:["Animation","Romance"], Drama:["Romance","Thriller"],
  Horror:["Thriller","Drama"], Romance:["Drama","Comedy"], Thriller:["Drama","Action"],
  Animation:["Comedy","Fantasy"], Documentary:["Drama"], Fantasy:["Animation","Sci-Fi"],
  "Sci-Fi":["Fantasy","Thriller"],
};

const LANG_CODES = { any:null, en:"en", hi:"hi", te:"te" };

const ok  = d => new Response(JSON.stringify(d), { status:200, headers:CORS });
const err = (m, s=500) => new Response(JSON.stringify({ error:m }), { status:s, headers:CORS });

function parseJson(text) {
  return JSON.parse(text.trim().replace(/^```json\s*/i,"").replace(/\s*```$/i,"").trim());
}

function preScore(movie, themes, langCode) {
  if (langCode && movie.original_language !== langCode) return -1;
  const text = `${movie.title||""} ${movie.overview||""}`.toLowerCase();
  const kwHits = themes.filter(t => text.includes(t.toLowerCase())).length;
  const kwScore   = (kwHits / Math.max(themes.length,1)) * 0.45;
  const qualScore = ((movie.vote_average||5) / 10) * 0.40;
  const year      = parseInt(movie.release_date?.split("-")[0]) || 2000;
  const recScore  = Math.max(0, Math.min(1,(year-1990)/35)) * 0.15;
  return kwScore + qualScore + recScore;
}

async function discoverTmdb(genreId, tmdbKey, langCode, sortBy, minVotes, page) {
  const lang = langCode ? `&with_original_language=${langCode}` : "";
  const url = `https://api.themoviedb.org/3/discover/movie?api_key=${tmdbKey}&with_genres=${genreId}&sort_by=${sortBy}&vote_count.gte=${minVotes}&page=${page}&include_adult=false&language=en-US${lang}`;
  try { const r = await fetch(url); const d = await r.json(); return d.results||[]; }
  catch { return []; }
}

async function searchByTheme(theme, tmdbKey, langCode) {
  const url = `https://api.themoviedb.org/3/search/movie?api_key=${tmdbKey}&query=${encodeURIComponent(theme)}&include_adult=false&language=en-US`;
  try {
    const r = await fetch(url); const d = await r.json();
    let results = d.results||[];
    if (langCode) results = results.filter(m => m.original_language === langCode);
    return results;
  } catch { return []; }
}

async function fetchGenreCandidates(genre, tmdbKey, langCode, themes) {
  const id = GENRE_IDS[genre]||18;
  const pA = Math.floor(Math.random()*8)+1;
  const pB = Math.floor(Math.random()*15)+1;
  const pC = Math.floor(Math.random()*5)+1;

  const settled = await Promise.allSettled([
    discoverTmdb(id, tmdbKey, langCode, "popularity.desc",           80, pA),
    discoverTmdb(id, tmdbKey, langCode, "vote_average.desc",         30, pB),
    discoverTmdb(id, tmdbKey, langCode, "primary_release_date.desc", 10, pC),
    ...themes.slice(0,3).map(t => searchByTheme(t, tmdbKey, langCode)),
  ]);

  const seen = new Set(); const merged = [];
  for (const s of settled) {
    if (s.status !== "fulfilled") continue;
    for (const m of (s.value||[])) {
      if (!seen.has(m.id) && m.poster_path) { seen.add(m.id); merged.push(m); }
    }
  }
  return merged;
}

async function fetchWithWidening(genre, tmdbKey, langCode, themes) {
  let pool = await fetchGenreCandidates(genre, tmdbKey, langCode, themes);

  if (langCode && pool.length < 8) {
    const id = GENRE_IDS[genre]||18;
    const lang = langCode ? `&with_original_language=${langCode}` : "";
    const [r1,r2] = await Promise.allSettled([
      fetch(`https://api.themoviedb.org/3/discover/movie?api_key=${tmdbKey}&with_genres=${id}&sort_by=popularity.desc&page=1&include_adult=false&language=en-US${lang}`).then(r=>r.json()),
      fetch(`https://api.themoviedb.org/3/discover/movie?api_key=${tmdbKey}&with_genres=${id}&sort_by=primary_release_date.desc&page=1&include_adult=false&language=en-US${lang}`).then(r=>r.json()),
    ]);
    const seen = new Set(pool.map(m=>m.id));
    for (const res of [r1,r2]) {
      if (res.status !== "fulfilled") continue;
      for (const m of (res.value?.results||[])) {
        if (!seen.has(m.id) && m.poster_path) { seen.add(m.id); pool.push(m); }
      }
    }
  }

  if (langCode && pool.length < 5) {
    for (const adj of (GENRE_ADJACENTS[genre]||[]).slice(0,2)) {
      if (pool.length >= 8) break;
      const adjPool = await fetchGenreCandidates(adj, tmdbKey, langCode, themes);
      const seen = new Set(pool.map(m=>m.id));
      for (const m of adjPool) { if (!seen.has(m.id)) { seen.add(m.id); pool.push(m); } }
    }
  }

  return pool;
}

async function getImdbId(tmdbId, tmdbKey) {
  try {
    const r = await fetch(`https://api.themoviedb.org/3/movie/${tmdbId}/external_ids?api_key=${tmdbKey}`);
    const d = await r.json(); return d.imdb_id||null;
  } catch { return null; }
}

async function omdbFetch(imdbId, omdbKey) {
  if (!imdbId||!omdbKey) return null;
  try {
    const r = await fetch(`https://www.omdbapi.com/?i=${imdbId}&plot=full&apikey=${omdbKey}`);
    const d = await r.json();
    if (d.Response==="False") return null;
    return {
      imdbRating: d.imdbRating!=="N/A" ? d.imdbRating : null,
      rtScore: d.Ratings?.find(x=>x.Source==="Rotten Tomatoes")?.Value||null,
      metascore: d.Metascore!=="N/A" ? d.Metascore : null,
      plot: d.Plot!=="N/A" ? d.Plot : null,
      language: d.Language||null,
    };
  } catch { return null; }
}

async function enrichBatch(candidates, tmdbKey, omdbKey) {
  const imdbIds = await Promise.all(candidates.map(m=>getImdbId(m.id, tmdbKey)));
  const omdbData = await Promise.all(imdbIds.map(id=>omdbFetch(id, omdbKey)));
  return candidates.map((m,i) => ({ ...m, imdbId:imdbIds[i], omdb:omdbData[i] }));
}

function buildContext(genreShortlists) {
  return genreShortlists.map(({ genre, candidates }) => {
    if (!candidates.length) return `${genre}: No candidates`;
    const lines = candidates.map(m => {
      const rt   = m.omdb?.rtScore   ? ` RT:${m.omdb.rtScore}`   : "";
      const imdb = m.omdb?.imdbRating? ` IMDb:${m.omdb.imdbRating}` : "";
      const plot = m.omdb?.plot || m.overview || "";
      const lang = m.original_language ? ` [lang:${m.original_language}]` : "";
      return `  ID:${m.id} | "${m.title}" (${m.release_date?.split("-")[0]||"?"})${lang} | TMDb:${(m.vote_average||0).toFixed(1)}${imdb}${rt} | "${plot.slice(0,130)}"`;
    });
    return `${genre} — ${candidates.length} candidates:\n${lines.join("\n")}`;
  }).join("\n\n");
}

export default {
  async fetch(request, env) {
    if (request.method==="OPTIONS") return new Response(null,{headers:CORS});
    if (request.method!=="POST") return err("Only POST allowed",405);

    let body;
    try { body = await request.json(); }
    catch { return err("Invalid JSON",400); }

    const { mood, moodChips, intent, filmLanguage="any", explanationLang="English" } = body;

    if (!env.ANTHROPIC_API_KEY||!env.TMDB_API_KEY)
      return err("Worker secrets not configured. Add ANTHROPIC_API_KEY and TMDB_API_KEY in Cloudflare dashboard.");

    if (!mood?.trim() && !moodChips?.length)
      return err("Please describe your mood.",400);

    const langCode  = LANG_CODES[filmLanguage] ?? null;
    const langLabel = filmLanguage==="hi"?"Hindi":filmLanguage==="te"?"Telugu":filmLanguage==="en"?"English":"Any language";
    const omdbKey   = env.OMDb_API_KEY || null;

    const moodCtx = mood?.trim() ? `User mood: "${mood.trim()}"` : "No written description — infer from chips only.";
    const chipCtx = moodChips?.length ? `Mood chips: ${moodChips.join(", ")}` : "No chips.";

    try {
      // ── 1. Claude: psychological mood analysis ────────────────────────────
      const moodApiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{"Content-Type":"application/json","x-api-key":env.ANTHROPIC_API_KEY,"anthropic-version":"2023-06-01"},
        body: JSON.stringify({
          model:"claude-sonnet-4-20250514", max_tokens:1000,
          messages:[{ role:"user", content:`You are an expert film therapist with deep emotional intelligence.

${moodCtx}
${chipCtx}
Watch intent: ${intent||"Feel better"}
Film language: ${langLabel}

Apply the Circumplex Model (valence + arousal axes) and Plutchik's Wheel to map this emotional state to a precise cinematic profile.

Return ONLY valid JSON — no markdown:
{
  "emotions": ["detected","emotions"],
  "dominantEmotion": "strongest emotion",
  "intensity": "low|medium|high",
  "valence": "positive|negative|mixed",
  "arousal": "high|medium|low",
  "moodSummary": "1-2 warm empathetic sentences",
  "cinematicProfile": {
    "pacing": "slow|moderate|kinetic",
    "tone": "warm|dark|whimsical|intense|melancholic|uplifting|bittersweet",
    "narrativeArc": "redemption|escape|connection|triumph|catharsis|mystery|coming-of-age",
    "searchThemes": ["8-10 SPECIFIC cinematic themes like 'found family', 'quiet redemption', 'heist comedy', 'survival thriller', 'small town warmth', 'unlikely friendship' — not generic words"],
    "avoidThemes": ["themes to avoid or empty array"]
  },
  "recommendedGenres": ["Genre1","Genre2","Genre3","Genre4","Genre5","Genre6"],
  "avoidDark": false
}

Psychological rules:
- Anxious/stressed (high arousal, negative valence) → avoid Thriller/Horror; Comedy/Animation/Fantasy
- Sad/lonely (low arousal, negative valence) → slow pacing, catharsis, Drama/Romance
- Excited (high arousal, positive valence) → kinetic, triumph, Action/Comedy
- Cozy/content (low arousal, positive valence) → warm tone, connection arc
- Intent "Escape" → Fantasy/Sci-Fi/Action. "Relate" → Drama/Romance. "Feel better" → Comedy/Animation. "Motivate" → Action/Documentary
- avoidDark:true for intense sadness, grief, or distress` }],
        }),
      });

      if (!moodApiRes.ok) { const e=await moodApiRes.json(); throw new Error(`Claude mood: ${e.error?.message||moodApiRes.status}`); }
      const moodApiData = await moodApiRes.json();
      let MA;
      try { MA = parseJson(moodApiData.content[0].text); }
      catch {
        MA = {
          emotions:["curious"], dominantEmotion:"neutral", intensity:"medium",
          valence:"mixed", arousal:"medium",
          moodSummary:"You're ready for a great film.",
          cinematicProfile:{
            pacing:"moderate", tone:"warm", narrativeArc:"connection",
            searchThemes:["character study","emotional journey","human connection","compelling narrative","award winning drama","friendship story","self-discovery"],
            avoidThemes:[],
          },
          recommendedGenres:["Drama","Comedy","Action","Romance","Thriller","Animation"],
          avoidDark:false,
        };
      }

      // ── 2. Build genre list ────────────────────────────────────────────────
      let genres = (MA.recommendedGenres||[]).slice(0,6);
      if (MA.avoidDark) {
        genres = genres.filter(g=>g!=="Horror"&&g!=="Thriller");
        const fill = ["Comedy","Animation","Romance","Fantasy","Drama"].filter(g=>!genres.includes(g));
        genres = [...genres,...fill].slice(0,6);
      }
      const themes = MA.cinematicProfile?.searchThemes || ["emotional journey","compelling story","critically acclaimed"];

      // ── 3. TMDb discovery — all genres in parallel ─────────────────────────
      const allPools = await Promise.all(genres.map(g => fetchWithWidening(g, env.TMDB_API_KEY, langCode, themes)));

      // Master pool for ID-based poster lookup
      const masterPool = new Map();
      for (const movies of allPools) for (const m of movies) masterPool.set(m.id, m);

      // ── 4. Pre-score → top 10 per genre ────────────────────────────────────
      const shortlists = genres.map((genre, i) => {
        const scored = allPools[i]
          .map(m => ({ m, s:preScore(m, themes, langCode) }))
          .filter(x => x.s >= 0)
          .sort((a,b) => b.s - a.s);
        return { genre, candidates: scored.slice(0,10).map(x=>x.m) };
      });

      // ── 5. OMDb enrichment — top 10 per genre, fully parallel, degrades gracefully ──
      const enriched = await Promise.all(
        shortlists.map(async ({genre, candidates}) => {
          if (!omdbKey||!candidates.length) return {genre, candidates};
          const e = await enrichBatch(candidates, env.TMDB_API_KEY, omdbKey);
          return {genre, candidates:e};
        })
      );

      // ── 6. Claude: select best film per genre ─────────────────────────────
      const ctx = buildContext(enriched);
      const langConstraint = langCode
        ? `\nCRITICAL LANGUAGE RULE: You MUST select films where lang field = "${langCode}" (${langLabel}). Do NOT pick English films. If pool is limited, pick the best available ${langLabel} film.\n`
        : "";
      const langOutput = explanationLang!=="English"
        ? `\nWrite all "explanation" and "tagline" values in ${explanationLang} language.\n`
        : "";

      const pickApiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{"Content-Type":"application/json","x-api-key":env.ANTHROPIC_API_KEY,"anthropic-version":"2023-06-01"},
        body: JSON.stringify({
          model:"claude-sonnet-4-20250514", max_tokens:2500,
          messages:[{ role:"user", content:`You are a warm, psychologically-informed film curator.

User's emotional profile:
- Mood: ${MA.moodSummary}
- Dominant: ${MA.dominantEmotion} (${MA.intensity} intensity) | Valence: ${MA.valence} | Arousal: ${MA.arousal}
- Needs: ${MA.cinematicProfile?.pacing} pacing, ${MA.cinematicProfile?.tone} tone, ${MA.cinematicProfile?.narrativeArc} arc
- Intent: ${intent||"Feel better"}
- Avoid: ${MA.cinematicProfile?.avoidThemes?.join(", ")||"nothing specific"}
${langConstraint}${langOutput}
Candidates (each has ID, title, year, language, ratings, plot):
${ctx}

Return ONLY a valid JSON array — no markdown:
[{
  "genre": "exact genre name",
  "tmdbId": 12345,
  "title": "exact title from candidates",
  "releaseYear": "YYYY",
  "explanation": "2-3 warm sentences speaking to this user's emotional state. Be personal and specific about why THIS film for THIS mood.",
  "matchScore": 0.87,
  "isTopPick": false,
  "tagline": "6-8 word poetic tagline"
}]

Rules:
- tmdbId MUST be the numeric ID from the candidate list — never invent
- isTopPick: true for exactly ONE film
- matchScore: 0.60–0.97
- No two picks from same director or franchise
- No film in more than one genre slot
- Prefer emotionally precise obscure picks over obvious blockbusters when they fit better
- Exactly 6 entries` }],
        }),
      });

      if (!pickApiRes.ok) { const e=await pickApiRes.json(); throw new Error(`Claude picks: ${e.error?.message||pickApiRes.status}`); }
      const pickApiData = await pickApiRes.json();
      let picks;
      try { picks = parseJson(pickApiData.content[0].text); }
      catch {
        picks = enriched.map(({genre,candidates},i) => ({
          genre, tmdbId:candidates[0]?.id, title:candidates[0]?.title||"No recommendation",
          releaseYear:candidates[0]?.release_date?.split("-")[0]||null,
          explanation:"A film that suits your current mood.",
          matchScore:0.75, isTopPick:i===0, tagline:"A film worth your time",
        }));
      }

      // ── 7. ID-based poster resolution — no string matching, no wrong posters ──
      const validIds = new Set(masterPool.keys());
      const results = await Promise.all(picks.map(async pick => {
        let id = typeof pick.tmdbId === "number" ? pick.tmdbId : parseInt(pick.tmdbId);
        if (!id || isNaN(id)) id = null;

        // Guard: Claude returned an ID not in our pool — search TMDb by title as safety net
        if (!id || !validIds.has(id)) {
          try {
            const q = encodeURIComponent(pick.title||"");
            const r = await fetch(`https://api.themoviedb.org/3/search/movie?api_key=${env.TMDB_API_KEY}&query=${q}&language=en-US`);
            const d = await r.json();
            const match = (d.results||[]).find(m=>m.title?.toLowerCase()===pick.title?.toLowerCase());
            id = match?.id || null;
            if (id && match) masterPool.set(id, match);
          } catch { id = null; }
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
          tmdbUrl:     id ? `https://www.themoviedb.org/movie/${id}` : null,
        };
      }));

      return ok({ recommendations:results, moodAnalysis:MA });

    } catch(e) {
      console.error(e);
      return err(e.message||"Something went wrong. Please try again.");
    }
  },
};
