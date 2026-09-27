/**
 * IRAQ DARK — API server + static hosting
 *
 * - Express 5 + better-sqlite3 (WAL)
 * - Cookie sessions stored in DB (7 days)
 * - Topics: search / filter / pagination / views / likes / bookmarks
 * - Replies: create / delete / likes
 * - Profiles: bio + avatar, follow / unfollow, follower counts
 * - Notifications: follow, reply, like + unread counter
 * - Serves the production build (dist/) when it exists
 */

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 4000;
const HOST = process.env.HOST || '0.0.0.0';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SESSION_DAYS = 7;
const COOKIE_NAME = 'session_id';
const projectRoot = path.join(__dirname, '..');
const dataDir = path.join(projectRoot, 'data');
const distDir = path.join(projectRoot, 'dist');

fs.mkdirSync(dataDir, { recursive: true });

// ---------------------------------------------------------------------------
// Database + schema (idempotent, safe to run on every start)
// ---------------------------------------------------------------------------

const db = new Database(path.join(dataDir, 'iraq-dark.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/** Add a column to an existing table when the schema is upgraded. */
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info("${table}")`).all();

  if (!columns.some(col => col.name === column)) {
    db.exec(`ALTER TABLE "${table}" ADD COLUMN ${column} ${definition}`);
  }
}

function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      is_banned INTEGER NOT NULL DEFAULT 0,
      banned_reason TEXT NOT NULL DEFAULT '',
      banned_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES categories(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id INTEGER PRIMARY KEY,
      bio TEXT NOT NULL DEFAULT '',
      avatar_url TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS follows (
      follower_id INTEGER NOT NULL,
      following_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (follower_id, following_id),
      CHECK (follower_id <> following_id),
      FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (following_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS notifications (
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
    );

    CREATE TABLE IF NOT EXISTS likes (
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
    );

    CREATE TABLE IF NOT EXISTS bookmarks (
      user_id INTEGER NOT NULL,
      topic_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, topic_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS topic_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id INTEGER NOT NULL,
      user_id INTEGER,
      viewer_key TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS topic_media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'image',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_topic_media_topic ON topic_media(topic_id, position);
    CREATE INDEX IF NOT EXISTS idx_topics_category ON topics(category_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_topics_user ON topics(user_id);
    CREATE INDEX IF NOT EXISTS idx_replies_topic ON replies(topic_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read, created_at);
    CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);
    CREATE INDEX IF NOT EXISTS idx_likes_topic ON likes(topic_id);
    CREATE INDEX IF NOT EXISTS idx_likes_reply ON likes(reply_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  `);

  // Upgrade pre-existing databases (users created before the admin panel).
  ensureColumn('users', 'is_banned', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'banned_reason', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('users', 'banned_at', 'TEXT');

  seedCategories();
}

/** Migrate legacy English category names to Arabic, then make sure all exist. */
function seedCategories() {
  const migrations = [
    ['General', 'عام'],
    ['Gaming', 'ألعاب'],
    ['Technology', 'تقنية']
  ];

  const rename = db.prepare('UPDATE categories SET name = ? WHERE name = ?');

  for (const [oldName, newName] of migrations) {
    try {
      rename.run(newName, oldName);
    } catch {
      // Target name already exists — nothing to migrate.
    }
  }

  const seed = db.prepare('INSERT OR IGNORE INTO categories (name, description) VALUES (?, ?)');
  seed.run('عام', 'النقاشات العامة والأسئلة اليومية');
  seed.run('ألعاب', 'الألعاب والسيرفرات واللاعبون');
  seed.run('تقنية', 'البرمجة والتقنية والأجهزة');
  seed.run('ترفيه', 'الأفلام والموسيقى والهوايات');
}

ensureSchema();

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

/** SQLite stores UTC timestamps as "YYYY-MM-DD HH:MM:SS" — normalise to ISO. */
function toIso(value) {
  if (!value) return null;
  const raw = String(value).trim();
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
}

function createSession(userId) {
  const id = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();

  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .run(id, userId, expires);

  return { id, expires };
}

function setSessionCookie(req, res, session) {
  const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const isHttps = req.secure || /^https$/i.test(forwardedProto);

  res.cookie(COOKIE_NAME, session.id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps,
    maxAge: SESSION_DAYS * 86400000,
    path: '/'
  });
}

