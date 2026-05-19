// Discovery algorithm for underground music recommendations.
// Uses Last.fm artist similarity and Spotify cross-reference instead of
// Spotify's deprecated /recommendations endpoint.

const CALIBRATION_SEEDS = [
  'Damon r.', 'MGNA Crrrta', 'The Hellp', 'Bassvictim', 'nate sib', 'Saska', 'tonser',
  'Somewhere Special', 'Suzy Sheer', 'DRES', 'heffy', 'Club Eat', 'Perto', 'anna luna',
  'Garett Caramel', 'Extra Small', 'The Twins', 'Brothel in Belize', 'The Bird',
  'SILICONE VALLEY', '80gawd', 'Amy', 'Dalhaus', 'The Truth', 'Gift Exchange',
  'D3SIST', 'The Femcels', 'Tommy Fleece', 'fakemink', 'velvette blue',
  'Cameron Winter', 'underscores', 'Frost Children', '2hollis', 'Snow Strippers'
];

/**
 * Aggregate top artists across time ranges into a weighted list.
 * short_term counts 3×, medium_term 2×, long_term 1×.
 */
function weightedArtistList(shortArtists, mediumArtists, longArtists) {
  const map = new Map();
  const add = (artists, weight) => {
    artists.forEach(artist => {
      if (!map.has(artist.id)) map.set(artist.id, { artist, weight: 0 });
      map.get(artist.id).weight += weight;
    });
  };
  add(shortArtists, 3);
  add(mediumArtists, 2);
  add(longArtists, 1);
  return [...map.values()].sort((a, b) => b.weight - a.weight);
}

/**
 * Build a taste profile from weighted artists.
 * Audio features are optional (Spotify restricted that endpoint in 2024).
 */
function buildTasteProfile(weightedArtists, audioFeatures = []) {
  // Count genre occurrences weighted by artist weight
  const genreWeights = {};
  weightedArtists.forEach(({ artist, weight }) => {
    (artist.genres || []).forEach(genre => {
      genreWeights[genre] = (genreWeights[genre] || 0) + weight;
    });
  });

  const topGenres = Object.entries(genreWeights)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([genre]) => genre);

  // Audio features — may be empty if endpoint is restricted
  const valid = audioFeatures.filter(Boolean);
  const hasAudioFeatures = valid.length > 0;

  const avg = { danceability: 0, energy: 0, valence: 0, tempo: 0, acousticness: 0, instrumentalness: 0, speechiness: 0 };
  if (hasAudioFeatures) {
    valid.forEach(f => {
      Object.keys(avg).forEach(k => { avg[k] += f[k] || 0; });
    });
    Object.keys(avg).forEach(k => {
      avg[k] = Math.round((avg[k] / valid.length) * 100) / 100;
    });
  }

  const moodLabel = hasAudioFeatures
    ? describeMood(avg.valence, avg.energy, avg.danceability, avg.acousticness, avg.instrumentalness)
    : describeMoodFromGenres(topGenres);

  const tempoLabel = hasAudioFeatures ? describeTempo(avg.tempo) : null;

  return {
    topGenres,
    avgFeatures: avg,
    hasAudioFeatures,
    moodLabel,
    tempoLabel,
    topArtistIds: weightedArtists.slice(0, 5).map(w => w.artist.id),
    topArtistNames: weightedArtists.slice(0, 10).map(w => w.artist.name)
  };
}

function describeMood(valence, energy, danceability = 0.5, acousticness = 0.5, instrumentalness = 0) {
  if (energy > 0.7  && danceability > 0.7)   return 'high-energy & danceable';
  if (energy > 0.7  && danceability < 0.5)   return 'intense & driven';
  if (energy < 0.5  && valence < 0.4)        return 'dark & introspective';
  if (energy < 0.5  && acousticness > 0.6)   return 'quiet & acoustic';
  if (instrumentalness > 0.5)                return 'instrumental-leaning';
  if (valence > 0.65 && energy > 0.65)       return 'upbeat & energetic';
  if (valence > 0.65 && energy < 0.4)        return 'feel-good & mellow';
  if (valence < 0.35 && energy > 0.65)       return 'intense & dark';
  if (valence < 0.35 && energy < 0.4)        return 'melancholic & introspective';
  return 'eclectic & wide-ranging';
}

