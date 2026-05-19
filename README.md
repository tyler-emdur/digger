# 🪲 Digger

Discover underground music based on your Spotify listening history. Digger analyzes your taste profile and surfaces artists you've never heard of — but will immediately love.

## Setup

### 1. Create a Spotify Developer App

1. Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. Click **Create App**
3. Fill in:
   - **App name**: Digger (or anything you like)
   - **App description**: Underground music discovery
   - **Redirect URI**: `http://localhost:3000/auth/callback`
   - **APIs used**: Web API
4. Accept the terms and click **Save**
5. On your app page, click **Settings** to find your **Client ID** and **Client Secret**

### 2. Configure Environment Variables

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```
SPOTIFY_CLIENT_ID=your_client_id_from_dashboard
SPOTIFY_CLIENT_SECRET=your_client_secret_from_dashboard
REDIRECT_URI=http://localhost:3000/auth/callback
SESSION_SECRET=any_long_random_string
LASTFM_API_KEY=optional_but_recommended
ANTHROPIC_API_KEY=optional_for_ai_blurbs
PORT=3000
```

### 3. Install Dependencies

```bash
npm install
```

### 4. Run

```bash
# Development (auto-restarts on changes)
npm run dev

# Production
npm start
```

Open [http://localhost:3000](http://localhost:3000) and connect your Spotify account.

---

## How It Works

### Taste Profile
Digger pulls your top artists across three time ranges (4 weeks, 6 months, all time) and weights them — recent listening counts 3× more than long-term. It extracts audio features (energy, danceability, valence, tempo, acousticness) from your top tracks and computes averages to build your audio fingerprint.

### Discovery Algorithm
When `LASTFM_API_KEY` is set, Digger uses your top artists plus curated calibration artists as seeds for a Last.fm similarity graph walk. Candidates are grouped into taste pillars, cross-referenced back to Spotify for playable tracks, and filtered aggressively:

- **Default mode**: roughly `≤ 80k` Last.fm listeners for most pillars
- **Deep dig mode**: roughly `≤ 40k` Last.fm listeners for most pillars
- Excludes any artist you've already listened to
- Deduplicates by artist so you get variety, not multiple tracks from the same band
- Blocks noisy tags, aliases, and obvious mainstream/polluted scenes
- Falls back to a Spotify album traversal path if Last.fm is not configured

The "why you might like this" blurb is generated from shared Last.fm tags and seed-artist connections. If `ANTHROPIC_API_KEY` is present, Claude can generate richer blurbs.

### Tuning the Algorithm

To adjust the recommendation shape, edit `lib/algorithm.js`:

- `PILLARS`: labels, quotas, and calibration seeds per taste pillar
- `CALIBRATION_SEEDS`: curated underground seed artists
- tag blocklists/gates: scene cleanup and pillar-specific filtering

Listener caps live in `routes/api.js` inside `lastfmRecommendations()`. Lower caps produce more obscure results but may reduce the number of Spotify-matchable tracks.

---

## Scopes Used

| Scope | Purpose |
|-------|---------|
| `user-top-read` | Read your top artists and tracks |
| `user-read-recently-played` | Read recently played tracks |
| `playlist-modify-public` | Create playlists and add tracks |
| `user-read-private` | Read your user ID for playlist creation |

## Notes

- **No data is stored.** Everything lives in a server-side session that expires after 2 hours.
- **Preview URLs** are provided by Spotify and are 30-second MP3 clips. Not all tracks have them — Spotify has been reducing preview availability, especially outside the US.
- **Rate limits**: Spotify allows ~180 requests per minute. If you hit a rate limit, the app will display an error with a retry hint.
- **Token refresh** is handled automatically — the access token is refreshed 5 minutes before it expires.
