/* ── Digger frontend ─────────────────────────────────────── */

const $ = id => document.getElementById(id);

// ── State ─────────────────────────────────────────────────
const state = {
  recommendations: [],
  digMode: 'underground',
  recsRequestId: 0,
  recsLoading: false,
  currentAudio: null,
  currentPlayBtn: null,
  savedUris: new Set()
};

const DIG_MODES = {
  surface: {
    label: 'Surface',
    subtitle: 'surface — broader underground filter'
  },
  underground: {
    label: 'Underground',
    subtitle: 'underground — mainstream filtered out'
  },
  'deep-cut': {
    label: 'Deep Cut',
    subtitle: 'deep cut — lower listener cap active'
  },
  micro: {
    label: 'Micro',
    subtitle: 'micro — smallest-scene filter active'
  }
};

// ── Routing ───────────────────────────────────────────────
async function init() {
  const params = new URLSearchParams(location.search);
  const errorCode = params.get('error');

  if (errorCode) {
    showView('landing');
    const banner = $('error-banner');
    banner.textContent = friendlyError(errorCode);
    banner.classList.remove('hidden');
    return;
  }

  let authStatus;
  try {
    const res = await fetch('/auth/status');
    authStatus = await res.json();
  } catch {
    showView('landing');
    return;
  }

  if (!authStatus.authenticated) {
    showView('landing');
    return;
  }

  showView('app');
  loadProfile();
}

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  $(`view-${name}`).classList.remove('hidden');
}

function friendlyError(code) {
  const map = {
    access_denied: 'You declined Spotify access. Click below to try again.',
    state_mismatch: 'Security check failed. Please try logging in again.',
    token_exchange_failed: 'Couldn\'t connect to Spotify. Please try again.'
  };
  return map[code] || 'Something went wrong. Please try again.';
}

function handle401(err) {
  if (!err) return false;
  const msg = typeof err === 'string' ? err : (err.error || '');
  if (msg === 'Not authenticated' || msg.includes('log in again')) {
    showToast('Session expired — logging back in…');
    setTimeout(() => { window.location.href = '/auth/login'; }, 2200);
    return true;
  }
  return false;
}

// ── Profile load ──────────────────────────────────────────
async function loadProfile() {
  setLoading('Digging into your Spotify history…');

  let profileData;
  try {
    const res = await fetch('/api/profile');
    if (!res.ok) throw await res.json();
    profileData = await res.json();
  } catch (err) {
    showError(err.error || 'Failed to load your profile.');
    return;
  }

  renderUser(profileData.user);
  renderTasteProfile(profileData.tasteProfile);
  if (profileData.topTracks?.length) renderTopTracks(profileData.topTracks);
  showMainContent();

  loadRecommendations();
}

function renderUser({ name, image }) {
  if (name) $('user-name').textContent = name;
  if (image) {
    const avatar = $('user-avatar');
    avatar.src = image;
    avatar.alt = name || 'User';
  }
  $('header-user').classList.remove('hidden');
}

function renderTasteProfile(profile) {
  const { moodLabel, tempoLabel, avgFeatures, topGenres, hasAudioFeatures, topArtistNames } = profile;

  let moodDesc = `Your sound is <span>${moodLabel}</span>`;
  if (tempoLabel) moodDesc += ` and ${tempoLabel}`;
  moodDesc += '.';
  $('profile-mood').innerHTML = moodDesc;

  if (hasAudioFeatures) {
    const statsConfig = [
      { label: 'Energy',       value: avgFeatures.energy,       format: pct },
      { label: 'Danceability', value: avgFeatures.danceability,  format: pct },
      { label: 'Mood',         value: avgFeatures.valence,       format: pct },
      { label: 'Acousticness', value: avgFeatures.acousticness,  format: pct },
      { label: 'Tempo',        value: avgFeatures.tempo,         format: v => `${Math.round(v)} BPM`, noBar: true }
    ];
    $('profile-stats').innerHTML = statsConfig.map(({ label, value, format, noBar }) => `
      <div class="stat-pill">
        <span class="stat-label">${label}</span>
        ${!noBar ? `<div class="stat-bar"><div class="stat-bar-fill" style="width:${value * 100}%"></div></div>` : ''}
        <span class="stat-value">${format(value)}</span>
      </div>
    `).join('');
  } else {
    $('profile-stats').innerHTML = '';
  }

  const tags = topGenres.length
    ? topGenres.slice(0, 8).map((g, i) => `<span class="genre-tag ${i >= 4 ? 'muted' : ''}">${g}</span>`)
    : (topArtistNames || []).slice(0, 8).map((n, i) => `<span class="genre-tag ${i >= 5 ? 'muted' : ''}">${n}</span>`);

  $('profile-genres').innerHTML = tags.join('');
}

function renderTopTracks(tracks) {
  const container = $('profile-top-tracks');
  if (!container) return;
  container.innerHTML = tracks.map(t => `
    <a class="top-track-pill" href="${esc(t.spotifyUrl)}" target="_blank" title="${esc(t.name)} — ${esc(t.artist)}">
      ${t.albumArt ? `<img class="top-track-art" src="${esc(t.albumArt)}" alt="" />` : '<div class="top-track-art"></div>'}
      <span class="top-track-info">
        <span class="top-track-name">${esc(t.name)}</span>
        <span class="top-track-artist">${esc(t.artist)}</span>
      </span>
    </a>
  `).join('');
  container.parentElement?.classList.remove('hidden');
}

