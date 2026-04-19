// Moodfilm — Cloudflare Worker
// API keys are stored as Worker Secrets in the Cloudflare dashboard.
// They are NEVER exposed to the browser or visible in any code.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

export default {
  async fetch(request, env) {
    // Handle preflight (browser sends this before real request)
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Only POST allowed" }), {
        status: 405,
        headers: CORS_HEADERS,
      });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: CORS_HEADERS,
      });
    }

    const { mood, moodChips, intent } = body;

    // env.ANTHROPIC_API_KEY and env.TMDB_API_KEY come from Cloudflare Secrets
    if (!env.ANTHROPIC_API_KEY || !env.TMDB_API_KEY) {
      return new Response(
        JSON.stringify({ error: "Worker secrets not configured. Add ANTHROPIC_API_KEY and TMDB_API_KEY in Cloudflare dashboard." }),
        { status: 500, headers: CORS_HEADERS }
      );
    }

    if (!mood && (!moodChips || moodChips.length === 0)) {
      return new Response(JSON.stringify({ error: "Please describe your mood." }), {
        status: 400,
        headers: CORS_HEADERS,
      });
    }

    try {
      // ── STEP 1: Claude analyzes mood ──────────────────────────────────────
      const analyzeRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 800,
          messages: [
            {
              role: "user",
              content: `You are an empathetic AI film curator. Analyze the user's emotional state.

User Mood: "${mood || ""}"
Mood Chips: ${moodChips?.length ? moodChips.join(", ") : "none"}
Intent: ${intent || "Feel better"}

Return ONLY valid JSON, no markdown:
{
  "emotions": ["array", "of", "emotions"],
  "dominantEmotion": "strongest emotion",
  "intensity": "low|medium|high",
  "moodSummary": "One warm empathetic sentence about their state",
  "recommendedGenres": ["Genre1","Genre2","Genre3","Genre4","Genre5","Genre6"],
  "avoidDark": false
}

Exactly 6 genres from: Drama, Comedy, Romance, Thriller, Action, Horror, Animation, Fantasy, Sci-Fi, Documentary
If intense sadness: avoidDark=true, use uplifting genres.
Intent "Escape": Fantasy/Sci-Fi/Action. "Relate": Drama/Romance. "Feel better": Comedy/Animation. "Get motivated": Action/Thriller.`,
            },
          ],
        }),
      });

      if (!analyzeRes.ok) {
        const err = await analyzeRes.json();
        throw new Error(`Claude: ${err.error?.message || analyzeRes.status}`);
      }

      const analyzeData = await analyzeRes.json();
      let moodAnalysis;
      try {
        const raw = analyzeData.content[0].text.trim().replace(/^```json\s*/i, "").replace(/\s*```$/i, "");
        moodAnalysis = JSON.parse(raw);
      } catch {
        moodAnalysis = {
          emotions: ["curious"],
          dominantEmotion: "neutral",
          intensity: "medium",
          moodSummary: "You're ready for a great film.",
          recommendedGenres: ["Drama", "Comedy", "Action", "Romance", "Thriller", "Animation"],
          avoidDark: false,
        };
      }

      // ── STEP 2: Fetch movies from TMDb per genre ──────────────────────────
      const genreIdMap = {
        Action: 28, Comedy: 35, Drama: 18, Horror: 27,
        Romance: 10749, Thriller: 53, Animation: 16,
        Documentary: 99, Fantasy: 14, "Sci-Fi": 878,
      };

      let genres = moodAnalysis.recommendedGenres || ["Drama", "Comedy", "Action", "Romance", "Thriller", "Animation"];
      if (moodAnalysis.avoidDark) {
        genres = genres.filter((g) => g !== "Horror" && g !== "Thriller");
        const fillers = ["Comedy", "Animation", "Romance", "Fantasy"].filter((g) => !genres.includes(g));
        genres = [...genres, ...fillers].slice(0, 6);
      }
      genres = genres.slice(0, 6);

      const movieFetches = genres.map(async (genre) => {
        const id = genreIdMap[genre] || 18;
        const url = `https://api.themoviedb.org/3/discover/movie?api_key=${env.TMDB_API_KEY}&with_genres=${id}&sort_by=vote_average.desc&vote_count.gte=200&page=1&include_adult=false&language=en-US`;
        const r = await fetch(url);
        const d = await r.json();
        return { genre, movies: (d.results || []).slice(0, 8) };
      });

      const genreMovies = await Promise.all(movieFetches);

      // ── STEP 3: Claude picks best movie per genre ─────────────────────────
      const movieContext = genreMovies
        .map(({ genre, movies }) =>
          movies.length
            ? `${genre}: ${movies.map((m) => `[${m.title} (${m.release_date?.split("-")[0] || "?"}), Rating:${m.vote_average?.toFixed(1)}, "${m.overview?.slice(0, 100)}"]`).join(" || ")}`
            : `${genre}: No results`
        )
        .join("\n");

      const recommendRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 2000,
          messages: [
            {
              role: "user",
              content: `You are a warm film curator. Pick the best movie per genre for this user.

Mood: ${moodAnalysis.moodSummary}
Dominant Emotion: ${moodAnalysis.dominantEmotion}
Intent: ${intent || "Feel better"}

Movies by genre:
${movieContext}

Return ONLY a valid JSON array, no markdown:
[{
  "genre": "exact genre name",
  "title": "exact movie title",
  "explanation": "2-3 warm sentences speaking directly to their mood",
  "matchScore": 0.82,
  "isTopPick": false,
  "tagline": "Short 6-8 word poetic tagline"
}]

One movie per genre. isTopPick=true for ONE best overall match only. matchScore 0.60–0.99.`,
            },
          ],
        }),
      });

      if (!recommendRes.ok) {
        const err = await recommendRes.json();
        throw new Error(`Claude: ${err.error?.message || recommendRes.status}`);
      }

      const recommendData = await recommendRes.json();
      let recommendations;
      try {
        const raw = recommendData.content[0].text.trim().replace(/^```json\s*/i, "").replace(/\s*```$/i, "");
        recommendations = JSON.parse(raw);
      } catch {
        recommendations = genreMovies.map(({ genre, movies }, i) => ({
          genre,
          title: movies[0]?.title || "No recommendation",
          explanation: "A highly rated film that matches your viewing needs.",
          matchScore: 0.75,
          isTopPick: i === 0,
          tagline: "A film worth your time",
        }));
      }

      // ── STEP 4: Enrich with posters ───────────────────────────────────────
      const enriched = recommendations.map((rec) => {
        const genreData = genreMovies.find((g) => g.genre.toLowerCase() === rec.genre?.toLowerCase());
        const movie = genreData?.movies.find((m) => m.title.toLowerCase() === rec.title?.toLowerCase()) || genreData?.movies[0];
        return {
          ...rec,
          poster: movie?.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null,
          backdrop: movie?.backdrop_path ? `https://image.tmdb.org/t/p/w780${movie.backdrop_path}` : null,
          rating: movie?.vote_average ? parseFloat(movie.vote_average.toFixed(1)) : null,
          releaseYear: movie?.release_date?.split("-")[0] || null,
          tmdbUrl: movie?.id ? `https://www.themoviedb.org/movie/${movie.id}` : null,
        };
      });

      return new Response(JSON.stringify({ recommendations: enriched, moodAnalysis }), {
        status: 200,
        headers: CORS_HEADERS,
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message || "Something went wrong" }), {
        status: 500,
        headers: CORS_HEADERS,
      });
    }
  },
};
