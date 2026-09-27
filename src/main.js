import './style.css'

/* ==========================================================================
   IRAQ DARK — single page app
   Vanilla JS, hash based routing, talks to /api (see server/server.cjs)
   ========================================================================== */

const app = document.querySelector('#app')

const state = {
  user: null,
  unread: 0,
  lastRoute: ''
}

/** Ephemeral UI state for the admin panel (which row is being edited). */
const adminUi = { editingId: null, banId: null }

/* --------------------------------------------------------------------------
   Tiny DOM helper
   -------------------------------------------------------------------------- */

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag)
  const deferred = {}

  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue

    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key === 'value' || key === 'checked') deferred[key] = value
    else if (key === 'html') node.innerHTML = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value)
    else node.setAttribute(key, value === true ? '' : value)
  }

  for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) {
    if (child === null || child === undefined || child === false) continue
    node.append(child)
  }

  // Apply after children so <select> can resolve its options.
  if ('value' in deferred) node.value = deferred.value
  if ('checked' in deferred) node.checked = Boolean(deferred.checked)

  return node
}

/* --------------------------------------------------------------------------
   Inline icons (feather style, 24x24 stroke)
   -------------------------------------------------------------------------- */

const ICONS = {
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  heart: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
  bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  comment: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>',
  menu: '<line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  back: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  ban: '<circle cx="12" cy="12" r="9"/><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/>'
}

function icon(name, size = 18) {
  return el('span', {
    class: 'icon',
    'aria-hidden': 'true',
    html: `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`
  })
}

/* --------------------------------------------------------------------------
   API + feedback
   -------------------------------------------------------------------------- */

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    const error = new Error(data.error || 'حدث خطأ في الطلب')
    error.status = response.status
    throw error
  }

  return data
}

/* --------------------------------------------------------------------------
   Media — uploads, avatars, attachments
   -------------------------------------------------------------------------- */

const MAX_MEDIA_PER_TOPIC = 4
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
const ACCEPTED_UPLOADS = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif',
  'video/mp4', 'video/webm', 'video/quicktime'
].join(',')

let attachId = 0

