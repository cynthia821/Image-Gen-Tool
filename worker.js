// Temper & Forge — Image Generation Worker
// Deploys to Cloudflare Workers (free tier)
// Store your fal.ai key as a Worker secret named FAL_API_KEY
//
// Models used:
//   fal-ai/nano-banana-pro            — text-only generation (no style ref)
//   krea/v2/medium/text-to-image      — style reference generation (image_style_references)

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Map Recraft-style image_size values to aspect_ratio strings.
// Two maps: nano-banana-pro supports 3:4, Krea v2 does not (uses 2:3 instead).
function mapAspectRatio(imageSize, forKrea = false) {
  const map = {
    'landscape_16_9': '16:9',
    'landscape_4_3':  '4:3',
    'square_hd':      '1:1',
    'square':         '1:1',
    'portrait_4_3':   forKrea ? '2:3' : '3:4',
    'portrait_16_9':  '9:16',
  };
  return map[imageSize] || '16:9';
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (err) {
      return json({ error: `Worker error: ${err?.message || String(err)}` }, 500);
    }
  },
};

async function handle(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Health check — lets the tool verify the worker is reachable
  if (request.method === 'GET') {
    return json({ status: 'ok' });
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const key = env.FAL_API_KEY;
  if (!key) {
    return json({ error: 'FAL_API_KEY secret is not configured on this Worker.' }, 500);
  }

  let prompt, image_size, style_ref, style_strength;
  try {
    ({ prompt, image_size, style_ref, style_strength } = await request.json());
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!prompt) {
    return json({ error: 'prompt is required' }, 400);
  }

  const strength = typeof style_strength === 'number' ? style_strength : 0.8;

  // Choose endpoint and build payload
  let endpoint, falBody;

  if (style_ref) {
    // Krea 2 Medium — supports image_style_references with per-reference strength
    endpoint = 'https://fal.run/krea/v2/medium/text-to-image';
    falBody = {
      prompt,
      aspect_ratio:           mapAspectRatio(image_size, true),
      creativity:             'low',
      image_style_references: [{ image_url: style_ref, strength }],
    };
  } else {
    // Nano Banana Pro — text-only, best quality for pure prompts
    endpoint = 'https://fal.run/fal-ai/nano-banana-pro';
    falBody = {
      prompt,
      aspect_ratio:  mapAspectRatio(image_size, false),
      output_format: 'png',
    };
  }

  const falRes = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Key ${key}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(falBody),
  });

  const falData = await falRes.json();

  if (!falRes.ok) {
    const errRaw = falData.detail || falData.message || `fal.ai error ${falRes.status}`;
    const errStr = typeof errRaw === 'string' ? errRaw : JSON.stringify(errRaw);
    return json({ error: `fal.ai ${falRes.status}: ${errStr}` }, falRes.status);
  }

  const imageUrl = falData.images?.[0]?.url;
  if (!imageUrl) {
    return json({ error: 'No image returned from fal.ai', raw: JSON.stringify(falData).slice(0, 200) }, 502);
  }

  // Return the CDN URL directly — avoids base64 conversion which can exceed
  // Cloudflare Workers' CPU time limit and crash the worker mid-response.
  // fal.ai CDN URLs (v3b.fal.media / v3.fal.media) are permanent GCS links.
  return json({ imageUrl });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