// Derive mood from genre tags when audio features are unavailable
function describeMoodFromGenres(genres) {
  const g = genres.join(' ').toLowerCase();
  if (/metal|hardcore|grindcore|noise|heavy/.test(g)) return 'intense & hard-hitting';
  if (/ambient|drone|post.rock|shoegaze|dream/.test(g)) return 'atmospheric & textured';
  if (/dance|edm|house|techno|club|electronic/.test(g)) return 'high-energy & danceable';
  if (/folk|acoustic|singer.songwriter|bluegrass/.test(g)) return 'intimate & acoustic';
  if (/jazz|blues|bossa|soul|gospel/.test(g)) return 'soulful & expressive';
  if (/hip.?hop|rap|trap|drill/.test(g)) return 'rhythmic & lyrical';
  if (/r.?b|neo.?soul|funk/.test(g)) return 'smooth & groove-forward';
  if (/punk|emo|post.punk/.test(g)) return 'raw & emotionally charged';
  if (/indie|alternative|art.rock/.test(g)) return 'indie & eclectic';
  return 'eclectic & wide-ranging';
}

function describeTempo(tempo) {
  if (tempo > 145) return 'fast-paced';
  if (tempo > 115) return 'mid-tempo';
  if (tempo > 85)  return 'moderate';
  return 'slow & deliberate';
}

// Tags that are listener opinions or demographics, not genre markers
const NOISE_TAGS = new Set([
  'seen live', 'albums i own', 'under 2000 listeners', 'beautiful', 'favorite',
  'favourite', 'favorites', 'favourites', 'all', 'epic', 'chill', 'sad', 'happy',
  'female vocalists', 'male vocalists', 'american', 'british', 'english', 'canadian',
  'dutch', 'swedish', 'german', 'australian', 'japanese', 'french', 'norwegian',
  'icelandic', 'irish', 'scottish', 'welsh', '00s', '90s', '80s', '70s', '60s',
  '2000s', '1990s', '1980s', '1970s', 'spotify', 'youtube', 'bandcamp', 'soundcloud'
]);

// Known aliases — finding these is not discovery
const ALIAS_BLOCKLIST = new Set([
  'afx', 'caustic window', 'polygon window', 'the tuss', 'bradley strider',
  'analord', 'power-pill', 'q-chastic', 'soit marrant', 'mike & rich',
  'universal indicator', 'blue calx', 'smojphace',
  'µ-ziq' // mike paradinas collab alias
].map(s => s.toLowerCase()));

// Tags that immediately disqualify a candidate if they are the TOP tag
const BLOCKED_TOP_TAGS = new Set([
  'finnish pop', 'finnish', 'suomi', 'schlager', 'europop', 'eurodance',
  'italo disco', 'hi-nrg', 'adult contemporary', 'chanson',
  'classical', 'opera', 'jazz', 'country', 'reggae', 'latin', 'k-pop', 'j-pop'
]);

// These tags are conditional: block unless artist ALSO has a redeeming indie/experimental tag
const CONDITIONAL_BLOCK_TAGS = new Set(['80s', 'new wave', 'synth-pop', 'synthpop']);
const REDEEMING_TAGS = new Set([
  'indie', 'experimental', 'electronic', 'post-punk', 'shoegaze',
  'dream pop', 'noise', 'lo-fi', 'bedroom pop', 'alternative'
]);

function checkTagBlocklist(tags) {
  if (!tags || !tags.length) return null; // no tags = not blocked
  const topTag = tags[0]?.toLowerCase();
  if (BLOCKED_TOP_TAGS.has(topTag)) return `Blocked top tag: ${topTag}`;
  const hasConditional = tags.some(t => CONDITIONAL_BLOCK_TAGS.has(t.toLowerCase()));
  if (hasConditional) {
    const hasRedeeming = tags.some(t => REDEEMING_TAGS.has(t.toLowerCase()));
    if (!hasRedeeming) return `Blocked: ${tags.find(t => CONDITIONAL_BLOCK_TAGS.has(t.toLowerCase()))} without indie/experimental`;
  }
  return null; // not blocked
}

