/*
 * GET /api/instagram/feed  —  Instagram Basic Display API proxy (Vercel Serverless)
 * ─────────────────────────────────────────────────────────────────────────────────
 * Fetches recent NAFUME Instagram posts server-side and returns safe JSON.
 * The access token is NEVER sent to the browser.
 *
 * Setup (one-time):
 *   1. Go to developers.facebook.com → My Apps → create an app (Business type)
 *   2. Add Instagram Graph API product
 *   3. Connect your Instagram Professional/Creator account
 *   4. Generate a long-lived User Access Token (valid 60 days; refresh via cron)
 *   5. Find your Instagram User ID via:
 *      GET https://graph.instagram.com/me?fields=id,username&access_token=YOUR_TOKEN
 *   6. Add to Vercel → Project → Settings → Environment Variables (Production + Preview):
 *        INSTAGRAM_ACCESS_TOKEN   — long-lived token from step 4
 *        INSTAGRAM_USER_ID        — numeric user ID from step 5
 *   7. Trigger a new Vercel deployment after adding env vars.
 *
 * Env vars required:
 *   INSTAGRAM_ACCESS_TOKEN
 *   INSTAGRAM_USER_ID
 *
 * Returns (safe, no tokens):
 *   { posts: [{ id, media_type, media_url, permalink, caption, timestamp }] }
 *   { posts: [] }  when env vars missing or API error (frontend falls back)
 */

// ─── In-memory cache (survives within the same serverless instance) ───────────
var _cache = { data: null, at: 0 };
var CACHE_TTL = 45 * 60 * 1000; // 45 minutes

// ─── Fields to request from Instagram Graph API ───────────────────────────────
var IG_FIELDS = 'id,media_type,media_url,thumbnail_url,permalink,caption,timestamp';
var IG_LIMIT  = 8;

module.exports = async function handler(req, res) {
  // Only allow GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // CORS: only allow same-origin and nafume.com
  var origin = req.headers.origin || '';
  if (!origin || origin.includes('nafume.com') || origin.includes('localhost') || origin.includes('vercel.app')) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }

  // Return cache if still fresh
  if (_cache.data && (Date.now() - _cache.at) < CACHE_TTL) {
    res.setHeader('Cache-Control', 'public, max-age=2700, stale-while-revalidate=900');
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(_cache.data);
  }

  var token  = process.env.INSTAGRAM_ACCESS_TOKEN;
  var userId = process.env.INSTAGRAM_USER_ID;

  // No env vars configured — return empty so frontend uses fallback
  if (!token || !userId) {
    return res.status(200).json({ posts: [], _info: 'env_not_configured' });
  }

  try {
    var apiUrl = [
      'https://graph.instagram.com/',
      encodeURIComponent(userId),
      '/media?fields=',
      IG_FIELDS,
      '&limit=',
      IG_LIMIT,
      '&access_token=',
      token
    ].join('');

    var ctrl  = new AbortController();
    var timer = setTimeout(function() { ctrl.abort(); }, 8000);
    var apiRes = await fetch(apiUrl, { signal: ctrl.signal });
    clearTimeout(timer);

    if (!apiRes.ok) {
      var errBody = await apiRes.text().catch(function () { return ''; });
      console.error('Instagram API error', apiRes.status, errBody);
      return res.status(200).json({ posts: [] });
    }

    var raw = await apiRes.json();

    // Build safe output — strip token, truncate caption
    var posts = (raw.data || []).map(function (p) {
      // VIDEO posts expose thumbnail_url for the still frame
      var imgUrl = (p.media_type === 'VIDEO') ? (p.thumbnail_url || '') : (p.media_url || '');
      return {
        id:         p.id,
        media_type: p.media_type,           // IMAGE | VIDEO | CAROUSEL_ALBUM
        media_url:  imgUrl,
        permalink:  p.permalink || 'https://www.instagram.com/nafume.official/',
        caption:    p.caption ? p.caption.slice(0, 150) : '',
        timestamp:  p.timestamp || ''
      };
    });

    // Filter out any entries where we couldn't get an image
    posts = posts.filter(function (p) { return p.media_url; });

    var result = { posts: posts };

    // Update in-memory cache
    _cache = { data: result, at: Date.now() };

    res.setHeader('Cache-Control', 'public, max-age=2700, stale-while-revalidate=900');
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(result);

  } catch (err) {
    console.error('Instagram feed fetch failed:', err.message);
    return res.status(200).json({ posts: [] });
  }
};