const pct = v => `${Math.round(v * 100)}%`;

// ── Recommendations ───────────────────────────────────────
async function loadRecommendations(mode = state.digMode, isRetry = false) {
  state.digMode = DIG_MODES[mode] ? mode : 'underground';
  const requestId = ++state.recsRequestId;
  stopAudio();

  state.recommendations = [];
  $('recs-tiers').innerHTML = '';
  $('recs-micro').innerHTML = '';
  $('recs-micro').classList.add('hidden');
  $('recs-empty').classList.add('hidden');
  $('recs-empty').querySelector('p').textContent = 'Nothing surfaced at this depth.';
  setDigModeUI(state.digMode);
  setRecsLoading(true);

  let data;
  try {
    const res = await fetch(`/api/recommendations?mode=${encodeURIComponent(state.digMode)}`);
    if (!res.ok) {
      const errData = await res.json();
      if (res.status === 401) { handle401(errData); return; }
      if (errData.error === 'profile_expired' && !isRetry) {
        $('recs-subtitle').textContent = 'Re-connecting…';
        await fetch('/api/profile');
        return loadRecommendations(mode, true);
      }
      throw errData;
    }
    data = await res.json();
  } catch (err) {
    if (requestId !== state.recsRequestId) return;
    if (handle401(err)) return;
    showRecommendationError(err.error || 'Failed to fetch recommendations.');
    setRecsLoading(false);
    return;
  }

  if (requestId !== state.recsRequestId) return;
  setRecsLoading(false);
  state.recommendations = data.recommendations || [];
  updateRecsHeader(data);

  const tiers = data.tiers || [];
  const totalTracks = tiers.reduce((s, t) => s + t.tracks.length, 0);

  if (!totalTracks && !data.microUnderground?.length) {
    $('recs-empty').classList.remove('hidden');
    updateRecommendationActions();
    return;
  }

  let html = '';

  if (data.mostUnexpectedMatch) {
    html += unexpectedMatchHTML(data.mostUnexpectedMatch);
  }

  // Scene DNA strip
  if (data.sceneAnchors?.length) {
    html += sceneDNAHTML(data.sceneAnchors);
  }

  html += tiers
    .filter(t => t.tracks.length > 0)
    .map(tier => tierSectionHTML(tier))
    .join('');

  $('recs-tiers').innerHTML = html;

  if (data.microUnderground?.length) {
    $('recs-micro').innerHTML = microUndergroundHTML(data.microUnderground);
    $('recs-micro').classList.remove('hidden');
  }

  attachCardListeners();
  if (data.debugInfo) renderDebugPanel(data.debugInfo, data.tiers);
  updateRecommendationActions();
}

function updateRecsHeader(data = {}) {
  const mode = data.mode || state.digMode;
  $('recs-subtitle').textContent = data.modeSubtitle || DIG_MODES[mode]?.subtitle || DIG_MODES.underground.subtitle;
}