function getUser(req) {
  const sessionId = req.cookies[COOKIE_NAME];
  if (!sessionId) return null;

  const row = db.prepare(`
    SELECT
      users.id, users.username, users.email, users.role, users.created_at,
      users.is_banned,
      COALESCE(p.avatar_url, '') AS avatar_url
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    LEFT JOIN user_profiles p ON p.user_id = users.id
    WHERE sessions.id = ? AND sessions.expires_at > datetime('now')
  `).get(sessionId);

  return row || null;
}

function optionalUser(req, res, next) {
  req.user = getUser(req);
  next();
}

function requireUser(req, res, next) {
  const user = getUser(req);

  if (!user) {
    return res.status(401).json({ error: 'يجب تسجيل الدخول أولا' });
  }

  req.user = user;
  next();
}

/** Admin-only routes: 401 when logged out, 403 when not an admin. */
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'يجب تسجيل الدخول أولا' });
  }

  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'هذه الصفحة مخصصة للمديرين فقط' });
  }

  next();
}

/** Banned members may browse, but they cannot publish anything. */
function requireNotBanned(req, res, next) {
  if (req.user && Number(req.user.is_banned) === 1) {
    return res.status(403).json({ error: 'حسابك موقوف عن النشر — تواصل مع الإدارة' });
  }

  next();
}

/** Small in-memory rate limiter (per IP, per route group). */
function rateLimit({ windowMs = 60000, max = 30, name }) {
  const buckets = new Map();

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, windowMs);

  if (typeof sweeper.unref === 'function') sweeper.unref();

  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${name}:${ip}`;
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    if (bucket.count > max) {
      return res.status(429).json({ error: 'عدد كبير من المحاولات، حاول بعد دقيقة' });
    }

    next();
  };
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function notify({ userId, actorId, type, topicId = null, message }) {
  if (!userId || userId === actorId) return;

  db.prepare(`
    INSERT INTO notifications (user_id, actor_id, type, topic_id, message)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, actorId, type, topicId, message);
}

/** Shared SELECT for a topic row (with counters and viewer flags). */
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

const MAX_MEDIA_PER_TOPIC = 4;
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

function attachMedia(rows) {
  if (!rows.length) return rows;

  const ids = rows.map(row => row.id);
  const placeholders = ids.map(() => '?').join(',');

  const media = db.prepare(`
    SELECT topic_id, url, kind
    FROM topic_media
    WHERE topic_id IN (${placeholders})
    ORDER BY position, id
  `).all(...ids);

  const grouped = new Map();
  for (const item of media) {
    if (!grouped.has(item.topic_id)) grouped.set(item.topic_id, []);
    grouped.get(item.topic_id).push(item);
  }

  for (const row of rows) row.media = grouped.get(row.id) || [];
  return rows;
}

function replaceTopicMedia(topicId, media) {
  db.prepare('DELETE FROM topic_media WHERE topic_id = ?').run(topicId);

  for (let position = 0; position < media.length; position += 1) {
    const item = media[position];
    db.prepare('INSERT INTO topic_media (topic_id, url, kind, position) VALUES (?, ?, ?, ?)')
      .run(topicId, item.url, item.kind, position);
  }
}

function decorateTopic(row) {
  if (!row) return row;
  return { ...row, created_at: toIso(row.created_at) };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');

if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  });
  next();
});

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);

app.use(cors({
  credentials: true,
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(null, false);
  }
}));

app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());
app.use(optionalUser);

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

const authLimiter = rateLimit({ name: 'auth', windowMs: 60000, max: 20 });

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'iraq-dark-api', time: new Date().toISOString() });
});