/** POST raw bytes to /api/media and resolve with { url, kind, bytes }. */
async function uploadFile(file, purpose = 'topic') {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error('الملف أكبر من الحد المسموح (20MB)')
  }

  const response = await fetch(`/api/media?purpose=${purpose}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(data.error || 'تعذّر رفع الملف')
  }

  return data
}

/**
 * Workers KV is eventually consistent: a file uploaded seconds ago may 404 for
 * a short window while the value propagates. Retry with a cache-busting query
 * string until it shows up, then fall back to a visible placeholder.
 */
const MEDIA_RETRY_DELAYS = [2000, 5000, 10000, 20000, 30000]

function withMediaRetry(node, url) {
  let attempt = 0

  node.addEventListener('error', () => {
    if (attempt >= MEDIA_RETRY_DELAYS.length) {
      node.replaceWith(el('div', { class: 'media-item media-missing', text: 'تعذّر تحميل الملف' }))
      return
    }

    const wait = MEDIA_RETRY_DELAYS[attempt]
    attempt += 1

    setTimeout(() => {
      const join = url.includes('?') ? '&' : '?'
      node.src = `${url}${join}r=${attempt}`
    }, wait)
  })

  return node
}

/** Avatar image when one was uploaded, otherwise the initial letter. */
function avatarNode(user, size = '') {
  const classes = ['avatar', size, user?.avatar_url ? 'img' : '']
    .filter(Boolean)
    .join(' ')
  const label = String(user?.username || user?.name || '?')

  if (user?.avatar_url) {
    return withMediaRetry(el('img', {
      class: classes,
      src: user.avatar_url,
      alt: label,
      loading: 'lazy',
      decoding: 'async'
    }), user.avatar_url)
  }

  return el('span', { class: classes, text: label.slice(0, 1).toUpperCase() })
}

/** Renders an attachment list: real players in full view, silent previews in cards. */
function mediaGallery(items, { compact = false } = {}) {
  if (!Array.isArray(items) || !items.length) return null

  const nodes = items.map(item => {
    if (item.kind === 'video') {
      const video = compact
        ? el('video', {
            class: 'media-item video',
            src: item.url,
            preload: 'metadata',
            muted: true,
            playsinline: true,
            'aria-hidden': 'true'
          })
        : el('video', {
            class: 'media-item video',
            src: item.url,
            controls: true,
            playsinline: true,
            preload: 'metadata'
          })

      return withMediaRetry(video, item.url)
    }

    return withMediaRetry(el('img', {
      class: 'media-item image',
      src: item.url,
      alt: 'مرفق منشور',
      loading: 'lazy',
      decoding: 'async'
    }), item.url)
  })

  return el('div', {
    class: `media-grid${compact ? ' compact' : ''} media-${Math.min(items.length, 4)}`
  }, nodes)
}

/**
 * File picker + thumbnails for the topic form.
 * `collect()` uploads everything new and resolves to `[{ url, kind }]`.
 */
function attachField(existing = []) {
  const inputId = `attach-file-${attachId++}`
  const items = existing.map(item => ({ ...item, file: null, objectUrl: null }))

  const preview = el('div', { class: 'attach-grid' })

  function clearPreviews() {
    for (const item of items) {
      if (item.objectUrl) URL.revokeObjectURL(item.objectUrl)
    }
  }

  function render() {
    preview.replaceChildren(...items.map((item, index) => {
      const thumb = item.kind === 'video'
        ? el('video', {
            class: 'attach-thumb',
            src: item.url,
            preload: 'metadata',
            muted: true,
            playsinline: true
          })
        : el('img', { class: 'attach-thumb', src: item.url, alt: '' })

      return el('div', { class: 'attach-item' }, [
        thumb,
        item.file ? el('span', { class: 'attach-badge', text: 'جديد' }) : null,
        el('button', {
          class: 'attach-remove',
          type: 'button',
          'aria-label': 'إزالة المرفق',
          onclick: () => {
            if (item.objectUrl) URL.revokeObjectURL(item.objectUrl)
            items.splice(index, 1)
            render()
          }
        }, [icon('close', 14)])
      ].filter(Boolean))
    }))
  }

  const input = el('input', {
    id: inputId,
    type: 'file',
    class: 'attach-input',
    accept: ACCEPTED_UPLOADS,
    multiple: true,
    onchange: event => {
      for (const file of [...(event.target.files || [])]) {
        if (items.length >= MAX_MEDIA_PER_TOPIC) {
          toast(`الحد الأقصى ${MAX_MEDIA_PER_TOPIC} مرفقات`, 'error')
          break
        }
        if (file.size > MAX_UPLOAD_BYTES) {
          toast('الملف أكبر من 20MB', 'error')
          continue
        }

        const objectUrl = URL.createObjectURL(file)

        items.push({
          file,
          kind: file.type.startsWith('video/') ? 'video' : 'image',
          url: objectUrl,
          objectUrl
        })
      }

      event.target.value = ''
      render()
    }
  })

  render()

  return {
    node: el('div', { class: 'field' }, [
      el('span', { text: 'صور / فيديو' }),
      input,
      el('label', { class: 'button ghost attach-pick', for: inputId }, [
        icon('plus', 16),
        el('span', { text: 'أضف مرفقاً' })
      ]),
      preview,
      el('p', { class: 'muted attach-hint', text: `حتى ${MAX_MEDIA_PER_TOPIC} مرفقات — صور أو فيديو بحد أقصى 20MB` })
    ]),
    clearPreviews,
    hasFiles: () => items.some(item => Boolean(item.file)),
    async collect() {
      const out = []

      for (const item of items) {
        if (item.file) {
          const stored = await uploadFile(item.file, 'topic')
          out.push({ url: stored.url, kind: stored.kind })
        } else {
          out.push({ url: item.url, kind: item.kind })
        }
      }

      return out
    }
  }
}

function toast(message, type = 'info') {
  let host = document.querySelector('#toasts')

  if (!host) {
    host = el('div', { id: 'toasts' })
    document.body.append(host)
  }

  const item = el('div', { class: `toast ${type}` }, [
    icon(type === 'error' ? 'close' : 'check', 16),
    el('span', { text: message })
  ])

  host.append(item)

  setTimeout(() => {
    item.classList.add('hide')
    setTimeout(() => item.remove(), 320)
  }, 3200)
}

function loadingView(text = 'جارٍ التحميل…') {
  return el('section', { class: 'panel loading-panel' }, [
    el('div', { class: 'spinner' }),
    el('p', { class: 'muted', text })
  ])
}

/** Re-read the signed-in user (used after avatar / username changes). */
async function refreshMe() {
  const me = await api('/api/auth/me').catch(() => ({ user: null }))
  state.user = me.user
  return state.user
}

/* --------------------------------------------------------------------------
   Dates (SQLite stores UTC as "YYYY-MM-DD HH:MM:SS")
   -------------------------------------------------------------------------- */

function parseDate(value) {
  if (!value) return null
  const raw = String(value).trim()
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

const relativeFormatter = new Intl.RelativeTimeFormat('ar', { numeric: 'auto' })

function timeAgo(value) {
  const date = parseDate(value)
  if (!date) return ''

  const seconds = (date.getTime() - Date.now()) / 1000
  const abs = Math.abs(seconds)

  if (abs < 60) return 'الآن'
  if (abs < 3600) return relativeFormatter.format(Math.round(seconds / 60), 'minute')
  if (abs < 86400) return relativeFormatter.format(Math.round(seconds / 3600), 'hour')
  if (abs < 2592000) return relativeFormatter.format(Math.round(seconds / 86400), 'day')
  if (abs < 31536000) return relativeFormatter.format(Math.round(seconds / 2592000), 'month')
  return relativeFormatter.format(Math.round(seconds / 31536000), 'year')
}

function formatDate(value) {
  const date = parseDate(value)
  if (!date) return ''
  return date.toLocaleDateString('ar-IQ', { year: 'numeric', month: 'long', day: 'numeric' })
}

/* --------------------------------------------------------------------------
   Router
   -------------------------------------------------------------------------- */

function parseRoute() {
  const raw = window.location.hash.replace(/^#/, '') || '/'
  const [path, query = ''] = raw.split('?')
  const parts = path.split('/').filter(Boolean)

  return { parts, query: new URLSearchParams(query) }
}

function navigate(hash) {
  if (window.location.hash === hash) render()
  else window.location.hash = hash
}

function queryString(params) {
  const search = new URLSearchParams()

  for (const [key, value] of Object.entries(params)) {
    if (value !== '' && value !== null && value !== undefined) search.set(key, value)
  }

  const text = search.toString()
  return text ? `?${text}` : ''
}

window.addEventListener('hashchange', render)

/* --------------------------------------------------------------------------
   Layout: header / footer
   -------------------------------------------------------------------------- */

function logoFlag() {
  return el('span', { class: 'iraq-header-flag', 'aria-label': 'علم العراق', role: 'img' }, [
    el('span', { class: 'iraq-header-cloth' }, [el('span', { text: 'الله أكبر' })])
  ])
}

function navLink(href, label, active, iconName) {
  return el('a', {
    class: `nav-btn${active ? ' active' : ''}`,
    href
  }, [iconName ? icon(iconName, 16) : null, el('span', { text: label })])
}

function renderHeader(route) {
  const current = route.parts[0] || 'home'
  const isTopics = current === 'topics' || current === 'topic'

  const searchForm = el('form', {
    class: 'header-search',
    role: 'search',
    onsubmit: event => {
      event.preventDefault()
      const value = new FormData(event.currentTarget).get('q')
      navigate(`#/topics${queryString({ q: String(value || '').trim() })}`)
    }
  }, [
    icon('search', 16),
    el('input', {
      name: 'q',
      type: 'search',
      placeholder: 'ابحث في المواضيع…',
      value: route.query.get('q') || '',
      'aria-label': 'بحث'
    })
  ])

  const links = [
    navLink('#/', 'الرئيسية', current === 'home', 'home'),
    navLink('#/topics', 'المواضيع', isTopics, 'comment'),
    navLink('#/categories', 'الأقسام', current === 'categories', 'grid'),
    state.user
      ? navLink('#/bookmarks', 'المحفوظات', current === 'bookmarks', 'bookmark')
      : null,
    state.user
      ? el('a', {
          class: `nav-btn${current === 'notifications' ? ' active' : ''}`,
          href: '#/notifications'
        }, [
          icon('bell', 16),
          el('span', { text: 'الإشعارات' }),
          el('span', {
            id: 'unread-badge',
            class: `badge${state.unread ? '' : ' hidden'}`,
            text: String(state.unread)
          })
        ])
      : null,
    state.user && state.user.role === 'admin'
      ? navLink('#/admin', 'لوحة التحكم', current === 'admin', 'shield')
      : null
  ]

  const account = state.user
    ? [
        el('a', {
          class: `nav-btn account${current === 'profile' ? ' active' : ''}`,
          href: '#/profile'
        }, [
          avatarNode(state.user, 'mini'),
          el('span', { text: state.user.username })
        ]),
        el('a', { class: 'nav-btn danger', href: '#/logout', onclick: event => {
          event.preventDefault()
          logout()
        } }, [icon('logout', 16), el('span', { text: 'خروج' })])
      ]
    : [
        el('a', { class: 'nav-btn ghost', href: '#/login', text: 'دخول' }),
        el('a', { class: 'nav-btn primary', href: '#/register', text: 'إنشاء حساب' })
      ]

  const nav = el('nav', { class: 'nav' }, [...links.filter(Boolean), ...account])

  const header = el('header', { class: 'topbar' }, [
    el('div', { class: 'brand-row' }, [
      el('a', { class: 'brand', href: '#/' }, [logoFlag(), el('span', { text: 'IRAQ DARK' })]),
      el('button', {
        class: 'menu-toggle',
        type: 'button',
        'aria-label': 'القائمة',
        onclick: event => {
          event.currentTarget.closest('.topbar').classList.toggle('nav-open')
        }
      }, [icon('menu', 20)])
    ]),
    searchForm,
    nav
  ])

  return header
}

function renderFooter() {
  return el('footer', { class: 'footer' }, [
    el('div', { class: 'footer-brand' }, [
      el('strong', { text: 'IRAQ DARK' }),
      el('span', { text: 'مساحة داكنة للنقاش العراقي — ألعاب، تقنية، وإبداع.' })
    ]),
    el('div', { class: 'footer-links' }, [
      el('a', { href: '#/', text: 'الرئيسية' }),
      el('a', { href: '#/topics', text: 'المواضيع' }),
      el('a', { href: '#/categories', text: 'الأقسام' })
    ]),
    el('div', { class: 'footer-meta', text: `© ${new Date().getFullYear()} IRAQ DARK` })
  ])
}

function renderLayout(content, route = parseRoute()) {
  app.replaceChildren()
  app.append(
    renderHeader(route),
    el('main', { class: 'container' }, [content]),
    renderFooter()
  )
}

function closeMenu() {
  document.querySelector('.topbar')?.classList.remove('nav-open')
}

/* --------------------------------------------------------------------------
   Shared pieces
   -------------------------------------------------------------------------- */

function flagArt() {
  return el('div', { class: 'iraq-flag', 'aria-label': 'علم العراق', role: 'img' }, [
    el('div', { class: 'flag-pole' }),
    el('div', { class: 'flag-cloth' }, [el('span', { text: 'الله أكبر' })])
  ])
}