function setDigModeUI(mode = state.digMode) {
  document.querySelectorAll('.dig-mode-btn').forEach(btn => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function setDigControlsLoading(on) {
  document.querySelectorAll('.dig-mode-btn').forEach(btn => {
    btn.disabled = on;
  });
}

function updateRecommendationActions() {
  const hasRecs = state.recommendations.length > 0;
  $('btn-save-all').disabled = state.recsLoading || !hasRecs;
  $('btn-scroll-mode').disabled = state.recsLoading || !hasRecs;
  $('btn-dig-again').disabled = state.recsLoading;
}

const LOADING_COPY = [
  'Digging...', 'Crawling the underground...', 'Finding similar artists...',
  'Crossing genre lines...', 'Surfacing the obscure...', 'Almost there...'
];
let loadingCopyTimer = null;

function setRecsLoading(on) {
  state.recsLoading = on;
  setDigControlsLoading(on);
  updateRecommendationActions();
  if (on) {
    const skeletons = Array(6).fill(0).map(() => `
      <div class="skeleton-card">
        <div class="skeleton-art"></div>
        <div class="skeleton-lines">
          <div class="skeleton-line" style="width:42%"></div>
          <div class="skeleton-line" style="width:28%"></div>
          <div class="skeleton-line" style="width:60%"></div>
        </div>
      </div>`).join('');

    $('recs-tiers').innerHTML = `
      <div class="tier-section">
        <div class="tier-header"><div class="tier-skeleton-header"></div></div>
        <div class="recs-grid">${skeletons}</div>
      </div>`;

    let copyIdx = 0;
    $('recs-subtitle').textContent = LOADING_COPY[0];
    clearInterval(loadingCopyTimer);
    loadingCopyTimer = setInterval(() => {
      copyIdx = (copyIdx + 1) % LOADING_COPY.length;
      $('recs-subtitle').textContent = LOADING_COPY[copyIdx];
    }, 2200);
  } else {
    clearInterval(loadingCopyTimer);
  }
}

// ── Tier sections ─────────────────────────────────────────
function tierSectionHTML(tier) {
  return `
    <div class="tier-section" id="tier-${esc(tier.id)}">
      <div class="tier-header">
        <h3 class="tier-title">${esc(tier.label)}</h3>
        <div class="tier-rule"></div>
      </div>
      ${tier.subtitle ? `<p class="tier-subtitle">${esc(tier.subtitle)}</p>` : ''}
      <div class="recs-grid">
        ${tier.tracks.map(t => trackCardHTML(t)).join('')}
      </div>
    </div>`;
}

function microUndergroundHTML(artists) {
  return `
    <div class="tier-section tier-micro" id="tier-micro">
      <div class="tier-header">
        <h3 class="tier-title">micro-underground</h3>
        <div class="tier-rule"></div>
      </div>
      <p class="tier-subtitle">under 5k listeners — so deep they might not have a Wikipedia page yet</p>
      <div class="micro-grid">
        ${artists.map(a => microArtistHTML(a)).join('')}
      </div>
    </div>`;
}

// Unexpected match (cross-pillar bridge artist)
function unexpectedMatchHTML(match) {
  const pillarLabels = {
    introspective: 'introspective', rock: 'rock',
    experimental: 'experimental', electronic: 'electronic',
    hiphop: 'hip-hop', wildcard: 'wildcard'
  };
  const p1 = pillarLabels[match.pillars?.[0]] || (match.pillars?.[0] || '');
  const p2 = pillarLabels[match.pillars?.[1]] || (match.pillars?.[1] || '');
  const bridgeStr = p1 && p2 ? `${esc(p1)} × ${esc(p2)}` : '';
  return `
    <div class="unexpected-banner">
      <div class="unexpected-header">
        <span class="unexpected-label">⚡ unexpected match</span>
        ${bridgeStr ? `<span class="unexpected-bridge">${bridgeStr}</span>` : ''}
      </div>
      <div class="recs-grid">
        ${trackCardHTML(match.track)}
      </div>
    </div>`;
}

// Scene DNA strip
function sceneDNAHTML(anchors) {
  return `
    <div class="scene-dna">
      <div class="scene-dna-header">
        <span class="scene-dna-label">scene dna</span>
        <div class="scene-dna-rule"></div>
      </div>
      <div class="scene-dna-strip">
        ${anchors.map(a => `
          <button class="scene-dna-anchor btn-dna-expand"
            data-artist="${esc(a.name)}" data-pillar="${esc(a.pillar || '')}">
            <span class="scene-dna-name">${esc(a.name)}</span>
            <span class="scene-dna-meta">${a.seedCount}× · ${a.listeners >= 1e6 ? (a.listeners/1e6).toFixed(1)+'M' : Math.round(a.listeners/1000)+'k'}</span>
          </button>
        `).join('')}
      </div>
      <div class="dna-expand-results hidden"></div>
    </div>`;
}

function microArtistHTML(a) {
  const listenerStr = a.listeners < 1000
    ? `${a.listeners} listeners`
    : `${Math.round(a.listeners / 1000)}k listeners`;
  const rarityBadge = !a.spotifyTrack
    ? '<span class="micro-badge micro-badge-soundcloud">soundcloud only</span>'
    : a.listeners < 500
    ? '<span class="micro-badge micro-badge-buried">almost no one has heard this</span>'
    : a.listeners < 1000
    ? '<span class="micro-badge micro-badge-buried">buried find</span>'
    : '';
  const artHTML = a.spotifyTrack?.albumArt
    ? `<img class="micro-art" src="${esc(a.spotifyTrack.albumArt)}" alt="" />`
    : `<div class="micro-art-placeholder">${(a.name?.[0] || '?').toUpperCase()}</div>`;
  return `
    <div class="micro-card">
      ${artHTML}
      <div class="micro-body">
        <div class="micro-name">${esc(a.name)}</div>
        ${rarityBadge}
        <div class="micro-listeners">◎ ${esc(listenerStr)}</div>
        <div class="micro-tags">
          ${(a.tags || []).slice(0, 4).map(t => `<span class="track-genre-tag">${esc(t)}</span>`).join('')}
        </div>
        <div class="micro-actions">
          ${a.spotifyTrack ? `<a href="${esc(a.spotifyTrack.spotifyUrl)}" target="_blank" class="btn-micro">spotify ↗</a>` : ''}
          <a href="https://www.youtube.com/results?search_query=${encodeURIComponent(a.name + ' music')}" target="_blank" class="btn-micro">youtube ↗</a>
          <a href="https://soundcloud.com/search?q=${encodeURIComponent(a.name)}" target="_blank" class="btn-micro">soundcloud ↗</a>
        </div>
      </div>
    </div>`;
}

// ── Track card HTML ───────────────────────────────────────
function tagGradientColor(tags) {
  const t = (tags || []).join(' ').toLowerCase();
  if (/witch house/.test(t))           return '#0d0613';
  if (/idm|ambient|drone/.test(t))     return '#060e1a';
  if (/folk|indie|bedroom/.test(t))    return '#141008';
  if (/cloud rap|plugg|phonk/.test(t)) return '#0a0a0a';
  if (/hyperpop|digicore/.test(t))     return '#1a0620';
  if (/post.punk|shoegaze/.test(t))    return '#0c0c16';
  return '#131313';
}

function trackCardHTML(track) {
  const hasPreview = !!(track.previewUrl);
  const hasSpotify = !!(track.id);
  if (!hasPreview && !hasSpotify) return '';

  const listenersN = track.listeners || 0;
  const listenerClass = listenersN < 5000
    ? 'listener-micro'
    : listenersN < 100000
    ? 'listener-green'
    : '';
  const listenerDisplay = track.popularityLabel
    ? (listenersN < 5000 ? '◎ ' : '') + track.popularityLabel
    : '';

  const gradColor = tagGradientColor(track.genres);
  const initial = esc((track.artist?.[0] || '?').toUpperCase());

  const artHTML = `
    <div class="card-art-wrap">
      <div class="art-bg" style="background:${gradColor}">
        <span class="art-initial">${initial}</span>
      </div>
      ${track.albumArt
        ? `<img class="card-art" src="${esc(track.albumArt)}" alt="" loading="lazy" onerror="this.style.display='none'" />`
        : ''}
      ${hasPreview ? `
        <button class="card-play-btn" aria-label="Play preview">▶</button>
        <audio class="track-audio" src="${esc(track.previewUrl)}" preload="none"></audio>
      ` : ''}
    </div>`;


  return `
    <div class="track-card" data-id="${esc(track.id)}" data-uri="${esc(track.uri)}"
         data-artist="${esc(track.artist)}" data-pillar="${esc(track.pillar || '')}"
         data-listeners="${track.listeners || 0}">

      <div class="card-row">
        ${artHTML}
        <div class="card-body">
          <div class="card-top">
            <span class="card-artist-name">
              ${track.artistSpotifyUrl
                ? `<a href="${esc(track.artistSpotifyUrl)}" target="_blank">${esc(track.artist)}</a>`
                : esc(track.artist)}
            </span>
            ${listenerDisplay
              ? `<span class="card-listeners ${listenerClass}">${esc(listenerDisplay)}</span>`
              : ''}
          </div>
          <div class="card-track-name">${esc(track.name)}</div>
          ${track.whyBlurb
            ? `<div class="card-blurb">${esc(track.whyBlurb)}</div>`
            : ''}
        </div>
        <div class="card-actions">
          <button class="btn-track-save" data-uri="${esc(track.uri)}" title="Save to playlist">+</button>
          <a href="${esc(track.spotifyUrl)}" target="_blank"
             class="btn-track-open${!hasPreview ? ' no-preview' : ''}"
             title="${!hasPreview ? 'No preview — open in Spotify' : 'Open in Spotify'}">↗</a>
        </div>
      </div>

      <div class="card-reactions-wrap">
        <div class="card-reactions">
          <button class="reaction-btn" data-action="more-like-this">more like this</button>
          <button class="reaction-btn" data-action="too-mainstream">too mainstream</button>
          <button class="reaction-btn" data-action="weirder">go weirder</button>
          <button class="reaction-btn" data-action="not-for-me">not for me</button>
        </div>
      </div>
      <div class="expand-results hidden"></div>
    </div>`;
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Card event listeners ──────────────────────────────────
function attachCardListeners() {
  document.querySelectorAll('.card-play-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      toggleCardAudio(btn);
    });
  });

  document.querySelectorAll('.btn-track-save').forEach(btn => {
    if (state.savedUris.has(btn.dataset.uri)) markSaved(btn);
    btn.addEventListener('click', () => saveTrack(btn));
  });

  document.querySelectorAll('.reaction-btn').forEach(btn => {
    btn.addEventListener('click', () => handleCardReaction(btn));
  });

  document.querySelectorAll('.btn-dna-expand').forEach(btn => {
    btn.addEventListener('click', () => handleDNAExpand(btn));
  });

  // Tier title intersection animation — mark immediately if already in viewport
  document.querySelectorAll('.tier-title').forEach(el => {
    if (el.classList.contains('visible')) return;
    const rect = el.getBoundingClientRect();
    if (rect.top >= 0 && rect.bottom <= window.innerHeight) {
      el.classList.add('visible');
    } else {
      tierTitleObserver.observe(el);
    }
  });

  // Stagger card entrance animation
  document.querySelectorAll('#recs-tiers .track-card').forEach((card, i) => {
    card.style.setProperty('--i', i);
  });
}

