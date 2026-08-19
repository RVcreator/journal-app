/**
 * Daybook backend — proxies AI calls so API keys never touch the browser.
 * Runs entirely on Cloudflare Workers AI's FREE tier (~10,000 neurons/day,
 * no credit card required) — both the text analysis and image generation
 * steps use it, so the whole pipeline costs $0 at your one-entry-per-day scale.
 *
 * Get credentials (both free, no card needed):
 *   1. Sign up at https://dash.cloudflare.com
 *   2. Your Account ID is on the right side of the dashboard home page
 *   3. Create an API token: My Profile > API Tokens > Create Token >
 *      "Workers AI" template (or custom token with "Workers AI: Edit" permission)
 *
 * Local run:
 *   npm install
 *   node server.js
 *
 * Requires a .env file locally (see .env.example) with:
 *   CLOUDFLARE_ACCOUNT_ID=...
 *   CLOUDFLARE_API_TOKEN=...
 * On Render, set these as Environment Variables in the dashboard instead of a .env file.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const CF_BASE = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run`;
const CF_HEADERS = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
};

// ---------------------------------------------------------------
// STEP 1: Analyze the journal entry — extract mood + visual keywords
// Uses Cloudflare Workers AI's free Llama model (text-only, no cost)
// Model catalog: https://developers.cloudflare.com/workers-ai/models/
// ---------------------------------------------------------------
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

  const raw = data.result?.response ?? '{}';
  const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());

  if (!parsed.language_ok) {
    const err = new Error(parsed.reason_if_rejected || 'Entry rejected.');
    err.status = 422;
    throw err;
  }
  return parsed; // { mood, keywords, image_prompt }
}

// ---------------------------------------------------------------
// STEP 2: Generate the actual image from the AI-built prompt
// Uses Cloudflare Workers AI's free FLUX.1 Schnell model
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

  // FLUX Schnell on Workers AI returns base64-encoded PNG in result.image
  return `data:image/png;base64,${data.result.image}`;
}

// Individual endpoints — handy for testing each step in isolation
app.post('/api/analyze', async (req, res) => {
  try {
    res.json(await analyzeEntry(req.body.text));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/generate-image', async (req, res) => {
  try {
    const image_base64 = await generateImage(req.body.image_prompt, req.body.mood);
    res.json({ image_base64 });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------
// STEP 3: Combined endpoint — what the frontend actually calls
// ---------------------------------------------------------------
app.post('/api/entry-to-image', async (req, res) => {
  try {
    const analysis = await analyzeEntry(req.body.text);
    const image_base64 = await generateImage(analysis.image_prompt, analysis.mood);
    res.json({ ...analysis, image_base64 });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('Daybook backend is running.'));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Daybook backend running on port ${PORT}`));