// Pillar definitions — each runs its own similarity-graph walk and has its own quota
const PILLARS = {
  introspective: {
    label: '🌿 Sounds Like Your Introspective Side',
    subtitle: 'From your folk, indie & bedroom pop favorites',
    quota: 5,
    calibSeeds: ['Cameron Winter', 'Saska', 'Somewhere Special', 'anna luna', 'velvette blue',
                 'Garett Caramel', 'Extra Small', 'The Bird', 'nate sib', 'Brothel in Belize']
  },
  rock: {
    label: '🎸 Sounds Like Your Rock Side',
    subtitle: 'From your indie rock, punk & emo favorites',
    quota: 4,
    calibSeeds: ['underscores', 'Frost Children', 'D3SIST', 'The Femcels', 'Gift Exchange',
                 'The Twins', 'The Truth', '2hollis']
  },
  experimental: {
    label: '🧠 Sounds Like Your Experimental Side',
    subtitle: 'From your ambient, IDM & experimental favorites',
    quota: 3,
    // extraSeeds: walked for discovery but never shown as results (too popular / well-known)
    extraSeeds: ['Boards of Canada', 'Autechre', 'Burial', 'Four Tet'],
    calibSeeds: ['Damon r.', 'MGNA Crrrta', 'The Hellp', 'Suzy Sheer', 'Dalhaus']
  },
  electronic: {
    label: '🌀 Sounds Like Your Electronic Side',
    subtitle: 'From your electronic & club music favorites',
    quota: 4,
    calibSeeds: ['Bassvictim', 'Snow Strippers', 'tonser', 'Club Eat', 'SILICONE VALLEY',
                 'DRES', 'heffy', 'Perto']
  },
  hiphop: {
    label: '🎵 Sounds Like Your Hip-Hop Side',
    subtitle: 'From your rap & hip-hop favorites',
    quota: 2,
    calibSeeds: ['80gawd', 'Tommy Fleece', 'fakemink', 'Amy']
  }
};

// Classify an artist to a taste pillar using their Last.fm tags.
// Returns pillar id string, or null if no pillar matches.
function classifyArtistToPillar(tags) {
  const t = new Set((tags || []).map(s => s.toLowerCase()));
  const has = (...keys) => keys.some(k => t.has(k));
  if (has('idm', 'ambient', 'drone', 'glitch', 'electroacoustic', 'braindance',
          'microsound', 'musique concrete', 'noise music', 'sound art')) return 'experimental';
  if (has('indie folk', 'folk', 'singer-songwriter', 'bedroom pop', 'indie pop',
          'acoustic', 'freak folk', 'chamber pop', 'emo folk', 'bedroom indie',
          'lo-fi', 'lo fi', 'shoegaze', 'dream pop')) return 'introspective';
  if (has('post-punk', 'post punk', 'punk', 'indie rock', 'noise rock', 'emo',
          'alternative', 'grunge', 'post-rock', 'math rock', 'hardcore',
          'midwest emo', 'skramz', 'noise pop', 'alt-emo', 'slacker rock')) return 'rock';
  if (has('hip-hop', 'hip hop', 'rap', 'trap', 'cloud rap', 'phonk', 'boom bap',
          'uk hip hop', 'underground hip hop')) return 'hiphop';
  if (has('electronic', 'electro', 'dance', 'edm', 'house', 'techno', 'club',
          'hyperpop', 'digicore', 'electropop', 'electroclash', 'indietronica',
          'synthpop', 'synth-pop', 'trance', 'chillwave', 'vaporwave')) return 'electronic';
  return null;
}