app.post('/api/auth/register', authLimiter, asyncRoute(async (req, res) => {
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

  const passwordHash = await bcrypt.hash(password, 12);

  const insertUser = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO users (username, email, password_hash)
      VALUES (?, ?, ?)
    `).run(username, email, passwordHash);

    db.prepare('INSERT OR IGNORE INTO user_profiles (user_id) VALUES (?)')
      .run(result.lastInsertRowid);

    return result;
  });

  const result = insertUser();
  const session = createSession(result.lastInsertRowid);
  setSessionCookie(req, res, session);

  res.status(201).json({
    user: { id: result.lastInsertRowid, username, email, role: 'member' }
  });
}));

app.post('/api/auth/login', authLimiter, asyncRoute(async (req, res) => {
  const identifier = String(req.body.usernameOrEmail || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  const user = db.prepare(`
    SELECT * FROM users
    WHERE lower(username) = ? OR lower(email) = ?
  `).get(identifier, identifier);

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  }

  const session = createSession(user.id);
  setSessionCookie(req, res, session);

  res.json({
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      created_at: toIso(user.created_at)
    }
  });
}));

app.post('/api/auth/logout', (req, res) => {
  const sessionId = req.cookies[COOKIE_NAME];

  if (sessionId) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }

  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: req.user });
});

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

app.get('/api/profile', requireUser, (req, res) => {
  const profile = db.prepare(`
    SELECT
      users.id, users.username, users.email, users.role, users.created_at,
      COALESCE(p.bio, '') AS bio,
      COALESCE(p.avatar_url, '') AS avatar_url
    FROM users
    LEFT JOIN user_profiles p ON p.user_id = users.id
    WHERE users.id = ?
  `).get(req.user.id);

  res.json({ profile: { ...profile, created_at: toIso(profile.created_at) } });
});

app.patch('/api/profile', requireUser, requireNotBanned, (req, res) => {
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

    const taken = db.prepare('SELECT 1 FROM users WHERE username = ? AND id <> ?')
      .get(patch.username, req.user.id);

    if (taken) return res.status(409).json({ error: 'اسم المستخدم مستخدم من حساب آخر' });
  }

  const current = db.prepare('SELECT bio, avatar_url FROM user_profiles WHERE user_id = ?')
    .get(req.user.id) || { bio: '', avatar_url: '' };

  const bio = 'bio' in patch ? patch.bio : current.bio;
  const avatarUrl = 'avatar_url' in patch ? patch.avatar_url : current.avatar_url;

  db.prepare(`
    INSERT INTO user_profiles (user_id, bio, avatar_url, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      bio = excluded.bio,
      avatar_url = excluded.avatar_url,
      updated_at = CURRENT_TIMESTAMP
  `).run(req.user.id, bio, avatarUrl);

  if (patch.username && patch.username !== req.user.username) {
    db.prepare('UPDATE users SET username = ? WHERE id = ?')
      .run(patch.username, req.user.id);
  }

  res.json({
    ok: true,
    bio,
    avatar_url: avatarUrl,
    username: patch.username || req.user.username
  });
});

app.get('/api/users/:id/profile', (req, res) => {
  const userId = cleanInt(req.params.id);

  if (!userId) {
    return res.status(400).json({ error: 'معرف المستخدم غير صحيح' });
  }

  const profile = db.prepare(`
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
    ? Boolean(db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').get(viewer.id, userId))
    : false;

  res.json({
    profile: {
      ...profile,
      email: viewer && viewer.id === userId ? profile.email : undefined,
      created_at: toIso(profile.created_at)
    },
    isFollowing,
    isSelf: Boolean(viewer && viewer.id === userId)
  });
});

app.post('/api/users/:id/follow', requireUser, requireNotBanned, (req, res) => {
  const followingId = cleanInt(req.params.id);

  if (!followingId) {
    return res.status(400).json({ error: 'معرف المستخدم غير صحيح' });
  }

  if (followingId === req.user.id) {
    return res.status(400).json({ error: 'لا يمكنك متابعة نفسك' });
  }

  const target = db.prepare('SELECT id, username FROM users WHERE id = ?').get(followingId);

  if (!target) {
    return res.status(404).json({ error: 'المستخدم غير موجود' });
  }

  const already = db.prepare(
    'SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?'
  ).get(req.user.id, followingId);

  const toggle = db.transaction(() => {
    if (already) {
      db.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?')
        .run(req.user.id, followingId);
      return false;
    }

    db.prepare('INSERT INTO follows (follower_id, following_id) VALUES (?, ?)')
      .run(req.user.id, followingId);

    notify({
      userId: followingId,
      actorId: req.user.id,
      type: 'follow',
      message: `${req.user.username} بدأ بمتابعتك`
    });

    return true;
  });

  const following = toggle();
  const followersCount = db.prepare(
    'SELECT COUNT(*) AS c FROM follows WHERE following_id = ?'
  ).get(followingId).c;

  res.json({ following, followers_count: followersCount });
});

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

app.get('/api/categories', (req, res) => {
  const categories = db.prepare(`
    SELECT
      c.id, c.name, c.description,
      (SELECT COUNT(*) FROM topics t WHERE t.category_id = c.id) AS topic_count
    FROM categories c
    ORDER BY c.id
  `).all();

  res.json({ categories });
});

app.get('/api/stats', (req, res) => {
  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM topics) AS topics,
      (SELECT COUNT(*) FROM replies) AS replies,
      (SELECT COUNT(*) FROM users) AS members,
      (SELECT COUNT(*) FROM sessions WHERE expires_at > datetime('now')) AS online
  `).get();

  res.json({ stats });
});

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const uploadsDir = path.join(dataDir, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

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

/** POST /api/media?purpose=topic|avatar — raw bytes, same contract as the Worker. */
app.post(
  '/api/media',
  requireUser,
  requireNotBanned,
  express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
  (req, res) => {
    const purpose = String(req.query.purpose || 'topic');
    if (purpose !== 'topic' && purpose !== 'avatar') {
      return res.status(400).json({ error: 'غرض الرفع غير صالح' });
    }

    const contentType = String(req.headers['content-type'] || '')
      .split(';')[0]
      .trim()
      .toLowerCase();

    const extension = UPLOAD_EXTENSIONS[contentType];
    if (!extension) {
      return res.status(415).json({
        error: 'نوع الملف غير مدعوم (صور: jpg png webp gif avif — فيديو: mp4 webm mov)'
      });
    }

    const buffer = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buffer || !buffer.length) return res.status(400).json({ error: 'الملف فارغ' });

    const filename = purpose === 'avatar'
      ? `a${req.user.id}.${extension}`
      : `t${req.user.id}_${crypto.randomBytes(9).toString('hex')}.${extension}`;

    fs.writeFileSync(path.join(uploadsDir, filename), buffer);

    res.json({
      url: `/media/${filename}`,
      kind: contentType.startsWith('video/') ? 'video' : 'image',
      bytes: buffer.length
    });
  }
);

/** GET /media/<filename> — serve a stored upload (Express `send` handles ranges). */
app.get('/media/:filename', (req, res) => {
  const filename = req.params.filename;

  if (!/^[A-Za-z0-9_-]+\.[a-z0-9]{2,5}$/.test(filename)) {
    return res.status(404).json({ error: 'الملف غير موجود' });
  }

  const file = path.join(uploadsDir, filename);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'الملف غير موجود' });

  res.set({
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename="${filename}"`
  });

  res.sendFile(file, error => {
    if (error && !res.headersSent) res.status(404).json({ error: 'الملف غير موجود' });
  });
});

