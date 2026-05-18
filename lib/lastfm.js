const axios = require('axios');

const BASE = 'https://ws.audioscrobbler.com/2.0/';

function key() {
  const k = process.env.LASTFM_API_KEY;
  if (!k) throw new Error('LASTFM_API_KEY not set');
  return k;
}

async function call(params) {
  const res = await axios.get(BASE, {
    params: { api_key: key(), format: 'json', autocorrect: 1, ...params },
    timeout: 10000
  });
  if (res.data.error) throw new Error(`Last.fm ${res.data.error}: ${res.data.message}`);
  return res.data;
}

async function safe(fn, fallback) {
  try { return await fn(); } catch { return fallback; }
}

// Returns { name, listeners, tags[], image } or null
async function getArtistInfo(artistName) {
  return safe(async () => {
    const d = await call({ method: 'artist.getInfo', artist: artistName });
    const a = d.artist;
    if (!a) return null;
    const images = a.image || [];
    const image = (images.find(i => i.size === 'extralarge') ||
                   images.find(i => i.size === 'large') ||
                   images.find(i => i.size === 'medium'))?.['#text'] || null;
    return {
      name: a.name,
      listeners: parseInt(a.stats?.listeners || '0', 10),
      tags: (a.tags?.tag || []).map(t => t.name.toLowerCase()).slice(0, 10),
      image: image && image.includes('2a96cbd8b46e442fc41c2b86b821562f') ? null : image
    };
  }, null);
}

// Look up a collab artist (e.g. "Artist A & Artist B") by splitting on " & "
// and merging the results. Falls back to direct lookup first.
async function getArtistInfoWithCollabFallback(artistName) {
  const info = await getArtistInfo(artistName);
  if (info && info.tags.length > 0) return info;
  if (!artistName.includes(' & ')) return info;

  const parts = artistName.split(' & ').map(s => s.trim()).filter(Boolean);
  const partInfos = await Promise.all(parts.map(p => getArtistInfo(p)));
  const valid = partInfos.filter(Boolean);
  if (!valid.length) return info; // return whatever we had (possibly null)

  const allTags = [...new Set(valid.flatMap(i => i.tags))].slice(0, 10);
  const avgListeners = Math.round(valid.reduce((s, i) => s + i.listeners, 0) / valid.length);
  const image = valid.find(i => i.image)?.image || null;
  return { name: artistName, listeners: avgListeners, tags: allTags, image };
}

// Returns [{ name, match }] sorted by match desc
async function getSimilarArtists(artistName, limit = 50) {
  return safe(async () => {
    const d = await call({ method: 'artist.getSimilar', artist: artistName, limit });
    return (d.similarartists?.artist || []).map(a => ({
      name: a.name,
      match: parseFloat(a.match || '0')
    }));
  }, []);
}

module.exports = { getArtistInfo, getArtistInfoWithCollabFallback, getSimilarArtists };
