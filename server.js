require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');

// ── Required environment variable checklist ──────────────────
// Printed on every startup so you know exactly what to add to the Vercel dashboard.
const ENV_VARS = [
  { name: 'SPOTIFY_CLIENT_ID',     required: true,  note: 'Spotify app → Settings → Client ID' },
  { name: 'SPOTIFY_CLIENT_SECRET', required: true,  note: 'Spotify app → Settings → Client Secret' },
  { name: 'SESSION_SECRET',        required: true,  note: 'Any long random string (e.g. openssl rand -hex 32)' },
  { name: 'REDIRECT_URI',          required: true,  note: 'Set to https://<your-app>.vercel.app/auth/callback after deploy' },
  { name: 'LASTFM_API_KEY',        required: false, note: 'last.fm API key — optional but strongly recommended' },
  { name: 'ANTHROPIC_API_KEY',     required: false, note: 'Anthropic API key — optional, enables AI blurbs' },
];

console.log('\n── Digger env check ──────────────────────────────────────────');
let missingRequired = false;
ENV_VARS.forEach(({ name, required, note }) => {
  const present = !!process.env[name];
  const icon = present ? '✓' : required ? '✗' : '·';
  if (!present && required) missingRequired = true;
  const status = present ? 'set' : required ? 'MISSING ← add to Vercel dashboard' : 'not set (optional)';
  console.log(`  ${icon}  ${name.padEnd(26)} ${status}`);
  if (!present && required) console.log(`       ${''.padEnd(26)} ↳ ${note}`);
});
if (missingRequired) {
  console.log('\n  ⚠  Add missing vars above to your .env file (local) or Vercel dashboard (production).\n');
} else {
  console.log('\n  All required vars present.\n');
}
// ─────────────────────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'digger-dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  // NOTE: express-session uses in-memory storage by default.
  // On Vercel serverless, function instances are stateless — sessions may not
  // persist between requests if they land on different instances.
  // For production with real traffic, replace with a persistent store:
  //   npm install connect-redis ioredis
  //   const RedisStore = require('connect-redis').default;
  //   store: new RedisStore({ client: redisClient })
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 2 * 60 * 60 * 1000 // 2 hours
  }
}));

app.use('/auth', authRoutes);
app.use('/api', apiRoutes);
app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Only start the HTTP server when run directly (not when imported by Vercel as a module)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🪲 Digger running at http://localhost:${PORT}\n`);
  });
}

// Export the Express app for Vercel serverless
module.exports = app;
