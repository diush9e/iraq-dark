/**
 * IRAQ DARK — API for Cloudflare Workers + D1
 *
 * Port of server/server.cjs:
 *   - better-sqlite3 (sync)  -> D1 (async) via req.db
 *   - express               -> tiny router in this file
 *   - bcrypt                -> PBKDF2-SHA256 via Web Crypto
 *   - setInterval cleanup    -> cron trigger (see worker/index.mjs)
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SESSION_DAYS = 7;
const COOKIE_NAME = 'session_id';
const JSON_LIMIT = 200 * 1024;
const PBKDF2_ITERATIONS = 100000;

const SECURE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};

// ---------------------------------------------------------------------------
// Schema (idempotent — applied once per isolate)
// ---------------------------------------------------------------------------

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    is_banned INTEGER NOT NULL DEFAULT 0,
    banned_reason TEXT NOT NULL DEFAULT '',
    banned_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (category_id) REFERENCES categories(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`,
  `CREATE TABLE IF NOT EXISTS replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`,
  `CREATE TABLE IF NOT EXISTS user_profiles (
    user_id INTEGER PRIMARY KEY,
    bio TEXT NOT NULL DEFAULT '',
    avatar_url TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS follows (
    follower_id INTEGER NOT NULL,
    following_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (follower_id, following_id),
    CHECK (follower_id <> following_id),
    FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (following_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    actor_id INTEGER,
    type TEXT NOT NULL,
    topic_id INTEGER,
    message TEXT NOT NULL,
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS likes (
    user_id INTEGER NOT NULL,
    topic_id INTEGER,
    reply_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (
      (topic_id IS NOT NULL AND reply_id IS NULL)
      OR
      (topic_id IS NULL AND reply_id IS NOT NULL)
    ),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE,
    FOREIGN KEY (reply_id) REFERENCES replies(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS bookmarks (
    user_id INTEGER NOT NULL,
    topic_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, topic_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS topic_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER NOT NULL,
    user_id INTEGER,
    viewer_key TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS topic_media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'image',
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_topic_media_topic ON topic_media(topic_id, position)`,
  `CREATE INDEX IF NOT EXISTS idx_topics_category ON topics(category_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_topics_user ON topics(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_replies_topic ON replies(topic_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id)`,
  `CREATE INDEX IF NOT EXISTS idx_likes_topic ON likes(topic_id)`,
  `CREATE INDEX IF NOT EXISTS idx_likes_reply ON likes(reply_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`
];

const CATEGORY_RENAMES = [['General', 'عام'], ['Gaming', 'ألعاب'], ['Technology', 'تقنية']];

const CATEGORY_SEEDS = [
  ['عام', 'النقاشات العامة والأسئلة اليومية'],
  ['ألعاب', 'الألعاب والسيرفرات واللاعبون'],
  ['تقنية', 'البرمجة والتقنية والأجهزة'],
  ['ترفيه', 'الأفلام والموسيقى والهوايات']
];

let schemaReady = false;

async function ensureSchema(db) {
  if (schemaReady) return;

  await db.batch(SCHEMA.map(sql => [sql]));

  for (const [oldName, newName] of CATEGORY_RENAMES) {
    try {
      await db.prepare('UPDATE categories SET name = ? WHERE name = ?').run(newName, oldName);
    } catch {
      // Target name already exists — nothing to migrate.
    }
  }

  for (const [name, description] of CATEGORY_SEEDS) {
    try {
      await db.prepare('INSERT OR IGNORE INTO categories (name, description) VALUES (?, ?)')
        .run(name, description);
    } catch {
      // Duplicate — already seeded.
    }
  }

  schemaReady = true;
}

// ---------------------------------------------------------------------------
// D1 adapter — better-sqlite3 shaped, but async
// ---------------------------------------------------------------------------

function bindArgs(args) {
  return args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
}

function createDb(env) {
  const d1 = env.DB;

  return {
    prepare(sql) {
      const stmt = () => d1.prepare(sql);
      const bound = args => {
        const values = bindArgs(args);
        return values.length ? stmt().bind(...values) : stmt();
      };

      return {
        async get(...args) {
          const row = await bound(args).first();
          return row === null ? undefined : row;
        },
        async all(...args) {
          const result = await bound(args).all();
          return result.results;
        },
        async run(...args) {
          const result = await bound(args).run();
          return {
            changes: result.meta?.changes ?? 0,
            lastInsertRowid: result.meta?.last_row_id ?? 0
          };
        }
      };
    },

    /** Atomic multi-statement run. Accepts [[sql, ...args], ...]. */
    async batch(statements) {
      const stmts = statements.map(([sql, ...args]) => {
        const values = bindArgs(args);
        const prepared = d1.prepare(sql);
        return values.length ? prepared.bind(...values) : prepared;
      });
      return d1.batch(stmts);
    }
  };
}

// ---------------------------------------------------------------------------
// Crypto (Web Crypto only — no node:crypto on Workers)
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();

function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function randomHex(bytes) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, value => value.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function deriveBits(password, salt, iterations, lengthBits) {
  const key = await crypto.subtle.importKey('raw', textEncoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    lengthBits
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await deriveBits(password, salt, PBKDF2_ITERATIONS, 256);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(derived)}`;
}

export async function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('pbkdf2$')) return false;

  const [, iterationsRaw, saltRaw, hashRaw] = stored.split('$');
  const iterations = Number(iterationsRaw);

  if (!Number.isInteger(iterations) || iterations < 1000 || !saltRaw || !hashRaw) return false;

  try {
    const salt = fromBase64(saltRaw);
    const expected = fromBase64(hashRaw);
    const derived = await deriveBits(password, salt, iterations, expected.length * 8);
    return constantTimeEqual(derived, expected);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

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

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value ?? '')}`];

  if (options.maxAge != null) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge / 1000))}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);

  return parts.join('; ');
}

// ---------------------------------------------------------------------------
// Request / response
// ---------------------------------------------------------------------------

