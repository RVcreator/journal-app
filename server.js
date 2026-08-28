/**
 * Daybook backend — real auth + real database + free AI.
 *
 * - Postgres (hosted on Neon's free tier) stores users, entries, and cover prefs
 * - bcrypt hashes passwords (never stored in plain text)
 * - JWT gives each logged-in user a token (sent as "Authorization: Bearer <token>")
 * - Cloudflare Workers AI (free tier) still handles text analysis + image generation
 *
 * Local run:
 *   npm install
 *   node server.js
 *
 * Requires a .env file locally (see .env.example):
 *   DATABASE_URL=...        (from Neon)
 *   JWT_SECRET=...          (any long random string)
 *   CLOUDFLARE_ACCOUNT_ID=...
 *   CLOUDFLARE_API_TOKEN=...
 * On Render, set these as Environment Variables in the dashboard instead of a .env file.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // required for Neon
});

// ---------------------------------------------------------------
// Database setup — creates tables on startup if they don't exist yet
// ---------------------------------------------------------------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      first_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS entries (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      entry_date DATE NOT NULL,
      text_content TEXT NOT NULL,
      word_count INTEGER,
      mood TEXT,
      keywords JSONB,
      image_base64 TEXT,
      attached_images JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(user_id, entry_date)
    );
  `);
  // Safe to run even if the column already exists, and safe on a table that
  // already existed before this column was added.
  await pool.query(`
    ALTER TABLE entries ADD COLUMN IF NOT EXISTS attached_images JSONB DEFAULT '[]'::jsonb;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cover_prefs (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      color TEXT DEFAULT '#E8A15C',
      pattern TEXT DEFAULT 'solid',
      icon TEXT DEFAULT 'moonStars'
    );
  `);
  console.log('Database tables ready.');
}

// ---------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------
function formatFirstName(raw) {
  const firstWord = (raw || '').trim().split(/\s+/)[0] || '';
  return firstWord.charAt(0).toUpperCase() + firstWord.slice(1).toLowerCase();
}

function signToken(user) {
  return jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not logged in.' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Session expired — please log in again.' });
  }
}

// ---------------------------------------------------------------
// AUTH ROUTES
// ---------------------------------------------------------------
app.post('/api/signup', async (req, res) => {
  try {
    const { firstName, email, password } = req.body;
    if (!firstName || !email || !password) {
      return res.status(400).json({ error: 'Please fill in every field.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password needs to be at least 6 characters.' });
    }
    const cleanEmail = email.trim().toLowerCase();
    const cleanName = formatFirstName(firstName);

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [cleanEmail]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'An account with that email already exists — try logging in instead.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (first_name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, first_name, email',
      [cleanName, cleanEmail, passwordHash]
    );
    const user = result.rows[0];
    await pool.query('INSERT INTO cover_prefs (user_id) VALUES ($1)', [user.id]);

    const token = signToken(user);
    res.json({ token, user: { firstName: user.first_name, email: user.email } });
  } catch (err) {
    console.error('/api/signup failed:', err.message);
    res.status(500).json({ error: 'Signup failed. Try again.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Please fill in every field.' });
    const cleanEmail = email.trim().toLowerCase();

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [cleanEmail]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Incorrect email or password.' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect email or password.' });

    const token = signToken(user);
    res.json({ token, user: { firstName: user.first_name, email: user.email } });
  } catch (err) {
    console.error('/api/login failed:', err.message);
    res.status(500).json({ error: 'Login failed. Try again.' });
  }
});

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT first_name, email FROM users WHERE id = $1', [req.user.userId]);
    if (!result.rows.length) return res.status(404).json({ error: 'User not found.' });
    res.json({ user: { firstName: result.rows[0].first_name, email: result.rows[0].email } });
  } catch (err) {
    console.error('/api/me failed:', err.message);
    res.status(500).json({ error: 'Could not load account.' });
  }
});

// ---------------------------------------------------------------
// COVER PREFERENCES
// ---------------------------------------------------------------
app.get('/api/cover-prefs', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT color, pattern, icon FROM cover_prefs WHERE user_id = $1', [req.user.userId]);
    res.json(result.rows[0] || { color: '#E8A15C', pattern: 'solid', icon: 'moonStars' });
  } catch (err) {
    console.error('/api/cover-prefs GET failed:', err.message);
    res.status(500).json({ error: 'Could not load cover preferences.' });
  }
});

app.put('/api/cover-prefs', requireAuth, async (req, res) => {
  try {
    const { color, pattern, icon } = req.body;
    await pool.query(
      `INSERT INTO cover_prefs (user_id, color, pattern, icon) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id) DO UPDATE SET color=$2, pattern=$3, icon=$4`,
      [req.user.userId, color, pattern, icon]
    );
    res.json({ color, pattern, icon });
  } catch (err) {
    console.error('/api/cover-prefs PUT failed:', err.message);
    res.status(500).json({ error: 'Could not save cover preferences.' });
  }
});

// ---------------------------------------------------------------
// ENTRIES
// ---------------------------------------------------------------
app.get('/api/entries', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT entry_date, text_content, word_count, mood, keywords, image_base64, attached_images FROM entries WHERE user_id = $1 ORDER BY entry_date',
      [req.user.userId]
    );
    const entries = {};
    for (const row of result.rows) {
      const dateKey = row.entry_date.toISOString().slice(0, 10);
      entries[dateKey] = {
        text: row.text_content,
        wordCount: row.word_count,
        mood: row.mood,
        keywords: row.keywords,
        imageUrl: row.image_base64,
        attachedImages: row.attached_images || [],
      };
    }
    res.json(entries);
  } catch (err) {
    console.error('/api/entries GET failed:', err.message);
    res.status(500).json({ error: 'Could not load entries.' });
  }
});

// ---------------------------------------------------------------
// STEP 1: Analyze the journal entry — extract mood + visual keywords
// Uses Cloudflare Workers AI's free Llama model
// ---------------------------------------------------------------
const CF_BASE = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run`;
const CF_HEADERS = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
};

async function analyzeEntry(text) {
  if (!text || text.trim().split(/\s+/).length < 100) {
    const err = new Error('Entry must be at least 100 words.');
    err.status = 400;
    throw err;
  }

  const response = await fetch(`${CF_BASE}/@cf/meta/llama-3.1-8b-instruct`, {
    method: 'POST',
    headers: CF_HEADERS,
    body: JSON.stringify({
      messages: [
        {
          role: 'user',
          content: `Read this journal entry and respond with ONLY valid JSON, no other text, no markdown fences:
{
  "mood": one of ["sunny","cloudy","rainy","stormy","cozy"],
  "keywords": [3 short concrete visual nouns/scenes from the entry, lowercase],
  "image_prompt": "one vivid sentence describing an illustration that captures the mood and a hint of the day's events, no people's real names",
  "language_ok": true or false (false if the entry is not coherent English),
  "reason_if_rejected": "" or a short reason if language_ok is false
}

Journal entry:
"""
${text}
"""`,
        },
      ],
    }),
  });

  const data = await response.json();
  if (!data.success) throw new Error(data.errors?.[0]?.message || 'Cloudflare AI error');

  let raw = data.result?.response;
  if (typeof raw !== 'string') raw = JSON.stringify(raw ?? {});

  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch (e) {
    console.error('Could not parse model output as JSON:', raw);
    throw new Error('The AI response was not valid JSON — try again.');
  }

  if (!parsed.language_ok) {
    const err = new Error(parsed.reason_if_rejected || 'Entry rejected.');
    err.status = 422;
    throw err;
  }
  return parsed;
}

// ---------------------------------------------------------------
// STEP 2: Generate the actual image — Cloudflare's free FLUX.1 Schnell
// ---------------------------------------------------------------
async function generateImage(image_prompt, mood) {
  const fullPrompt = `Hand-drawn doodle illustration, notebook sketch style, black ink outlines,
soft pastel watercolor wash, warm cream paper background. Mood: ${mood}. Scene: ${image_prompt}`;

  const response = await fetch(`${CF_BASE}/@cf/black-forest-labs/flux-1-schnell`, {
    method: 'POST',
    headers: CF_HEADERS,
    body: JSON.stringify({ prompt: fullPrompt, steps: 4 }),
  });

  const data = await response.json();
  if (!data.success) throw new Error(data.errors?.[0]?.message || 'Cloudflare image error');
  return `data:image/png;base64,${data.result.image}`;
}

// ---------------------------------------------------------------
// POST /api/entries — the real save-a-day-entry endpoint the frontend calls.
// Enforces one-per-day at the database level (UNIQUE constraint), analyzes,
// generates the image, and stores everything in one go.
// ---------------------------------------------------------------
app.post('/api/entries', requireAuth, async (req, res) => {
  try {
    const { text, attachedImages, date } = req.body;
    const images = Array.isArray(attachedImages) ? attachedImages.slice(0, 3) : [];

    // The client sends its own local calendar date (YYYY-MM-DD) so "today" always
    // matches what the user's device considers today, regardless of server timezone.
    const entryDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10);

    const existing = await pool.query(
      'SELECT id FROM entries WHERE user_id = $1 AND entry_date = $2',
      [req.user.userId, entryDate]
    );
    if (existing.rows.length) {
      return res.status(409).json({ error: "You've already journaled today — come back tomorrow." });
    }

    const analysis = await analyzeEntry(text);
    const image_base64 = await generateImage(analysis.image_prompt, analysis.mood);
    const wordCount = text.trim().split(/\s+/).length;

    await pool.query(
      `INSERT INTO entries (user_id, entry_date, text_content, word_count, mood, keywords, image_base64, attached_images)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [req.user.userId, entryDate, text, wordCount, analysis.mood, JSON.stringify(analysis.keywords), image_base64, JSON.stringify(images)]
    );

    res.json({ mood: analysis.mood, keywords: analysis.keywords, image_base64, wordCount });
  } catch (err) {
    console.error('/api/entries POST failed:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('Daybook backend is running.'));

const PORT = process.env.PORT || 3001;
initDb()
  .then(() => app.listen(PORT, () => console.log(`Daybook backend running on port ${PORT}`)))
  .catch(err => {
    console.error('Failed to initialize database:', err.message);
    process.exit(1);
  });