function statBlock(value, label) {
  return el('div', { class: 'stat' }, [
    el('strong', { text: String(value ?? 0) }),
    el('span', { text: label })
  ])
}

function categoryChip(category) {
  return el('a', {
    class: 'chip',
    href: `#/topics${queryString({ category: category.id ?? category })}`,
    text: typeof category === 'object' ? category.name : String(category)
  })
}

function topicCard(topic) {
  return el('a', { class: 'topic-card', href: `#/topic/${topic.id}` }, [
    el('div', { class: 'topic-card-top' }, [
      categoryChip({ id: topic.category_id, name: topic.category }),
      el('span', { class: 'topic-time', text: timeAgo(topic.created_at) })
    ]),
    el('h3', { text: topic.title }),
    el('p', { class: 'topic-excerpt', text: topic.excerpt || '' }),
    mediaGallery(topic.media, { compact: true }),
    el('div', { class: 'topic-card-foot' }, [
      el('span', { class: 'meta author' }, [
        avatarNode(topic, 'mini'),
        icon('user', 14),
        el('span', { text: topic.username })
      ]),
      el('span', { class: 'meta' }, [icon('comment', 14), el('span', { text: String(topic.reply_count ?? 0) })]),
      el('span', { class: 'meta' }, [icon('heart', 14), el('span', { text: String(topic.like_count ?? 0) })]),
      el('span', { class: 'meta' }, [icon('eye', 14), el('span', { text: String(topic.view_count ?? 0) })])
    ])
  ])
}

function emptyState(text) {
  return el('p', { class: 'muted empty-state', text })
}

async function refreshUnread() {
  if (!state.user) state.unread = 0
  else {
    const data = await api('/api/notifications/unread-count').catch(() => ({ count: 0 }))
    state.unread = data.count || 0
  }

  const badge = document.querySelector('#unread-badge')
  if (badge) {
    badge.textContent = String(state.unread)
    badge.classList.toggle('hidden', !state.unread)
  }
}

/* --------------------------------------------------------------------------
   Views
   -------------------------------------------------------------------------- */

async function viewHome() {
  const [{ categories }, { stats }, { topics }] = await Promise.all([
    api('/api/categories'),
    api('/api/stats'),
    api('/api/topics?limit=6&sort=new')
  ])

  const hero = el('section', { class: 'hero' }, [
    flagArt(),
    el('div', { class: 'hero-copy' }, [
      el('p', { class: 'eyebrow', text: 'IRAQ DARK / 2026' }),
      el('h1', { text: 'حيث تلتقي الظلال، وتولد الأفكار، وتصوت الأصوات.' }),
      el('p', {
        class: 'hero-text',
        text: 'مساحة عراقية داكنة للنقاش في الألعاب والتقنية والإبداع — شارك رأيك، اطرح سؤالك، وتابع ما يهمك.'
      }),
      el('div', { class: 'hero-actions' }, [
        el('a', { class: 'button primary', href: '#/topics' }, [el('span', { text: 'استكشف المواضيع' })]),
        state.user
          ? el('a', { class: 'button ghost', href: '#/new' }, [icon('plus', 16), el('span', { text: 'اكتب موضوعاً' })])
          : el('a', { class: 'button ghost', href: '#/register' }, [el('span', { text: 'انضم إلينا' })])
      ])
    ]),
    el('div', { class: 'hero-stats' }, [
      statBlock(stats.topics, 'موضوع'),
      statBlock(stats.replies, 'رد'),
      statBlock(stats.members, 'عضو'),
      statBlock(stats.online, 'جلسة نشطة')
    ])
  ])

  const sections = el('section', { class: 'section-block' }, [
    sectionHeading('DISCOVER', 'الأقسام',
      el('a', { class: 'button ghost small', href: '#/categories', text: 'كل الأقسام' })),
    el('div', { class: 'cards' }, categories.length
      ? categories.map(category => el('a', {
          class: 'category-card',
          href: `#/topics${queryString({ category: category.id })}`
        }, [
          el('span', { class: 'category-icon', text: '◈' }),
          el('div', { class: 'category-body' }, [
            el('strong', { text: category.name }),
            el('small', { text: category.description })
          ]),
          el('span', { class: 'category-count', text: `${category.topic_count}` })
        ]))
      : [emptyState('لا توجد أقسام بعد.')])
  ])

  const latest = el('section', { class: 'section-block' }, [
    sectionHeading('LIVE DISCUSSIONS', 'أحدث المواضيع',
      el('a', { class: 'button ghost small', href: '#/topics', text: 'عرض الكل' })),
    el('div', { class: 'topic-list' }, topics.length
      ? topics.map(topicCard)
      : [emptyState('لا توجد مواضيع بعد — كن أول من يكتب.')])
  ])

  renderLayout(el('div', {}, [hero, sections, latest]))
}

function sectionHeading(eyebrow, title, action = null) {
  return el('div', { class: 'section-heading' }, [
    el('div', {}, [
      el('p', { class: 'eyebrow', text: eyebrow }),
      el('h2', { text: title })
    ]),
    action
  ])
}

async function viewTopics(query) {
  const params = {
    q: query.get('q') || '',
    category: query.get('category') || '',
    sort: query.get('sort') || 'new',
    page: Math.max(1, Number(query.get('page')) || 1),
    limit: 10
  }

  const request = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== '' && value !== 0) request.set(key, value)
  }

  const [{ topics, pagination }, { categories }] = await Promise.all([
    api(`/api/topics?${request.toString()}`),
    api('/api/categories')
  ])

  const setParam = (key, value) => {
    const next = { ...params, [key]: value }
    if (key !== 'page') next.page = 1
    navigate(`#/topics${queryString(next)}`)
  }

  const searchForm = el('form', {
    class: 'filter-search',
    onsubmit: event => {
      event.preventDefault()
      setParam('q', String(new FormData(event.currentTarget).get('q') || '').trim())
    }
  }, [
    icon('search', 16),
    el('input', { name: 'q', type: 'search', value: params.q, placeholder: 'ابحث بالعنوان أو المحتوى…' }),
    el('button', { class: 'button primary small', type: 'submit', text: 'بحث' })
  ])

  const chips = el('div', { class: 'chip-row' }, [
    el('button', {
      class: `chip${params.category ? '' : ' active'}`,
      type: 'button',
      text: 'الكل',
      onclick: () => setParam('category', '')
    }),
    ...categories.map(category => el('button', {
      class: `chip${String(params.category) === String(category.id) ? ' active' : ''}`,
      type: 'button',
      text: `${category.name} (${category.topic_count})`,
      onclick: () => setParam('category', category.id)
    }))
  ])

  const sortSelect = el('select', {
    class: 'sort-select',
    'aria-label': 'الترتيب',
    onchange: event => setParam('sort', event.currentTarget.value)
  }, [
    el('option', { value: 'new', text: 'الأحدث', selected: params.sort === 'new' }),
    el('option', { value: 'active', text: 'الأكثر نقاشاً', selected: params.sort === 'active' }),
    el('option', { value: 'top', text: 'الأكثر إعجاباً', selected: params.sort === 'top' })
  ])
  sortSelect.value = params.sort

  const list = el('div', { class: 'topic-list' },
    topics.length ? topics.map(topicCard) : [emptyState('لا توجد نتائج مطابقة.')])

  const pages = []
  for (let page = 1; page <= pagination.pages; page += 1) {
    if (pagination.pages > 7 && Math.abs(page - pagination.page) > 2 && page !== 1 && page !== pagination.pages) {
      if (pages[pages.length - 1] !== '…') pages.push('…')
      continue
    }
    pages.push(page)
  }

  const paginationBar = pagination.total > 0
    ? el('div', { class: 'pagination' }, [
        el('button', {
          class: 'page-btn',
          type: 'button',
          text: 'السابق',
          disabled: pagination.page <= 1,
          onclick: () => setParam('page', pagination.page - 1)
        }),
        ...pages.map(page => page === '…'
          ? el('span', { class: 'page-ellipsis', text: '…' })
          : el('button', {
              class: `page-btn${page === pagination.page ? ' active' : ''}`,
              type: 'button',
              text: String(page),
              onclick: () => setParam('page', page)
            })),
        el('button', {
          class: 'page-btn',
          type: 'button',
          text: 'التالي',
          disabled: pagination.page >= pagination.pages,
          onclick: () => setParam('page', pagination.page + 1)
        }),
        el('span', { class: 'pagination-meta', text: `${pagination.total} موضوع` })
      ])
    : null

  const header = sectionHeading(
    'DISCUSSIONS',
    params.q ? `نتائج: ${params.q}` : 'كل المواضيع',
    state.user
      ? el('a', { class: 'button primary', href: '#/new' }, [icon('plus', 16), el('span', { text: 'موضوع جديد' })])
      : el('a', { class: 'button primary', href: '#/login', text: 'سجّل الدخول للنشر' })
  )

  renderLayout(el('section', { class: 'panel page-panel' }, [
    header,
    el('div', { class: 'filters' }, [searchForm, sortSelect]),
    chips,
    list,
    paginationBar
  ]))
}

