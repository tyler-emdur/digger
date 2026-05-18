/* ── Digger frontend ─────────────────────────────────────── */

const $ = id => document.getElementById(id);

// ── State ─────────────────────────────────────────────────
const state = {
  recommendations: [],
  isDeepDig: false,
  currentAudio: null,
  currentPlayBtn: null,
  savedUris: new Set()
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

  // Build mood description from what's actually available
  let moodDesc = `Your sound is <span>${moodLabel}</span>`;
  if (tempoLabel) moodDesc += ` and ${tempoLabel}`;
  moodDesc += '.';
  $('profile-mood').innerHTML = moodDesc;

  // Only show audio-feature stats when Spotify returned them
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

  // Prefer genre tags; fall back to top artist names
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
async function loadRecommendations(deepDig = false) {
  state.isDeepDig = deepDig;
  stopAudio();

  $('recs-tiers').innerHTML = '';
  $('recs-micro').innerHTML = '';
  $('recs-micro').classList.add('hidden');
  $('recs-empty').classList.add('hidden');
  setRecsLoading(true);

  let data;
  try {
    const res = await fetch(`/api/recommendations?deepDig=${deepDig}`);
    if (!res.ok) throw await res.json();
    data = await res.json();
  } catch (err) {
    showError(err.error || 'Failed to fetch recommendations.');
    setRecsLoading(false);
    return;
  }

  setRecsLoading(false);
  state.recommendations = data.recommendations || [];
  updateRecsHeader(deepDig, data.popularityThreshold);

  const tiers = data.tiers || [];
  const totalTracks = tiers.reduce((s, t) => s + t.tracks.length, 0);

  if (!totalTracks && !data.microUnderground?.length) {
    $('recs-empty').classList.remove('hidden');
    return;
  }

  let html = '';

  // B3: Scene DNA strip
  if (data.sceneAnchors?.length) {
    html += sceneDNAHTML(data.sceneAnchors);
  }

  // B7: Most unexpected match callout
  if (data.mostUnexpectedMatch?.track) {
    html += unexpectedMatchHTML(data.mostUnexpectedMatch);
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

  // Auto scroll mode on mobile
  if (window.innerWidth < 768 && state.recommendations.length > 0) {
    setTimeout(enterScrollMode, 500);
  }
}

function updateRecsHeader(deepDig, threshold) {
  $('recs-subtitle').textContent = deepDig
    ? 'Deep dig mode — maximum underground filter active'
    : 'Mainstream filtered out — underground discoveries only';

  const btn = $('btn-dig-deeper');
  if (deepDig) {
    btn.classList.add('active');
    $('dig-deeper-label').textContent = 'Reset Filter';
    $('dig-deeper-sub').textContent = threshold != null ? `≤${threshold} popularity` : 'deepest cuts';
  } else {
    btn.classList.remove('active');
    $('dig-deeper-label').textContent = 'Dig Deeper';
    $('dig-deeper-sub').textContent = threshold != null ? `≤${threshold} popularity` : 'widen search';
  }
}

const LOADING_COPY = [
  'Digging...', 'Crawling the underground...', 'Finding similar artists...',
  'Crossing genre lines...', 'Surfacing the obscure...', 'Almost there...'
];
let loadingCopyTimer = null;

function setRecsLoading(on) {
  if (on) {
    $('recs-tiers').innerHTML = `
      <div class="tier-section">
        <div class="tier-skeleton-header"></div>
        <div class="recs-grid">${Array(4).fill(0).map(() => skeletonCard()).join('')}</div>
      </div>
      <div class="tier-section">
        <div class="tier-skeleton-header"></div>
        <div class="recs-grid">${Array(5).fill(0).map(() => skeletonCard()).join('')}</div>
      </div>`;
    // Rotate subtitle copy while loading
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

function skeletonCard() {
  return `
    <div class="track-card" style="pointer-events:none">
      <div class="card-main-row">
        <div style="width:80px;height:80px;border-radius:8px;background:var(--surface-2);flex-shrink:0"></div>
        <div style="flex:1;display:flex;flex-direction:column;gap:8px;min-width:0">
          <div style="height:16px;background:var(--surface-2);border-radius:4px;width:55%"></div>
          <div style="height:12px;background:var(--surface-2);border-radius:4px;width:40%"></div>
          <div style="height:11px;background:var(--surface-2);border-radius:4px;width:30%"></div>
          <div style="height:11px;background:var(--surface-2);border-radius:4px;width:75%"></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0">
          <div style="width:54px;height:28px;background:var(--surface-2);border-radius:6px"></div>
          <div style="width:54px;height:28px;background:var(--surface-2);border-radius:6px"></div>
        </div>
      </div>
    </div>`;
}

// ── Tier sections ─────────────────────────────────────────
function tierSectionHTML(tier) {
  return `
    <div class="tier-section" id="tier-${esc(tier.id)}">
      <div class="tier-header">
        <h3 class="tier-title">${esc(tier.label)}</h3>
        <p class="tier-subtitle">${esc(tier.subtitle)}</p>
      </div>
      <div class="recs-grid">
        ${tier.tracks.map(t => trackCardHTML(t)).join('')}
      </div>
    </div>`;
}

function microUndergroundHTML(artists) {
  return `
    <div class="tier-section tier-micro">
      <div class="tier-header">
        <h3 class="tier-title">🔬 Micro-Underground</h3>
        <p class="tier-subtitle">Under 5k listeners — so underground they might not be on Spotify yet</p>
      </div>
      <div class="micro-grid">
        ${artists.map(a => microArtistHTML(a)).join('')}
      </div>
    </div>`;
}

// B3: Scene DNA section
function sceneDNAHTML(anchors) {
  return `
    <div class="scene-dna-section">
      <h3 class="scene-dna-title">🧬 Your Scene's DNA</h3>
      <p class="scene-dna-sub">The artists that shaped everything you're about to hear. Too well-known to show as results — but their gravity pulled everything.</p>
      <div class="scene-dna-strip">
        ${anchors.map(a => `
          <div class="scene-dna-card">
            <div class="scene-dna-name">${esc(a.name)}</div>
            <div class="scene-dna-meta">${a.seedCount} connection${a.seedCount !== 1 ? 's' : ''} · ${a.listeners >= 1000000 ? (a.listeners/1e6).toFixed(1)+'M' : Math.round(a.listeners/1000)+'k'} listeners</div>
            <div class="scene-dna-tags">${(a.tags || []).slice(0, 3).map(t => `<span class="track-genre-tag">${esc(t)}</span>`).join('')}</div>
            <button class="btn-dna-expand" data-artist="${esc(a.name)}" data-pillar="${esc(a.pillar || '')}">Find artists like this →</button>
          </div>
        `).join('')}
      </div>
      <div class="dna-expand-results hidden"></div>
    </div>`;
}

// B7: Most unexpected match callout
function unexpectedMatchHTML({ track, pillars }) {
  const PILLAR_NAMES = { introspective: 'introspective', rock: 'rock', experimental: 'experimental', electronic: 'electronic', hiphop: 'hip-hop' };
  const p1 = PILLAR_NAMES[pillars?.[0]] || pillars?.[0] || '';
  const p2 = PILLAR_NAMES[pillars?.[1]] || pillars?.[1] || '';
  return `
    <div class="unexpected-match-wrap">
      <div class="unexpected-badge">🎯 Most unexpected match</div>
      <p class="unexpected-desc">Scored well in both your ${esc(p1)} and ${esc(p2)} sides simultaneously</p>
      ${trackCardHTML(track)}
    </div>`;
}

function microArtistHTML(a) {
  const listenerStr = a.listeners < 1000 ? `${a.listeners} listeners` : `${Math.round(a.listeners / 1000)}k listeners`;
  // B5: rarity badges
  const rarityBadge = !a.spotifyTrack
    ? '<span class="micro-badge micro-badge-soundcloud">Only on SoundCloud</span>'
    : a.listeners < 500
    ? '<span class="micro-badge micro-badge-buried">👁 Almost no one has heard this</span>'
    : a.listeners < 1000
    ? '<span class="micro-badge micro-badge-buried">🪦 Buried find</span>'
    : '';
  // B6: use lfm image or gradient
  const artHTML = (a.spotifyTrack?.albumArt)
    ? `<img class="micro-art" src="${esc(a.spotifyTrack.albumArt)}" alt="" />`
    : `<div class="micro-art">${tagGradient(a.tags, a.name?.[0])}</div>`;
  return `
    <div class="micro-card">
      ${artHTML}
      <div class="micro-body">
        <div class="micro-name">${esc(a.name)}</div>
        ${rarityBadge}
        <div class="micro-listeners">🔬 ${esc(listenerStr)}</div>
        <div class="micro-tags">
          ${(a.tags || []).slice(0, 4).map(t => `<span class="track-genre-tag">${esc(t)}</span>`).join('')}
        </div>
        <div class="micro-actions">
          ${a.spotifyTrack ? `<a href="${esc(a.spotifyTrack.spotifyUrl)}" target="_blank" class="btn-micro">Spotify ↗</a>` : ''}
          <a href="https://www.youtube.com/results?search_query=${encodeURIComponent(a.name + ' music')}" target="_blank" class="btn-micro">YouTube ↗</a>
          <a href="https://soundcloud.com/search?q=${encodeURIComponent(a.name)}" target="_blank" class="btn-micro">SoundCloud ↗</a>
        </div>
      </div>
    </div>`;
}

// ── Track card HTML ───────────────────────────────────────
const SCENE_COLORS = {
  'Hyperpop-Adjacent': '#e040fb',
  'Alt-Emo':           '#f44336',
  'Post-Punk':         '#7c4dff',
  'Indie Sleaze':      '#00bcd4',
  'Bedroom Pop':       '#ff9800',
  'Lo-Fi Experimental':'#607d8b',
  'Ambient/Electronic':'#00e5ff',
  'Post-Internet':     '#4caf50',
  'SoundCloud Native': '#1db954',
};

// Returns just the color string for a genre set
function tagGradientColor(tags) {
  const t = (tags || []).join(' ').toLowerCase();
  if (/witch house/.test(t))               return '#1a0a2e';
  if (/idm|ambient|drone/.test(t))         return '#0a1628';
  if (/folk|indie|bedroom/.test(t))        return '#1a1208';
  if (/cloud rap|plugg|phonk/.test(t))     return '#0f0f0f';
  if (/hyperpop|digicore/.test(t))         return '#2a0a2e';
  if (/post.punk|shoegaze/.test(t))        return '#12121e';
  return '#1a1a1a';
}

// Kept for microArtistHTML usage
function tagGradient(tags, initial) {
  const color = tagGradientColor(tags);
  return `<div class="art-gradient-fallback" style="background:${color}"><span class="art-gradient-initial">${esc((initial || '?').toUpperCase())}</span></div>`;
}

function trackCardHTML(track) {
  // Bug 3: skip cards with no audio at all
  const hasPreview = !!(track.previewUrl);
  const hasSpotify = !!(track.id);
  if (!hasPreview && !hasSpotify) return '';

  const listenersN = track.listeners || 0;
  const listenerClass = listenersN < 5000 ? 'listener-count-micro' : listenersN < 100000 ? 'listener-count-green' : 'listener-count-dim';
  const listenerIcon = listenersN < 5000 ? '🔬 ' : '';
  const listenerDisplay = track.popularityLabel ? `${listenerIcon}${track.popularityLabel}` : '';

  // Bug 1: gradient always rendered first; img overlays it with simple onerror
  const gradColor = tagGradientColor(track.genres);
  const initial = esc((track.artist?.[0] || '?').toUpperCase());
  const artHTML = `
    <div class="card-art-wrap">
      <div class="art-gradient-fallback" style="background:${gradColor}">
        <span class="art-gradient-initial">${initial}</span>
      </div>
      ${track.albumArt ? `<img class="card-art" src="${esc(track.albumArt)}" alt="" loading="lazy" onerror="this.style.display='none'" />` : ''}
      ${hasPreview ? `
        <button class="card-play-btn" aria-label="Play preview">▶</button>
        <audio class="track-audio" src="${esc(track.previewUrl)}" preload="none"></audio>
      ` : ''}
    </div>`;

  // Bug 3: Spotify iframe when no preview_url
  const audioHTML = !hasPreview ? `
    <div class="card-iframe-wrap">
      <iframe src="https://open.spotify.com/embed/track/${esc(track.id)}?utm_source=generator"
        width="100%" height="52" frameBorder="0"
        allow="autoplay; clipboard-write; encrypted-media; picture-in-picture"
        loading="lazy"></iframe>
    </div>` : '';

  return `
    <div class="track-card" data-id="${esc(track.id)}" data-uri="${esc(track.uri)}"
         data-artist="${esc(track.artist)}" data-pillar="${esc(track.pillar || '')}"
         data-listeners="${track.listeners || 0}">

      <div class="recommendation-card">
        ${artHTML}
        <div class="card-content">
          <div class="card-artist">
            ${track.artistSpotifyUrl
              ? `<a href="${esc(track.artistSpotifyUrl)}" target="_blank">${esc(track.artist)}</a>`
              : esc(track.artist)}
          </div>
          <div class="card-track">${esc(track.name)}</div>
          <div class="card-blurb">${esc(track.whyBlurb)}</div>
          ${listenerDisplay ? `<div class="track-meta"><span class="listener-count ${listenerClass}">${esc(listenerDisplay)}</span></div>` : ''}
        </div>
        <div class="card-side-actions">
          <button class="btn-track btn-track-save" data-uri="${esc(track.uri)}">+ Save</button>
          <a href="${esc(track.spotifyUrl)}" target="_blank" class="btn-track btn-track-open">↗</a>
        </div>
      </div>

      ${audioHTML}

      <div class="card-reactions">
        <button class="reaction-btn" data-action="more-like-this">👍 More</button>
        <button class="reaction-btn" data-action="too-mainstream">📻 Mainstream</button>
        <button class="reaction-btn" data-action="weirder">🌀 Weirder</button>
        <button class="reaction-btn" data-action="not-for-me">💔 Nope</button>
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
  // Click-to-play preview button (Bug 3)
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

  // B2: card reaction buttons
  document.querySelectorAll('.reaction-btn').forEach(btn => {
    btn.addEventListener('click', () => handleCardReaction(btn));
  });

  // B3: scene DNA expand buttons
  document.querySelectorAll('.btn-dna-expand').forEach(btn => {
    btn.addEventListener('click', () => handleDNAExpand(btn));
  });

  // Tier title IntersectionObserver
  document.querySelectorAll('.tier-title').forEach(el => {
    if (!el.classList.contains('visible')) tierTitleObserver.observe(el);
  });

  // Stagger card animation
  document.querySelectorAll('#recs-tiers .track-card').forEach((card, i) => {
    card.style.setProperty('--i', i);
  });
}

// B2: card reaction handler
async function handleCardReaction(btn) {
  const card = btn.closest('.track-card');
  if (!card) return;
  const action = btn.dataset.action;
  const artistName = card.dataset.artist;
  const pillar = card.dataset.pillar;
  const listeners = parseInt(card.dataset.listeners || '0', 10);

  btn.disabled = true;
  btn.style.opacity = '0.5';

  try {
    const res = await fetch('/api/card-reaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, artistName, pillar, listeners })
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
      const label = action === 'too-mainstream' ? '📻 Cap lowered' : action === 'weirder' ? '🌀 Going deeper' : '💔 Removed';
      showToast(label);
    } else if (action === 'more-like-this') {
      const expandDiv = card.querySelector('.expand-results');
      if (!expandDiv) return;
      if (data.tracks?.length) {
        expandDiv.innerHTML = `<p class="expand-label">More like ${esc(artistName)}:</p>` +
          data.tracks.map(t => trackCardHTML(t)).join('');
        expandDiv.classList.remove('hidden');
        attachInlineCardListeners(expandDiv);
      } else {
        showToast('No more results found for this artist');
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

// B3: Scene DNA expand
async function handleDNAExpand(btn) {
  const artistName = btn.dataset.artist;
  const pillar = btn.dataset.pillar;
  btn.textContent = 'Loading…';
  btn.disabled = true;
  try {
    const res = await fetch('/api/card-reaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'more-like-this', artistName, pillar, listeners: 200000 })
    });
    const data = await res.json();
    const resultDiv = btn.closest('.scene-dna-section')?.querySelector('.dna-expand-results');
    if (resultDiv && data.tracks?.length) {
      resultDiv.innerHTML = `<p class="expand-label">Artists like ${esc(artistName)}:</p>` +
        data.tracks.map(t => trackCardHTML(t)).join('');
      resultDiv.classList.remove('hidden');
      attachInlineCardListeners(resultDiv);
    } else {
      showToast('No results found');
    }
  } catch (err) {
    showToast('Expand failed');
  }
  btn.textContent = 'Find artists like this →';
  btn.disabled = false;
}

// Attach listeners to dynamically added cards (expand results, DNA results)
function attachInlineCardListeners(container) {
  container.querySelectorAll('.card-play-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); toggleCardAudio(btn); });
  });
  container.querySelectorAll('.btn-track-save').forEach(b => b.addEventListener('click', () => saveTrack(b)));
  container.querySelectorAll('.reaction-btn').forEach(b => b.addEventListener('click', () => handleCardReaction(b)));
}

// ── Audio playback (Bug 3) ────────────────────────────────
function toggleCardAudio(btn) {
  const wrap = btn.closest('.card-art-wrap');
  const audio = wrap?.querySelector('.track-audio');
  if (!audio) return;

  // Stop whatever is currently playing
  if (state.currentAudio && state.currentAudio !== audio) {
    stopAudio();
  }

  if (audio.paused) {
    audio.volume = 0.8;
    audio.play().catch(() => {});
    btn.textContent = '■';
    btn.classList.add('playing');
    state.currentAudio = audio;
    state.currentPlayBtn = btn;

    audio.ontimeupdate = () => {};
    audio.onended = () => {
      audio.currentTime = 0;
      btn.textContent = '▶';
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
    state.currentPlayBtn.textContent = '▶';
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
    btn.textContent = 'Error';
    btn.disabled = false;
    setTimeout(() => { btn.textContent = '+ Save'; btn.disabled = false; }, 2000);
    showToast(err.error || 'Failed to save track');
  }
}

function markSaved(btn) {
  btn.textContent = '✓ Saved';
  btn.classList.add('saved');
  btn.disabled = true;
}

// ── Save all ──────────────────────────────────────────────
async function saveAll() {
  if (!state.recommendations.length) return;

  const btn = $('btn-save-all');
  const original = btn.textContent;
  btn.textContent = 'Creating playlist…';
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

    // Mark all as saved
    state.recommendations.forEach(t => state.savedUris.add(t.uri));
    document.querySelectorAll('.btn-track-save').forEach(markSaved);

    showToast(`Playlist created with ${trackUris.length} tracks`, data.playlistUrl);
    btn.textContent = '✓ Playlist Created';
  } catch (err) {
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
    <p style="color:var(--text-muted);text-align:center;max-width:400px">${esc(msg)}</p>
    <a href="/auth/logout" style="color:var(--green);margin-top:12px">Log in again</a>`;
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

  // Recommendations table from tiers
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

  panel.innerHTML = `
    <div class="debug-section">
      <strong>Seeds</strong>
      <p>${(info.seeds || []).map(s => `<code>${esc(s)}</code>`).join(' ')}</p>
    </div>
    <div class="debug-section">
      <strong>Pipeline (per pillar: candidates → scored → final)</strong>
      ${['introspective','rock','experimental','electronic','hiphop'].map(p => `
        <p>${p}: ${info[p+'Candidates'] ?? '—'} candidates → ${info[p+'Scored'] ?? '—'} scored → ${info[p+'Final'] ?? '—'} shown</p>
      `).join('')}
      <p>Wildcard: ${info.wildcardFinal ?? '—'} shown</p>
      <p>Micro-underground: ${info.finalMicro ?? '—'} shown</p>
      ${info.userPillarSeeds ? `<p>User seed → pillar map: ${Object.entries(info.userPillarSeeds).map(([p,seeds]) => `${p}: ${seeds.join(', ')}`).join(' | ')}</p>` : ''}
    </div>
    ${genreRows ? `
    <div class="debug-section">
      <strong>Listening distribution (by tag weight)</strong>
      <table class="debug-table"><tr><th>Bucket</th><th>Share</th></tr>${genreRows}</table>
    </div>` : ''}
    ${slotRows ? `
    <div class="debug-section">
      <strong>Result slots allocated</strong>
      <table class="debug-table"><tr><th>Bucket</th><th>Slots</th></tr>${slotRows}</table>
    </div>` : ''}
    ${recsRows ? `
    <div class="debug-section">
      <strong>Recommendations (pillar, listeners, matching tags)</strong>
      <table class="debug-table"><tr><th>Artist</th><th>Pillar</th><th>Listeners</th><th>Matching tags</th></tr>${recsRows}</table>
    </div>` : ''}
    ${tagRows ? `
    <div class="debug-section">
      <strong>Tag profile (top 20, normalized weight)</strong>
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

  scrollState.likes = 0;
  scrollState.dislikes = 0;
  updateScrollTally();

  $('scroll-container').innerHTML = tracks.map(scrollCardHTML).join('');
  $('scroll-mode').classList.remove('hidden');
  $('scroll-refresh').classList.add('hidden');
  document.body.style.overflow = 'hidden';

  attachScrollListeners();
  setupScrollObserver();
  setTimeout(() => $('scroll-kb-hint').classList.add('fade-out'), 3000);
}

function exitScrollMode() {
  $('scroll-mode').classList.add('hidden');
  document.body.style.overflow = '';
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
  const listenerColor = n < 5000 ? '#c084fc' : n < 100000 ? '#1db954' : '#888';
  const listenerIcon = n < 5000 ? '🔬' : '👂';
  const pillarLabels = {
    introspective: 'Introspective Side', rock: 'Rock Side',
    experimental: 'Experimental Side', electronic: 'Electronic Side',
    hiphop: 'Hip-Hop Side', wildcard: 'Outside Usual Zones'
  };
  const pillarLabel = track.pillar ? (pillarLabels[track.pillar] || track.pillar) : '';

  const tags = (track.genres || []).slice(0, 6).map(t => {
    const matched = (track.overlappingTags || []).includes(t);
    return `<span class="sc-tag${matched ? ' sc-tag-match' : ''}">${esc(t)}</span>`;
  }).join('');

  return `
    <div class="scroll-card" data-id="${esc(track.id)}" data-uri="${esc(track.uri)}">
      <div class="sc-bg" style="background-image:url('${esc(track.albumArt || '')}')"></div>
      ${track.albumArt ? `<div class="sc-art-wrap"><img class="sc-art" src="${esc(track.albumArt)}" alt="" /></div>` : '<div class="sc-art-wrap sc-art-blank"></div>'}
      ${track.previewUrl
        ? `<audio class="sc-audio" src="${esc(track.previewUrl)}" preload="metadata"></audio>`
        : `<div class="sc-no-preview">
             <iframe src="https://open.spotify.com/embed/track/${esc(track.id)}?utm_source=generator&theme=0"
               width="100%" height="80" frameborder="0" class="sc-iframe"
               allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
               loading="lazy"></iframe>
           </div>`}
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
          ${track.popularityLabel ? `<span style="color:${listenerColor}">${listenerIcon} ${esc(track.popularityLabel)}</span>` : ''}
          ${pillarLabel ? `<span>${esc(pillarLabel)}</span>` : ''}
          ${track.sceneTag ? `<span style="color:#e040fb">${esc(track.sceneTag)}</span>` : ''}
          ${track.deepCut ? `<span style="color:#fbbf24">✦ Deep Cut</span>` : ''}
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

  // Tap-to-play + horizontal swipe support
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

      // Horizontal swipe (right=like, left=dislike)
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 55) {
        handleScrollFeedback(card, dx > 0 ? 'like' : 'dislike');
        return;
      }
      // Tap (not swipe, not hold)
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
        // This card is now visible
        if (audio) {
          if (scrollState.activeAudio && scrollState.activeAudio !== audio) {
            scrollState.activeAudio.pause();
            scrollState.activeAudio.currentTime = 0;
            resetScrollFill(scrollState.activeAudio);
          }
          audio.currentTime = 0;
          const p = audio.play();
          if (p) p.catch(() => {
            // Autoplay blocked — show a tap-to-play hint on the card
            card.classList.add('sc-play-blocked');
          });
          scrollState.activeAudio = audio;
          audio.ontimeupdate = () => {
            if (!audio.duration) return;
            const fill = card.querySelector('.sc-progress-fill');
            if (fill) fill.style.width = `${(audio.currentTime / audio.duration) * 100}%`;
          };
          audio.onended = () => {
            audio.currentTime = 0;
            resetScrollFill(audio);
          };
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

  // Flash overlay
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

  // Send to server
  if (track) {
    fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: track.genres || [], action })
    }).catch(() => {});
  }

  // Show refresh button after 5 interactions
  if (scrollState.likes + scrollState.dislikes >= 5) {
    $('scroll-refresh').classList.remove('hidden');
  }

  // Scroll to next card after brief pause
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
  if (el) el.innerHTML = `<span class="tally-likes">❤ ${scrollState.likes}</span><span class="tally-dislikes">✕ ${scrollState.dislikes}</span>`;
}

async function scrollRefreshRecs() {
  exitScrollMode();
  setRecsLoading(true);
  $('recs-tiers').innerHTML = '';
  await loadRecommendations(state.isDeepDig);
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

// ── Wire up buttons ───────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  $('btn-dig-deeper').addEventListener('click', () => {
    // Toggle between deep dig and normal
    loadRecommendations(!state.isDeepDig);
  });

  $('btn-reset-dig').addEventListener('click', () => {
    loadRecommendations(false);
  });

  $('btn-save-all').addEventListener('click', saveAll);
  $('btn-scroll-mode').addEventListener('click', enterScrollMode);
  $('scroll-close').addEventListener('click', exitScrollMode);
  $('scroll-refresh').addEventListener('click', scrollRefreshRecs);
  window.addEventListener('keydown', handleScrollKeyboard);
  window.addEventListener('beforeunload', stopAudio);

  const debugToggle = $('debug-toggle');
  if (debugToggle) {
    debugToggle.addEventListener('click', () => {
      const content = $('debug-panel');
      const isOpen = content?.style.display !== 'none';
      if (content) content.style.display = isOpen ? 'none' : 'block';
      debugToggle.textContent = isOpen ? '🔬 Nerd mode ▾' : '🔬 Nerd mode ▴';
    });
  }

  init();
});