class ApiResponse {
  constructor() {
    this.statusCode = 200;
    this.headers = new Headers();
    this.cookies = [];
    this.sent = false;
    this.body = null;
    this.contentType = null;
    this.onSent = null;
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  set(fields) {
    for (const [key, value] of Object.entries(fields)) this.headers.set(key, value);
    return this;
  }

  json(data) {
    this.send(JSON.stringify(data), 'application/json; charset=utf-8');
    return this;
  }

  cookie(name, value, options = {}) {
    this.cookies.push(serializeCookie(name, value, options));
    return this;
  }

  clearCookie(name, options = {}) {
    this.cookies.push(serializeCookie(name, '', { ...options, maxAge: 0 }));
    return this;
  }

  send(body, contentType) {
    if (this.sent) return;
    this.sent = true;
    this.body = body;
    this.contentType = contentType;
    if (this.onSent) this.onSent();
  }

  toResponse() {
    const headers = new Headers(this.headers);
    if (this.contentType) headers.set('Content-Type', this.contentType);
    for (const cookie of this.cookies) headers.append('Set-Cookie', cookie);

    const status = this.statusCode === 204 ? 204 : this.statusCode;
    return new Response(this.body, { status, headers });
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const routeCache = new Map();

function compile(path) {
  if (routeCache.has(path)) return routeCache.get(path);

  const keys = [];
  const pattern = path
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\/:([^/]+)/g, (_, key) => {
      keys.push(key);
      return '/([^/]+)';
    });

  const compiled = { regex: new RegExp(`^${pattern}$`), keys };
  routeCache.set(path, compiled);
  return compiled;
}

function runChain(handlers, req, res) {
  return new Promise((resolve, reject) => {
    let index = -1;

    // A handler that responds without calling next() ends the chain here.
    res.onSent = resolve;

    const next = error => {
      if (error) return reject(error);
      if (res.sent) return resolve();

      index += 1;
      if (index >= handlers.length) return resolve();

      let output;
      try {
        output = handlers[index](req, res, next);
      } catch (err) {
        return reject(err);
      }

      if (output && typeof output.then === 'function') output.catch(next);
      return undefined;
    };

    next();
  });
}

function createRouter() {
  const routes = [];

  const register = method => (path, ...handlers) => {
    routes.push({ method, path, handlers });
  };

  return {
    get: register('GET'),
    post: register('POST'),
    patch: register('PATCH'),
    delete: register('DELETE'),

    match(method, pathname) {
      for (const route of routes) {
        if (route.method !== method) continue;
        const { regex, keys } = compile(route.path);
        const found = regex.exec(pathname);
        if (!found) continue;

        const params = {};
        keys.forEach((key, i) => { params[key] = decodeURIComponent(found[i + 1]); });
        return { handlers: route.handlers, params };
      }
      return null;
    }
  };
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

// ---------------------------------------------------------------------------
// Rate limiting (best effort, per isolate)
// ---------------------------------------------------------------------------

const buckets = new Map();

function rateLimit({ windowMs = 60000, max = 30, name }) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${name}:${req.ip}`;

    // Lazy sweep keeps the map small without a timer.
    if (buckets.size > 500) {
      for (const [entry, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(entry);
      }
    }

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    if (bucket.count > max) {
      return res.status(429).json({ error: 'عدد كبير من المحاولات، حاول بعد دقيقة' });
    }

    return next();
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cleanText(value, maxLength) {
  const text = String(value || '').trim();
  if (!text || text.length > maxLength) return null;
  return text;
}

function cleanInt(value) {
  const num = Number(value);
  return Number.isInteger(num) ? num : null;
}

function toIso(value) {
  if (!value) return null;
  const raw = String(value).trim();
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
}

async function createSession(db, userId) {
  const id = randomHex(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();

  await db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .run(id, userId, expires);

  return { id, expires };
}

function setSessionCookie(req, res, session) {
  res.cookie(COOKIE_NAME, session.id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: SESSION_DAYS * 86400000,
    path: '/'
  });
}

async function getUser(req) {
  const sessionId = req.cookies[COOKIE_NAME];
  if (!sessionId) return null;

  const row = await req.db.prepare(`
    SELECT
      users.id, users.username, users.email, users.role, users.created_at,
      users.is_banned
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.id = ? AND sessions.expires_at > datetime('now')
  `).get(sessionId);

  return row || null;
}

function requireUser(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'يجب تسجيل الدخول أولا' });
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'يجب تسجيل الدخول أولا' });
  }
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'هذه الصفحة مخصصة للمديرين فقط' });
  }
  return next();
}

function requireNotBanned(req, res, next) {
  if (req.user && Number(req.user.is_banned) === 1) {
    return res.status(403).json({ error: 'حسابك موقوف عن النشر — تواصل مع الإدارة' });
  }
  return next();
}

async function notify(db, { userId, actorId, type, topicId = null, message }) {
  if (!userId || userId === actorId) return;

  await db.prepare(`
    INSERT INTO notifications (user_id, actor_id, type, topic_id, message)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, actorId, type, topicId, message);
}

function topicSelect(meId, { full = false } = {}) {
  const contentColumn = full ? 't.content' : 'substr(t.content, 1, 260) AS excerpt';

  return `
    SELECT
      t.id,
      t.category_id,
      t.title,
      ${contentColumn},
      t.created_at,
      c.name AS category,
      u.id AS author_id,
      u.username,
      COALESCE(p.avatar_url, '') AS author_avatar,
      (SELECT COUNT(*) FROM replies r WHERE r.topic_id = t.id) AS reply_count,
      (SELECT COUNT(*) FROM likes l WHERE l.topic_id = t.id) AS like_count,
      (SELECT COUNT(*) FROM topic_views v WHERE v.topic_id = t.id) AS view_count,
      EXISTS(SELECT 1 FROM likes l WHERE l.topic_id = t.id AND l.user_id = ${Number(meId) || -1}) AS liked,
      EXISTS(SELECT 1 FROM bookmarks b WHERE b.topic_id = t.id AND b.user_id = ${Number(meId) || -1}) AS bookmarked
    FROM topics t
    JOIN categories c ON c.id = t.category_id
    JOIN users u ON u.id = t.user_id
    LEFT JOIN user_profiles p ON p.user_id = u.id
  `;
}

function replySelect(meId) {
  return `
    SELECT
      r.id, r.content, r.created_at,
      u.id AS author_id,
      u.username,
      COALESCE(p.avatar_url, '') AS author_avatar,
      (SELECT COUNT(*) FROM likes l WHERE l.reply_id = r.id) AS like_count,
      EXISTS(SELECT 1 FROM likes l WHERE l.reply_id = r.id AND l.user_id = ${Number(meId) || -1}) AS liked
    FROM replies r
    JOIN users u ON u.id = r.user_id
    LEFT JOIN user_profiles p ON p.user_id = u.id
  `;
}

/* ---- media ---- */

export const MAX_MEDIA_PER_TOPIC = 4;
const MEDIA_URL_PATTERN = /^\/media\/[A-Za-z0-9_-]+\.[a-z0-9]{2,5}$/;

/** Returns null when the caller did not send a media list (keep what exists). */
function cleanMedia(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return [];

  const out = [];
  for (const item of value) {
    if (out.length >= MAX_MEDIA_PER_TOPIC) break;
    const url = String(item?.url || '');
    if (!MEDIA_URL_PATTERN.test(url)) continue;
    out.push({ url, kind: item?.kind === 'video' ? 'video' : 'image' });
  }
  return out;
}

async function attachMedia(db, rows) {
  if (!rows.length) return rows;

  const ids = rows.map(row => row.id);
  const placeholders = ids.map(() => '?').join(',');

  const media = await db.prepare(`
    SELECT topic_id, url, kind
    FROM topic_media
    WHERE topic_id IN (${placeholders})
    ORDER BY position, id
  `).all(ids);

  const grouped = new Map();
  for (const item of media) {
    if (!grouped.has(item.topic_id)) grouped.set(item.topic_id, []);
    grouped.get(item.topic_id).push(item);
  }

  for (const row of rows) row.media = grouped.get(row.id) || [];
  return rows;
}

async function replaceTopicMedia(db, topicId, media) {
  await db.prepare('DELETE FROM topic_media WHERE topic_id = ?').run(topicId);

  for (let position = 0; position < media.length; position += 1) {
    const item = media[position];
    await db.prepare(
      'INSERT INTO topic_media (topic_id, url, kind, position) VALUES (?, ?, ?, ?)'
    ).run(topicId, item.url, item.kind, position);
  }
}

/* ---- storage ---- */

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MEDIA_FILENAME_PATTERN = /^[A-Za-z0-9_-]+\.[a-z0-9]{2,5}$/;

const UPLOAD_EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov'
};