async function viewCategories() {
  const { categories } = await api('/api/categories')

  renderLayout(el('section', { class: 'panel page-panel' }, [
    sectionHeading('SECTIONS', 'الأقسام'),
    el('div', { class: 'cards wide' }, categories.length
      ? categories.map(category => el('a', {
          class: 'category-card',
          href: `#/topics${queryString({ category: category.id })}`
        }, [
          el('span', { class: 'category-icon', text: '◈' }),
          el('div', { class: 'category-body' }, [
            el('strong', { text: category.name }),
            el('small', { text: category.description }),
            el('span', { class: 'meta', text: `${category.topic_count} موضوع` })
          ])
        ]))
      : [emptyState('لا توجد أقسام بعد.')])
  ]))
}

async function viewTopic(id) {
  const data = await api(`/api/topics/${id}`)
  const { topic, replies } = data

  const isOwner = state.user && (state.user.id === topic.author_id || state.user.role === 'admin')
  const canFollow = Boolean(state.user && state.user.id !== topic.author_id)

  const targetProfile = canFollow
    ? await api(`/api/users/${topic.author_id}/profile`).catch(() => null)
    : null

  const likeButton = el('button', {
    class: `action-btn${topic.liked ? ' active' : ''}`,
    type: 'button',
    onclick: async event => {
      if (!state.user) return navigate('#/login')

      try {
        const result = await api(`/api/topics/${topic.id}/like`, { method: 'POST' })
        event.currentTarget.classList.toggle('active', result.liked)
        event.currentTarget.querySelector('.count').textContent = String(result.like_count)
      } catch (error) {
        toast(error.message, 'error')
      }
    }
  }, [icon('heart', 16), el('span', { class: 'count', text: String(topic.like_count) })])

  const bookmarkButton = el('button', {
    class: `action-btn${topic.bookmarked ? ' active' : ''}`,
    type: 'button',
    onclick: async event => {
      if (!state.user) return navigate('#/login')

      try {
        const result = await api(`/api/topics/${topic.id}/bookmark`, { method: 'POST' })
        event.currentTarget.classList.toggle('active', result.bookmarked)
        toast(result.bookmarked ? 'أُضيف إلى المحفوظات' : 'أُزيل من المحفوظات')
      } catch (error) {
        toast(error.message, 'error')
      }
    }
  }, [icon('bookmark', 16), el('span', { text: 'حفظ' })])

  const shareButton = el('button', {
    class: 'action-btn',
    type: 'button',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(window.location.href)
        toast('تم نسخ رابط الموضوع')
      } catch {
        toast('تعذّر نسخ الرابط', 'error')
      }
    }
  }, [icon('share', 16), el('span', { text: 'مشاركة' })])

  const authorRow = el('div', { class: 'author-row' }, [
    el('a', { class: 'author', href: `#/user/${topic.author_id}` }, [
      avatarNode(topic),
      el('div', {}, [
        el('strong', { text: topic.username }),
        el('small', { text: formatDate(topic.created_at) })
      ])
    ]),
    el('div', { class: 'author-actions' }, [
      targetProfile ? followButton(topic.author_id, targetProfile.isFollowing) : null,
      isOwner
        ? el('a', { class: 'action-btn', href: `#/edit/${topic.id}` }, [icon('edit', 16), el('span', { text: 'تعديل' })])
        : null,
      isOwner
        ? el('button', {
            class: 'action-btn danger',
            type: 'button',
            onclick: async () => {
              if (!window.confirm('حذف الموضوع وكل ردوده؟')) return
              try {
                await api(`/api/topics/${topic.id}`, { method: 'DELETE' })
                toast('تم حذف الموضوع')
                navigate('#/topics')
              } catch (error) {
                toast(error.message, 'error')
              }
            }
          }, [icon('trash', 16), el('span', { text: 'حذف' })])
        : null
    ].filter(Boolean))
  ])

  const meta = el('div', { class: 'topic-meta-row' }, [
    categoryChip({ id: topic.category_id, name: topic.category }),
    el('span', { class: 'meta' }, [icon('eye', 14), el('span', { text: `${topic.view_count} مشاهدة` })]),
    el('span', { class: 'meta' }, [icon('comment', 14), el('span', { text: `${replies.length} رد` })]),
    el('span', { class: 'meta', text: timeAgo(topic.created_at) })
  ])

  const replyItems = replies.map(reply => {
    const isReplyOwner = state.user && (state.user.id === reply.author_id || state.user.role === 'admin')

    const replyLike = el('button', {
      class: `action-btn small${reply.liked ? ' active' : ''}`,
      type: 'button',
      onclick: async event => {
        if (!state.user) return navigate('#/login')

        try {
          const result = await api(`/api/replies/${reply.id}/like`, { method: 'POST' })
          event.currentTarget.classList.toggle('active', result.liked)
          event.currentTarget.querySelector('.count').textContent = String(result.like_count)
        } catch (error) {
          toast(error.message, 'error')
        }
      }
    }, [icon('heart', 14), el('span', { class: 'count', text: String(reply.like_count) })])

    return el('article', { class: 'reply' }, [
      el('div', { class: 'reply-head' }, [
        el('a', { class: 'author', href: `#/user/${reply.author_id}` }, [
          avatarNode(reply, 'mini'),
          el('strong', { text: reply.username })
        ]),
        el('span', { class: 'meta', text: timeAgo(reply.created_at) })
      ]),
      el('p', { class: 'reply-content', text: reply.content }),
      el('div', { class: 'reply-actions' }, [
        replyLike,
        isReplyOwner
          ? el('button', {
              class: 'action-btn small danger',
              type: 'button',
              onclick: async () => {
                if (!window.confirm('حذف الرد؟')) return
                try {
                  await api(`/api/replies/${reply.id}`, { method: 'DELETE' })
                  toast('تم حذف الرد')
                  viewTopic(topic.id)
                } catch (error) {
                  toast(error.message, 'error')
                }
              }
            }, [icon('trash', 14), el('span', { text: 'حذف' })])
          : null
      ].filter(Boolean))
    ])
  })

  const replyForm = state.user
    ? el('form', { class: 'reply-form' }, [
        el('label', { class: 'field' }, [
          el('span', { text: 'اكتب ردك' }),
          el('textarea', { name: 'content', required: true, maxlength: '5000', rows: '5', placeholder: 'شارك رأيك بأسلوب رصين…' })
        ]),
        el('div', { class: 'form-actions' }, [
          el('button', { class: 'button primary', type: 'submit' }, [icon('send', 16), el('span', { text: 'إرسال الرد' })])
        ])
      ])
    : el('div', { class: 'login-cta' }, [
        el('p', { text: 'سجّل الدخول للمشاركة في النقاش.' }),
        el('a', { class: 'button primary', href: '#/login', text: 'تسجيل الدخول' })
      ])

  replyForm.addEventListener?.('submit', async event => {
    event.preventDefault()
    const content = String(new FormData(event.currentTarget).get('content') || '').trim()
    if (!content) return

    try {
      await api(`/api/topics/${topic.id}/replies`, {
        method: 'POST',
        body: JSON.stringify({ content })
      })
      toast('تم نشر ردك')
      viewTopic(topic.id)
    } catch (error) {
      toast(error.message, 'error')
    }
  })

  renderLayout(el('section', { class: 'panel topic-page' }, [
    el('a', { class: 'button ghost small back-btn', href: '#/topics' }, [icon('back', 16), el('span', { text: 'كل المواضيع' })]),
    meta,
    el('h1', { class: 'topic-title', text: topic.title }),
    authorRow,
    topic.content
      ? el('div', { class: 'topic-content', text: topic.content })
      : null,
    mediaGallery(topic.media),
    el('div', { class: 'topic-actions' }, [likeButton, bookmarkButton, shareButton]),
    el('hr'),
    el('h3', { class: 'replies-title', text: `الردود (${replies.length})` }),
    el('div', { class: 'replies' }, replies.length ? replyItems : [emptyState('لا ردود بعد —ابدأ أنت النقاش.')]),
    replyForm
  ]))

  refreshUnread()
}