// Map Last.fm tags to a scene category using Set membership (not joined-string regex)
// Returns null when no specific scene applies — the UI skips the badge.
function assignSceneTag(tags) {
  const t = new Set(tags.map(s => s.toLowerCase()));
  const has = (...keys) => keys.some(k => t.has(k));

  if (has('hyperpop', 'digicore', 'bubblegum bass', 'glitchcore', 'pc music', 'nightcore')) return 'Hyperpop-Adjacent';
  if (has('midwest emo', 'skramz', 'screamo', 'emo', 'alt-emo', 'indie emo')) return 'Alt-Emo';
  if (has('post-punk', 'post punk', 'cold wave', 'dark wave', 'gothic rock', 'goth', 'new wave')) return 'Post-Punk';
  if (has('shoegaze', 'shoegazing', 'dream pop', 'noise pop')) return 'Indie Sleaze';
  if (has('bedroom pop', 'slacker rock', 'bedroom indie', 'lo-fi indie', 'lo fi indie')) return 'Bedroom Pop';
  if (has('lo-fi', 'lo fi', 'noise rock', 'experimental rock')) return 'Lo-Fi Experimental';
  if (has('idm', 'electronica', 'ambient', 'drone', 'chillwave', 'synthpop', 'synth pop', 'vaporwave', 'vapor soul', 'glitch')) return 'Ambient/Electronic';
  if (has('experimental', 'avant-garde', 'avant garde', 'musique concrete')) return 'Lo-Fi Experimental';
  if (has('post-internet', 'internet music')) return 'Post-Internet';
  if (has('cloud rap', 'plugg', 'digicore', 'rage', 'phonk')) return 'Underground Hip-Hop';
  return null; // No badge — better than a wrong badge
}

// Generate a blurb that names the actual overlapping tags and the seeds they came from.
// Format: "Tagged bedroom pop and noise pop like your Alex G and Title Fight listening."
function generateSpecificBlurb(candidateTags, seedInfoMap, connectedSeedNames) {
  // Filter out noise tags from the candidate's tags
  const cleanTags = candidateTags.filter(t => !NOISE_TAGS.has(t.toLowerCase()));

  // Build: tag → which seeds also have this tag
  const tagToSeeds = {};
  for (const seedName of connectedSeedNames) {
    const info = seedInfoMap.get(seedName);
    if (!info) continue;
    const seedTagsClean = info.tags.filter(t => !NOISE_TAGS.has(t.toLowerCase()));
    for (const tag of cleanTags) {
      if (seedTagsClean.includes(tag)) {
        if (!tagToSeeds[tag]) tagToSeeds[tag] = new Set();
        tagToSeeds[tag].add(seedName);
      }
    }
  }

  // Sort overlapping tags: more seeds sharing it = more important
  const overlapping = Object.entries(tagToSeeds)
    .sort(([, a], [, b]) => b.size - a.size)
    .slice(0, 3);

  if (!overlapping.length) {
    const fallback = connectedSeedNames[0];
    return fallback ? `In the same underground orbit as ${fallback}.` : 'A hidden gem well below the mainstream radar.';
  }

  const tagNames = overlapping.map(([tag]) => tag);
  const involvedSeeds = [...new Set(overlapping.flatMap(([, s]) => [...s]))].slice(0, 2);

  const tagStr = tagNames.length === 1
    ? tagNames[0]
    : `${tagNames.slice(0, -1).join(', ')} and ${tagNames[tagNames.length - 1]}`;

  const seedStr = involvedSeeds.join(' and ');

  return `Tagged ${tagStr} like your ${seedStr} listening.`;
}

function formatListeners(n) {
  if (!n && n !== 0) return null;
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M listeners`;
  if (n >= 1000) return `${Math.round(n / 1000)}k listeners`;
  return `${n} listeners`;
}

module.exports = {
  weightedArtistList,
  buildTasteProfile,
  assignSceneTag,
  generateSpecificBlurb,
  formatListeners,
  checkTagBlocklist,
  classifyArtistToPillar,
  ALIAS_BLOCKLIST,
  NOISE_TAGS,
  CALIBRATION_SEEDS,
  BLOCKED_TOP_TAGS,
  PILLARS
};
