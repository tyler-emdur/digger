const express = require('express');
const router = express.Router();
const axios = require('axios');
const querystring = require('querystring');
const crypto = require('crypto');

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3000/auth/callback';

const SCOPES = [
  'user-top-read',
  'user-read-recently-played',
  'user-library-read',
  'playlist-modify-public',
  'user-read-private'
].join(' ');

router.get('/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.authState = state;

  const params = querystring.stringify({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    state,
    scope: SCOPES,
    show_dialog: false
  });

  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.redirect('/?error=access_denied');
  if (state !== req.session.authState) return res.redirect('/?error=state_mismatch');

  try {
    const tokenRes = await axios.post(
      'https://accounts.spotify.com/api/token',
      querystring.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`
        }
      }
    );

    const { access_token, refresh_token, expires_in } = tokenRes.data;
    req.session.accessToken = access_token;
    req.session.refreshToken = refresh_token;
    req.session.tokenExpiry = Date.now() + expires_in * 1000;
    delete req.session.authState;

    res.redirect('/');
  } catch (err) {
    console.error('Token exchange failed:', err.response?.data || err.message);
    res.redirect('/?error=token_exchange_failed');
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

router.get('/status', (req, res) => {
  res.json({ authenticated: !!req.session.accessToken });
});

module.exports = router;