function followButton(userId, initiallyFollowing = false) {
  let following = initiallyFollowing

  return el('button', {
    class: `action-btn follow${following ? ' active' : ''}`,
    type: 'button',
    text: following ? 'تتم المتابعة' : 'متابعة',
    onclick: async event => {
      try {
        const result = await api(`/api/users/${userId}/follow`, { method: 'POST' })
        following = result.following
        event.currentTarget.classList.toggle('active', following)
        event.currentTarget.textContent = following ? 'تتم المتابعة' : 'متابعة'
        toast(following ? 'تتم متابعة هذا العضو' : 'أُلغيت المتابعة')
      } catch (error) {
        toast(error.message, 'error')
      }
    }
  })
}

function authView(mode) {
  const isLogin = mode === 'login'

  const fields = isLogin
    ? [
        { name: 'usernameOrEmail', label: 'اسم المستخدم أو البريد', type: 'text', autocomplete: 'username' },
        { name: 'password', label: 'كلمة المرور', type: 'password', autocomplete: 'current-password' }
      ]
    : [
        { name: 'username', label: 'اسم المستخدم (حروف وأرقام إنجليزية)', type: 'text', autocomplete: 'username' },
        { name: 'email', label: 'البريد الإلكتروني', type: 'email', autocomplete: 'email' },
        { name: 'password', label: 'كلمة المرور (8 أحرف على الأقل)', type: 'password', autocomplete: 'new-password' }
      ]

  const form = el('form', { class: 'auth-card' }, [
    el('p', { class: 'eyebrow', text: 'IRAQ DARK ACCOUNT' }),
    el('h2', { text: isLogin ? 'تسجيل الدخول' : 'إنشاء حساب' }),
    el('p', {
      class: 'auth-hint',
      text: isLogin ? 'أهلاً بعودتك إلى الظلام.' : 'انضم إلى النقاش — الحساب مجاني وسريع.'
    })
  ])

  for (const field of fields) {
    form.append(el('label', { class: 'field' }, [
      el('span', { text: field.label }),
      el('input', {
        name: field.name,
        type: field.type,
        required: true,
        autocomplete: field.autocomplete,
        minlength: field.type === 'password' && !isLogin ? '8' : null
      })
    ]))
  }

  form.append(el('button', {
    class: 'button primary full',
    type: 'submit',
    text: isLogin ? 'دخول' : 'إنشاء الحساب'
  }))

  form.append(el('p', { class: 'auth-switch' }, [
    el('span', { text: isLogin ? 'ما عندك حساب؟' : 'عندك حساب بالفعل؟' }),
    el('a', { href: isLogin ? '#/register' : '#/login', text: isLogin ? 'أنشئ واحداً' : 'سجّل الدخول' })
  ]))

  form.addEventListener('submit', async event => {
    event.preventDefault()

    const button = form.querySelector('button[type="submit"]')
    button.disabled = true

    try {
      const body = Object.fromEntries(new FormData(form))
      const result = await api(isLogin ? '/api/auth/login' : '/api/auth/register', {
        method: 'POST',
        body: JSON.stringify(body)
      })

      state.user = result.user
      await refreshMe()
      await refreshUnread()
      toast(isLogin ? `أهلاً ${result.user.username}` : 'تم إنشاء حسابك بنجاح')
      navigate('#/')
    } catch (error) {
      toast(error.message, 'error')
      button.disabled = false
    }
  })

  renderLayout(el('div', { class: 'auth-wrap' }, [form]))
}

async function viewTopicForm(editId = null) {
  if (!state.user) {
    toast('يجب تسجيل الدخول أولا', 'error')
    return navigate('#/login')
  }

  const { categories } = await api('/api/categories')
  let initial = { title: '', content: '', category_id: categories[0]?.id }
  let initialMedia = []

  if (editId) {
    const data = await api(`/api/topics/${editId}`)
    if (data.topic.author_id !== state.user.id && state.user.role !== 'admin') {
      toast('لا تملك صلاحية تعديل هذا الموضوع', 'error')
      return navigate(`#/topic/${editId}`)
    }
    initial = {
      title: data.topic.title,
      content: data.topic.content,
      category_id: data.topic.category_id
    }
    initialMedia = data.topic.media || []
  }

  const attach = attachField(initialMedia)
  const submitBtn = el('button', {
    class: 'button primary',
    type: 'submit',
    text: editId ? 'حفظ التعديلات' : 'نشر الموضوع'
  })

  const form = el('form', { class: 'panel form-card' }, [
    el('p', { class: 'eyebrow', text: editId ? 'EDIT DISCUSSION' : 'NEW DISCUSSION' }),
    el('h2', { text: editId ? 'تعديل الموضوع' : 'إنشاء موضوع' }),
    el('label', { class: 'field' }, [
      el('span', { text: 'القسم' }),
      el('select', { name: 'categoryId', required: true, value: String(initial.category_id) }, categories.map(category =>
        el('option', { value: category.id, text: category.name })
      ))
    ]),
    el('label', { class: 'field' }, [
      el('span', { text: 'العنوان' }),
      el('input', { name: 'title', required: true, maxlength: '120', value: initial.title, placeholder: 'عنوان واضح يجذب الانتباه' })
    ]),
    el('label', { class: 'field' }, [
      el('span', { text: 'المحتوى' }),
      el('textarea', { name: 'content', maxlength: '10000', rows: '10', placeholder: 'اكتب موضوعك هنا… أو اكتفِ بمرفق' }, [])
    ]),
    attach.node,
    el('div', { class: 'form-actions' }, [
      submitBtn,
      el('a', {
        class: 'button ghost',
        href: editId ? `#/topic/${editId}` : '#/topics',
        text: 'إلغاء',
        onclick: () => attach.clearPreviews()
      })
    ])
  ])

  form.querySelector('textarea').value = initial.content

  form.addEventListener('submit', async event => {
    event.preventDefault()
    const body = Object.fromEntries(new FormData(form))
    body.categoryId = Number(body.categoryId)

    const label = submitBtn.textContent
    submitBtn.disabled = true
    submitBtn.textContent = 'جارٍ النشر…'

    try {
      body.media = await attach.collect()

      if (!String(body.content || '').trim() && !body.media.length) {
        throw new Error('أضف نصاً للموضوع أو مرفقاً واحداً على الأقل')
      }

      const result = editId
        ? await api(`/api/topics/${editId}`, { method: 'PATCH', body: JSON.stringify(body) })
        : await api('/api/topics', { method: 'POST', body: JSON.stringify(body) })

      attach.clearPreviews()
      toast(editId ? 'تم حفظ التعديلات' : 'تم نشر الموضوع')
      navigate(`#/topic/${result.topic.id}`)
    } catch (error) {
      toast(error.message, 'error')
      submitBtn.disabled = false
      submitBtn.textContent = label
    }
  })

  renderLayout(form)
}