// Card reaction handler
async function handleCardReaction(btn) {
  const card = btn.closest('.track-card');
  if (!card) return;
  const action = btn.dataset.action;
  const artistName = card.dataset.artist;
  const pillar = card.dataset.pillar;
  const listeners = parseInt(card.dataset.listeners || '0', 10);

  btn.disabled = true;
  btn.style.opacity = '0.4';

  try {
    const res = await fetch('/api/card-reaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, artistName, pillar, listeners, mode: state.digMode })
    });
    const data = await res.json();
    if (!res.ok) throw data;

    if (action === 'not-for-me' || action === 'too-mainstream' || action === 'weirder') {
      card.classList.add('card-dismissed');
      setTimeout(() => {
        card.style.maxHeight = '0';
        card.style.overflow = 'hidden';
        card.style.opacity = '0';
        setTimeout(() => card.remove(), 300);
      }, 200);
      const label = action === 'too-mainstream' ? 'cap lowered' : action === 'weirder' ? 'going deeper' : 'removed';
      showToast(label);
    } else if (action === 'more-like-this') {
      const expandDiv = card.querySelector('.expand-results');
      if (!expandDiv) return;
      if (data.tracks?.length) {
        expandDiv.innerHTML = `<p class="expand-label">more like ${esc(artistName)}</p>` +
          data.tracks.map(t => trackCardHTML(t)).join('');
        expandDiv.classList.remove('hidden');
        attachInlineCardListeners(expandDiv);
      } else {
        showToast('No more results for this artist');
        btn.disabled = false;
        btn.style.opacity = '1';
      }
    }
  } catch (err) {
    showToast(err.error || 'Reaction failed');
    btn.disabled = false;
    btn.style.opacity = '1';
  }
}

