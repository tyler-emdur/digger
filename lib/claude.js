const Anthropic = require('@anthropic-ai/sdk');

let _client;
function client() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

const SYSTEM_PROMPT = `You are a music writer for an underground discovery app. Write a single evocative sentence (max 12 words) describing why this artist fits the user's taste. Style examples:
'Feels like Snow Strippers after staying up too late'
'Sounds like if Alex G made bloghouse'
'A colder, more fragmented version of Title Fight'
'Sits somewhere between fakemink and early Salem'
Rules: always name one of the user's actual artists. Never use the word "tagged". Sound like a friend, not a database. Output only the sentence — no quotes, no punctuation wrapping.`;

async function generateBlurb({ candidateArtist, candidateTags, viaArtist, userTopArtists, energyDelta }) {
  const tagsStr   = candidateTags.slice(0, 5).join(', ') || 'unknown genre';
  const artistStr = userTopArtists.slice(0, 5).join(', ');
  const content = `Artist: ${candidateArtist}
Tags: ${tagsStr}
Connected via: ${viaArtist || artistStr.split(',')[0]}
User listens to: ${artistStr}
Energy character vs user: ${energyDelta || 'similar'}
Write one sentence.`;

  const msg = await client().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 48,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }]
  });
  return msg.content[0]?.text?.trim().replace(/^["'`]|["'`]$/g, '') || null;
}

// Generate blurbs for an array of track metadata objects, in parallel.
// Falls back to null on individual failures — caller keeps existing blurb.
async function generateBlurbsBatch(items) {
  return Promise.all(items.map(item =>
    generateBlurb(item).catch(() => null)
  ));
}

// Generate a single blurb for the "most unexpected match" callout that
// references both pillars it scored highly in.
async function generateUnexpectedBlurb({ candidateArtist, pillar1, pillar2, userTopArtists }) {
  const PILLAR_LABELS = {
    introspective: 'introspective/folk side',
    rock:          'rock/punk side',
    experimental:  'experimental/IDM side',
    electronic:    'electronic side',
    hiphop:        'hip-hop side'
  };
  const p1 = PILLAR_LABELS[pillar1] || pillar1;
  const p2 = PILLAR_LABELS[pillar2] || pillar2;
  const artistStr = userTopArtists.slice(0, 4).join(', ');
  const content = `Artist: ${candidateArtist}
User listens to: ${artistStr}
This artist scored highly on BOTH the user's ${p1} AND their ${p2}.
Write one sentence that references both sides. Max 14 words.`;

  const msg = await client().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 56,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }]
  });
  return msg.content[0]?.text?.trim().replace(/^["'`]|["'`]$/g, '') || null;
}

module.exports = { generateBlurbsBatch, generateUnexpectedBlurb };
