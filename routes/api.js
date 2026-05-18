const express = require('express');
const router = express.Router();
const spotify = require('../lib/spotify');
const lastfm = require('../lib/lastfm');
const claude  = require('../lib/claude');
const {
  weightedArtistList,
  buildTasteProfile,
  assignSceneTag,
  generateSpecificBlurb,
  formatListeners,
  checkTagBlocklist,
  classifyTagsToBucket,
  classifyArtistToPillar,
  ALIAS_BLOCKLIST,
  CALIBRATION_SEEDS,
  PILLARS
} = require('../lib/algorithm');

function requireAuth(req, res, next) {
  if (!req.session.accessToken) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

function handleSpotifyError(err, res) {
  const status = err.response?.status;
  console.error('Spotify error detail:', {
    status,
    url: err.config?.url,
    data: err.response?.data,
    headers: err.response?.headers
  });
  if (status === 429) {
    const retryAfter = err.response.headers['retry-after'] || 30;
    return res.status(429).json({ error: `Spotify rate limit hit. Retry in ${retryAfter}s.` });
  }
  if (status === 401) {
    return res.status(401).json({ error: 'Spotify session expired. Please log in again.' });
  }
  res.status(500).json({ error: err.response?.data?.error?.message || err.message || 'Spotify API error', spotifyStatus: status });
}

// Debug endpoint — probe each Spotify call individually and report results
router.get('/debug', requireAuth, async (req, res) => {
  const token = await spotify.getValidToken(req.session);
  const axios = require('axios');
  const results = {};

  const probe = async (label, url, params = {}) => {
    try {
      const r = await axios.get(`https://api.spotify.com/v1${url}`, {
        headers: { Authorization: `Bearer ${token}` },
        params
      });
      results[label] = { ok: true, status: r.status, sample: JSON.stringify(r.data).slice(0, 120) };
    } catch (e) {
      results[label] = { ok: false, status: e.response?.status, data: e.response?.data, msg: e.message };
    }
  };

  // User-data endpoints
  await probe('/me', '/me');
  await probe('/me/top/artists', '/me/top/artists', { time_range: 'short_term', limit: 1 });
  await probe('/me/top/tracks', '/me/top/tracks', { time_range: 'short_term', limit: 1 });
  await probe('/me/player/recently-played', '/me/player/recently-played', { limit: 1 });

  // Catalog endpoints
  await probe('/artists/{id}', '/artists/0qc4BFxcwRFZfevTck4fOi');
  await probe('/artists/{id}/top-tracks', '/artists/0qc4BFxcwRFZfevTck4fOi/top-tracks', { market: 'US' });
  await probe('/artists/{id}/related-artists', '/artists/0qc4BFxcwRFZfevTck4fOi/related-artists');
  await probe('/artists/{id}/albums', '/artists/0qc4BFxcwRFZfevTck4fOi/albums', { limit: 1 });
  await probe('/albums/{id}', '/albums/4aawyAB9vmqN3uQ7FjRGTy');
  await probe('/albums/{id}/tracks', '/albums/4aawyAB9vmqN3uQ7FjRGTy/tracks', { limit: 1 });
  await probe('/tracks/{id}', '/tracks/11dFghVXANMlKmJXsNCbNl');

  // Search
  await probe('/search artist', '/search', { q: 'indie rock', type: 'artist', limit: 1 });
  await probe('/search track', '/search', { q: 'indie rock', type: 'track', limit: 1 });
  await probe('/search genre filter', '/search', { q: 'genre:indie', type: 'artist', limit: 1 });

  // Browse / discovery
  await probe('/browse/new-releases', '/browse/new-releases', { limit: 1 });
  await probe('/browse/categories', '/browse/categories', { limit: 1 });
  await probe('/audio-features', '/audio-features', { ids: '11dFghVXANMlKmJXsNCbNl' });
  await probe('/recommendations (deprecated?)', '/recommendations', { seed_genres: 'pop', limit: 1 });

  console.log('DEBUG RESULTS:', JSON.stringify(results, null, 2));
  res.json({
    tokenPresent: !!token,
    tokenPrefix: token ? token.slice(0, 12) + '…' : null,
    sessionExpiry: new Date(req.session.tokenExpiry).toISOString(),
    results
  });
});

// Fetch and analyze the user's listening data, build taste profile
router.get('/profile', requireAuth, async (req, res) => {
  try {
    const token = await spotify.getValidToken(req.session);

    const [
      shortArtists, mediumArtists, longArtists,
      shortTracks, mediumTracks, longTracks,
      recentlyPlayed,
      userProfile
    ] = await Promise.all([
      spotify.getTopArtists(token, 'short_term'),
      spotify.getTopArtists(token, 'medium_term'),
      spotify.getTopArtists(token, 'long_term'),
      spotify.getTopTracks(token, 'short_term', 50),
      spotify.getTopTracks(token, 'medium_term', 50),
      spotify.getTopTracks(token, 'long_term', 50),
      spotify.getRecentlyPlayed(token, 50),
      spotify.getUserProfile(token)
    ]);

    // Fetch saved (liked) tracks — graceful failure if user has none or scope missing
    const savedTracks = await spotify.getSavedTracks(token, 100).catch(() => []);

    // Deduplicate all tracks into allTracks
    const seenTrackIds = new Set();
    const allTracks = [];
    for (const track of [...shortTracks, ...mediumTracks, ...longTracks, ...recentlyPlayed, ...savedTracks]) {
      if (!track || !track.id) continue;
      if (seenTrackIds.has(track.id)) continue;
      seenTrackIds.add(track.id);
      allTracks.push(track);
    }

    // Store heard track IDs in session (as array for JSON serialization)
    const heardTrackIds = new Set(allTracks.map(t => t.id));
    req.session.heardTrackIds = [...heardTrackIds];

    const weighted = weightedArtistList(shortArtists, mediumArtists, longArtists);

    // /me/top/artists now returns simplified objects without genres or popularity.
    // Enrich the top 15 artists by fetching them individually via /artists/{id}.
    const topIds = weighted.slice(0, 15).map(w => w.artist.id);
    const enrichedArtists = await Promise.all(
      topIds.map(id => spotify.getArtist(token, id).catch(() => null))
    );
    const enrichedMap = new Map(enrichedArtists.filter(Boolean).map(a => [a.id, a]));
    const enrichedWeighted = weighted.map(w => ({
      weight: w.weight,
      artist: enrichedMap.get(w.artist.id) || w.artist
    }));

    // Try audio features for all tracks
    let audioFeatures = [];
    try {
      const trackIds = allTracks.map(t => t.id).filter(Boolean);
      if (trackIds.length) audioFeatures = await spotify.getAudioFeatures(token, trackIds);
      if (audioFeatures.length) {
        console.log('Audio features available:', audioFeatures.length);
        const centroid = {};
        const keys = ['danceability', 'energy', 'valence', 'tempo', 'acousticness', 'instrumentalness', 'speechiness'];
        keys.forEach(k => { centroid[k] = Math.round(audioFeatures.reduce((s, f) => s + (f?.[k] || 0), 0) / audioFeatures.length * 100) / 100; });
        console.log('Taste centroid:', centroid);
        req.session.tasteCentroid = centroid;
      }
    } catch (e) {
      console.log('Audio features blocked:', e.response?.status || e.message);
    }

    const tasteProfile = buildTasteProfile(enrichedWeighted, audioFeatures);

    // Collect all artist IDs from ALL tracks
    const topTrackArtistIds = [...new Set(
      allTracks.flatMap(t => (t.artists || []).map(a => a.id))
    )].slice(0, 100);

    // Cache everything for the recommendations call
    req.session.tasteProfile = tasteProfile;
    req.session.topTrackArtistIds = topTrackArtistIds;
    req.session.listenedArtistIds = [...new Set([
      ...enrichedWeighted.map(w => w.artist.id),
      ...topTrackArtistIds
    ])];
    req.session.userId = userProfile.id;
    req.session.userMarket = userProfile.country || 'US';

    // Prefetch Last.fm data for seed artists AND all calibration seeds in parallel
    if (process.env.LASTFM_API_KEY) {
      const primarySeedNames = enrichedWeighted.slice(0, 10).map(w => w.artist.name);
      const allSeedNamesForLfm = [...new Set([...primarySeedNames, ...CALIBRATION_SEEDS])];

      const infos = await Promise.all(allSeedNamesForLfm.map(n => lastfm.getArtistInfo(n)));

      const lfmSeedInfos = {};
      allSeedNamesForLfm.forEach((name, i) => {
        if (infos[i]) lfmSeedInfos[name] = infos[i];
      });
      req.session.lfmSeedInfos = lfmSeedInfos;

      // Count how many valid seeds found on Last.fm
      // Build tag weights with 60/40 split: user's Spotify listening (60%) vs calibration seeds (40%).
      // This prevents the heavily-electronic calibration list from drowning out the user's actual taste.
      const primaryTagCounts = {};   // tag -> Set of primary seed names
      const calibTagCounts = {};     // tag -> Set of calibration seed names

      allSeedNamesForLfm.forEach(name => {
        const info = lfmSeedInfos[name];
        if (!info) return;
        const isPrimary = primarySeedNames.includes(name);
        const counts = isPrimary ? primaryTagCounts : calibTagCounts;
        (info.tags || []).forEach(tag => {
          if (!counts[tag]) counts[tag] = new Set();
          counts[tag].add(name);
        });
      });

      const primaryFoundCount = Math.max(primarySeedNames.filter(n => lfmSeedInfos[n]).length, 1);
      const calibFoundCount   = Math.max(CALIBRATION_SEEDS.filter(n => lfmSeedInfos[n]).length, 1);

      const userTagWeights = {};
      const allTagKeys = new Set([...Object.keys(primaryTagCounts), ...Object.keys(calibTagCounts)]);
      allTagKeys.forEach(tag => {
        const pw = (primaryTagCounts[tag]?.size || 0) / primaryFoundCount;
        const cw = (calibTagCounts[tag]?.size || 0) / calibFoundCount;
        userTagWeights[tag] = Math.min(0.6 * pw + 0.4 * cw, 0.3);
      });

      req.session.userTagWeights = userTagWeights;
      console.log('Tag profile (60/40 weighted):', userTagWeights);
    }

    const topTracksDisplay = shortTracks.slice(0, 8).map(t => ({
      id: t.id,
      name: t.name,
      artist: t.artists?.[0]?.name || '',
      albumArt: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || null,
      spotifyUrl: t.external_urls?.spotify || ''
    }));

    res.json({
      user: {
        name: userProfile.display_name,
        image: userProfile.images?.[0]?.url || null
      },
      tasteProfile,
      topTracks: topTracksDisplay
    });
  } catch (err) {
    handleSpotifyError(err, res);
  }
});

// Expose recommendation internals for debugging
router.get('/recs-debug', requireAuth, async (req, res) => {
  const token = await spotify.getValidToken(req.session);
  const tasteProfile = req.session.tasteProfile;

  // Always re-fetch top artists so we can see their raw genre data
  const topArtistsRaw = await spotify.getTopArtists(token, 'short_term', 10);
  const firstArtistRaw = topArtistsRaw[0] || null;
  const artistIds = topArtistsRaw.map(a => a.id).filter(Boolean);

  // Test individual /artists/{id} for the first top artist to see if it returns genres
  let singleArtistFull = null;
  if (artistIds[0]) {
    try {
      singleArtistFull = await spotify.getArtist(token, artistIds[0]);
    } catch (e) {
      singleArtistFull = { error: e.response?.status, msg: e.message };
    }
  }

  if (!tasteProfile) return res.json({ error: 'No tasteProfile in session — visit /api/profile first' });

  // Test: search for the first top artist by name — does search return genres + popularity?
  const firstArtistName = topArtistsRaw[0]?.name;
  let searchArtistTest = null;
  if (firstArtistName) {
    try {
      const r = await spotify.searchArtists(token, `"${firstArtistName}"`, 5, 0);
      const match = r.find(a => a.name.toLowerCase() === firstArtistName.toLowerCase()) || r[0];
      searchArtistTest = match ? { name: match.name, genres: match.genres, popularity: match.popularity, keys: Object.keys(match) } : null;
    } catch (e) { searchArtistTest = { error: e.message }; }
  }

  // Sanity check with a well-known artist
  let strokesTest = null;
  try {
    const r = await spotify.searchArtists(token, '"The Strokes"', 3, 0);
    const s = r.find(a => a.name === 'The Strokes') || r[0];
    strokesTest = s ? { name: s.name, genres: s.genres, popularity: s.popularity } : null;
  } catch (e) { strokesTest = { error: e.message }; }

  // Test underground search on a known genre
  let genreSearchTest = null;
  try {
    const r = await spotify.searchArtists(token, 'genre:"indie rock"', 50, 0);
    const underground = r.filter(a => a.popularity != null && a.popularity < 30 && a.popularity >= 2);
    genreSearchTest = { totalResults: r.length, undergroundCount: underground.length, firstResultKeys: r[0] ? Object.keys(r[0]) : [], firstResultPop: r[0]?.popularity, firstResultGenres: r[0]?.genres };
  } catch (e) { genreSearchTest = { error: e.message }; }

  // Test track search — full track objects include popularity even when artist objects don't
  let trackSearchTest = null;
  try {
    const r = await spotify.searchTracks(token, 'indie', 5, 0);
    trackSearchTest = r[0] ? { keys: Object.keys(r[0]), popularity: r[0].popularity, artistName: r[0].artists?.[0]?.name } : null;
  } catch (e) { trackSearchTest = { error: e.message }; }

  res.json({
    verdict: 'All artist objects stripped of genres+popularity. Track search objects include popularity.',
    trackSearchTest,
    strokesTest,
    genreSearchTest
  });
});

router.get('/recommendations', requireAuth, async (req, res) => {
  try {
    if (process.env.LASTFM_API_KEY) {
      return await lastfmRecommendations(req, res);
    }
    return await albumTraversalRecommendations(req, res);
  } catch (err) {
    handleSpotifyError(err, res);
  }
});

// ── Last.fm-powered algorithm (per-pillar graph walks) ───────────────────────
async function lastfmRecommendations(req, res) {
  const token = await spotify.getValidToken(req.session);
  const tasteProfile = req.session.tasteProfile;
  if (!tasteProfile) return res.status(400).json({ error: 'Load your profile first.' });

  const deepDig = req.query.deepDig === 'true';
  const listenedArtistIds = new Set(req.session.listenedArtistIds || []);
  const heardTrackIds     = new Set(req.session.heardTrackIds || []);
  const lfmSeedInfos      = req.session.lfmSeedInfos || {};
  const userTagWeights    = req.session.userTagWeights || {};
  const primarySeedNames  = (tasteProfile.topArtistNames || []).slice(0, 10);
  const tasteCentroid     = req.session.tasteCentroid || {};

  // Per-session listener cap overrides set by card reactions
  const capOverrides    = req.session.pillarListenerCaps || {};
  const blockedArtists  = new Set((req.session.blockedArtists || []).map(n => n.toLowerCase()));

  const rejectedLog = [];
  const debugStages = { seeds: primarySeedNames, tagProfile: userTagWeights };
  const seedInfoMap = new Map(Object.entries(lfmSeedInfos));

  const allSeedNamesLower = [...primarySeedNames, ...CALIBRATION_SEEDS].map(n => n.toLowerCase());

  // Global dedup for output — prevents same artist in two pillar tiers
  const globalChosen = new Set();

  // Base exclusion set (seeds are never candidates)
  const EXPERIMENTAL_EXTRA = ['Boards of Canada', 'Autechre', 'Burial', 'Four Tet'];
  const baseExcluded = new Set([
    ...primarySeedNames.map(n => n.toLowerCase()),
    ...CALIBRATION_SEEDS.map(n => n.toLowerCase()),
    ...EXPERIMENTAL_EXTRA.map(n => n.toLowerCase())
  ]);

  // ── Classify user's primary seeds into pillars ────────────────────────────
  const userPillarSeeds = {};
  for (const name of primarySeedNames) {
    const info = lfmSeedInfos[name];
    const pillarId = classifyArtistToPillar(info?.tags || []);
    if (pillarId) {
      if (!userPillarSeeds[pillarId]) userPillarSeeds[pillarId] = [];
      userPillarSeeds[pillarId].push(name);
    }
  }
  debugStages.userPillarSeeds = userPillarSeeds;

  // ── Enrich helper (A4: collab name splitting) ─────────────────────────────
  async function enrichCandidates(candidates) {
    const infos = await Promise.all(
      candidates.map(c => lastfm.getArtistInfoWithCollabFallback(c.name))
    );
    return candidates.map((c, i) => ({ ...c, lfmInfo: infos[i] }));
  }

  // Pillars with per-pillar listener caps (A2: experimental cap = 150k)
  const DEFAULT_CAP = deepDig ? 40000 : 80000;
  const PILLAR_CAPS = {
    experimental: deepDig ? 75000 : 150000
  };

  // Tags that gate the introspective pillar (A1)
  const INTROSPECTIVE_GATE = new Set([
    'indie folk', 'folk', 'singer-songwriter', 'bedroom pop', 'lo-fi', 'lo fi',
    'indie pop', 'emo', 'indie rock', 'acoustic', 'alternative folk', 'freak folk',
    'chamber pop', 'shoegaze', 'dream pop', 'noise pop', 'emo folk', 'bedroom indie',
    'indie', 'alt-emo', 'midwest emo', 'skramz', 'slacker rock', 'noise rock', 'alternative'
  ]);
  const INTROSPECTIVE_HARD_REJECT_TOP = new Set(['electropop', 'electroclash', 'electronic']);

  // ── Filter + score ────────────────────────────────────────────────────────
  // Scene coherence check removed — tag blocklist handles pollutants.
  // Per-pillar gates added instead (A1).
  const sceneDNAMap = new Map(); // track high-listener rejections for B3

  function filterAndScore(enriched, listenerCap, pillarId) {
    return enriched
      .map(c => {
        const nameLow = c.name.toLowerCase();
        if (ALIAS_BLOCKLIST.has(nameLow) || blockedArtists.has(nameLow)) {
          rejectedLog.push({ name: c.name, reason: 'Alias / blocked', pillar: pillarId }); return null;
        }
        if (!c.lfmInfo) {
          rejectedLog.push({ name: c.name, reason: 'Not on Last.fm', pillar: pillarId }); return null;
        }
        const candidateTags = c.lfmInfo.tags || [];
        const tagAlias = allSeedNamesLower.find(s => candidateTags.some(t => t.toLowerCase().includes(s)));
        if (tagAlias) {
          rejectedLog.push({ name: c.name, reason: `Alias of ${tagAlias}`, pillar: pillarId }); return null;
        }
        const blockReason = checkTagBlocklist(candidateTags);
        if (blockReason) {
          rejectedLog.push({ name: c.name, reason: blockReason, pillar: pillarId }); return null;
        }

        // A1: introspective pillar tag gate
        if (pillarId === 'introspective') {
          const topTag = candidateTags[0]?.toLowerCase();
          if (INTROSPECTIVE_HARD_REJECT_TOP.has(topTag)) {
            rejectedLog.push({ name: c.name, reason: `Introspective gate: #1 tag is ${topTag}`, pillar: pillarId }); return null;
          }
          const hasGate = candidateTags.slice(0, 5).some(t => INTROSPECTIVE_GATE.has(t.toLowerCase()));
          if (!hasGate) {
            rejectedLog.push({ name: c.name, reason: 'Introspective gate: no qualifying tag in top 5', pillar: pillarId }); return null;
          }
        }

        const listeners = c.lfmInfo.listeners;
        if (listeners < 50) {
          rejectedLog.push({ name: c.name, reason: `Only ${listeners} listeners`, pillar: pillarId }); return null;
        }
        if (listeners > listenerCap) {
          // Track for Scene DNA (B3) — over-cap but mentioned by multiple seeds
          const seedCount = c.seedNames?.length || 0;
          if (seedCount >= 2 && !sceneDNAMap.has(c.name)) {
            sceneDNAMap.set(c.name, {
              name: c.name, listeners, tags: candidateTags,
              seedCount, connectedSeeds: c.seedNames?.slice(0, 3) || [], pillar: pillarId
            });
          }
          rejectedLog.push({ name: c.name, reason: `${listeners.toLocaleString()} > cap ${listenerCap.toLocaleString()}`, pillar: pillarId }); return null;
        }

        const overlappingTags = candidateTags.filter(t => (userTagWeights[t] || 0) > 0);
        const tagScore = candidateTags.reduce((s, t) => s + (userTagWeights[t] || 0), 0);
        const multiSeedBonus = (c.seedNames?.length || 0) * 0.05;
        return { ...c, score: tagScore + multiSeedBonus, overlappingTags };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
  }

  // ── Spotify cross-reference ────────────────────────────────────────────────
  async function spotifyXRef(candidates, quota) {
    const pool = candidates.slice(0, quota + 14);
    const searches = await Promise.all(
      pool.map(c =>
        spotify.searchTracks(token, `artist:"${c.name}"`, 10, 0)
          .then(tracks => ({ c, tracks }))
          .catch(() => ({ c, tracks: [] }))
      )
    );

    const results = [];
    for (const { c, tracks } of searches) {
      if (results.length >= quota) break;
      const nameLow = c.name.toLowerCase();
      const byArtist = tracks.filter(t => (t.artists || []).some(a => a.name.toLowerCase() === nameLow));
      const pool2 = byArtist.length ? byArtist : tracks.filter(t =>
        (t.artists || []).some(a => a.name.toLowerCase().includes(nameLow.split(' ')[0]))
      );
      if (!pool2.length) { rejectedLog.push({ name: c.name, reason: 'Not found on Spotify', pillar: c.pillar }); continue; }

      let track = pool2.find(t => !heardTrackIds.has(t.id));
      let deepCut = false;

      if (!track) {
        const sa = pool2[0].artists.find(a => a.name.toLowerCase() === nameLow) || pool2[0].artists[0];
        if (sa && listenedArtistIds.has(sa.id)) {
          rejectedLog.push({ name: c.name, reason: 'All tracks heard', pillar: c.pillar }); continue;
        }
        track = pool2[0];
      }

      const spotifyArtist = (track.artists || []).find(a => a.name.toLowerCase() === nameLow) || track.artists?.[0];
      if (!spotifyArtist) { rejectedLog.push({ name: c.name, reason: 'No matching artist', pillar: c.pillar }); continue; }
      if (globalChosen.has(c.name.toLowerCase())) continue;

      if (listenedArtistIds.has(spotifyArtist.id)) {
        if (heardTrackIds.has(track.id)) { rejectedLog.push({ name: c.name, reason: 'All tracks heard', pillar: c.pillar }); continue; }
        deepCut = true;
      }

      // A6: preview URL chain: track object → getTrack fallback
      let previewUrl = track.preview_url;
      if (!previewUrl) {
        try { const ft = await spotify.getTrack(token, track.id); previewUrl = ft.preview_url || null; } catch {}
      }

      const candidateTags = c.lfmInfo?.tags || [];
      const lfmImage = c.lfmInfo?.image || null;
      const albumArt = track.album?.images?.[0]?.url || lfmImage || null;
      const resolvedSeeds = c.seedNames.filter(s => primarySeedNames.includes(s));
      const whyBlurb = generateSpecificBlurb(candidateTags, seedInfoMap,
        resolvedSeeds.length ? resolvedSeeds : c.seedNames.slice(0, 2));

      globalChosen.add(c.name.toLowerCase());
      results.push({
        id: track.id, uri: track.uri, name: track.name,
        artist: c.name, artistId: spotifyArtist.id,
        album: track.album?.name || '',
        albumArt,
        previewUrl: previewUrl || null,
        popularityLabel: formatListeners(c.lfmInfo?.listeners),
        spotifyUrl: track.external_urls?.spotify || '',
        artistSpotifyUrl: spotifyArtist.external_urls?.spotify || '',
        genres: candidateTags,
        sceneTag: assignSceneTag(candidateTags),
        whyBlurb,
        listeners: c.lfmInfo?.listeners || 0,
        pillar: c.pillar,
        deepCut,
        overlappingTags: c.overlappingTags || [],
        seedNames: resolvedSeeds.length ? resolvedSeeds : c.seedNames.slice(0, 3) // B4
      });
    }
    return results;
  }

  // ── Walk each pillar independently ────────────────────────────────────────
  const SIM_LIMIT = deepDig ? 100 : 80;

  const pillarScoredMap   = {};
  const pillarEnrichedMap = {};

  for (const [pillarId, pillar] of Object.entries(PILLARS)) {
    const listenerCap = capOverrides[pillarId] ?? (PILLAR_CAPS[pillarId] ?? DEFAULT_CAP);
    const userSeeds   = (userPillarSeeds[pillarId] || []).slice(0, 3);
    const extraSeeds  = pillar.extraSeeds || [];
    const allSeeds    = [...new Set([...userSeeds, ...pillar.calibSeeds, ...extraSeeds])];

    console.log(`Pillar ${pillarId}: ${allSeeds.length} seeds, cap ${listenerCap.toLocaleString()}`);
    const simResults = await Promise.all(allSeeds.map(n => lastfm.getSimilarArtists(n, SIM_LIMIT)));

    const excluded = new Set([...baseExcluded, ...globalChosen]);
    const candidateMap = new Map();
    simResults.forEach((results, si) => {
      const fromName = allSeeds[si];
      (results || []).forEach(({ name, match }) => {
        const low = name.toLowerCase();
        if (excluded.has(low)) return;
        if (!candidateMap.has(name)) candidateMap.set(name, { name, totalMatch: 0, seedNames: [], pillar: pillarId });
        const c = candidateMap.get(name);
        c.totalMatch += match;
        if (!c.seedNames.includes(fromName)) c.seedNames.push(fromName);
      });
    });

    const candidateList = [...candidateMap.values()]
      .sort((a, b) => b.totalMatch - a.totalMatch)
      .slice(0, 120);

    debugStages[`${pillarId}Candidates`] = candidateList.length;

    const enriched = await enrichCandidates(candidateList);
    pillarEnrichedMap[pillarId] = enriched;

    const scored = filterAndScore(enriched, listenerCap, pillarId);
    pillarScoredMap[pillarId] = scored;
    debugStages[`${pillarId}Scored`] = scored.length;
  }

  // ── B7: Most unexpected match — artist scoring in 2+ pillars ─────────────
  const crossPillarMap = new Map();
  for (const [pillarId, scored] of Object.entries(pillarScoredMap)) {
    scored.slice(0, 30).forEach(c => {
      if (!crossPillarMap.has(c.name)) crossPillarMap.set(c.name, { pillars: [], maxScore: 0, data: c });
      const e = crossPillarMap.get(c.name);
      e.pillars.push(pillarId);
      e.maxScore = Math.max(e.maxScore, c.score || 0);
    });
  }
  const unexpectedCandidate = [...crossPillarMap.values()]
    .filter(e => e.pillars.length >= 2)
    .sort((a, b) => b.maxScore - a.maxScore)[0] || null;

  // ── Build per-pillar tiers ─────────────────────────────────────────────────
  const finalTiers = [];
  const allTrackRecs = [];

  // Resolve "most unexpected" as a Spotify track first so it gets a card
  let mostUnexpectedMatch = null;
  if (unexpectedCandidate) {
    const xrefResult = await spotifyXRef([unexpectedCandidate.data], 1);
    if (xrefResult.length) {
      mostUnexpectedMatch = {
        track: { ...xrefResult[0], unexpected: true },
        pillars: unexpectedCandidate.pillars
      };
    }
  }

  for (const [pillarId, pillar] of Object.entries(PILLARS)) {
    const scored = pillarScoredMap[pillarId] || [];
    const tracks = await spotifyXRef(scored, pillar.quota);
    if (tracks.length > 0) {
      finalTiers.push({ id: pillarId, label: pillar.label, subtitle: pillar.subtitle, tracks });
      allTrackRecs.push(...tracks);
    }
    debugStages[`${pillarId}Final`] = tracks.length;
  }

  // Wildcard tier
  const wildcardPool = [];
  for (const scored of Object.values(pillarScoredMap)) {
    wildcardPool.push(...scored.filter(c => !globalChosen.has(c.name.toLowerCase())));
  }
  wildcardPool.sort((a, b) => (b.score || 0) - (a.score || 0));
  const wildcardTracks = await spotifyXRef(wildcardPool.slice(0, 20), 2);
  wildcardTracks.forEach(t => { t.wildcard = true; });
  if (wildcardTracks.length > 0) {
    finalTiers.push({ id: 'wildcard', label: '🎲 Outside Your Usual Zones', subtitle: 'High-scoring artists that cross genre lines', tracks: wildcardTracks });
    allTrackRecs.push(...wildcardTracks);
  }

  // ── Micro-underground per pillar (max 2 per pillar, A3: dedup) ────────────
  const microByPillar = {};
  for (const [pillarId, enriched] of Object.entries(pillarEnrichedMap)) {
    microByPillar[pillarId] = enriched.filter(c => {
      if (!c.lfmInfo) return false;
      const l = c.lfmInfo.listeners;
      return l < 5000 && l >= 10 &&
        !ALIAS_BLOCKLIST.has(c.name.toLowerCase()) &&
        !globalChosen.has(c.name.toLowerCase()) &&
        !blockedArtists.has(c.name.toLowerCase());
    }).slice(0, 2);
  }

  // A3: dedup across pillars by name
  const microSeen = new Set();
  const microCandidates = Object.values(microByPillar).flat().filter(c => {
    const low = c.name.toLowerCase();
    if (microSeen.has(low)) return false;
    microSeen.add(low);
    return true;
  }).sort((a, b) => (a.lfmInfo?.listeners || 0) - (b.lfmInfo?.listeners || 0)).slice(0, 12);

  const microUnderground = (await Promise.all(
    microCandidates.map(c =>
      spotify.searchTracks(token, `artist:"${c.name}"`, 5, 0)
        .then(tracks => {
          const nameLow = c.name.toLowerCase();
          const t = tracks.find(tr => (tr.artists || []).some(a => a.name.toLowerCase() === nameLow)) || null;
          return {
            name: c.name, listeners: c.lfmInfo?.listeners || 0,
            tags: c.lfmInfo?.tags?.length ? c.lfmInfo.tags : ['tags unavailable'], // A4 fallback
            pillar: c.pillar,
            spotifyTrack: t ? {
              id: t.id, uri: t.uri, name: t.name,
              albumArt: t.album?.images?.[0]?.url || c.lfmInfo?.image || null,
              spotifyUrl: t.external_urls?.spotify || '',
              previewUrl: t.preview_url || null
            } : null,
            notOnSpotify: !t
          };
        })
        .catch(() => ({
          name: c.name, listeners: c.lfmInfo?.listeners || 0,
          tags: c.lfmInfo?.tags?.length ? c.lfmInfo.tags : ['tags unavailable'],
          pillar: c.pillar, spotifyTrack: null, notOnSpotify: true
        }))
    )
  )).filter(m => m.listeners > 0)
    .sort((a, b) => a.listeners - b.listeners)
    .slice(0, 10);

  // ── B3: Scene DNA — over-cap artists appearing in 3+ seeds ───────────────
  const sceneAnchors = [...sceneDNAMap.values()]
    .filter(a => a.seedCount >= 3)
    .sort((a, b) => b.seedCount - a.seedCount || b.listeners - a.listeners)
    .slice(0, 5);

  // ── B1: Claude blurbs (if API key present) ────────────────────────────────
  const energyDelta = tasteCentroid.energy > 0.65 ? 'higher energy than user' :
                      tasteCentroid.energy < 0.4  ? 'lower energy than user'  : 'similar energy';

  if (process.env.ANTHROPIC_API_KEY) {
    // Main tier tracks
    const blurbItems = allTrackRecs.map(t => ({
      candidateArtist: t.artist,
      candidateTags: t.genres || [],
      viaArtist: t.seedNames?.[0] || primarySeedNames[0] || '',
      userTopArtists: primarySeedNames,
      energyDelta
    }));
    const blurbs = await claude.generateBlurbsBatch(blurbItems);
    allTrackRecs.forEach((t, i) => { if (blurbs[i]) t.whyBlurb = blurbs[i]; });
    // Keep tiers in sync
    for (const tier of finalTiers) {
      tier.tracks.forEach(t => {
        const updated = allTrackRecs.find(r => r.id === t.id);
        if (updated?.whyBlurb) t.whyBlurb = updated.whyBlurb;
      });
    }

    // Unexpected match blurb
    if (mostUnexpectedMatch) {
      const ub = await claude.generateUnexpectedBlurb({
        candidateArtist: mostUnexpectedMatch.track.artist,
        pillar1: mostUnexpectedMatch.pillars[0],
        pillar2: mostUnexpectedMatch.pillars[1],
        userTopArtists: primarySeedNames
      }).catch(() => null);
      if (ub) mostUnexpectedMatch.track.whyBlurb = ub;
    }
  }

  debugStages.finalMicro = microUnderground.length;
  console.log(`Results: ${allTrackRecs.length} tracks, ${finalTiers.length} pillars, ${microUnderground.length} micro`);

  res.json({
    tiers: finalTiers,
    microUnderground,
    mostUnexpectedMatch,
    sceneAnchors,
    recommendations: allTrackRecs,
    deepDig,
    popularityThreshold: null,
    debugInfo: {
      ...debugStages,
      rejected: rejectedLog,
      tagProfile: userTagWeights,
      userPillarSeeds
    }
  });
}

// ── Fallback: album-graph traversal (no Last.fm key) ─────────────────────────
async function albumTraversalRecommendations(req, res) {
  const token = await spotify.getValidToken(req.session);
  const tasteProfile = req.session.tasteProfile;
  if (!tasteProfile) return res.status(400).json({ error: 'Load your profile first.' });

  const deepDig = req.query.deepDig === 'true';
  const listenedArtistIds = new Set(req.session.listenedArtistIds || []);
  const userMarket = req.session.userMarket || 'US';
  const seedIds = tasteProfile.topArtistIds || [];
  const seedNames = tasteProfile.topArtistNames || [];

  const primaryIds = seedIds.slice(0, deepDig ? 8 : 5);
  const albumCap = deepDig ? 60 : 35;

  const [primaryOwn, primaryOn] = await Promise.all([
    Promise.all(primaryIds.map((id, i) =>
      spotify.getArtistAlbums(token, id, deepDig ? 8 : 5, userMarket, 'album,single')
        .then(albums => albums.map(a => ({ album: a, seedName: seedNames[i] || 'your library' })))
        .catch(() => [])
    )),
    Promise.all(primaryIds.map((id, i) =>
      spotify.getArtistAlbums(token, id, 5, userMarket, 'appears_on')
        .then(albums => albums.map(a => ({ album: a, seedName: seedNames[i] || 'your library' })))
        .catch(() => [])
    ))
  ]);

  const seenAlbumIds = new Set();
  const albumsWithSeed = [...primaryOwn.flat(), ...primaryOn.flat()]
    .filter(({ album }) => {
      if (seenAlbumIds.has(album.id)) return false;
      seenAlbumIds.add(album.id);
      return true;
    }).slice(0, albumCap);

  const albumTracksResults = await Promise.all(
    albumsWithSeed.map(({ album, seedName }) =>
      spotify.getAlbumTracks(token, album.id, 10)
        .then(tracks => ({ tracks, album, seedName }))
        .catch(() => ({ tracks: [], album, seedName }))
    )
  );

  const candidateMap = new Map();
  for (const { tracks, album, seedName } of albumTracksResults) {
    for (const track of tracks) {
      for (const artist of track.artists || []) {
        if (listenedArtistIds.has(artist.id) || candidateMap.has(artist.id)) continue;
        candidateMap.set(artist.id, {
          id: track.id, uri: track.uri, name: track.name,
          artist: artist.name, artistId: artist.id,
          album: album.name, albumArt: album.images?.[0]?.url || null,
          previewUrl: track.preview_url || null, popularity: null,
          spotifyUrl: track.external_urls?.spotify || '',
          artistSpotifyUrl: artist.external_urls?.spotify || '',
          genres: [], sceneTag: null,
          whyBlurb: `Appears on the same record as ${seedName}.`
        });
      }
    }
  }

  const recommendations = [...candidateMap.values()]
    .filter(r => r.id && r.uri)
    .sort(() => Math.random() - 0.5)
    .slice(0, 20);

  res.json({
    recommendations, deepDig, popularityThreshold: null,
    debugInfo: {
      note: 'Add LASTFM_API_KEY to .env for genre filtering and proper underground scoring',
      candidateCount: candidateMap.size, finalCount: recommendations.length
    }
  });
}

// ── Card reaction endpoint (B2) ───────────────────────────────────────────
// action: "more-like-this" | "too-mainstream" | "weirder" | "not-for-me"
router.post('/card-reaction', requireAuth, async (req, res) => {
  const { action, artistName, pillar, listeners } = req.body;
  if (!action || !artistName) return res.status(400).json({ error: 'Missing fields' });

  if (!req.session.blockedArtists) req.session.blockedArtists = [];
  if (!req.session.pillarListenerCaps) req.session.pillarListenerCaps = {};

  switch (action) {
    case 'not-for-me':
      if (!req.session.blockedArtists.includes(artistName))
        req.session.blockedArtists.push(artistName);
      return res.json({ success: true });

    case 'too-mainstream': {
      if (!req.session.blockedArtists.includes(artistName))
        req.session.blockedArtists.push(artistName);
      if (pillar) {
        const DEFAULT = pillar === 'experimental' ? 150000 : 80000;
        const current = req.session.pillarListenerCaps[pillar] ?? DEFAULT;
        req.session.pillarListenerCaps[pillar] = Math.max(10000, current - 15000);
      }
      return res.json({ success: true, newCap: req.session.pillarListenerCaps[pillar] });
    }

    case 'weirder': {
      if (!req.session.blockedArtists.includes(artistName))
        req.session.blockedArtists.push(artistName);
      if (pillar) {
        const DEFAULT = pillar === 'experimental' ? 150000 : 80000;
        const current = req.session.pillarListenerCaps[pillar] ?? DEFAULT;
        req.session.pillarListenerCaps[pillar] = Math.max(5000, current - 20000);
      }
      return res.json({ success: true, newCap: req.session.pillarListenerCaps[pillar] });
    }

    case 'more-like-this': {
      // Expand: walk similarity from this artist and return 3 new tracks
      try {
        const token = await spotify.getValidToken(req.session);
        const heardTrackIds = new Set(req.session.heardTrackIds || []);
        const listenedArtistIds = new Set(req.session.listenedArtistIds || []);
        const userTagWeights = req.session.userTagWeights || {};
        const blockedArtists = new Set((req.session.blockedArtists || []).map(n => n.toLowerCase()));

        const similarRaw = await lastfm.getSimilarArtists(artistName, 40);
        const known = new Set([...(req.session.listenedArtistIds || [])]);

        const candidates = similarRaw.filter(({ name }) => !blockedArtists.has(name.toLowerCase()));
        const infos = await Promise.all(candidates.slice(0, 25).map(c => lastfm.getArtistInfoWithCollabFallback(c.name)));

        const cap = listeners ? Math.max(listeners, 10000) : (req.session.pillarListenerCaps?.[pillar] ?? 80000);
        const scored = candidates
          .map((c, i) => {
            const info = infos[i];
            if (!info || info.listeners > cap || info.listeners < 50) return null;
            const score = (info.tags || []).reduce((s, t) => s + (userTagWeights[t] || 0), 0);
            return { ...c, pillar, lfmInfo: info, score, seedNames: [artistName], overlappingTags: [] };
          })
          .filter(Boolean)
          .sort((a, b) => b.score - a.score)
          .slice(0, 15);

        const searches = await Promise.all(
          scored.map(c =>
            spotify.searchTracks(token, `artist:"${c.name}"`, 10, 0)
              .then(tracks => ({ c, tracks })).catch(() => ({ c, tracks: [] }))
          )
        );

        const results = [];
        const { generateSpecificBlurb: gsb, assignSceneTag: ast, formatListeners: fl } = require('../lib/algorithm');
        const seedInfoMap = new Map(Object.entries(req.session.lfmSeedInfos || {}));

        for (const { c, tracks } of searches) {
          if (results.length >= 3) break;
          const nameLow = c.name.toLowerCase();
          if (blockedArtists.has(nameLow)) continue;
          const byArtist = tracks.filter(t => (t.artists || []).some(a => a.name.toLowerCase() === nameLow));
          const pool2 = byArtist.length ? byArtist : tracks.slice(0, 3);
          if (!pool2.length) continue;
          const track = pool2.find(t => !heardTrackIds.has(t.id)) || pool2[0];
          const spotifyArtist = (track.artists || []).find(a => a.name.toLowerCase() === nameLow) || track.artists?.[0];
          if (!spotifyArtist) continue;
          let previewUrl = track.preview_url;
          if (!previewUrl) { try { const ft = await spotify.getTrack(token, track.id); previewUrl = ft.preview_url || null; } catch {} }
          const tags = c.lfmInfo?.tags || [];
          results.push({
            id: track.id, uri: track.uri, name: track.name,
            artist: c.name, artistId: spotifyArtist.id, album: track.album?.name || '',
            albumArt: track.album?.images?.[0]?.url || c.lfmInfo?.image || null,
            previewUrl: previewUrl || null,
            popularityLabel: fl(c.lfmInfo?.listeners),
            spotifyUrl: track.external_urls?.spotify || '',
            artistSpotifyUrl: spotifyArtist.external_urls?.spotify || '',
            genres: tags, sceneTag: ast(tags),
            whyBlurb: gsb(tags, seedInfoMap, [artistName]),
            listeners: c.lfmInfo?.listeners || 0, pillar, deepCut: false,
            overlappingTags: [], seedNames: [artistName], expanded: true
          });
        }
        return res.json({ success: true, tracks: results });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    default:
      return res.status(400).json({ error: 'Unknown action' });
  }
});

// Feedback endpoint — adjust tag weights based on like/dislike in scroll mode
router.post('/feedback', requireAuth, (req, res) => {
  const { tags = [], action } = req.body;
  if (!['like', 'dislike'].includes(action)) return res.status(400).json({ error: 'Invalid action' });

  const weights = req.session.userTagWeights || {};
  const delta = action === 'like' ? 0.05 : -0.03;
  tags.forEach(tag => {
    weights[tag] = Math.max(0, Math.min(0.5, (weights[tag] || 0) + delta));
  });
  req.session.userTagWeights = weights;

  if (!req.session.feedbackCounts) req.session.feedbackCounts = { likes: 0, dislikes: 0 };
  req.session.feedbackCounts[action === 'like' ? 'likes' : 'dislikes']++;

  res.json({ success: true, counts: req.session.feedbackCounts });
});

// Save all shown tracks to a new playlist
router.post('/playlist', requireAuth, async (req, res) => {
  try {
    const { trackUris, name } = req.body;
    if (!trackUris?.length) return res.status(400).json({ error: 'No tracks provided.' });

    const token = await spotify.getValidToken(req.session);
    const userId = req.session.userId;
    if (!userId) return res.status(400).json({ error: 'User ID missing — load profile first.' });

    const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const playlistName = name || `Digger Finds – ${date}`;

    const playlist = await spotify.createPlaylist(
      token, userId, playlistName,
      'Underground discoveries curated by Digger 🪲'
    );
    await spotify.addTracksToPlaylist(token, playlist.id, trackUris);

    res.json({ success: true, playlistUrl: playlist.external_urls.spotify });
  } catch (err) {
    handleSpotifyError(err, res);
  }
});

// Save a single track — creates/reuses the session playlist
router.post('/playlist/track', requireAuth, async (req, res) => {
  try {
    const { trackUri } = req.body;
    if (!trackUri) return res.status(400).json({ error: 'No track URI provided.' });

    const token = await spotify.getValidToken(req.session);
    const userId = req.session.userId;
    if (!userId) return res.status(400).json({ error: 'User ID missing — load profile first.' });

    // Create the playlist once per session, then reuse it
    if (!req.session.currentPlaylistId) {
      const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const playlist = await spotify.createPlaylist(
        token, userId, `Digger Finds – ${date}`,
        'Underground discoveries curated by Digger 🪲'
      );
      req.session.currentPlaylistId = playlist.id;
      req.session.currentPlaylistUrl = playlist.external_urls.spotify;
    }

    await spotify.addTracksToPlaylist(token, req.session.currentPlaylistId, [trackUri]);

    res.json({ success: true, playlistUrl: req.session.currentPlaylistUrl });
  } catch (err) {
    handleSpotifyError(err, res);
  }
});

module.exports = router;