async function viewNotifications() {
  if (!state.user) {
    toast('يجب تسجيل الدخول أولا', 'error')
    return navigate('#/login')
  }

  const { notifications } = await api('/api/notifications')

  const list = notifications.length
    ? notifications.map(item => el('a', {
        class: `notification-item${item.is_read ? '' : ' unread'}`,
        href: item.topic_id ? `#/topic/${item.topic_id}` : '#/profile'
      }, [
        el('span', { class: 'notification-dot' }),
        el('div', {}, [
          el('strong', { text: item.message }),
          el('small', { text: timeAgo(item.created_at) })
        ])
      ]))
    : [emptyState('لا توجد إشعارات حاليا.')]

  renderLayout(el('section', { class: 'panel page-panel notifications-page' }, [
    el('div', { class: 'section-heading' }, [
      sectionHeading('ACTIVITY', 'الإشعارات'),
      notifications.some(item => !item.is_read)
        ? el('button', {
            class: 'button ghost small',
            type: 'button',
            text: 'تحديد الكل كمقروء',
            onclick: async () => {
              await api('/api/notifications/read', { method: 'POST' })
              await refreshUnread()
              viewNotifications()
            }
          })
        : null
    ].filter(Boolean)),
    el('div', { class: 'notifications-list' }, list)
  ]))

  refreshUnread()
}

async function viewBookmarks() {
  if (!state.user) {
    toast('يجب تسجيل الدخول أولا', 'error')
    return navigate('#/login')
  }

  const { topics } = await api('/api/bookmarks')

  renderLayout(el('section', { class: 'panel page-panel' }, [
    sectionHeading('SAVED', 'الموضوعات المحفوظة'),
    el('div', { class: 'topic-list' },
      topics.length ? topics.map(topicCard) : [emptyState('لا توجد مواضيع محفوظة بعد.')])
  ]))
}

async function viewProfile(userId) {
  if (!userId) {
    if (!state.user) return navigate('#/login')
    userId = state.user.id
  }

  const profile = await api(`/api/users/${userId}/profile`)
  const { profile: user, isFollowing, isSelf } = profile
  const { topics } = await api(`/api/topics?author=${userId}&limit=20`)

  const avatarInputId = `avatar-file-${attachId++}`

  const avatarInput = el('input', {
    id: avatarInputId,
    type: 'file',
    class: 'attach-input',
    accept: 'image/jpeg,image/png,image/webp,image/gif,image/avif',
    onchange: async event => {
      const file = event.target.files && event.target.files[0]
      event.target.value = ''
      if (!file) return

      try {
        const stored = await uploadFile(file, 'avatar')
        await api('/api/profile', {
          method: 'PATCH',
          body: JSON.stringify({ avatar_url: stored.url })
        })
        toast('تم تحديث الصورة الشخصية')
        await refreshMe()
        viewProfile(userId)
      } catch (error) {
        toast(error.message, 'error')
      }
    }
  })

  const avatarColumn = el('div', { class: 'profile-avatar' }, [
    avatarNode(user, 'big'),
    isSelf ? avatarInput : null,
    isSelf
      ? el('label', { class: 'button ghost small avatar-pick', for: avatarInputId }, [
          icon('edit', 14),
          el('span', { text: 'تغيير الصورة' })
        ])
      : null,
    isSelf && user.avatar_url
      ? el('button', {
          class: 'button ghost small danger',
          type: 'button',
          text: 'إزالة الصورة',
          onclick: async () => {
            try {
              await api('/api/profile', {
                method: 'PATCH',
                body: JSON.stringify({ avatar_url: '' })
              })
              toast('تمت إزالة الصورة الشخصية')
              await refreshMe()
              viewProfile(userId)
            } catch (error) {
              toast(error.message, 'error')
            }
          }
        })
      : null
  ].filter(Boolean))

  const header = el('div', { class: 'profile-card' }, [
    avatarColumn,
    el('div', { class: 'profile-info' }, [
      el('h1', { text: user.username }),
      el('div', { class: 'profile-tags' }, [
        el('span', { class: `chip role ${user.role}`, text: user.role === 'admin' ? 'مدير' : 'عضو' }),
        el('span', { class: 'meta', text: `عضو منذ ${formatDate(user.created_at)}` })
      ]),
      el('p', { class: 'profile-bio', text: user.bio || 'لا توجد نبذة بعد.' })
    ]),
    el('div', { class: 'profile-actions' }, [
      isSelf
        ? el('a', { class: 'button ghost', href: '#/notifications'}, [icon('bell', 16), el('span', { text: 'الإشعارات' })])
        : null,
      isSelf
        ? el('button', {
            class: 'button ghost danger',
            type: 'button',
            onclick: logout
          }, [icon('logout', 16), el('span', { text: 'خروج' })])
        : null,
      !isSelf && state.user
        ? el('button', {
            class: `button ${isFollowing ? 'ghost' : 'primary'}`,
            type: 'button',
            text: isFollowing ? 'تتم المتابعة' : 'متابعة',
            onclick: async event => {
              try {
                const result = await api(`/api/users/${userId}/follow`, { method: 'POST' })
                event.currentTarget.textContent = result.following ? 'تتم المتابعة' : 'متابعة'
                event.currentTarget.className = `button ${result.following ? 'ghost' : 'primary'}`
                toast(result.following ? 'تتم متابعة هذا العضو' : 'أُلغيت المتابعة')
                viewProfile(userId)
              } catch (error) {
                toast(error.message, 'error')
              }
            }
          })
        : null,
      !state.user ? el('a', { class: 'button primary', href: '#/login', text: 'متابعة' }) : null
    ].filter(Boolean))
  ])

  const stats = el('div', { class: 'profile-stats' }, [
    statBlock(user.topic_count, 'موضوع'),
    statBlock(user.reply_count, 'رد'),
    statBlock(user.likes_received, 'إعجاب'),
    statBlock(user.views_received, 'مشاهدة'),
    statBlock(user.followers_count, 'متابع'),
    statBlock(user.following_count, 'يتابع')
  ])

  const profileForm = isSelf
    ? (() => {
        const form = el('form', { class: 'bio-form' }, [
          el('label', { class: 'field' }, [
            el('span', { text: 'اسم المستخدم' }),
            el('input', {
              name: 'username',
              required: true,
              minlength: '3',
              maxlength: '24',
              pattern: '[a-zA-Z0-9_]+',
              value: user.username,
              placeholder: 'يُسمح بالحروف والرقم والشرطة السفلية'
            })
          ]),
          el('label', { class: 'field' }, [
            el('span', { text: 'نبذة عنك' }),
            el('textarea', { name: 'bio', maxlength: '300', rows: '3', placeholder: 'عرّف بنفسك في سطرين…' }, [])
          ]),
          el('div', { class: 'form-actions' }, [
            el('button', { class: 'button primary small', type: 'submit', text: 'حفظ البيانات' })
          ])
        ])

        form.querySelector('textarea').value = user.bio || ''

        form.addEventListener('submit', async event => {
          event.preventDefault()
          const data = new FormData(form)

          try {
            await api('/api/profile', {
              method: 'PATCH',
              body: JSON.stringify({
                username: String(data.get('username') || '').trim(),
                bio: data.get('bio')
              })
            })
            toast('تم حفظ بياناتك')
            await refreshMe()
            viewProfile(userId)
          } catch (error) {
            toast(error.message, 'error')
          }
        })

        return form
      })()
    : null

  renderLayout(el('div', { class: 'profile-page' }, [
    header,
    stats,
    profileForm,
    el('section', { class: 'section-block' }, [
      sectionHeading('POSTS', isSelf ? 'مواضيعك' : `مواضيع ${user.username}`),
      el('div', { class: 'topic-list' },
        topics.length ? topics.map(topicCard) : [emptyState('لا توجد مواضيع بعد.')])
    ])
  ].filter(Boolean)))
}