const EXTENSION_TYPES = Object.fromEntries(
  Object.entries(UPLOAD_EXTENSIONS).map(([type, ext]) => [ext, type])
);
EXTENSION_TYPES.jpeg = EXTENSION_TYPES.jpg;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function findSessionUser(db, sessionId) {
  if (!sessionId) return null;

  return db.prepare(`
    SELECT
      users.id, users.username, users.email, users.role, users.created_at,
      users.is_banned
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.id = ? AND sessions.expires_at > datetime('now')
  `).get(sessionId) || null;
}

/**
 * Store one uploaded file (Workers KV) and return its public URL.
 * `purpose` is `topic` (feed attachment) or `avatar`.
 *
 * KV values cap at 25MB, so uploads are capped at 20MB to leave headroom.
 */
export async function storeUpload(request, url, env) {
  if (request.method !== 'POST') {
    throw new HttpError(405, 'طريقة الطلب غير مدعومة');
  }

  const db = createDb(env);
  await ensureSchema(db);

  const cookies = parseCookies(request.headers.get('Cookie'));
  const user = await findSessionUser(db, cookies[COOKIE_NAME] || '');

  if (!user) throw new HttpError(401, 'يجب تسجيل الدخول أولا');
  if (user.is_banned) throw new HttpError(403, 'هذا الحساب موقوف');

  const purpose = url.searchParams.get('purpose') || 'topic';
  if (purpose !== 'topic' && purpose !== 'avatar') {
    throw new HttpError(400, 'غرض الرفع غير صالح');
  }

  const contentType = (request.headers.get('content-type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase();

  const extension = UPLOAD_EXTENSIONS[contentType];
  if (!extension) {
    throw new HttpError(415, 'نوع الملف غير مدعوم (صور: jpg png webp gif avif — فيديو: mp4 webm mov)');
  }

  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_UPLOAD_BYTES) {
    throw new HttpError(413, 'الملف أكبر من الحد المسموح (20MB)');
  }

  const buffer = await request.arrayBuffer();
  if (buffer.byteLength === 0) throw new HttpError(400, 'الملف فارغ');
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new HttpError(413, 'الملف أكبر من الحد المسموح (20MB)');
  }

  if (!env.MEDIA) {
    throw new HttpError(503, 'الرفع المباشر غير مفعّل على الخادم');
  }

  const filename = purpose === 'avatar'
    ? `a${user.id}.${extension}`
    : `t${user.id}_${randomHex(9)}.${extension}`;

  await env.MEDIA.put(filename, buffer, {
    metadata: { contentType, kind: contentType.startsWith('video/') ? 'video' : 'image', bytes: buffer.byteLength }
  });

  return {
    url: `/media/${filename}`,
    kind: contentType.startsWith('video/') ? 'video' : 'image',
    bytes: buffer.byteLength
  };
}

