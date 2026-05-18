# Digger — Session Recap

**Project:** Underground music discovery app  
**Stack:** Node/Express backend, vanilla JS/HTML/CSS frontend, no framework  
**Run:** `npm run dev` → `http://localhost:3000`  
**Required env:** `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `LASTFM_API_KEY`, `SESSION_SECRET`, `REDIRECT_URI`, `ANTHROPIC_API_KEY` (optional — falls back to template blurbs)

---

## What Digger Does

1. User logs in with Spotify OAuth
2. Backend fetches their top artists (short/medium/long term, weighted 3x/2x/1x), top tracks, recently played, liked tracks
3. That listening history is cross-referenced with Last.fm's similarity graph to find underground artists the user doesn't know yet
4. Results are grouped into taste "pillars" (introspective, rock, experimental, electronic, hip-hop) based on tag classification
5. Each card shows artist name, track, blurb, listener count, and either a ▶ preview button (30s audio) or an embedded Spotify iframe

---

## File Map

```
digger/
├── server.js              # Express entry point, session config
├── routes/
│   ├── auth.js            # Spotify OAuth: /auth/login, /auth/callback, /auth/logout, /auth/status
│   └── api.js             # All API routes (see below)
├── lib/
│   ├── algorithm.js       # Taste profile builder, pillar definitions, tag classifiers, blurb generators
│   ├── lastfm.js          # Last.fm API wrapper (getArtistInfo, getSimilarArtists, collab fallback)
│   ├── spotify.js         # Spotify API wrapper (getTopArtists, getTopTracks, searchArtists, etc.)
│   └── claude.js          # Anthropic SDK wrapper for AI blurbs (claude-haiku-4-5-20251001)
└── public/
    ├── index.html         # Single HTML file — two views: landing, app
    ├── app.js             # All frontend JS (~1100 lines)
    └── styles.css         # All CSS (~1370 lines)
