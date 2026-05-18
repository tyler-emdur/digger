require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'digger-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 2 * 60 * 60 * 1000 // 2 hours
  }
}));

app.use('/auth', authRoutes);
app.use('/api', apiRoutes);
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback — lets the frontend JS handle routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🪲 Digger running at http://localhost:${PORT}\n`);
});