/* --------------------------------------------------------------------------
   Admin panel — visible to admins only (server enforces it too)
   -------------------------------------------------------------------------- */

async function viewAdmin(query) {
  if (!state.user) {
    toast('يجب تسجيل الدخول أولا', 'error')
    return navigate('#/login')
  }

  if (state.user.role !== 'admin') {
    return renderLayout(el('section', { class: 'panel page-panel center-panel' }, [
      el('p', { class: 'eyebrow', text: '403' }),
      el('h2', { text: 'غير مخوّل' }),
      el('p', { class: 'muted', text: 'لوحة التحكم مخصصة لمسؤول الموقع فقط.' }),
      el('a', { class: 'button primary', href: '#/', text: 'العودة للرئيسية' })
    ]))
  }

  const params = {
    q: query.get('q') || '',
    role: query.get('role') || '',
    status: query.get('status') || '',
    page: Math.max(1, Number(query.get('page')) || 1)
  }

  const setParam = (key, value) => {
    const next = { ...params, [key]: value }
    if (key !== 'page') next.page = 1
    navigate(`#/admin${queryString(next)}`)
  }

  const [{ stats }, { users, pagination }] = await Promise.all([
    api('/api/admin/overview'),
    api(`/api/admin/users${queryString(params)}`)
  ])

  const refresh = () => viewAdmin(parseRoute().query)

  async function patch(userId, body, successMessage) {
    try {
      await api(`/api/admin/users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify(body)
      })
      toast(successMessage)
      return true
    } catch (error) {
      toast(error.message, 'error')
      return false
    }
  }

  function adminRow(user) {
    const isSelf = user.id === state.user.id
    const editing = adminUi.editingId === user.id

    const roleChip = el('span', {
      class: `chip role ${user.role}`,
      text: user.role === 'admin' ? 'مدير' : 'عضو'
    })

    const statusChip = user.is_banned
      ? el('span', { class: 'chip banned', text: 'موقوف' })
      : null

    const roleAction = isSelf
      ? null
      : el('button', {
          class: 'button ghost small',
          type: 'button',
          text: user.role === 'admin' ? 'تخفيض' : 'ترقية',
          onclick: async () => {
            const next = user.role === 'admin' ? 'member' : 'admin'

            if (next === 'member' && !window.confirm(`تخفيض ${user.username} إلى عضو عادي؟`)) return

            const ok = await patch(
              user.id,
              { role: next },
              next === 'admin' ? `تمت ترقية ${user.username} إلى مدير` : `تم تخفيض ${user.username}`
            )

            if (ok) refresh()
          }
        })

    const banning = adminUi.banId === user.id

    const banAction = isSelf
      ? null
      : user.is_banned
        ? el('button', {
            class: 'button primary small',
            type: 'button',
            text: 'رفع الإيقاف',
            onclick: async () => {
              if (!window.confirm(`رفع الإيقاف عن ${user.username}؟`)) return

              const ok = await patch(
                user.id,
                { is_banned: false },
                `رُفع الإيقاف عن ${user.username}`
              )

              if (ok) refresh()
            }
          })
        : el('button', {
            class: 'button ghost small',
            type: 'button',
            text: 'إيقاف',
            onclick: () => {
              adminUi.banId = user.id
              adminUi.editingId = null
              refresh()
            }
          })

    const banForm = banning
      ? (() => {
          const form = el('form', { class: 'admin-edit-form ban-form' }, [
            el('label', { class: 'field' }, [
              el('span', { text: 'سبب الإيقاف عن النشر' }),
              el('input', { name: 'reason', value: 'مخالفة قوانين المنتدى', maxlength: '200' })
            ]),
            el('div', { class: 'form-actions' }, [
              el('button', { class: 'button danger small', type: 'submit', text: 'تأكيد الإيقاف' }),
              el('button', {
                class: 'button ghost small',
                type: 'button',
                text: 'إلغاء',
                onclick: () => {
                  adminUi.banId = null
                  refresh()
                }
              })
            ])
          ])

          form.addEventListener('submit', async event => {
            event.preventDefault()
            const data = new FormData(form)

            const ok = await patch(
              user.id,
              { is_banned: true, banned_reason: data.get('reason') },
              `تم إيقاف ${user.username} عن النشر`
            )

            if (ok) {
              adminUi.banId = null
              refresh()
            }
          })

          return form
        })()
      : null

    const editAction = el('button', {
      class: 'button ghost small',
      type: 'button',
      text: editing ? 'إغلاق' : 'تعديل',
      onclick: () => {
        adminUi.editingId = editing ? null : user.id
        adminUi.banId = null
        refresh()
      }
    })

    const deleteAction = isSelf
      ? null
      : el('button', {
          class: 'button danger small',
          type: 'button',
          text: 'حذف',
          onclick: async () => {
            const summary = `سيُحذف ${user.topic_count} موضوع و${user.reply_count} رد — لا يمكن التراجع.`

            if (!window.confirm(`حذف حساب ${user.username} نهائياً؟\n${summary}`)) return

            try {
              await api(`/api/admin/users/${user.id}`, { method: 'DELETE' })
              toast(`تم حذف ${user.username}`)
              adminUi.editingId = null
              adminUi.banId = null
              refresh()
            } catch (error) {
              toast(error.message, 'error')
            }
          }
        })

    const editForm = editing
      ? (() => {
          const form = el('form', { class: 'admin-edit-form' }, [
            el('label', { class: 'field' }, [
              el('span', { text: 'اسم المستخدم (إنجليزي)' }),
              el('input', { name: 'username', value: user.username, maxlength: '24' })
            ]),
            el('label', { class: 'field' }, [
              el('span', { text: 'البريد الإلكتروني' }),
              el('input', { name: 'email', type: 'email', value: user.email, maxlength: '120' })
            ]),
            el('div', { class: 'form-actions' }, [
              el('button', { class: 'button primary small', type: 'submit', text: 'حفظ' }),
              el('button', {
                class: 'button ghost small',
                type: 'button',
                text: 'إلغاء',
                onclick: () => {
                  adminUi.editingId = null
                  refresh()
                }
              })
            ])
          ])

          form.addEventListener('submit', async event => {
            event.preventDefault()
            const data = new FormData(form)

            const ok = await patch(
              user.id,
              { username: data.get('username'), email: data.get('email') },
              `تم تحديث بيانات ${user.username}`
            )

            if (ok) {
              adminUi.editingId = null
              refresh()
            }
          })

          return form
        })()
      : null

    return el('div', { class: `admin-row${user.is_banned ? ' banned' : ''}` }, [
      el('div', { class: 'admin-row-head' }, [
        avatarNode(user),
        el('div', { class: 'admin-row-id' }, [
          el('div', { class: 'admin-row-name' }, [
            el('strong', { text: user.username }),
            isSelf ? el('span', { class: 'chip self', text: 'أنت' }) : null,
            roleChip,
            statusChip
          ].filter(Boolean)),
          el('small', { class: 'muted', text: user.email }),
          user.is_banned && user.banned_reason
            ? el('small', { class: 'admin-ban-reason', text: `السبب: ${user.banned_reason}` })
            : null
        ].filter(Boolean)),
        el('div', { class: 'admin-row-actions' }, [
          roleAction,
          banAction,
          editAction,
          deleteAction
        ].filter(Boolean))
      ]),
      el('div', { class: 'admin-row-meta' }, [
        el('span', { class: 'meta' }, [icon('comment', 14), el('span', { text: `${user.topic_count} موضوع` })]),
        el('span', { class: 'meta' }, [icon('send', 14), el('span', { text: `${user.reply_count} رد` })]),
        el('span', { class: 'meta' }, [icon('user', 14), el('span', { text: `منذ ${formatDate(user.created_at)}` })]),
        user.banned_at
          ? el('span', { class: 'meta' }, [icon('ban', 14), el('span', { text: `أُوقف ${timeAgo(user.banned_at)}` })])
          : null
      ].filter(Boolean)),
      editForm,
      banForm
    ])
  }

  const searchForm = el('form', {
    class: 'filter-search',
    onsubmit: event => {
      event.preventDefault()
      setParam('q', String(new FormData(event.currentTarget).get('q') || '').trim())
    }
  }, [
    icon('search', 16),
    el('input', { name: 'q', type: 'search', value: params.q, placeholder: 'ابحث بالاسم أو البريد…' }),
    el('button', { class: 'button primary small', type: 'submit', text: 'بحث' })
  ])

  const roleChips = el('div', { class: 'chip-row' }, [
    el('button', {
      class: `chip${params.role ? '' : ' active'}`,
      type: 'button',
      text: 'كل الأدوار',
      onclick: () => setParam('role', '')
    }),
    el('button', {
      class: `chip${params.role === 'admin' ? ' active' : ''}`,
      type: 'button',
      text: 'المديرون',
      onclick: () => setParam('role', 'admin')
    }),
    el('button', {
      class: `chip${params.role === 'member' ? ' active' : ''}`,
      type: 'button',
      text: 'الأعضاء',
      onclick: () => setParam('role', 'member')
    }),
    el('span', { class: 'chip-divider', text: '•' }),
    el('button', {
      class: `chip${params.status === 'banned' ? ' active' : ''}`,
      type: 'button',
      text: 'الموقوفون',
      onclick: () => setParam('status', params.status === 'banned' ? '' : 'banned')
    }),
    el('button', {
      class: `chip${params.status === 'active' ? ' active' : ''}`,
      type: 'button',
      text: 'النشطون',
      onclick: () => setParam('status', params.status === 'active' ? '' : 'active')
    })
  ])

  const statsBlock = el('div', { class: 'admin-stats' }, [
    statBlock(stats.members, 'عضو'),
    statBlock(stats.admins, 'مدير'),
    statBlock(stats.banned, 'موقوف'),
    statBlock(stats.online, 'متصل الآن'),
    statBlock(stats.topics, 'موضوع'),
    statBlock(stats.replies, 'رد')
  ])

  const list = users.length
    ? users.map(adminRow)
    : [emptyState('لا يوجد حسابات مطابقة.')]

  const pages = []
  for (let page = 1; page <= pagination.pages; page += 1) {
    if (pagination.pages > 7 && page > 2 && page < pagination.pages - 1 && Math.abs(page - pagination.page) > 1) {
      if (pages[pages.length - 1] !== '…') pages.push('…')
      continue
    }
    pages.push(page)
  }

  const paginationBar = pagination.pages > 1
    ? el('div', { class: 'pagination' }, [
        el('button', {
          class: 'page-btn',
          type: 'button',
          text: 'السابق',
          disabled: pagination.page <= 1,
          onclick: () => setParam('page', pagination.page - 1)
        }),
        ...pages.map(page => page === '…'
          ? el('span', { class: 'page-ellipsis', text: '…' })
          : el('button', {
              class: `page-btn${page === pagination.page ? ' active' : ''}`,
              type: 'button',
              text: String(page),
              onclick: () => setParam('page', page)
            })),
        el('button', {
          class: 'page-btn',
          type: 'button',
          text: 'التالي',
          disabled: pagination.page >= pagination.pages,
          onclick: () => setParam('page', pagination.page + 1)
        }),
        el('span', { class: 'pagination-meta', text: `${pagination.total} حساب` })
      ])
    : null

  renderLayout(el('section', { class: 'panel page-panel admin-page' }, [
    el('div', { class: 'section-heading' }, [
      sectionHeading('CONTROL ROOM', 'لوحة التحكم'),
      el('button', {
        class: 'button ghost small',
        type: 'button',
        text: 'تحديث',
        onclick: refresh
      })
    ]),
    statsBlock,
    el('div', { class: 'filters' }, [searchForm]),
    roleChips,
    el('div', { class: 'admin-list' }, list),
    paginationBar
  ].filter(Boolean)))
}

async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST' })
  } catch {
    // Session may already be gone.
  }

  state.user = null
  state.unread = 0
  toast('تم تسجيل الخروج')
  navigate('#/')
}

function viewNotFound() {
  renderLayout(el('section', { class: 'panel page-panel center-panel' }, [
    el('p', { class: 'eyebrow', text: '404' }),
    el('h2', { text: 'الصفحة غير موجودة' }),
    el('a', { class: 'button primary', href: '#/', text: 'العودة للرئيسية' })
  ]))
}

/* --------------------------------------------------------------------------
   Router
   -------------------------------------------------------------------------- */

async function render() {
  const route = parseRoute()
  const [head, param] = route.parts

  closeMenu()

  try {
    if (!head || head === 'home') await viewHome()
    else if (head === 'topics') await viewTopics(route.query)
    else if (head === 'categories') await viewCategories()
    else if (head === 'topic' && param) await viewTopic(Number(param))
    else if (head === 'new') await viewTopicForm()
    else if (head === 'edit' && param) await viewTopicForm(Number(param))
    else if (head === 'login') authView('login')
    else if (head === 'register') authView('register')
    else if (head === 'notifications') await viewNotifications()
    else if (head === 'admin') await viewAdmin(route.query)
    else if (head === 'bookmarks') await viewBookmarks()
    else if (head === 'profile') await viewProfile()
    else if (head === 'user' && param) await viewProfile(Number(param))
    else viewNotFound()
  } catch (error) {
    if (error.status === 401) {
      state.user = null
      renderLayout(el('section', { class: 'panel page-panel center-panel' }, [
        el('h2', { text: 'يجب تسجيل الدخول' }),
        el('p', { class: 'muted', text: error.message }),
        el('a', { class: 'button primary', href: '#/login', text: 'تسجيل الدخول' })
      ]))
    } else {
      renderLayout(el('section', { class: 'panel page-panel center-panel' }, [
        el('h2', { text: 'تعذّر تحميل الصفحة' }),
        el('p', { class: 'muted', text: error.message }),
        el('button', { class: 'button primary', type: 'button', text: 'إعادة المحاولة', onclick: render })
      ]))
    }
  }

  const key = window.location.hash || '#/'
  if (key !== state.lastRoute) {
    state.lastRoute = key
    window.scrollTo(0, 0)
  }

  closeMenu()
}

/* --------------------------------------------------------------------------
   Boot
   -------------------------------------------------------------------------- */

async function boot() {
  app.replaceChildren(el('div', { class: 'boot-screen' }, [
    el('div', { class: 'spinner' }),
    el('p', { class: 'muted', text: 'جارٍ تحميل IRAQ DARK…' })
  ]))

  const me = await api('/api/auth/me').catch(() => ({ user: null }))
  state.user = me.user

  await refreshUnread()
  await render()

  // Keep the unread badge fresh without re-rendering the whole page.
  setInterval(() => {
    if (state.user) refreshUnread()
  }, 45000)
}

boot()