```

---

## API Routes (`routes/api.js`)

| Route | Method | What it does |
|---|---|---|
| `/api/profile` | GET | Fetches Spotify top artists/tracks, builds taste profile, prefetches Last.fm seed data, stores everything in session |
| `/api/recommendations` | GET | Runs the pillar-based Last.fm graph walk, Spotify cross-reference, returns tiers + micro-underground + scene DNA + unexpected match. Query param: `?deepDig=true` |
| `/api/playlist/track` | POST | Saves a single track to the user's Digger playlist (creates it if it doesn't exist) |
| `/api/playlist` | POST | Creates a full playlist from an array of track URIs |
| `/api/card-reaction` | POST | Handles card feedback: `not-for-me` / `too-mainstream` / `weirder` / `more-like-this`. Adjusts session caps and blocklists |
| `/api/feedback` | POST | Records scroll-mode like/dislike (unused in scoring currently) |
| `/api/debug` | GET | Probes every Spotify endpoint individually and reports what's available |

---

## The Core Algorithm (`lastfmRecommendations` in api.js)

This is the main function (~350 lines). Here's the flow:

### 1. Pillar setup
Five pillars defined in `lib/algorithm.js → PILLARS`:
- `introspective` — folk, bedroom pop, indie, shoegaze (quota: 5)
- `rock` — post-punk, emo, indie rock, noise rock (quota: 4)
- `experimental` — IDM, ambient, drone, glitch (quota: 3, listener cap: 150k)
- `electronic` — house, techno, hyperpop, club (quota: 4)
- `hiphop` — rap, trap, cloud rap (quota: 2)

Each pillar has `calibSeeds` (curated underground artists used as graph walk starting points).

### 2. User seed classification
The user's top 10 Spotify artists are classified into pillars using `classifyArtistToPillar(tags)` in algorithm.js. Their pillar assignment is stored in `userPillarSeeds`.

### 3. Graph walk per pillar
For each pillar:
- Seeds = pillar's calibSeeds + user's seeds that belong to that pillar
- Call `lastfm.getSimilarArtists(seed, 50)` for each seed (with dedup)
- Candidates are artists that appeared as similar to multiple seeds

### 4. Enrich + filter (`filterAndScore`)
For each candidate:
- Look up on Last.fm via `getArtistInfoWithCollabFallback()` (handles "Artist A & Artist B" collabs)
- Reject if: in alias blocklist, in user-blocked list (from card reactions), not on LFM, has blocked top tags (Finnish pop, eurodance, classical, etc.), or introspective pillar gate fails
- **Introspective gate (A1):** reject if #1 tag is electronic/electropop/electroclash, AND require at least one qualifying folk/indie tag in top 5
- Reject if listeners < 50 (broken/unlisted) or > listenerCap (too mainstream)
- Over-cap artists mentioned by 3+ seeds go into `sceneDNAMap` (shown as Scene DNA strip)
- Score = tagOverlap (weighted by userTagWeights) + listenerRatio + matchBonus

### 5. Tag weighting (60/40 split)
Built during `/api/profile`. User's Spotify artists = 60%, calibration seeds = 40%. Prevents the heavily-electronic calibration list from skewing the tag profile.

### 6. Spotify cross-reference (`spotifyXRef`)
Takes LFM artist name → searches Spotify → finds a representative track → returns:
- `previewUrl` (30s audio, often null post-2024 Spotify policy changes)
- `albumArt` (track album image)
- `spotifyUrl`, `artistSpotifyUrl`, `id`, `uri`
- `seedNames` (which seeds led to this artist — shown as discovery path)

### 7. Result shape
```js
{
  tiers: [{ id, label, subtitle, tracks: [...] }],   // one per pillar
  microUnderground: [...],                             // < 5k listeners, no Spotify track
  mostUnexpectedMatch: { track, pillars: ['a','b'] }, // scored in 2+ pillars
  sceneAnchors: [...],                                 // over-cap artists from Scene DNA
  recommendations: [...],                              // flat list of all rec tracks
  debugInfo: { ... }
}
```

### Track object shape
```js
{
  id, uri, name, artist, artistSpotifyUrl, spotifyUrl,
  albumArt,        // Spotify album image URL or null
  previewUrl,      // 30s audio URL or null (frequently null post-2024)
  listeners,       // Last.fm listener count
  popularityLabel, // e.g. "12k listeners"
  genres,          // Last.fm tags array
  overlappingTags, // tags that match the user's profile
  whyBlurb,        // AI-generated or template blurb
  pillar,          // 'introspective' | 'rock' | 'experimental' | 'electronic' | 'hiphop' | 'wildcard'
  seedNames,       // ['SeedArtist'] — discovery pathway
  deepCut,         // boolean: < 8k listeners
  sceneTag,        // e.g. 'Bedroom Pop', 'Post-Punk' (badge label)
  wildcard,        // boolean: scored across multiple pillars
}
```

---

## Frontend Architecture (`public/app.js`)

### State
```js
const state = {
  recommendations: [],  // flat array of all rec tracks
  isDeepDig: false,
  currentAudio: null,   // currently playing <audio> element
  currentPlayBtn: null, // the ▶ button that's currently showing ■
  savedUris: new Set()
};
```

### Key functions
| Function | What it does |
|---|---|
| `loadProfile()` | Fetches /api/profile, renders user + taste panel, then calls loadRecommendations() |
| `loadRecommendations(deepDig)` | Fetches /api/recommendations, renders scene DNA + unexpected match + tier sections + micro-underground |
| `trackCardHTML(track)` | Generates the HTML for a single recommendation card |
| `attachCardListeners()` | Wires up play buttons, save buttons, reaction buttons, tier-title observer, card stagger animation |
| `toggleCardAudio(btn)` | Click-to-play: plays 30s preview, toggles ▶/■, stops previously playing audio |
| `stopAudio()` | Pauses current audio, resets button state |
| `handleCardReaction(btn)` | POSTs to /api/card-reaction, dismisses card or expands inline results |
| `enterScrollMode()` | Full-screen swipe mode (auto-enters on mobile < 768px) |
| `saveTrack(btn)` | POSTs to /api/playlist/track |
| `saveAll()` | POSTs to /api/playlist with all rec URIs |
| `renderDebugPanel(info, tiers)` | Renders the "🔬 Nerd mode" panel with pipeline counts, tag profile, rejected artists |

### Card HTML structure
```html
<div class="track-card" data-id data-uri data-artist data-pillar data-listeners>
  <div class="recommendation-card">        <!-- max-height: 100px, overflow: hidden -->
    <div class="card-art-wrap">            <!-- 56x56px, position: relative -->
      <div class="art-gradient-fallback">  <!-- always rendered, genre-tinted color -->
        <span class="art-gradient-initial">A</span>
      </div>
      <img class="card-art" onerror="this.style.display='none'" />  <!-- overlays gradient -->
      <button class="card-play-btn">▶</button>                      <!-- if previewUrl -->
      <audio class="track-audio" src="..."></audio>                  <!-- if previewUrl -->
    </div>
    <div class="card-content">
      <div class="card-artist">Artist Name</div>
      <div class="card-track">Track Name</div>
      <div class="card-blurb">Why blurb...</div>
      <div class="track-meta">listener count badge</div>
    </div>
    <div class="card-side-actions">       <!-- save + open buttons -->
      <button class="btn-track-save">+ Save</button>
      <a class="btn-track-open">↗</a>
    </div>
  </div>
  <!-- shown only when no previewUrl: -->
  <div class="card-iframe-wrap">
    <iframe src="https://open.spotify.com/embed/track/ID..." height="52"></iframe>
  </div>
  <div class="card-reactions">            <!-- 4 borderless reaction buttons -->
    👍 More | 📻 Mainstream | 🌀 Weirder | 💔 Nope
  </div>
  <div class="expand-results hidden"></div>  <!-- inline expansion for "More like this" -->