app.get('/api/topics', (req, res) => {
  const meId = req.user ? req.user.id : -1;
  const search = String(req.query.q || '').trim().slice(0, 100);
  const categoryId = cleanInt(req.query.category);
  const authorId = cleanInt(req.query.author);
  const sort = ['new', 'top', 'active'].includes(req.query.sort) ? req.query.sort : 'new';

  const page = Math.max(1, cleanInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, cleanInt(req.query.limit) || 10));

  const where = [];
  const params = { meId };

  if (search) {
    where.push(`(t.title LIKE @search ESCAPE '\\' OR t.content LIKE @search ESCAPE '\\')`);
    params.search = `%${search.replace(/[\\%_]/g, ch => `\\${ch}`)}%`;
  }

  if (categoryId) {
    where.push('t.category_id = @categoryId');
    params.categoryId = categoryId;
  }

  if (authorId) {
    where.push('t.user_id = @authorId');
    params.authorId = authorId;
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const orderSql = {
    new: 'ORDER BY t.created_at DESC',
    top: 'ORDER BY like_count DESC, reply_count DESC, t.created_at DESC',
    active: 'ORDER BY reply_count DESC, t.created_at DESC'
  }[sort];

  const total = db.prepare(`
    SELECT COUNT(*) AS c FROM topics t ${whereSql}
  `).get(params).c;

  const rows = db.prepare(`
    ${topicSelect(meId)}
    ${whereSql}
    ${orderSql}
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset: (page - 1) * limit });

  attachMedia(rows);

  res.json({
    topics: rows.map(decorateTopic),
    pagination: {
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit))
    }
  });
});

app.post('/api/topics', requireUser, requireNotBanned, (req, res) => {
  const media = cleanMedia(req.body.media) || [];
  const title = cleanText(req.body.title, 120);
  const body = String(req.body.content || '').trim();
  const content = body.length > 10000 ? null : body;
  const categoryId = cleanInt(req.body.categoryId);

  if (!title || content === null || !categoryId || (!content && !media.length)) {
    return res.status(400).json({ error: 'العنوان والمحتوى والقسم مطلوبة' });
  }

  const category = db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId);

  if (!category) {
    return res.status(400).json({ error: 'القسم غير موجود' });
  }

  const result = db.prepare(`
    INSERT INTO topics (category_id, user_id, title, content)
    VALUES (?, ?, ?, ?)
  `).run(categoryId, req.user.id, title, content);

  replaceTopicMedia(result.lastInsertRowid, media);

  const topic = db.prepare(`${topicSelect(req.user.id)} WHERE t.id = ?`)
    .get(result.lastInsertRowid);

  attachMedia([topic]);

  res.status(201).json({ topic: decorateTopic(topic) });
});

app.get('/api/topics/:id', (req, res) => {
  const topicId = cleanInt(req.params.id);

  if (!topicId) {
    return res.status(400).json({ error: 'معرف الموضوع غير صحيح' });
  }

  const meId = req.user ? req.user.id : -1;
  const topic = db.prepare(`${topicSelect(meId, { full: true })} WHERE t.id = ?`).get(topicId);

  if (!topic) {
    return res.status(404).json({ error: 'الموضوع غير موجود' });
  }

  // Count the view at most once per viewer per day.
  const viewerKey = req.user
    ? `u:${req.user.id}`
    : `ip:${req.ip || req.socket.remoteAddress || 'anon'}`;

  const recentView = db.prepare(`
    SELECT 1 FROM topic_views
    WHERE topic_id = ? AND viewer_key = ?
      AND created_at > datetime('now', '-1 day')
  `).get(topicId, viewerKey);

  if (!recentView) {
    db.prepare(`
      INSERT INTO topic_views (topic_id, user_id, viewer_key)
      VALUES (?, ?, ?)
    `).run(topicId, req.user ? req.user.id : null, viewerKey);
  }

  const replies = db.prepare(`
    ${replySelect(meId)}
    WHERE r.topic_id = ?
    ORDER BY r.created_at ASC, r.id ASC
  `).all(topicId);

  attachMedia([topic]);

  res.json({
    topic: decorateTopic(topic),
    replies: replies.map(reply => ({ ...reply, created_at: toIso(reply.created_at) }))
  });
});

app.patch('/api/topics/:id', requireUser, requireNotBanned, (req, res) => {
  const topicId = cleanInt(req.params.id);
  const topic = topicId ? db.prepare('SELECT * FROM topics WHERE id = ?').get(topicId) : null;

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
    : Boolean(db.prepare('SELECT 1 FROM topic_media WHERE topic_id = ?').get(topicId));

  if (!title || content === null || !categoryId || (!content && !hasMedia)) {
    return res.status(400).json({ error: 'العنوان والمحتوى والقسم مطلوبة' });
  }

  db.prepare(`
    UPDATE topics SET title = ?, content = ?, category_id = ? WHERE id = ?
  `).run(title, content, categoryId, topicId);

  if (media) replaceTopicMedia(topicId, media);

  const updated = db.prepare(`${topicSelect(req.user.id)} WHERE t.id = ?`).get(topicId);
  attachMedia([updated]);
  res.json({ topic: decorateTopic(updated) });
});

app.delete('/api/topics/:id', requireUser, (req, res) => {
  const topicId = cleanInt(req.params.id);
  const topic = topicId ? db.prepare('SELECT * FROM topics WHERE id = ?').get(topicId) : null;

  if (!topic) return res.status(404).json({ error: 'الموضوع غير موجود' });
  if (topic.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'لا تملك صلاحية حذف هذا الموضوع' });
  }

  const remove = db.transaction(() => {
    db.prepare('DELETE FROM replies WHERE topic_id = ?').run(topicId);
    db.prepare('DELETE FROM topic_media WHERE topic_id = ?').run(topicId);
    db.prepare('DELETE FROM topics WHERE id = ?').run(topicId);
  });

  remove();
  res.json({ ok: true });
});

app.post('/api/topics/:id/like', requireUser, requireNotBanned, (req, res) => {
  const topicId = cleanInt(req.params.id);
  const topic = topicId ? db.prepare('SELECT * FROM topics WHERE id = ?').get(topicId) : null;

  if (!topic) return res.status(404).json({ error: 'الموضوع غير موجود' });

  const existing = db.prepare(
    'SELECT 1 FROM likes WHERE user_id = ? AND topic_id = ?'
  ).get(req.user.id, topicId);

  if (existing) {
    db.prepare('DELETE FROM likes WHERE user_id = ? AND topic_id = ?')
      .run(req.user.id, topicId);
  } else {
    db.prepare('INSERT INTO likes (user_id, topic_id) VALUES (?, ?)')
      .run(req.user.id, topicId);

    notify({
      userId: topic.user_id,
      actorId: req.user.id,
      type: 'like',
      topicId,
      message: `${req.user.username} أعجب بموضوعك: ${topic.title}`
    });
  }

  const likeCount = db.prepare('SELECT COUNT(*) AS c FROM likes WHERE topic_id = ?')
    .get(topicId).c;

  res.json({ liked: !existing, like_count: likeCount });
});

app.post('/api/topics/:id/bookmark', requireUser, (req, res) => {
  const topicId = cleanInt(req.params.id);
  const topic = topicId ? db.prepare('SELECT id FROM topics WHERE id = ?').get(topicId) : null;

  if (!topic) return res.status(404).json({ error: 'الموضوع غير موجود' });

  const existing = db.prepare('SELECT 1 FROM bookmarks WHERE user_id = ? AND topic_id = ?')
    .get(req.user.id, topicId);

  if (existing) {
    db.prepare('DELETE FROM bookmarks WHERE user_id = ? AND topic_id = ?')
      .run(req.user.id, topicId);
  } else {
    db.prepare('INSERT INTO bookmarks (user_id, topic_id) VALUES (?, ?)')
      .run(req.user.id, topicId);
  }

  res.json({ bookmarked: !existing });
});

app.get('/api/bookmarks', requireUser, (req, res) => {
  const rows = db.prepare(`
    SELECT b.topic_id AS id, b.created_at AS saved_at
    FROM bookmarks b
    WHERE b.user_id = ?
    ORDER BY b.created_at DESC
    LIMIT 100
  `).all(req.user.id);

  const topics = rows.map(row => {
    const topic = db.prepare(`${topicSelect(req.user.id)} WHERE t.id = ?`).get(row.id);
    return topic ? decorateTopic(topic) : null;
  }).filter(Boolean);

  res.json({ topics });
});

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

app.post('/api/topics/:id/replies', requireUser, requireNotBanned, (req, res) => {
  const topicId = cleanInt(req.params.id);
  const content = cleanText(req.body.content, 5000);

  if (!topicId || !content) {
    return res.status(400).json({ error: 'معرف الموضوع والرد مطلوبان' });
  }

  const topic = db.prepare('SELECT id, user_id, title FROM topics WHERE id = ?').get(topicId);

  if (!topic) {
    return res.status(404).json({ error: 'الموضوع غير موجود' });
  }

  const result = db.prepare(`
    INSERT INTO replies (topic_id, user_id, content)
    VALUES (?, ?, ?)
  `).run(topicId, req.user.id, content);

  notify({
    userId: topic.user_id,
    actorId: req.user.id,
    type: 'reply',
    topicId,
    message: `${req.user.username} ردّ على موضوعك: ${topic.title}`
  });

  const reply = db.prepare(`
    ${replySelect(req.user.id)}
    WHERE r.id = ?
  `).get(result.lastInsertRowid);

  res.status(201).json({ reply: { ...reply, created_at: toIso(reply.created_at) } });
});

app.delete('/api/replies/:id', requireUser, (req, res) => {
  const replyId = cleanInt(req.params.id);
  const reply = replyId
    ? db.prepare('SELECT id, user_id, topic_id FROM replies WHERE id = ?').get(replyId)
    : null;

  if (!reply) return res.status(404).json({ error: 'الرد غير موجود' });
  if (reply.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'لا تملك صلاحية حذف هذا الرد' });
  }

  db.prepare('DELETE FROM replies WHERE id = ?').run(replyId);
  res.json({ ok: true });
});

app.post('/api/replies/:id/like', requireUser, requireNotBanned, (req, res) => {
  const replyId = cleanInt(req.params.id);
  const reply = replyId
    ? db.prepare('SELECT id, user_id, topic_id FROM replies WHERE id = ?').get(replyId)
    : null;

  if (!reply) return res.status(404).json({ error: 'الرد غير موجود' });

  const existing = db.prepare('SELECT 1 FROM likes WHERE user_id = ? AND reply_id = ?')
    .get(req.user.id, replyId);

  if (existing) {
    db.prepare('DELETE FROM likes WHERE user_id = ? AND reply_id = ?')
      .run(req.user.id, replyId);
  } else {
    db.prepare('INSERT INTO likes (user_id, reply_id) VALUES (?, ?)')
      .run(req.user.id, replyId);

    notify({
      userId: reply.user_id,
      actorId: req.user.id,
      type: 'like',
      topicId: reply.topic_id,
      message: `${req.user.username} أعجاب بردّك`
    });
  }

  const likeCount = db.prepare('SELECT COUNT(*) AS c FROM likes WHERE reply_id = ?')
    .get(replyId).c;

  res.json({ liked: !existing, like_count: likeCount });
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

app.get('/api/notifications', requireUser, (req, res) => {
  const notifications = db.prepare(`
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
});

app.get('/api/notifications/unread-count', requireUser, (req, res) => {
  const count = db.prepare(
    'SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0'
  ).get(req.user.id).c;

  res.json({ count });
});

app.post('/api/notifications/read', requireUser, (req, res) => {
  const id = cleanInt(req.body.id);

  if (id) {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?')
      .run(id, req.user.id);
  } else {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?')
      .run(req.user.id);
  }

  const count = db.prepare(
    'SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0'
  ).get(req.user.id).c;

  res.json({ ok: true, count });
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

const adminUserSelect = `
  SELECT
    u.id, u.username, u.email, u.role, u.is_banned, u.banned_reason, u.banned_at,
    u.created_at,
    COALESCE(p.avatar_url, '') AS avatar_url,
    (SELECT COUNT(*) FROM topics t WHERE t.user_id = u.id) AS topic_count,
    (SELECT COUNT(*) FROM replies r WHERE r.user_id = u.id) AS reply_count
  FROM users u
  LEFT JOIN user_profiles p ON p.user_id = u.id
`;

const ROLES = ['admin', 'member'];

function loadAdminTarget(req, res) {
  const userId = cleanInt(req.params.id);

  if (!userId) {
    res.status(400).json({ error: 'معرف المستخدم غير صحيح' });
    return null;
  }

  const user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(userId);

  if (!user) {
    res.status(404).json({ error: 'المستخدم غير موجود' });
    return null;
  }

  return user;
}

/** Never let the last remaining admin demote or delete themselves. */
function adminGuard(req, res, target, action) {
  if (target.id !== req.user.id || target.role !== 'admin') return true;

  const admins = db.prepare(
    "SELECT COUNT(*) AS c FROM users WHERE role = 'admin'"
  ).get().c;

  if (admins > 1) return true;

  res.status(400).json({ error: `لا يمكن ${action} آخر مدير في الموقع` });
  return false;
}

app.get('/api/admin/overview', requireUser, requireAdmin, (req, res) => {
  const stats = db.prepare(`
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
});

app.get('/api/admin/users', requireUser, requireAdmin, (req, res) => {
  const search = String(req.query.q || '').trim().slice(0, 100);
  const role = ROLES.includes(req.query.role) ? req.query.role : '';
  const status = ['banned', 'active'].includes(req.query.status) ? req.query.status : '';

  const page = Math.max(1, cleanInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, cleanInt(req.query.limit) || 20));

  const where = [];
  const params = { meId: req.user.id };

  if (search) {
    where.push(`(u.username LIKE @search ESCAPE '\\' OR u.email LIKE @search ESCAPE '\\')`);
    params.search = `%${search.replace(/[\\%_]/g, ch => `\\${ch}`)}%`;
  }

  if (role) {
    where.push('u.role = @role');
    params.role = role;
  }

  if (status === 'banned') where.push('u.is_banned = 1');
  if (status === 'active') where.push('u.is_banned = 0');

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(
    `SELECT COUNT(*) AS c FROM users u ${whereSql}`
  ).get(params).c;

  const rows = db.prepare(`
    ${adminUserSelect}
    ${whereSql}
    ORDER BY (u.id = @meId) DESC, u.created_at DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset: (page - 1) * limit });

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
      total,
      pages: Math.max(1, Math.ceil(total / limit))
    }
  });
});