// Scene DNA expand
async function handleDNAExpand(btn) {
  const artistName = btn.dataset.artist;
  const pillar = btn.dataset.pillar;
  btn.style.opacity = '0.5';
  btn.disabled = true;
  try {
    const res = await fetch('/api/card-reaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'more-like-this', artistName, pillar, listeners: 200000, mode: state.digMode })
    });
    const data = await res.json();
    const resultDiv = btn.closest('.scene-dna')?.querySelector('.dna-expand-results');
    if (resultDiv && data.tracks?.length) {
      resultDiv.innerHTML = `<p class="expand-label">artists like ${esc(artistName)}</p>` +
        `<div class="recs-grid">${data.tracks.map(t => trackCardHTML(t)).join('')}</div>`;
      resultDiv.classList.remove('hidden');
      attachInlineCardListeners(resultDiv);
    } else {
      showToast('No results found');
    }
  } catch {
    showToast('Expand failed');
  }
  btn.style.opacity = '1';
  btn.disabled = false;
}

// Listeners for dynamically added inline cards
function attachInlineCardListeners(container) {
  container.querySelectorAll('.card-play-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); toggleCardAudio(btn); });
  });
  container.querySelectorAll('.btn-track-save').forEach(b => b.addEventListener('click', () => saveTrack(b)));
  container.querySelectorAll('.reaction-btn').forEach(b => b.addEventListener('click', () => handleCardReaction(b)));
}

// ── Audio playback ────────────────────────────────────────
function toggleCardAudio(btn) {
  const wrap = btn.closest('.card-art-wrap');
  const audio = wrap?.querySelector('.track-audio');
  if (!audio) return;

  if (state.currentAudio && state.currentAudio !== audio) {
    stopAudio();
  }

  if (audio.paused) {
    audio.volume = 0.8;
    audio.play().catch(() => {});
    btn.innerHTML = '<span class="card-eq"><i></i><i></i><i></i></span>';
    btn.classList.add('playing');
    state.currentAudio = audio;
    state.currentPlayBtn = btn;

    audio.onended = () => {
      audio.currentTime = 0;
      btn.innerHTML = '▶';
      btn.classList.remove('playing');
      state.currentAudio = null;
      state.currentPlayBtn = null;
    };
  } else {
    stopAudio();
  }
}

function stopAudio() {
  if (state.currentAudio) {
    state.currentAudio.pause();
    state.currentAudio.currentTime = 0;
    state.currentAudio = null;
  }
  if (state.currentPlayBtn) {
    state.currentPlayBtn.innerHTML = '▶';
    state.currentPlayBtn.classList.remove('playing');
    state.currentPlayBtn = null;
  }
}

// ── Section header observer ───────────────────────────────
const tierTitleObserver = new IntersectionObserver(entries => {
  entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); });
}, { threshold: 0.1 });

// ── Save track ────────────────────────────────────────────
async function saveTrack(btn) {
  if (btn.classList.contains('saved')) return;
  const uri = btn.dataset.uri;

  btn.textContent = '…';
  btn.disabled = true;

  try {
    const res = await fetch('/api/playlist/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackUri: uri })
    });
    const data = await res.json();
    if (!res.ok) throw data;

    state.savedUris.add(uri);
    markSaved(btn);
    showToast('Saved to your Digger playlist', data.playlistUrl);
  } catch (err) {
    if (handle401(err)) return;
    btn.textContent = '+';
    btn.disabled = false;
    showToast(err.error || 'Failed to save track');
  }
}

function markSaved(btn) {
  btn.textContent = '✓';
  btn.classList.add('saved');
  btn.disabled = true;
}

// ── Save all ──────────────────────────────────────────────
async function saveAll() {
  if (!state.recommendations.length) return;

  const btn = $('btn-save-all');
  const original = btn.textContent;
  btn.textContent = 'Creating…';
  btn.disabled = true;

  try {
    const trackUris = state.recommendations.map(t => t.uri);
    const res = await fetch('/api/playlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackUris })
    });
    const data = await res.json();
    if (!res.ok) throw data;

    state.recommendations.forEach(t => state.savedUris.add(t.uri));
    document.querySelectorAll('.btn-track-save').forEach(markSaved);

    showToast(`Saved ${trackUris.length} tracks to playlist`, data.playlistUrl);
    btn.textContent = '✓ Saved';
  } catch (err) {
    if (handle401(err)) return;
    showToast(err.error || 'Failed to create playlist');
    btn.textContent = original;
    btn.disabled = false;
  }
}

// ── Toast ─────────────────────────────────────────────────
let toastTimer;
function showToast(msg, link) {
  clearTimeout(toastTimer);
  const toast = $('toast');
  $('toast-msg').textContent = msg;
  const linkEl = $('toast-link');
  if (link) {
    linkEl.href = link;
    linkEl.classList.remove('hidden');
  } else {
    linkEl.classList.add('hidden');
  }
  toast.classList.remove('hidden');
  requestAnimationFrame(() => toast.classList.add('show'));
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.classList.add('hidden'), 300);
  }, 5000);
}

// ── Loading / error helpers ───────────────────────────────
function setLoading(label) {
  $('loading-label').textContent = label;
  $('loading-state').style.display = 'flex';
  $('main-content').classList.add('hidden');
}

function showMainContent() {
  $('loading-state').style.display = 'none';
  $('main-content').classList.remove('hidden');
}

