const axios = require('axios');
const querystring = require('querystring');

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

async function refreshToken(session) {
  const res = await axios.post(
    'https://accounts.spotify.com/api/token',
    querystring.stringify({
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken
    }),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`
      }
    }
  );
  session.accessToken = res.data.access_token;
  session.tokenExpiry = Date.now() + res.data.expires_in * 1000;
  if (res.data.refresh_token) session.refreshToken = res.data.refresh_token;
  return session.accessToken;
}

async function getValidToken(session) {
  // Proactively refresh if within 5 minutes of expiry
  if (Date.now() > session.tokenExpiry - 5 * 60 * 1000) {
    return refreshToken(session);
  }
  return session.accessToken;
}

function client(token) {
  return axios.create({
    baseURL: 'https://api.spotify.com/v1',
    headers: { Authorization: `Bearer ${token}` }
  });
}

async function getTopArtists(token, timeRange, limit = 50) {
  const res = await client(token).get(`/me/top/artists`, { params: { time_range: timeRange, limit } });
  return res.data.items;
}

async function getTopTracks(token, timeRange, limit = 50) {
  const res = await client(token).get(`/me/top/tracks`, { params: { time_range: timeRange, limit } });
  return res.data.items;
}

async function getRecentlyPlayed(token, limit = 50) {
  const res = await client(token).get(`/me/player/recently-played`, { params: { limit } });
  return res.data.items.map(i => i.track);
}

async function getAudioFeatures(token, trackIds) {
  if (!trackIds.length) return [];
  const features = [];
  // Spotify allows up to 100 IDs per request
  for (let i = 0; i < trackIds.length; i += 100) {
    const batch = trackIds.slice(i, i + 100);
    const res = await client(token).get(`/audio-features`, { params: { ids: batch.join(',') } });
    features.push(...(res.data.audio_features || []).filter(Boolean));
  }
  return features;
}

async function getUserProfile(token) {
  const res = await client(token).get(`/me`);
  return res.data;
}

async function getArtist(token, artistId) {
  const res = await client(token).get(`/artists/${artistId}`);
  return res.data;
}

async function searchArtists(token, query, limit = 50, offset = 0) {
  const res = await client(token).get('/search', {
    params: { q: query, type: 'artist', limit, offset }
  });
  return res.data.artists?.items || [];
}

async function searchTracks(token, query, limit = 50, offset = 0) {
  const res = await client(token).get('/search', {
    params: { q: query, type: 'track', limit, offset }
  });
  return res.data.tracks?.items || [];
}

async function getArtistAlbums(token, artistId, limit = 3, market = 'US', includeGroups = 'album,single') {
  const res = await client(token).get(`/artists/${artistId}/albums`, {
    params: { include_groups: includeGroups, limit, market }
  });
  return res.data.items || [];
}

async function getAlbumTracks(token, albumId, limit = 3) {
  const res = await client(token).get(`/albums/${albumId}/tracks`, {
    params: { limit }
  });
  return res.data.items || [];
}

async function createPlaylist(token, userId, name, description) {
  const res = await client(token).post(`/users/${userId}/playlists`, {
    name,
    description,
    public: true
  });
  return res.data;
}

async function addTracksToPlaylist(token, playlistId, uris) {
  // Spotify allows up to 100 tracks per request
  for (let i = 0; i < uris.length; i += 100) {
    await client(token).post(`/playlists/${playlistId}/tracks`, { uris: uris.slice(i, i + 100) });
  }
}

async function getSavedTracks(token, limit = 100) {
  const res = await client(token).get('/me/tracks', { params: { limit } });
  return (res.data.items || []).map(i => i.track).filter(Boolean);
}

async function getTrack(token, trackId) {
  const res = await client(token).get(`/tracks/${trackId}`);
  return res.data;
}

module.exports = {
  getValidToken,
  getTopArtists,
  getTopTracks,
  getRecentlyPlayed,
  getAudioFeatures,
  getUserProfile,
  getArtist,
  searchArtists,
  searchTracks,
  getArtistAlbums,
  getAlbumTracks,
  createPlaylist,
  addTracksToPlaylist,
  getSavedTracks,
  getTrack
};