/** Stream a stored file back out, with HTTP range support so <video> can seek. */
export async function serveMedia(request, url, env) {
  const filename = url.pathname.slice('/media/'.length);

  if (!MEDIA_FILENAME_PATTERN.test(filename)) {
    throw new HttpError(404, 'الملف غير موجود');
  }

  if (!env.MEDIA) throw new HttpError(503, 'الرفع المباشر غير مفعّل على الخادم');

  const stored = await env.MEDIA.get(filename, 'arrayBuffer');
  if (!stored) throw new HttpError(404, 'الملف غير موجود');

  const size = stored.byteLength;
  const contentType =
    EXTENSION_TYPES[filename.split('.').pop()] || 'application/octet-stream';

  const baseHeaders = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename="${filename}"`
  };

  if (request.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: { ...baseHeaders, 'Content-Length': String(size) }
    });
  }

  const range = parseByteRange(request.headers.get('Range'), size);

  if (!range) {
    return new Response(stored, {
      status: 200,
      headers: { ...baseHeaders, 'Content-Length': String(size) }
    });
  }

  if (range.start > range.end || range.start >= size) {
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` }
    });
  }

  return new Response(stored.slice(range.start, range.end + 1), {
    status: 206,
    headers: {
      ...baseHeaders,
      'Content-Length': String(range.end - range.start + 1),
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`
    }
  });
}

function parseByteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;

  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start) || start >= size) return null;

  const end = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isFinite(end) || end < start) return null;

  return { start, end: Math.min(end, size - 1) };
}

function decorateTopic(row) {
  if (!row) return row;
  return { ...row, created_at: toIso(row.created_at) };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const authLimiter = rateLimit({ name: 'auth', windowMs: 60000, max: 20 });
const ROLES = ['admin', 'member'];

const ADMIN_USER_SELECT = `
  SELECT
    u.id, u.username, u.email, u.role, u.is_banned, u.banned_reason, u.banned_at,
    u.created_at,
    COALESCE(p.avatar_url, '') AS avatar_url,
    (SELECT COUNT(*) FROM topics t WHERE t.user_id = u.id) AS topic_count,
    (SELECT COUNT(*) FROM replies r WHERE r.user_id = u.id) AS reply_count
  FROM users u
  LEFT JOIN user_profiles p ON p.user_id = u.id
`;

async function loadAdminTarget(req, res) {
  const userId = cleanInt(req.params.id);

  if (!userId) {
    res.status(400).json({ error: 'معرف المستخدم غير صحيح' });
    return null;
  }

  const user = await req.db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(userId);

  if (!user) {
    res.status(404).json({ error: 'المستخدم غير موجود' });
    return null;
  }

  return user;
}

async function adminGuard(req, res, target, action) {
  if (target.id !== req.user.id || target.role !== 'admin') return true;

  const row = await req.db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get();
  if (row.c > 1) return true;

  res.status(400).json({ error: `لا يمكن ${action} آخر مدير في الموقع` });
  return false;
}

export function buildRoutes() {
  const router = createRouter();

  // ---- Auth ----
  router.get('/api/health', (req, res) => {
    res.json({ ok: true, service: 'iraq-dark-api', time: new Date().toISOString() });
  });

  router.post('/api/auth/register', authLimiter, asyncRoute(async (req, res) => {
    const db = req.db;
    const username = String(req.body.username || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
      return res.status(400).json({ error: 'اسم المستخدم يجب أن يكون 3-24 حرفاً أو رقماً (بالإنجليزية)' });
    }

    if (!email.includes('@') || email.length > 120) {
      return res.status(400).json({ error: 'البريد الإلكتروني غير صحيح' });
    }

    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: 'كلمة المرور يجب أن تكون بين 8 و128 حرفاً' });
    }

    const passwordHash = await hashPassword(password);
    const result = await db.prepare('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)')
      .run(username, email, passwordHash);

    await db.prepare('INSERT OR IGNORE INTO user_profiles (user_id) VALUES (?)')
      .run(result.lastInsertRowid);

    const session = await createSession(db, result.lastInsertRowid);
    setSessionCookie(req, res, session);

    return res.status(201).json({
      user: { id: result.lastInsertRowid, username, email, role: 'member' }
    });
  }));

  router.post('/api/auth/login', authLimiter, asyncRoute(async (req, res) => {
    const db = req.db;
    const identifier = String(req.body.usernameOrEmail || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    const user = await db.prepare(
      'SELECT * FROM users WHERE lower(username) = ? OR lower(email) = ?'
    ).get(identifier, identifier);

    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
    }

    const session = await createSession(db, user.id);
    setSessionCookie(req, res, session);

    return res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        created_at: toIso(user.created_at)
      }
    });
  }));

  router.post('/api/auth/logout', asyncRoute(async (req, res) => {
    const sessionId = req.cookies[COOKIE_NAME];

    if (sessionId) {
      await req.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    }

    res.clearCookie(COOKIE_NAME, { path: '/' });
    return res.json({ ok: true });
  }));

  router.get('/api/auth/me', (req, res) => {
    res.json({ user: req.user });
  });

  // ---- Profile ----
  router.get('/api/profile', requireUser, asyncRoute(async (req, res) => {
    const profile = await req.db.prepare(`
      SELECT
        users.id, users.username, users.email, users.role, users.created_at,
        COALESCE(p.bio, '') AS bio,
        COALESCE(p.avatar_url, '') AS avatar_url
      FROM users
      LEFT JOIN user_profiles p ON p.user_id = users.id
      WHERE users.id = ?
    `).get(req.user.id);

    res.json({ profile: { ...profile, created_at: toIso(profile.created_at) } });
  }));

  router.patch('/api/profile', requireUser, requireNotBanned, asyncRoute(async (req, res) => {
    const db = req.db;
    const patch = {};

    if (req.body.bio !== undefined) {
      patch.bio = String(req.body.bio).trim();
      if (patch.bio.length > 300) {
        return res.status(400).json({ error: 'النبذة أطول من الحد المسموح (300 حرف)' });
      }
    }

    if (req.body.avatar_url !== undefined) {
      patch.avatar_url = String(req.body.avatar_url).trim();

      if (patch.avatar_url) {
        const localUpload = /^\/media\/[A-Za-z0-9_-]+\.[a-z0-9]{2,5}$/.test(patch.avatar_url);
        const remote = /^https?:\/\/[^\s]{3,500}$/.test(patch.avatar_url);

        if (!localUpload && !remote) {
          return res.status(400).json({ error: 'رابط الصورة غير صالح' });
        }
      }
    }

    if (req.body.username !== undefined) {
      patch.username = String(req.body.username).trim();

      if (!/^[a-zA-Z0-9_]{3,24}$/.test(patch.username)) {
        return res.status(400).json({ error: 'اسم المستخدم يجب أن يكون 3-24 حرفاً أو رقماً (بالإنجليزية)' });
      }

      const taken = await db.prepare('SELECT 1 FROM users WHERE username = ? AND id <> ?')
        .get(patch.username, req.user.id);

      if (taken) return res.status(409).json({ error: 'اسم المستخدم مستخدم من حساب آخر' });
    }

    const current = await db.prepare(
      'SELECT bio, avatar_url FROM user_profiles WHERE user_id = ?'
    ).get(req.user.id) || { bio: '', avatar_url: '' };

    const bio = 'bio' in patch ? patch.bio : current.bio;
    const avatarUrl = 'avatar_url' in patch ? patch.avatar_url : current.avatar_url;

    await db.prepare(`
      INSERT INTO user_profiles (user_id, bio, avatar_url, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        bio = excluded.bio,
        avatar_url = excluded.avatar_url,
        updated_at = CURRENT_TIMESTAMP
    `).run(req.user.id, bio, avatarUrl);

    if (patch.username && patch.username !== req.user.username) {
      await db.prepare('UPDATE users SET username = ? WHERE id = ?')
        .run(patch.username, req.user.id);
    }

    return res.json({
      ok: true,
      bio,
      avatar_url: avatarUrl,
      username: patch.username || req.user.username
    });
  }));

  router.get('/api/users/:id/profile', asyncRoute(async (req, res) => {
    const userId = cleanInt(req.params.id);

    if (!userId) {
      return res.status(400).json({ error: 'معرف المستخدم غير صحيح' });
    }

    const profile = await req.db.prepare(`
      SELECT
        users.id, users.username, users.email, users.role, users.created_at,
        COALESCE(p.bio, '') AS bio,
        COALESCE(p.avatar_url, '') AS avatar_url,
        (SELECT COUNT(*) FROM topics WHERE topics.user_id = users.id) AS topic_count,
        (SELECT COUNT(*) FROM replies WHERE replies.user_id = users.id) AS reply_count,
        (SELECT COUNT(*) FROM follows WHERE follows.following_id = users.id) AS followers_count,
        (SELECT COUNT(*) FROM follows WHERE follows.follower_id = users.id) AS following_count,
        (
          (SELECT COUNT(*) FROM likes l JOIN topics lt ON lt.id = l.topic_id WHERE lt.user_id = users.id)
          +
          (SELECT COUNT(*) FROM likes l JOIN replies lr ON lr.id = l.reply_id WHERE lr.user_id = users.id)
        ) AS likes_received,
        (
          SELECT COUNT(*) FROM topic_views v JOIN topics lt ON lt.id = v.topic_id WHERE lt.user_id = users.id
        ) AS views_received
      FROM users
      LEFT JOIN user_profiles p ON p.user_id = users.id
      WHERE users.id = ?
    `).get(userId);

    if (!profile) {
      return res.status(404).json({ error: 'المستخدم غير موجود' });
    }

    const viewer = req.user;
    const isFollowing = viewer && viewer.id !== userId
      ? Boolean(await req.db.prepare(
          'SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?'
        ).get(viewer.id, userId))
      : false;

    return res.json({
      profile: {
        ...profile,
        email: viewer && viewer.id === userId ? profile.email : undefined,
        created_at: toIso(profile.created_at)
      },
      isFollowing,
      isSelf: Boolean(viewer && viewer.id === userId)
    });
  }));

  router.post('/api/users/:id/follow', requireUser, requireNotBanned, asyncRoute(async (req, res) => {
    const db = req.db;
    const followingId = cleanInt(req.params.id);

    if (!followingId) {
      return res.status(400).json({ error: 'معرف المستخدم غير صحيح' });
    }

    if (followingId === req.user.id) {
      return res.status(400).json({ error: 'لا يمكنك متابعة نفسك' });
    }

    const target = await db.prepare('SELECT id, username FROM users WHERE id = ?').get(followingId);

    if (!target) {
      return res.status(404).json({ error: 'المستخدم غير موجود' });
    }

    const already = await db.prepare(
      'SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?'
    ).get(req.user.id, followingId);

    if (already) {
      await db.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?')
        .run(req.user.id, followingId);
    } else {
      await db.prepare('INSERT INTO follows (follower_id, following_id) VALUES (?, ?)')
        .run(req.user.id, followingId);

      await notify(db, {
        userId: followingId,
        actorId: req.user.id,
        type: 'follow',
        message: `${req.user.username} بدأ بمتابعتك`
      });
    }

    const following = !already;
    const followersCount = await db.prepare(
      'SELECT COUNT(*) AS c FROM follows WHERE following_id = ?'
    ).get(followingId);

    res.json({ following, followers_count: followersCount.c });
  }));

  // ---- Categories + stats ----
  router.get('/api/categories', asyncRoute(async (req, res) => {
    const categories = await req.db.prepare(`
      SELECT
        c.id, c.name, c.description,
        (SELECT COUNT(*) FROM topics t WHERE t.category_id = c.id) AS topic_count
      FROM categories c
      ORDER BY c.id
    `).all();

    res.json({ categories });
  }));

  router.get('/api/stats', asyncRoute(async (req, res) => {
    const stats = await req.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM topics) AS topics,
        (SELECT COUNT(*) FROM replies) AS replies,
        (SELECT COUNT(*) FROM users) AS members,
        (SELECT COUNT(*) FROM sessions WHERE expires_at > datetime('now')) AS online
    `).get();

    res.json({ stats });
  }));

  // ---- Topics ----
  router.get('/api/topics', asyncRoute(async (req, res) => {
    const db = req.db;
    const meId = req.user ? req.user.id : -1;
    const search = String(req.query.q || '').trim().slice(0, 100);
    const categoryId = cleanInt(req.query.category);
    const authorId = cleanInt(req.query.author);
    const sort = ['new', 'top', 'active'].includes(req.query.sort) ? req.query.sort : 'new';

    const page = Math.max(1, cleanInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, cleanInt(req.query.limit) || 10));

    const where = [];
    const values = [];

    if (search) {
      where.push(`(t.title LIKE ? ESCAPE '\\' OR t.content LIKE ? ESCAPE '\\')`);
      const pattern = `%${search.replace(/[\\%_]/g, ch => `\\${ch}`)}%`;
      values.push(pattern, pattern);
    }

    if (categoryId) {
      where.push('t.category_id = ?');
      values.push(categoryId);
    }

    if (authorId) {
      where.push('t.user_id = ?');
      values.push(authorId);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const orderSql = {
      new: 'ORDER BY t.created_at DESC',
      top: 'ORDER BY like_count DESC, reply_count DESC, t.created_at DESC',
      active: 'ORDER BY reply_count DESC, t.created_at DESC'
    }[sort];

    const totalRow = await db.prepare(`SELECT COUNT(*) AS c FROM topics t ${whereSql}`).get(...values);
    const total = totalRow.c;

    const rows = await db.prepare(`
      ${topicSelect(meId)}
      ${whereSql}
      ${orderSql}
      LIMIT ? OFFSET ?
    `).all([...values, limit, (page - 1) * limit]);

    await attachMedia(db, rows);

    res.json({
      topics: rows.map(decorateTopic),
      pagination: {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit))
      }
    });
  }));

  router.post('/api/topics', requireUser, requireNotBanned, asyncRoute(async (req, res) => {
    const db = req.db;
    const media = cleanMedia(req.body.media) || [];
    const title = cleanText(req.body.title, 120);
    const body = String(req.body.content || '').trim();
    const content = body.length > 10000 ? null : body;
    const categoryId = cleanInt(req.body.categoryId);

    if (!title || content === null || !categoryId || (!content && !media.length)) {
      return res.status(400).json({ error: 'العنوان والمحتوى والقسم مطلوبة' });
    }

    const category = await db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId);

    if (!category) {
      return res.status(400).json({ error: 'القسم غير موجود' });
    }

    const result = await db.prepare(
      'INSERT INTO topics (category_id, user_id, title, content) VALUES (?, ?, ?, ?)'
    ).run(categoryId, req.user.id, title, content);

    await replaceTopicMedia(db, result.lastInsertRowid, media);

    const topic = await db.prepare(`${topicSelect(req.user.id)} WHERE t.id = ?`)
      .get(result.lastInsertRowid);

    await attachMedia(db, [topic]);

    return res.status(201).json({ topic: decorateTopic(topic) });
  }));

  router.get('/api/topics/:id', asyncRoute(async (req, res) => {
    const db = req.db;
    const topicId = cleanInt(req.params.id);

    if (!topicId) {
      return res.status(400).json({ error: 'معرف الموضوع غير صحيح' });
    }

    const meId = req.user ? req.user.id : -1;
    const topic = await db.prepare(`${topicSelect(meId, { full: true })} WHERE t.id = ?`).get(topicId);

    if (!topic) {
      return res.status(404).json({ error: 'الموضوع غير موجود' });
    }

    const viewerKey = req.user ? `u:${req.user.id}` : `ip:${req.ip || 'anon'}`;

    const recentView = await db.prepare(`
      SELECT 1 FROM topic_views
      WHERE topic_id = ? AND viewer_key = ?
        AND created_at > datetime('now', '-1 day')
    `).get(topicId, viewerKey);

    if (!recentView) {
      await db.prepare('INSERT INTO topic_views (topic_id, user_id, viewer_key) VALUES (?, ?, ?)')
        .run(topicId, req.user ? req.user.id : null, viewerKey);
    }

    const replies = await db.prepare(`
      ${replySelect(meId)}
      WHERE r.topic_id = ?
      ORDER BY r.created_at ASC, r.id ASC
    `).all(topicId);

    await attachMedia(db, [topic]);

    res.json({
      topic: decorateTopic(topic),
      replies: replies.map(reply => ({ ...reply, created_at: toIso(reply.created_at) }))
    });
  }));

  router.patch('/api/topics/:id', requireUser, requireNotBanned, asyncRoute(async (req, res) => {
    const db = req.db;
    const topicId = cleanInt(req.params.id);
    const topic = topicId ? await db.prepare('SELECT * FROM topics WHERE id = ?').get(topicId) : null;

    if (!topic) return res.status(404).json({ error: 'الموضوع غير موجود' });
    if (topic.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'لا تملك صلاحية تعديل هذا الموضوع' });
    }

    const media = cleanMedia(req.body.media);
    const title = cleanText(req.body.title, 120);
    const body = String(req.body.content || '').trim();
    const content = body.length > 10000 ? null : body;
    const categoryId = cleanInt(req.body.categoryId);

    const hasMedia = media
      ? media.length > 0
      : Boolean(await db.prepare('SELECT 1 FROM topic_media WHERE topic_id = ?').get(topicId));

    if (!title || content === null || !categoryId || (!content && !hasMedia)) {
      return res.status(400).json({ error: 'العنوان والمحتوى والقسم مطلوبة' });
    }

    await db.prepare('UPDATE topics SET title = ?, content = ?, category_id = ? WHERE id = ?')
      .run(title, content, categoryId, topicId);

    if (media) await replaceTopicMedia(db, topicId, media);

    const updated = await db.prepare(`${topicSelect(req.user.id)} WHERE t.id = ?`).get(topicId);
    await attachMedia(db, [updated]);
    return res.json({ topic: decorateTopic(updated) });
  }));

  router.delete('/api/topics/:id', requireUser, asyncRoute(async (req, res) => {
    const db = req.db;
    const topicId = cleanInt(req.params.id);
    const topic = topicId ? await db.prepare('SELECT * FROM topics WHERE id = ?').get(topicId) : null;

    if (!topic) return res.status(404).json({ error: 'الموضوع غير موجود' });
    if (topic.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'لا تملك صلاحية حذف هذا الموضوع' });
    }

    // Explicit deletes keep this correct even without FK cascade enforcement.
    await db.batch([
      ['DELETE FROM replies WHERE topic_id = ?', topicId],
      ['DELETE FROM topic_media WHERE topic_id = ?', topicId],
      ['DELETE FROM likes WHERE topic_id = ?', topicId],
      ['DELETE FROM bookmarks WHERE topic_id = ?', topicId],
      ['DELETE FROM topic_views WHERE topic_id = ?', topicId],
      ['DELETE FROM notifications WHERE topic_id = ?', topicId],
      ['DELETE FROM topics WHERE id = ?', topicId]
    ]);

    return res.json({ ok: true });
  }));

  router.post('/api/topics/:id/like', requireUser, requireNotBanned, asyncRoute(async (req, res) => {
    const db = req.db;
    const topicId = cleanInt(req.params.id);
    const topic = topicId ? await db.prepare('SELECT * FROM topics WHERE id = ?').get(topicId) : null;

    if (!topic) return res.status(404).json({ error: 'الموضوع غير موجود' });

    const existing = await db.prepare(
      'SELECT 1 FROM likes WHERE user_id = ? AND topic_id = ?'
    ).get(req.user.id, topicId);

    if (existing) {
      await db.prepare('DELETE FROM likes WHERE user_id = ? AND topic_id = ?')
        .run(req.user.id, topicId);
    } else {
      await db.prepare('INSERT INTO likes (user_id, topic_id) VALUES (?, ?)')
        .run(req.user.id, topicId);

      await notify(db, {
        userId: topic.user_id,
        actorId: req.user.id,
        type: 'like',
        topicId,
        message: `${req.user.username} أعجب بموضوعك: ${topic.title}`
      });
    }

    const likeCount = await db.prepare('SELECT COUNT(*) AS c FROM likes WHERE topic_id = ?')
      .get(topicId);

    return res.json({ liked: !existing, like_count: likeCount.c });
  }));

  router.post('/api/topics/:id/bookmark', requireUser, asyncRoute(async (req, res) => {
    const db = req.db;
    const topicId = cleanInt(req.params.id);
    const topic = topicId ? await db.prepare('SELECT id FROM topics WHERE id = ?').get(topicId) : null;

    if (!topic) return res.status(404).json({ error: 'الموضوع غير موجود' });

    const existing = await db.prepare(
      'SELECT 1 FROM bookmarks WHERE user_id = ? AND topic_id = ?'
    ).get(req.user.id, topicId);

    if (existing) {
      await db.prepare('DELETE FROM bookmarks WHERE user_id = ? AND topic_id = ?')
        .run(req.user.id, topicId);
    } else {
      await db.prepare('INSERT INTO bookmarks (user_id, topic_id) VALUES (?, ?)')
        .run(req.user.id, topicId);
    }

    return res.json({ bookmarked: !existing });
  }));

  router.get('/api/bookmarks', requireUser, asyncRoute(async (req, res) => {
    const db = req.db;

    const rows = await db.prepare(`
      SELECT b.topic_id AS id, b.created_at AS saved_at
      FROM bookmarks b
      WHERE b.user_id = ?
      ORDER BY b.created_at DESC
      LIMIT 100
    `).all(req.user.id);

    const topics = [];
    for (const row of rows) {
      const topic = await db.prepare(`${topicSelect(req.user.id)} WHERE t.id = ?`).get(row.id);
      if (topic) topics.push(decorateTopic(topic));
    }

    res.json({ topics });
  }));

  // ---- Replies ----
  router.post('/api/topics/:id/replies', requireUser, requireNotBanned, asyncRoute(async (req, res) => {
    const db = req.db;
    const topicId = cleanInt(req.params.id);
    const content = cleanText(req.body.content, 5000);

    if (!topicId || !content) {
      return res.status(400).json({ error: 'معرف الموضوع والرد مطلوبان' });
    }

    const topic = await db.prepare('SELECT id, user_id, title FROM topics WHERE id = ?').get(topicId);

    if (!topic) {
      return res.status(404).json({ error: 'الموضوع غير موجود' });
    }

    const result = await db.prepare('INSERT INTO replies (topic_id, user_id, content) VALUES (?, ?, ?)')
      .run(topicId, req.user.id, content);

    await notify(db, {
      userId: topic.user_id,
      actorId: req.user.id,
      type: 'reply',
      topicId,
      message: `${req.user.username} ردّ على موضوعك: ${topic.title}`
    });

    const reply = await db.prepare(`
      ${replySelect(req.user.id)}
      WHERE r.id = ?
    `).get(result.lastInsertRowid);

    return res.status(201).json({ reply: { ...reply, created_at: toIso(reply.created_at) } });
  }));

  router.delete('/api/replies/:id', requireUser, asyncRoute(async (req, res) => {
    const db = req.db;
    const replyId = cleanInt(req.params.id);
    const reply = replyId
      ? await db.prepare('SELECT id, user_id, topic_id FROM replies WHERE id = ?').get(replyId)
      : null;

    if (!reply) return res.status(404).json({ error: 'الرد غير موجود' });
    if (reply.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'لا تملك صلاحية حذف هذا الرد' });
    }

    await db.prepare('DELETE FROM replies WHERE id = ?').run(replyId);
    return res.json({ ok: true });
  }));

  router.post('/api/replies/:id/like', requireUser, requireNotBanned, asyncRoute(async (req, res) => {
    const db = req.db;
    const replyId = cleanInt(req.params.id);
    const reply = replyId
      ? await db.prepare('SELECT id, user_id, topic_id FROM replies WHERE id = ?').get(replyId)
      : null;

    if (!reply) return res.status(404).json({ error: 'الرد غير موجود' });

    const existing = await db.prepare('SELECT 1 FROM likes WHERE user_id = ? AND reply_id = ?')
      .get(req.user.id, replyId);

    if (existing) {
      await db.prepare('DELETE FROM likes WHERE user_id = ? AND reply_id = ?')
        .run(req.user.id, replyId);
    } else {
      await db.prepare('INSERT INTO likes (user_id, reply_id) VALUES (?, ?)')
        .run(req.user.id, replyId);

      await notify(db, {
        userId: reply.user_id,
        actorId: req.user.id,
        type: 'like',
        topicId: reply.topic_id,
        message: `${req.user.username} أعجاب بردّك`
      });
    }

    const likeCount = await db.prepare('SELECT COUNT(*) AS c FROM likes WHERE reply_id = ?')
      .get(replyId);

    return res.json({ liked: !existing, like_count: likeCount.c });
  }));

  // ---- Notifications ----
  router.get('/api/notifications', requireUser, asyncRoute(async (req, res) => {
    const notifications = await req.db.prepare(`
      SELECT
        n.id, n.type, n.message, n.topic_id, n.is_read, n.created_at,
        u.username AS actor_username
      FROM notifications n
      LEFT JOIN users u ON u.id = n.actor_id
      WHERE n.user_id = ?
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT 50
    `).all(req.user.id);

    res.json({
      notifications: notifications.map(item => ({ ...item, created_at: toIso(item.created_at) }))
    });
  }));

  router.get('/api/notifications/unread-count', requireUser, asyncRoute(async (req, res) => {
    const count = await req.db.prepare(
      'SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0'
    ).get(req.user.id);

    res.json({ count: count.c });
  }));

  router.post('/api/notifications/read', requireUser, asyncRoute(async (req, res) => {
    const db = req.db;
    const id = cleanInt(req.body.id);

    if (id) {
      await db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?')
        .run(id, req.user.id);
    } else {
      await db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
    }

    const count = await db.prepare(
      'SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0'
    ).get(req.user.id);

    res.json({ ok: true, count: count.c });
  }));

  // ---- Admin ----
  router.get('/api/admin/overview', requireUser, requireAdmin, asyncRoute(async (req, res) => {
    const stats = await req.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM users) AS members,
        (SELECT COUNT(*) FROM users WHERE role = 'admin') AS admins,
        (SELECT COUNT(*) FROM users WHERE is_banned = 1) AS banned,
        (SELECT COUNT(*) FROM users WHERE created_at >= datetime('now', '-7 days')) AS week_members,
        (SELECT COUNT(*) FROM topics) AS topics,
        (SELECT COUNT(*) FROM replies) AS replies,
        (SELECT COUNT(*) FROM sessions WHERE expires_at > datetime('now')) AS online
    `).get();

    res.json({ stats });
  }));

  router.get('/api/admin/users', requireUser, requireAdmin, asyncRoute(async (req, res) => {
    const db = req.db;
    const search = String(req.query.q || '').trim().slice(0, 100);
    const role = ROLES.includes(req.query.role) ? req.query.role : '';
    const status = ['banned', 'active'].includes(req.query.status) ? req.query.status : '';

    const page = Math.max(1, cleanInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, cleanInt(req.query.limit) || 20));

    const where = [];
    const values = [];

    if (search) {
      where.push(`(u.username LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')`);
      const pattern = `%${search.replace(/[\\%_]/g, ch => `\\${ch}`)}%`;
      values.push(pattern, pattern);
    }

    if (role) {
      where.push('u.role = ?');
      values.push(role);
    }

    if (status === 'banned') where.push('u.is_banned = 1');
    if (status === 'active') where.push('u.is_banned = 0');

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const totalRow = await db.prepare(`SELECT COUNT(*) AS c FROM users u ${whereSql}`).get(...values);

    const rows = await db.prepare(`
      ${ADMIN_USER_SELECT}
      ${whereSql}
      ORDER BY (u.id = ?) DESC, u.created_at DESC
      LIMIT ? OFFSET ?
    `).all([...values, req.user.id, limit, (page - 1) * limit]);

    res.json({
      users: rows.map(row => ({
        ...row,
        is_banned: Number(row.is_banned) === 1,
        created_at: toIso(row.created_at),
        banned_at: toIso(row.banned_at)
      })),
      pagination: {
        page,
        limit,
        total: totalRow.c,
        pages: Math.max(1, Math.ceil(totalRow.c / limit))
      }
    });
  }));

  router.patch('/api/admin/users/:id', requireUser, requireAdmin, asyncRoute(async (req, res) => {
    const db = req.db;
    const target = await loadAdminTarget(req, res);
    if (!target) return undefined;

    const updates = [];
    const values = [];
    const messages = [];

    if (req.body.role !== undefined) {
      const role = String(req.body.role);

      if (!ROLES.includes(role)) {
        return res.status(400).json({ error: 'الدور غير صالح' });
      }

      if (role !== target.role) {
        if (role === 'member' && !(await adminGuard(req, res, target, 'تخفيض صلاحية'))) {
          return undefined;
        }

        updates.push('role = ?');
        values.push(role);
        messages.push(role === 'admin' ? 'ترقية إلى مدير' : 'تخفيض إلى عضو');
      }
    }

    if (req.body.is_banned !== undefined) {
      const banned = Boolean(req.body.is_banned);

      if (banned && !(await adminGuard(req, res, target, 'إيقاف'))) return undefined;

      const reason = banned
        ? String(req.body.banned_reason || 'مخالفة قوانين المنتدى').trim().slice(0, 200)
        : '';

      updates.push('is_banned = ?', 'banned_reason = ?', 'banned_at = ?');
      values.push(banned ? 1 : 0, reason, banned ? new Date().toISOString() : null);
      messages.push(banned ? 'إيقاف عن النشر' : 'رفع الإيقاف');

      if (banned) {
        await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
      }
    }

    if (req.body.username !== undefined) {
      const username = String(req.body.username).trim();

      if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
        return res.status(400).json({ error: 'اسم المستخدم يجب أن يكون 3-24 حرفاً أو رقماً (بالإنجليزية)' });
      }

      const taken = await db.prepare(
        'SELECT 1 FROM users WHERE username = ? AND id <> ?'
      ).get(username, target.id);

      if (taken) return res.status(409).json({ error: 'اسم المستخدم مستخدم من حساب آخر' });

      if (username !== target.username) {
        updates.push('username = ?');
        values.push(username);
        messages.push('تعديل اسم المستخدم');
      }
    }

    if (req.body.email !== undefined) {
      const email = String(req.body.email).trim().toLowerCase();

      if (!email.includes('@') || email.length > 120) {
        return res.status(400).json({ error: 'البريد الإلكتروني غير صحيح' });
      }

      const taken = await db.prepare(
        'SELECT 1 FROM users WHERE lower(email) = ? AND id <> ?'
      ).get(email, target.id);

      if (taken) return res.status(409).json({ error: 'البريد مستخدم من حساب آخر' });

      updates.push('email = ?');
      values.push(email);
      messages.push('تعديل البريد الإلكتروني');
    }

    if (!updates.length) {
      return res.json({ ok: true, changed: [] });
    }

    await db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`)
      .run([...values, target.id]);

    const user = await db.prepare(`${ADMIN_USER_SELECT} WHERE u.id = ?`).get(target.id);

    return res.json({
      ok: true,
      changed: messages,
      user: {
        ...user,
        is_banned: Number(user.is_banned) === 1,
        created_at: toIso(user.created_at),
        banned_at: toIso(user.banned_at)
      }
    });
  }));

  router.delete('/api/admin/users/:id', requireUser, requireAdmin, asyncRoute(async (req, res) => {
    const db = req.db;
    const target = await loadAdminTarget(req, res);
    if (!target) return undefined;

    if (target.id === req.user.id) {
      return res.status(400).json({ error: 'لا يمكنك حذف حسابك من هذه الصفحة' });
    }

    if (target.role === 'admin' && !(await adminGuard(req, res, target, 'حذف'))) {
      return undefined;
    }

    // Explicit deletes first: topics/replies FKs to users are not cascading.
    await db.batch([
      ['DELETE FROM replies WHERE user_id = ?', target.id],
      ['DELETE FROM likes WHERE user_id = ?', target.id],
      ['DELETE FROM bookmarks WHERE user_id = ?', target.id],
      ['DELETE FROM follows WHERE follower_id = ? OR following_id = ?', target.id, target.id],
      ['DELETE FROM notifications WHERE user_id = ? OR actor_id = ?', target.id, target.id],
      ['DELETE FROM topic_views WHERE user_id = ?', target.id],
      ['DELETE FROM notifications WHERE topic_id IN (SELECT id FROM topics WHERE user_id = ?)', target.id],
      ['DELETE FROM topic_media WHERE topic_id IN (SELECT id FROM topics WHERE user_id = ?)', target.id],
      ['DELETE FROM likes WHERE topic_id IN (SELECT id FROM topics WHERE user_id = ?)', target.id],
      ['DELETE FROM bookmarks WHERE topic_id IN (SELECT id FROM topics WHERE user_id = ?)', target.id],
      ['DELETE FROM topic_views WHERE topic_id IN (SELECT id FROM topics WHERE user_id = ?)', target.id],
      ['DELETE FROM replies WHERE topic_id IN (SELECT id FROM topics WHERE user_id = ?)', target.id],
      ['DELETE FROM topics WHERE user_id = ?', target.id],
      ['DELETE FROM user_profiles WHERE user_id = ?', target.id],
      ['DELETE FROM sessions WHERE user_id = ?', target.id],
      ['DELETE FROM users WHERE id = ?', target.id]
    ]);

    return res.json({ ok: true, deleted: target.username });
  }));

  return router;
}

export async function cleanupSessions(db) {
  await db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
}

export {
  COOKIE_NAME,
  ensureSchema,
  createDb,
  runChain,
  ApiResponse,
  SECURE_HEADERS,
  JSON_LIMIT
};