app.patch('/api/admin/users/:id', requireUser, requireAdmin, (req, res) => {
  const target = loadAdminTarget(req, res);
  if (!target) return;

  const updates = [];
  const values = [];
  const messages = [];

  if (req.body.role !== undefined) {
    const role = String(req.body.role);

    if (!ROLES.includes(role)) {
      return res.status(400).json({ error: 'الدور غير صالح' });
    }

    if (role !== target.role) {
      if (role === 'member' && !adminGuard(req, res, target, 'تخفيض صلاحية')) return;

      updates.push('role = ?');
      values.push(role);
      messages.push(role === 'admin' ? 'ترقية إلى مدير' : 'تخفيض إلى عضو');
    }
  }

  if (req.body.is_banned !== undefined) {
    const banned = Boolean(req.body.is_banned);

    if (banned && !adminGuard(req, res, target, 'إيقاف')) return;

    const reason = banned
      ? String(req.body.banned_reason || 'مخالفة قوانين المنتدى').trim().slice(0, 200)
      : '';

    updates.push('is_banned = ?', 'banned_reason = ?', 'banned_at = ?');
    values.push(banned ? 1 : 0, reason, banned ? new Date().toISOString() : null);
    messages.push(banned ? 'إيقاف عن النشر' : 'رفع الإيقاف');

    if (banned) {
      // Kill every live session so the ban takes effect immediately.
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    }
  }

  if (req.body.username !== undefined) {
    const username = String(req.body.username).trim();

    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
      return res.status(400).json({ error: 'اسم المستخدم يجب أن يكون 3-24 حرفاً أو رقماً (بالإنجليزية)' });
    }

    const taken = db.prepare(
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

    const taken = db.prepare(
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

  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`)
    .run(...values, target.id);

  const user = db.prepare(`${adminUserSelect} WHERE u.id = ?`).get(target.id);

  res.json({
    ok: true,
    changed: messages,
    user: {
      ...user,
      is_banned: Number(user.is_banned) === 1,
      created_at: toIso(user.created_at),
      banned_at: toIso(user.banned_at)
    }
  });
});

app.delete('/api/admin/users/:id', requireUser, requireAdmin, (req, res) => {
  const target = loadAdminTarget(req, res);
  if (!target) return;

  if (target.id === req.user.id) {
    return res.status(400).json({ error: 'لا يمكنك حذف حسابك من هذه الصفحة' });
  }

  if (target.role === 'admin' && !adminGuard(req, res, target, 'حذف')) return;

  const wipe = db.transaction(() => {
    // Explicit deletes first: topics/replies FKs to users are not cascading.
    db.prepare('DELETE FROM replies WHERE user_id = ?').run(target.id);
    db.prepare('DELETE FROM likes WHERE user_id = ?').run(target.id);
    db.prepare('DELETE FROM bookmarks WHERE user_id = ?').run(target.id);
    db.prepare('DELETE FROM follows WHERE follower_id = ? OR following_id = ?')
      .run(target.id, target.id);
    db.prepare('DELETE FROM notifications WHERE user_id = ? OR actor_id = ?')
      .run(target.id, target.id);
    db.prepare('DELETE FROM topic_views WHERE user_id = ?').run(target.id);
    db.prepare('DELETE FROM topic_media WHERE topic_id IN (SELECT id FROM topics WHERE user_id = ?)')
      .run(target.id);
    db.prepare('DELETE FROM topics WHERE user_id = ?').run(target.id);
    db.prepare('DELETE FROM user_profiles WHERE user_id = ?').run(target.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  });

  wipe();

  res.json({ ok: true, deleted: target.username });
});

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

function cleanupSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= datetime(\'now\')').run();
}

cleanupSessions();
setInterval(cleanupSessions, 6 * 60 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Static build + SPA fallback + error handling
// ---------------------------------------------------------------------------

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'المسار غير موجود' });
});

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir, { index: 'index.html', maxAge: IS_PRODUCTION ? '1h' : 0 }));

  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.json({
      ok: true,
      service: 'iraq-dark-api',
      hint: 'Run "npm run build" then "NODE_ENV=production npm start" to serve the UI.'
    });
  });
}

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);

  // body-parser failures are client errors (payload too large, broken JSON).
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'الملف أكبر من الحد المسموح (30MB)' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'بيانات الطلب غير صالحة' });
  }

  res.status(500).json({ error: 'حدث خطأ داخلي في الخادم' });
});

app.listen(PORT, HOST, () => {
  console.log(`Iraq Dark API running on http://localhost:${PORT}`);
});

module.exports = app;
