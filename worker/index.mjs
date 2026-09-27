/**
 * IRAQ DARK — Cloudflare Worker entry point.
 *
 * - /api/*  -> routes defined in ./app.mjs (D1)
 * - everything else -> static assets from ./dist
 * - scheduled cron  -> expired session cleanup
 */

import {
  buildRoutes,
  cleanupSessions,
  createDb,
  ensureSchema,
  runChain,
  ApiResponse,
  COOKIE_NAME,
  SECURE_HEADERS,
  JSON_LIMIT
} from './app.mjs';

const router = buildRoutes();

const ALLOWED_ORIGINS = [
  'http://localhost:4000',
  'http://127.0.0.1:4000',
  'http://localhost:8787',
  'https://iraq-dark.laethking131.workers.dev'
];

function parseQuery(searchParams) {
  const query = {};
  for (const [key, value] of searchParams) {
    if (!(key in query)) query[key] = value;
  }
  return query;
}

function parseBody(text) {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function parseCookies(header) {
  const jar = {};
  if (!header) return jar;

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    try {
      jar[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      jar[name] = part.slice(index + 1).trim();
    }
  }

  return jar;
}

function applyCors(request, res, url) {
  const origin = request.headers.get('Origin');
  if (!origin) return;

  const sameOrigin = origin === url.origin;
  const allowed = sameOrigin || ALLOWED_ORIGINS.includes(origin) ||
    (request.headers.get('Host') && origin === `https://${request.headers.get('Host')}`);

  if (!allowed) return;

  res.headers.set('Access-Control-Allow-Origin', origin);
  res.headers.set('Access-Control-Allow-Credentials', 'true');
  res.headers.set('Vary', 'Origin');
  res.headers.set(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Requested-With'
  );
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
}

async function handleApi(request, url, env) {
  const method = request.method.toUpperCase();
  const db = createDb(env);

  await ensureSchema(db);

  if (method === 'OPTIONS') {
    const res = new ApiResponse();
    res.status(204);
    applyCors(request, res, url);
    return res.toResponse();
  }

  const res = new ApiResponse();
  res.set(SECURE_HEADERS);
  applyCors(request, res, url);

  let body = {};
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const text = await request.text();
      if (text.length > JSON_LIMIT) {
        res.status(413).json({ error: 'حجم الطلب كبير جدا' });
        return res.toResponse();
      }
      body = parseBody(text);
    }
  }

  const req = {
    method,
    url,
    path: url.pathname,
    query: parseQuery(url.searchParams),
    params: {},
    body,
    headers: request.headers,
    cookies: parseCookies(request.headers.get('Cookie')),
    ip: request.headers.get('CF-Connecting-IP') ||
      request.headers.get('X-Forwarded-For') ||
      request.headers.get('X-Real-IP') ||
      'anonymous',
    secure: url.protocol === 'https:',
    db,
    user: null
  };

  // `req.get('x-forwarded-proto')` compatibility with the Express code.
  req.get = name => request.headers.get(name);

  req.user = await db.prepare(`
    SELECT
      users.id, users.username, users.email, users.role, users.created_at,
      users.is_banned
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.id = ? AND sessions.expires_at > datetime('now')
  `).get(req.cookies[COOKIE_NAME] || '') || null;

  const matched = router.match(method, url.pathname);

  if (matched) {
    req.params = matched.params;
    try {
      await runChain(matched.handlers, req, res);
    } catch (error) {
      console.error('route error', error);
      if (!res.sent) {
        res.status(500).json({ error: 'حدث خطأ في الخادم' });
      }
    }
  } else if (!res.sent) {
    res.status(404).json({ error: 'المسار غير موجود' });
  }

  return res.toResponse();
}

async function serveAsset(request, url, env) {
  const assetResponse = await env.ASSETS.fetch(request);
  if (assetResponse.status !== 404) return assetResponse;

  // SPA fallback (hash routing only ever needs index.html).
  if (request.method === 'GET' || request.method === 'HEAD') {
    const indexRequest = new Request(new URL('/index.html', url.origin), {
      method: 'GET',
      headers: request.headers
    });
    const indexResponse = await env.ASSETS.fetch(indexRequest);
    if (indexResponse.status === 200) {
      const headers = new Headers(indexResponse.headers);
      headers.set('Cache-Control', 'no-cache');
      return new Response(indexResponse.body, { status: 200, headers });
    }
  }

  return assetResponse;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        return await handleApi(request, url, env);
      }
      return await serveAsset(request, url, env);
    } catch (error) {
      console.error('worker error', error);
      const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
      for (const [key, value] of Object.entries(SECURE_HEADERS)) headers.set(key, value);
      return new Response(JSON.stringify({ error: 'حدث خطأ في الخادم' }), {
        status: 500,
        headers
      });
    }
  },

  async scheduled(_event, env) {
    try {
      const db = createDb(env);
      await ensureSchema(db);
      const result = await cleanupSessions(db);
      console.log('sessions cleaned', JSON.stringify(result));
    } catch (error) {
      console.error('scheduled cleanup failed', error);
      throw error;
    }
  }
};