</div>
```

### Audio logic
- Cards with `previewUrl`: ▶ button click → `toggleCardAudio(btn)` → plays `<audio>` at vol 0.8, toggles to ■
- Cards without `previewUrl` but with Spotify ID: 52px Spotify iframe embedded below the compact row
- Cards with neither: skipped entirely (return `''` from `trackCardHTML`)

---

## What's Working

- Full Spotify OAuth flow
- Taste profile with audio features (when available) or genre-derived mood
- Last.fm pillar-based graph walk with per-pillar quotas and listener caps
- Spotify cross-reference (artist name → track → albumArt, previewUrl, IDs)
- 30s audio preview playback with click-to-play ▶/■ toggle
- Spotify iframe embed fallback when no preview URL
- Art rendering: gradient fallback always behind, image overlays (no broken img tags)
- Card reactions: session-stored blocklist + pillar cap adjustments
- "More like this" inline expansion
- Scene DNA section (over-cap artists mentioned by 3+ seeds)
- "Most unexpected match" callout (artist scoring in 2+ pillars)
- Discovery pathway (seed chain shown on each card)
- Scroll mode (full-screen swipe cards, auto-enters on mobile < 768px)
- Touch swipe gestures: right=like, left=dislike
- AI blurbs via claude-haiku-4-5-20251001 (falls back to template if no API key)
- Save single track or all tracks to Spotify playlist
- "🔬 Nerd mode" debug panel
- Staggered card fade-in animation (60ms per card)
- Tier section title slide-in via IntersectionObserver
- Micro-underground section: distinct dark/noisy/monospace visual with glow pulse
- Loading: 🪲 beetle march animation + rotating copy

---

## Known Issues / Likely Next Work

### Audio
- Spotify `preview_url` is frequently `null` post-2024 (Spotify deprecated it for many markets). The iframe fallback handles this but the 52px iframe is visually disruptive in the compact card layout. Consider requesting Extended Quota Mode from Spotify or exploring alternative preview sources.

### Image quality
- `albumArt` comes from the Spotify track's album images (not the artist image). For compilation tracks or EP-heavy artists the art can be inconsistent.
- The gradient fallback color palette uses only 6 genre buckets and defaults to `#1a1a1a`. Could expand.

### Card reactions
- Pillar cap adjustments from reactions persist only for the session (stored in `req.session.pillarListenerCaps`). They reset on logout.
- "More like this" expansion uses a fresh LFM walk — can be slow.

### Algorithm
- The wildcard pillar (artists that score in multiple pillars) is tracked in `crossPillarMap` but slot quotas for wildcard aren't enforced separately — they fall into `mostUnexpectedMatch` only.
- Micro-underground artists (< 5k listeners) with no Spotify track are shown with a YouTube/SoundCloud link but have no playback inside the app.

### Mobile
- The scroll mode auto-enters on < 768px but the list view below it still renders (wasted render).
- No gesture support for the list view cards (only scroll mode has swipe).

---

## Spotify API Restrictions (2024+)

These endpoints are blocked without Extended Quota Mode approval:
- `/recommendations` — fully deprecated
- `/audio-features` — restricted (code handles graceful failure)
- `preview_url` in track objects — frequently null

These endpoints still work:
- `/me/top/artists`, `/me/top/tracks`, `/me/player/recently-played`
- `/artists/{id}` — full artist object (genres, popularity)
- `/artists/{id}/top-tracks`
- `/search` — both artist and track search
- `/tracks/{id}` — full track object (but preview_url often null)
- Playlist write endpoints

---

## Environment Variables Needed

```
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
REDIRECT_URI=http://localhost:3000/auth/callback
SESSION_SECRET=any-random-string
LASTFM_API_KEY=...            # required — without it falls back to a much weaker Spotify-only algorithm
ANTHROPIC_API_KEY=...         # optional — without it uses template blurbs from algorithm.js
```

The LASTFM_API_KEY is critical. Without it, `lastfmRecommendations()` doesn't run and the app falls back to `albumTraversalRecommendations()` which produces significantly worse results.

---

## Calibration Seeds

These are the curated underground artists hard-coded in `lib/algorithm.js → CALIBRATION_SEEDS`. They act as taste anchors — walked on Last.fm for similar artists but never shown as results. They were chosen to represent the target "underground" aesthetic:

```
Damon r., MGNA Crrrta, The Hellp, Bassvictim, nate sib, Saska, tonser,
Somewhere Special, Suzy Sheer, DRES, heffy, Club Eat, Perto, anna luna,
Garett Caramel, Extra Small, The Twins, Brothel in Belize, The Bird,
SILICONE VALLEY, 80gawd, Amy, Dalhaus, The Truth, Gift Exchange,
D3SIST, The Femcels, Tommy Fleece, fakemink, velvette blue,
Cameron Winter, underscores, Frost Children, 2hollis, Snow Strippers
```

The experimental pillar also has `extraSeeds` (walked but never shown as results): Boards of Canada, Autechre, Burial, Four Tet.