function showError(msg) {
  $('loading-state').innerHTML = `
    <p style="color:var(--text-muted);text-align:center;max-width:380px;font-size:0.88rem">${esc(msg)}</p>
    <a href="/auth/logout" style="color:var(--green);margin-top:12px;font-size:0.82rem">Log in again</a>`;
}

function showRecommendationError(msg) {
  $('recs-tiers').innerHTML = '';
  $('recs-micro').innerHTML = '';
  $('recs-micro').classList.add('hidden');
  $('recs-empty').classList.remove('hidden');
  $('recs-empty').querySelector('p').textContent = msg;
  showToast(msg);
}

// ── Debug panel ──────────────────────────────────────────
function renderDebugPanel(info, tiers = []) {
  const panel = $('debug-panel');
  if (!panel) return;

  const tagRows = Object.entries(info.tagProfile || {})
    .sort(([, a], [, b]) => b - a)
    .slice(0, 20)
    .map(([tag, w]) => `<tr><td>${esc(tag)}</td><td>${(w * 100).toFixed(1)}%</td></tr>`)
    .join('');

  const rejectedRows = (info.rejected || [])
    .map(r => `<tr><td>${esc(r.name)}</td><td>Hop ${r.hop || '?'}</td><td>${esc(r.reason)}</td></tr>`)
    .join('');

  const allRecs = tiers.flatMap(t => t.tracks || []);
  const recsRows = allRecs.map(t => `<tr>
    <td>${esc(t.artist)}</td>
    <td>${esc(t.pillar || '—')}</td>
    <td>${t.listeners?.toLocaleString() || '—'}</td>
    <td>${(t.overlappingTags || []).slice(0, 3).join(', ') || '—'}</td>
  </tr>`).join('');

  const genreRows = Object.entries(info.genreDistribution || {})
    .filter(([, v]) => v && v !== '0%')
    .map(([k, v]) => `<tr><td>${esc(k.replace(/_/g, '/'))}</td><td>${esc(String(v))}</td></tr>`)
    .join('');

  const slotRows = Object.entries(info.slotAllocation || {})
    .map(([k, v]) => `<tr><td>${esc(k.replace(/_/g, '/'))}</td><td>${v} slots</td></tr>`)
    .join('');

  const capRows = Object.entries(info.activeCaps || {})
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${Number(v).toLocaleString()} listeners</td></tr>`)
    .join('');

  panel.innerHTML = `
    <div class="debug-section">
      <strong>Seeds</strong>
      <p>${(info.seeds || []).map(s => `<code>${esc(s)}</code>`).join(' ')}</p>
    </div>
    <div class="debug-section">
      <strong>Pipeline (per pillar: candidates → scored → final)</strong>
      ${['introspective','rock','experimental','electronic','hiphop'].map(p => `
        <p>${p}: ${info[p+'Candidates'] ?? '—'} → ${info[p+'Scored'] ?? '—'} → ${info[p+'Final'] ?? '—'}</p>
      `).join('')}
      <p>Wildcard: ${info.wildcardFinal ?? '—'} shown</p>
      <p>Micro-underground: ${info.finalMicro ?? '—'} shown</p>
      <p>Mode: ${esc(info.modeLabel || info.mode || 'Underground')}</p>
    </div>
    ${capRows ? `
    <div class="debug-section">
      <strong>Active listener caps</strong>
      <table class="debug-table"><tr><th>Pillar</th><th>Cap</th></tr>${capRows}</table>
    </div>` : ''}
    ${genreRows ? `
    <div class="debug-section">
      <strong>Listening distribution</strong>
      <table class="debug-table"><tr><th>Bucket</th><th>Share</th></tr>${genreRows}</table>
    </div>` : ''}
    ${slotRows ? `
    <div class="debug-section">
      <strong>Slots allocated</strong>
      <table class="debug-table"><tr><th>Bucket</th><th>Slots</th></tr>${slotRows}</table>
    </div>` : ''}
    ${recsRows ? `
    <div class="debug-section">
      <strong>Recommendations</strong>
      <table class="debug-table"><tr><th>Artist</th><th>Pillar</th><th>Listeners</th><th>Matching tags</th></tr>${recsRows}</table>
    </div>` : ''}
    ${tagRows ? `
    <div class="debug-section">
      <strong>Tag profile (top 20)</strong>
      <table class="debug-table"><tr><th>Tag</th><th>Weight</th></tr>${tagRows}</table>
    </div>` : ''}
    ${rejectedRows ? `
    <div class="debug-section">
      <strong>Rejected (${(info.rejected || []).length})</strong>
      <table class="debug-table"><tr><th>Artist</th><th>Hop</th><th>Reason</th></tr>${rejectedRows}</table>
    </div>` : ''}
  `;
  $('debug-wrap').classList.remove('hidden');
}

// ── Scroll Mode ───────────────────────────────────────────
const scrollState = {
  likes: 0,
  dislikes: 0,
  observer: null,
  activeAudio: null
};

function enterScrollMode() {
  const tracks = state.recommendations.filter(t => t.id && t.uri);
  if (!tracks.length) { showToast('Load recommendations first'); return; }

  // Save the scroll position of the main window before hiding it
  scrollState.savedScrollY = window.scrollY;

  scrollState.likes = 0;
  scrollState.dislikes = 0;
  updateScrollTally();

  $('scroll-container').innerHTML = tracks.map(scrollCardHTML).join('');
  $('scroll-mode').classList.remove('hidden');
  $('scroll-refresh').classList.add('hidden');
  
  // Hide main view to completely avoid double-rendering / heavy reflows
  $('view-app').classList.add('hidden');
  
  document.body.style.overflow = 'hidden';

  attachScrollListeners();
  setupScrollObserver();
  setTimeout(() => $('scroll-kb-hint').classList.add('fade-out'), 3000);
}

function exitScrollMode() {
  $('scroll-mode').classList.add('hidden');
  document.body.style.overflow = '';
  
  // Restore main view
  $('view-app').classList.remove('hidden');
  
  // Restore scroll position
  if (typeof scrollState.savedScrollY === 'number') {
    window.scrollTo(0, scrollState.savedScrollY);
  }

  if (scrollState.activeAudio) {
    scrollState.activeAudio.pause();
    scrollState.activeAudio.currentTime = 0;
    scrollState.activeAudio = null;
  }
  if (scrollState.observer) { scrollState.observer.disconnect(); scrollState.observer = null; }
  $('scroll-kb-hint').classList.remove('fade-out');
}

function scrollCardHTML(track) {
  const n = track.listeners || 0;
  const listenerColor = n < 5000 ? '#a78bfa' : n < 100000 ? '#1db954' : '#888';
  const pillarLabels = {
    introspective: 'Introspective', rock: 'Rock',
    experimental: 'Experimental', electronic: 'Electronic',
    hiphop: 'Hip-Hop', wildcard: 'Outside Usual Zones'
  };
  const pillarLabel = track.pillar ? (pillarLabels[track.pillar] || track.pillar) : '';

  const tags = (track.genres || []).slice(0, 6).map(t => {
    const matched = (track.overlappingTags || []).includes(t);
    return `<span class="sc-tag${matched ? ' sc-tag-match' : ''}">${esc(t)}</span>`;
  }).join('');

  return `
    <div class="scroll-card" data-id="${esc(track.id)}" data-uri="${esc(track.uri)}">
      <div class="sc-bg" style="background-image:url('${esc(track.albumArt || '')}')"></div>
      ${track.albumArt
        ? `<div class="sc-art-wrap"><img class="sc-art" src="${esc(track.albumArt)}" alt="" /></div>`
        : '<div class="sc-art-wrap sc-art-blank"></div>'}
      ${track.previewUrl
        ? `<audio class="sc-audio" src="${esc(track.previewUrl)}" preload="metadata"></audio>`
        : ''}
      <div class="sc-gradient"></div>
      <div class="sc-progress"><div class="sc-progress-fill"></div></div>

      <div class="sc-info">
        <div class="sc-track-name">${esc(track.name)}</div>
        <div class="sc-artist">
          ${track.artistSpotifyUrl
            ? `<a href="${esc(track.artistSpotifyUrl)}" target="_blank" style="color:inherit;text-decoration:none">${esc(track.artist)}</a>`
            : esc(track.artist)}
        </div>
        <div class="sc-stats">
          ${track.popularityLabel ? `<span style="color:${listenerColor}">${esc(track.popularityLabel)}</span>` : ''}
          ${pillarLabel ? `<span>${esc(pillarLabel)}</span>` : ''}
        </div>
        <p class="sc-blurb">${esc(track.whyBlurb)}</p>
        ${tags ? `<div class="sc-tags">${tags}</div>` : ''}
      </div>

      <div class="sc-actions">
        <button class="sc-btn sc-dislike" title="Not for me (← key)">✕</button>
        <button class="sc-btn sc-save" data-uri="${esc(track.uri)}" title="Save to playlist">＋</button>
        <a href="${esc(track.spotifyUrl)}" target="_blank" class="sc-btn sc-open" title="Open in Spotify">↗</a>
        <button class="sc-btn sc-like" title="Love it (→ key)">♥</button>
      </div>
    </div>`;
}

function attachScrollListeners() {
  document.querySelectorAll('.sc-like').forEach(btn => {
    btn.addEventListener('click', () => handleScrollFeedback(btn.closest('.scroll-card'), 'like'));
  });
  document.querySelectorAll('.sc-dislike').forEach(btn => {
    btn.addEventListener('click', () => handleScrollFeedback(btn.closest('.scroll-card'), 'dislike'));
  });
  document.querySelectorAll('.sc-save').forEach(btn => {
    btn.addEventListener('click', () => handleScrollSave(btn));
  });

  document.querySelectorAll('.scroll-card').forEach(card => {
    let touchStartX = 0, touchStartY = 0, touchStartTime = 0;

    card.addEventListener('touchstart', e => {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchStartTime = Date.now();
    }, { passive: true });

    card.addEventListener('touchend', e => {
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;
      const dt = Date.now() - touchStartTime;
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 55) {
        handleScrollFeedback(card, dx > 0 ? 'like' : 'dislike');
        return;
      }
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && dt < 300) {
        if (card.classList.contains('sc-play-blocked')) {
          const audio = card.querySelector('.sc-audio');
          if (audio) audio.play().then(() => card.classList.remove('sc-play-blocked')).catch(() => {});
        }
      }
    }, { passive: true });
  });
}

function setupScrollObserver() {
  if (scrollState.observer) scrollState.observer.disconnect();

  scrollState.observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      const card = entry.target;
      const audio = card.querySelector('.sc-audio');

      if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
        if (audio) {
          if (scrollState.activeAudio && scrollState.activeAudio !== audio) {
            scrollState.activeAudio.pause();
            scrollState.activeAudio.currentTime = 0;
            resetScrollFill(scrollState.activeAudio);
          }
          audio.currentTime = 0;
          const p = audio.play();
          if (p) p.catch(() => { card.classList.add('sc-play-blocked'); });
          scrollState.activeAudio = audio;
          audio.ontimeupdate = () => {
            if (!audio.duration) return;
            const fill = card.querySelector('.sc-progress-fill');
            if (fill) fill.style.width = `${(audio.currentTime / audio.duration) * 100}%`;
          };
          audio.onended = () => { audio.currentTime = 0; resetScrollFill(audio); };
        }
      } else if (!entry.isIntersecting) {
        if (audio) {
          audio.pause();
          audio.currentTime = 0;
          resetScrollFill(audio);
          if (scrollState.activeAudio === audio) scrollState.activeAudio = null;
        }
      }
    });
  }, { threshold: [0, 0.5, 1.0] });

  document.querySelectorAll('.scroll-card').forEach(c => scrollState.observer.observe(c));
}

function resetScrollFill(audio) {
  const fill = audio.closest?.('.scroll-card')?.querySelector('.sc-progress-fill');
  if (fill) fill.style.width = '0%';
}

async function handleScrollFeedback(card, action) {
  if (!card || card.dataset.acted) return;
  card.dataset.acted = '1';

  const trackId = card.dataset.id;
  const track = state.recommendations.find(t => t.id === trackId);

  const flash = document.createElement('div');
  flash.className = `sc-flash sc-flash-${action}`;
  flash.textContent = action === 'like' ? '♥' : '✕';
  card.appendChild(flash);

  if (action === 'like') {
    scrollState.likes++;
    card.querySelector('.sc-like')?.classList.add('sc-btn-active-like');
  } else {
    scrollState.dislikes++;
    card.querySelector('.sc-dislike')?.classList.add('sc-btn-active-dislike');
  }
  updateScrollTally();

  if (track) {
    fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: track.genres || [], action })
    }).catch(() => {});
  }

  if (scrollState.likes + scrollState.dislikes >= 5) {
    $('scroll-refresh').classList.remove('hidden');
  }

  setTimeout(() => {
    const cards = [...$('scroll-container').querySelectorAll('.scroll-card')];
    const idx = cards.indexOf(card);
    if (idx < cards.length - 1) {
      cards[idx + 1].scrollIntoView({ behavior: 'smooth' });
    }
  }, 280);
}

async function handleScrollSave(btn) {
  if (btn.classList.contains('sc-saved')) return;
  const uri = btn.dataset.uri;
  btn.textContent = '…';
  try {
    const res = await fetch('/api/playlist/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackUri: uri })
    });
    const data = await res.json();
    if (!res.ok) throw data;
    btn.textContent = '✓';
    btn.classList.add('sc-saved');
    showToast('Saved to your Digger playlist', data.playlistUrl);
  } catch (err) {
    btn.textContent = '＋';
    showToast(err.error || 'Failed to save');
  }
}

function updateScrollTally() {
  const el = $('scroll-tally');
  if (el) el.innerHTML =
    `<span class="tally-likes">❤ ${scrollState.likes}</span><span class="tally-dislikes">✕ ${scrollState.dislikes}</span>`;
}

async function scrollRefreshRecs() {
  exitScrollMode();
  setRecsLoading(true);
  $('recs-tiers').innerHTML = '';
  await loadRecommendations(state.digMode);
  setTimeout(enterScrollMode, 300);
}

function handleScrollKeyboard(e) {
  if ($('scroll-mode').classList.contains('hidden')) return;
  const container = $('scroll-container');
  const cards = [...container.querySelectorAll('.scroll-card')];
  const visible = cards.find(c => {
    const r = c.getBoundingClientRect();
    return r.top > -80 && r.top < 80;
  });
  if (!visible) return;
  if (e.key === 'ArrowRight' || e.key === 'l') handleScrollFeedback(visible, 'like');
  else if (e.key === 'ArrowLeft' || e.key === 'd') handleScrollFeedback(visible, 'dislike');
  else if (e.key === '+' || e.key === 's') visible.querySelector('.sc-save')?.click();
  else if (e.key === 'Escape') exitScrollMode();
}

// ── Wire up ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  $('btn-reset-dig')?.addEventListener('click', () => loadRecommendations('underground'));
  $('btn-save-all').addEventListener('click', saveAll);
  $('btn-scroll-mode').addEventListener('click', enterScrollMode);
  $('btn-dig-again').addEventListener('click', () => loadRecommendations(state.digMode));
  $('scroll-close').addEventListener('click', exitScrollMode);
  $('scroll-refresh').addEventListener('click', scrollRefreshRecs);
  window.addEventListener('keydown', handleScrollKeyboard);
  window.addEventListener('beforeunload', stopAudio);

  document.querySelectorAll('.dig-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (!DIG_MODES[mode] || mode === state.digMode) return;
      loadRecommendations(mode);
    });
  });

  const debugToggle = $('debug-toggle');
  if (debugToggle) {
    debugToggle.addEventListener('click', () => {
      const content = $('debug-panel');
      const isOpen = content?.style.display !== 'none';
      if (content) content.style.display = isOpen ? 'none' : 'block';
      debugToggle.textContent = isOpen ? 'Nerd mode ▾' : 'Nerd mode ▴';
    });
  }

  init();
});
