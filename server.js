'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
loadEnvFile(path.join(ROOT, '.env'));

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const DATA_ROOT = path.resolve(process.env.DATA_ROOT || path.join(ROOT, 'storage'));
const DB_FILE = path.resolve(process.env.DB_FILE || path.join(DATA_ROOT, 'belilas.sqlite'));
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(DATA_ROOT, 'uploads'));
const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR || path.join(DATA_ROOT, 'media'));
const TMP_DIR = path.resolve(process.env.TMP_DIR || path.join(DATA_ROOT, 'tmp'));
const MAX_UPLOAD_MB = clampNumber(process.env.MAX_UPLOAD_MB, 25, 1, 100);
const MAX_UPLOAD_FILES = clampNumber(process.env.MAX_UPLOAD_FILES, 5, 1, 10);
const SESSION_HOURS = clampNumber(process.env.ADMIN_SESSION_HOURS, 8, 1, 72);
const COOKIE_NAME = 'belilas_admin_session';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (IS_PROD ? '' : 'BELILASPRINTING2026STORE');
const SESSION_SECRET = process.env.SESSION_SECRET || (IS_PROD ? '' : crypto.randomBytes(48).toString('hex'));

if (IS_PROD && (!ADMIN_PASSWORD || ADMIN_PASSWORD.includes('GANTI_DENGAN'))) throw new Error('ADMIN_PASSWORD wajib diisi dengan password asli pada environment production.');
if (IS_PROD && ADMIN_PASSWORD.length < 16) throw new Error('ADMIN_PASSWORD minimal 16 karakter pada production.');
if (IS_PROD && (!SESSION_SECRET || SESSION_SECRET.includes('GANTI_DENGAN'))) throw new Error('SESSION_SECRET wajib diisi dengan secret acak pada environment production.');
if (IS_PROD && SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET minimal 32 karakter pada production.');
if (PUBLIC_BASE_URL) {
  let parsedBase;
  try { parsedBase = new URL(PUBLIC_BASE_URL); } catch { throw new Error('PUBLIC_BASE_URL tidak valid. Gunakan format https://domain-anda'); }
  if (IS_PROD && parsedBase.protocol !== 'https:') throw new Error('PUBLIC_BASE_URL production wajib menggunakan https://');
}
if (!IS_PROD && !process.env.SESSION_SECRET) console.warn('[DEV] SESSION_SECRET sementara dibuat otomatis. Session admin akan logout ketika server restart.');
if (IS_PROD && !PUBLIC_BASE_URL) console.warn('[PROD] PUBLIC_BASE_URL belum diisi. Isi setelah domain aktif agar origin check dan sitemap optimal.');

for (const dir of [DATA_ROOT, path.dirname(DB_FILE), UPLOAD_DIR, MEDIA_DIR, TMP_DIR, path.join(DATA_ROOT, 'backups')]) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new DatabaseSync(DB_FILE, { timeout: 5000 });
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    status TEXT NOT NULL,
    phone_last8 TEXT NOT NULL,
    payload TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_orders_phone_last8 ON orders(phone_last8);
`);

seedDatabaseIfEmpty();

const app = express();
app.disable('x-powered-by');
app.set('env', NODE_ENV);
configureTrustProxy(app, process.env.TRUST_PROXY);

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
      formAction: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      upgradeInsecureRequests: IS_PROD ? [] : null
    }
  }
}));
app.use(compression());
app.use(express.json({ limit: '1mb', type: ['application/json', 'application/*+json'] }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Terlalu banyak percobaan login. Coba lagi beberapa saat.' }
});
const orderLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Terlalu banyak pesanan dari koneksi ini. Coba lagi nanti.' }
});
const trackingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 80,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Terlalu banyak pengecekan status. Coba lagi sebentar.' }
});

app.use('/media', express.static(MEDIA_DIR, {
  index: false,
  dotfiles: 'deny',
  maxAge: '30d',
  immutable: true,
  setHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
}));
app.use(express.static(path.join(ROOT, 'public'), {
  index: 'index.html',
  dotfiles: 'deny',
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

// Health endpoints for hosting/load balancer.
app.get('/healthz', (req, res) => res.status(200).json({ ok: true, service: 'belilas-digital-printing' }));
app.get('/readyz', (req, res) => {
  try {
    fs.mkdirSync(DATA_ROOT, { recursive: true });
    res.status(200).json({
      ok: true,
      service: "belilas-digital-printing"
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      error: error.message
    });
  }
});

app.get('/robots.txt', (req, res) => {
  const base = PUBLIC_BASE_URL || requestOrigin(req);
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /admin.html\nDisallow: /api/admin/\nSitemap: ${base}/sitemap.xml\n`);
});
app.get('/sitemap.xml', (req, res) => {
  const base = escapeXml(PUBLIC_BASE_URL || requestOrigin(req));
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${base}/</loc></url></urlset>`);
});

// Public CMS data.
app.get('/api/settings', (req, res) => res.json(getKvJson('settings', {})));
app.get('/api/products', (req, res) => res.json(getKvJson('products', [])));
app.get('/api/config', (req, res) => res.json({ maxUploadMb: MAX_UPLOAD_MB, maxUploadFiles: MAX_UPLOAD_FILES }));

// Admin authentication: password is never stored in browser storage and never placed in URLs.
app.post('/api/admin/login', loginLimiter, requireSameOrigin, (req, res) => {
  const password = String(req.body?.password || '');
  if (!constantTimeEqual(password, ADMIN_PASSWORD)) return res.status(401).json({ error: 'Password admin salah.' });
  setAdminCookie(res, createSessionToken());
  res.json({ success: true, expiresInHours: SESSION_HOURS });
});
app.get('/api/admin/session', requireAdmin, (req, res) => res.json({ authenticated: true }));
app.post('/api/admin/logout', requireAdmin, requireCmsWrite, (req, res) => {
  clearAdminCookie(res);
  res.json({ success: true });
});

const settingsKeys = new Set([
  'siteName','promoText','heroEyebrow','heroTitleBefore','heroHighlight','heroTitleAfter','heroText',
  'contactTitle','contactText','whatsappNumber','whatsappDisplay','storeHours','footerText','logoUrl'
]);
app.put('/api/admin/settings', requireAdmin, requireCmsWrite, (req, res) => {
  const current = getKvJson('settings', {});
  const next = { ...current };
  for (const [key, value] of Object.entries(req.body || {})) {
    if (!settingsKeys.has(key)) continue;
    if (key === 'whatsappNumber') next[key] = normalizePhone(value).slice(0, 20);
    else if (key === 'logoUrl') next[key] = safeText(value, 300);
    else next[key] = safeText(value, ['heroText','contactText','footerText'].includes(key) ? 1200 : 300);
  }
  if (!next.whatsappNumber && next.whatsappDisplay) next.whatsappNumber = normalizePhone(next.whatsappDisplay).replace(/^0/, '62');
  setKvJson('settings', next);
  res.json({ success: true, settings: next });
});

const mediaStorage = multer.diskStorage({
  destination(req, file, cb) { cb(null, TMP_DIR); },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `media-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  }
});
const uploadMedia = multer({
  storage: mediaStorage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!['.png','.jpg','.jpeg','.webp'].includes(ext)) return cb(new Error('Logo/gambar harus PNG, JPG, JPEG, atau WEBP.'));
    cb(null, true);
  }
});
app.post('/api/admin/media', requireAdmin, requireCmsWrite, uploadMedia.single('image'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Pilih file gambar.' });
    if (!isValidImageFile(req.file.path, path.extname(req.file.originalname).toLowerCase())) {
      fs.rmSync(req.file.path, { force: true });
      return res.status(400).json({ error: 'Isi file tidak sesuai format gambar.' });
    }
    const finalPath = path.join(MEDIA_DIR, path.basename(req.file.filename));
    fs.renameSync(req.file.path, finalPath);
    res.status(201).json({ success: true, url: `/media/${path.basename(finalPath)}` });
  } catch (error) {
    if (req.file?.path) fs.rmSync(req.file.path, { force: true });
    throw error;
  }
});

// Product CRUD.
app.post('/api/admin/products', requireAdmin, requireCmsWrite, (req, res) => {
  const products = getKvJson('products', []);
  let id = slugify(req.body.id || req.body.name);
  if (products.some(p => p.id === id)) id = `${id}-${Date.now().toString().slice(-6)}`;
  const product = sanitizeProduct(req.body, { id });
  products.push(product);
  setKvJson('products', products);
  res.status(201).json(product);
});
app.put('/api/admin/products/:id', requireAdmin, requireCmsWrite, (req, res) => {
  const products = getKvJson('products', []);
  const index = products.findIndex(p => p.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: 'Produk tidak ditemukan.' });
  products[index] = sanitizeProduct({ ...products[index], ...req.body }, { id: products[index].id });
  setKvJson('products', products);
  res.json(products[index]);
});
app.delete('/api/admin/products/:id', requireAdmin, requireCmsWrite, (req, res) => {
  const products = getKvJson('products', []);
  const next = products.filter(p => p.id !== req.params.id);
  if (next.length === products.length) return res.status(404).json({ error: 'Produk tidak ditemukan.' });
  setKvJson('products', next);
  res.json({ success: true });
});

// Private customer design uploads. Files are never exposed with express.static.
const allowedDesignExt = new Set(['.pdf','.png','.jpg','.jpeg','.webp','.zip','.rar','.ai','.psd','.cdr','.svg','.eps']);
const designStorage = multer.diskStorage({
  destination(req, file, cb) {
    if (!req.uploadToken) req.uploadToken = crypto.randomBytes(16).toString('hex');
    const folder = path.join(TMP_DIR, req.uploadToken);
    fs.mkdirSync(folder, { recursive: true });
    cb(null, folder);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(10).toString('hex')}${ext}`);
  }
});
const uploadDesign = multer({
  storage: designStorage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: MAX_UPLOAD_FILES },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowedDesignExt.has(ext)) return cb(new Error('Format file desain tidak didukung.'));
    cb(null, true);
  }
});

app.post('/api/orders', orderLimiter, uploadDesign.array('designFiles', MAX_UPLOAD_FILES), (req, res) => {
  try {
    const products = getKvJson('products', []);
    const productMap = new Map(products.map(p => [p.id, p]));
    const payload = JSON.parse(req.body.order || '{}');
    const customer = {
      name: safeText(payload.customer?.name, 120),
      phone: normalizePhone(payload.customer?.phone),
      email: safeText(payload.customer?.email, 160),
      address: safeText(payload.customer?.address, 600),
      city: safeText(payload.customer?.city, 120),
      note: safeText(payload.customer?.note, 1000)
    };
    if (!customer.name || customer.phone.length < 9) return cleanupAndSend(req, res, 400, 'Nama dan nomor WhatsApp wajib diisi.');

    const items = [];
    let subtotal = 0;
    for (const line of (Array.isArray(payload.items) ? payload.items : [])) {
      const product = productMap.get(String(line.id));
      const qty = Math.max(1, Math.min(999, Number(line.qty) || 1));
      if (!product || product.active === false) continue;
      const lineTotal = product.price * qty;
      subtotal += lineTotal;
      items.push({ id: product.id, name: product.name, price: product.price, unit: product.unit, qty, lineTotal });
    }
    if (!items.length) return cleanupAndSend(req, res, 400, 'Keranjang pesanan kosong.');

    const shippingOptions = {
      pickup: { label: 'Ambil di toko', fee: 0 },
      local: { label: 'Kurir lokal', fee: 15000 },
      expedition: { label: 'Ekspedisi', fee: 25000 }
    };
    const shippingKey = shippingOptions[payload.shipping] ? payload.shipping : 'pickup';
    const shipping = shippingOptions[shippingKey];
    const payment = ['transfer','cod','store'].includes(payload.payment) ? payload.payment : 'transfer';
    const total = subtotal + shipping.fee;
    const id = makeOrderId();
    const now = new Date().toISOString();
    const orderFolder = path.join(UPLOAD_DIR, id);
    fs.mkdirSync(orderFolder, { recursive: true });

    const uploadedFiles = [];
    for (const file of (req.files || [])) {
      const safeOriginal = sanitizeFilename(file.originalname);
      const destination = path.join(orderFolder, path.basename(file.filename));
      fs.renameSync(file.path, destination);
      uploadedFiles.push({ name: safeOriginal, storedName: path.basename(file.filename), size: file.size, mime: safeText(file.mimetype, 120) });
    }
    cleanupUploadTemp(req);

    const order = {
      id, createdAt: now, updatedAt: now, status: 'Menunggu Konfirmasi', customer, items,
      shipping: { key: shippingKey, ...shipping }, payment, subtotal, total, files: uploadedFiles
    };
    saveOrder(order);
    res.status(201).json({ success: true, orderId: id, status: order.status, total, filesUploaded: uploadedFiles.length });
  } catch (error) {
    console.error('[ORDER]', error);
    cleanupUploadTemp(req);
    res.status(400).json({ error: 'Pesanan tidak dapat diproses. Periksa data yang diisi.' });
  }
});

app.get('/api/orders/:id', trackingLimiter, (req, res) => {
  const id = safeText(req.params.id, 80).toUpperCase();
  const phone = normalizePhone(req.query.phone);
  const order = getOrder(id);
  if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan.' });
  if (!phone || lastDigits(order.customer.phone, 8) !== lastDigits(phone, 8)) return res.status(403).json({ error: 'Nomor WhatsApp tidak cocok.' });
  res.json({
    id: order.id, createdAt: order.createdAt, updatedAt: order.updatedAt, status: order.status,
    customer: { name: order.customer.name }, items: order.items, shipping: order.shipping, payment: order.payment,
    subtotal: order.subtotal, total: order.total, files: order.files.map(f => ({ name: f.name, size: f.size }))
  });
});

app.get('/api/admin/orders', requireAdmin, (req, res) => res.json(listOrders()));
app.patch('/api/admin/orders/:id', requireAdmin, requireCmsWrite, (req, res) => {
  const allowedStatuses = ['Menunggu Konfirmasi','Menunggu Pembayaran','File Dicek','Proses Desain','Proses Cetak','Siap Diambil','Dikirim','Selesai','Dibatalkan'];
  const status = safeText(req.body.status, 80);
  if (!allowedStatuses.includes(status)) return res.status(400).json({ error: 'Status tidak valid.' });
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan.' });
  order.status = status;
  order.updatedAt = new Date().toISOString();
  saveOrder(order);
  res.json({ success: true, order });
});
app.get('/api/admin/orders/:id/files/:storedName', requireAdmin, (req, res) => {
  const id = path.basename(req.params.id);
  const storedName = path.basename(req.params.storedName);
  const order = getOrder(id);
  if (!order) return res.status(404).send('Pesanan tidak ditemukan.');
  const fileMeta = order.files.find(file => file.storedName === storedName);
  if (!fileMeta) return res.status(404).send('File tidak ditemukan.');
  const filePath = path.join(UPLOAD_DIR, id, storedName);
  if (!fs.existsSync(filePath)) return res.status(404).send('File tidak tersedia.');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.download(filePath, sanitizeFilename(fileMeta.name));
});
app.get('/api/admin/export', requireAdmin, (req, res) => {
  const exportData = {
    exportedAt: new Date().toISOString(),
    settings: getKvJson('settings', {}),
    products: getKvJson('products', []),
    orders: listOrders()
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  res.setHeader('Content-Disposition', `attachment; filename="belilas-export-${stamp}.json"`);
  res.type('application/json').send(JSON.stringify(exportData, null, 2));
});

app.use((err, req, res, next) => {
  cleanupUploadTemp(req);
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? `Ukuran file terlalu besar. Maksimal ${MAX_UPLOAD_MB} MB per file.`
      : err.code === 'LIMIT_FILE_COUNT'
        ? `Terlalu banyak file. Maksimal ${MAX_UPLOAD_FILES} file.`
        : err.message;
    return res.status(400).json({ error: message });
  }
  if (err) {
    console.error('[ERROR]', err);
    return res.status(400).json({ error: safeText(err.message, 300) || 'Terjadi kesalahan.' });
  }
  next();
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Endpoint tidak ditemukan.' });
  res.status(404).sendFile(path.join(ROOT, 'public', 'index.html'));
});

const server = app.listen(PORT, () => {
  console.log(`Belilas Digital Printing berjalan pada port ${PORT} (${NODE_ENV}).`);
  console.log(`Data: ${DATA_ROOT}`);
  if (!IS_PROD) {
    console.log(`Toko: http://localhost:${PORT}`);
    console.log(`Edit langsung: http://localhost:${PORT}/?edit=1`);
    console.log(`CMS: http://localhost:${PORT}/admin.html`);
  }
});

let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} diterima. Menutup server...`);
  server.close(() => {
    try { db.close(); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
}
function configureTrustProxy(application, value) {
  if (!value) return;
  if (/^\d+$/.test(value)) application.set('trust proxy', Number(value));
  else if (value === 'true') application.set('trust proxy', true);
  else application.set('trust proxy', value);
}
function getKvJson(key, fallback) {
  try {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  } catch {
    return fallback;
  }
}
function setKvJson(key, value) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO kv(key,value,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(key, JSON.stringify(value), now);
}
function seedDatabaseIfEmpty() {
  const seedDir = path.join(ROOT, 'seed');
  if (!db.prepare('SELECT 1 FROM kv WHERE key = ?').get('settings')) {
    const settings = readJson(path.join(seedDir, 'settings.json'), {});
    setKvJson('settings', settings);
  }
  if (!db.prepare('SELECT 1 FROM kv WHERE key = ?').get('products')) {
    const products = readJson(path.join(seedDir, 'products.json'), []);
    setKvJson('products', products);
  }
  const count = Number(db.prepare('SELECT COUNT(*) AS count FROM orders').get().count || 0);
  if (count === 0) {
    for (const order of readJson(path.join(seedDir, 'orders.json'), [])) {
      try { saveOrder(order); } catch {}
    }
  }
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveOrder(order) {
  const payload = JSON.stringify(order);
  db.prepare(`INSERT INTO orders(id,created_at,updated_at,status,phone_last8,payload) VALUES(?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,status=excluded.status,phone_last8=excluded.phone_last8,payload=excluded.payload`)
    .run(order.id, order.createdAt, order.updatedAt, order.status, lastDigits(order.customer?.phone, 8), payload);
}
function getOrder(id) {
  try {
    const row = db.prepare('SELECT payload FROM orders WHERE id = ?').get(String(id || '').toUpperCase());
    return row ? JSON.parse(row.payload) : null;
  } catch { return null; }
}
function listOrders() {
  return db.prepare('SELECT payload FROM orders ORDER BY created_at DESC').all().map(row => JSON.parse(row.payload));
}
function safeText(value, max = 500) {
  return String(value ?? '').replace(/[<>]/g, '').trim().slice(0, max);
}
function normalizePhone(value) { return String(value || '').replace(/\D/g, ''); }
function lastDigits(value, count) { return normalizePhone(value).slice(-count); }
function slugify(value) {
  return safeText(value, 80).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || `produk-${Date.now()}`;
}
function sanitizeFilename(value) {
  const parsed = path.parse(String(value || 'file'));
  const name = parsed.name.replace(/[^a-zA-Z0-9._()\- ]/g, '_').slice(0, 100) || 'file';
  const ext = parsed.ext.replace(/[^a-zA-Z0-9.]/g, '').slice(0, 12);
  return `${name}${ext}`;
}
function sanitizeProduct(input, { id }) {
  return {
    id,
    name: safeText(input.name, 120) || 'Produk Baru',
    category: ['promosi','kantor','acara','custom'].includes(input.category) ? input.category : 'custom',
    price: Math.max(0, Math.round(Number(input.price) || 0)),
    unit: safeText(input.unit, 60) || 'pcs',
    badge: safeText(input.badge, 40) || 'Produk',
    description: safeText(input.description, 800),
    accent: ['blue','yellow','purple','cyan','pink','orange','slate'].includes(input.accent) ? input.accent : 'blue',
    active: input.active !== false && input.active !== 'false'
  };
}
function makeOrderId() {
  const date = new Date();
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  return `BL-${stamp}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}
function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
function createSessionToken() {
  const payload = Buffer.from(JSON.stringify({
    exp: Date.now() + SESSION_HOURS * 60 * 60 * 1000,
    nonce: crypto.randomBytes(16).toString('hex')
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}
function verifySessionToken(token) {
  try {
    const [payload, signature] = String(token || '').split('.');
    if (!payload || !signature) return false;
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
    if (!constantTimeEqual(signature, expected)) return false;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number(data.exp) > Date.now();
  } catch { return false; }
}
function parseCookies(req) {
  const out = {};
  for (const chunk of String(req.headers.cookie || '').split(';')) {
    const index = chunk.indexOf('=');
    if (index < 0) continue;
    const key = chunk.slice(0, index).trim();
    const value = chunk.slice(index + 1).trim();
    try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
  }
  return out;
}
function setAdminCookie(res, token) {
  const flags = [`${COOKIE_NAME}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${SESSION_HOURS * 3600}`];
  if (IS_PROD) flags.push('Secure');
  res.setHeader('Set-Cookie', flags.join('; '));
}
function clearAdminCookie(res) {
  const flags = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (IS_PROD) flags.push('Secure');
  res.setHeader('Set-Cookie', flags.join('; '));
}
function requireAdmin(req, res, next) {
  if (!verifySessionToken(parseCookies(req)[COOKIE_NAME])) return res.status(401).json({ error: 'Session admin tidak valid. Silakan login kembali.' });
  next();
}
function requestOrigin(req) {
  const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const forwardedHost = String(req.get('x-forwarded-host') || '').split(',')[0].trim();
  const protocol = forwardedProto || req.protocol || 'http';
  const host = forwardedHost || req.get('host');
  return `${protocol}://${host}`;
}
function requireSameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (!origin) return next();
  const expected = PUBLIC_BASE_URL ? new URL(PUBLIC_BASE_URL).origin : requestOrigin(req);
  if (origin !== expected) return res.status(403).json({ error: 'Origin tidak diizinkan.' });
  next();
}
function requireCmsWrite(req, res, next) {
  if (req.get('x-belilas-cms') !== '1') return res.status(403).json({ error: 'Permintaan CMS tidak valid.' });
  return requireSameOrigin(req, res, next);
}
function cleanupUploadTemp(req) {
  if (!req?.uploadToken) return;
  try { fs.rmSync(path.join(TMP_DIR, path.basename(req.uploadToken)), { recursive: true, force: true }); } catch {}
}
function cleanupAndSend(req, res, status, message) {
  cleanupUploadTemp(req);
  return res.status(status).json({ error: message });
}
function isValidImageFile(filePath, ext) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(16);
    fs.readSync(fd, buffer, 0, 16, 0);
    fs.closeSync(fd);
    if (ext === '.png') return buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
    if (ext === '.jpg' || ext === '.jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    if (ext === '.webp') return buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
    return false;
  } catch { return false; }
}
function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, char => ({ '<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;' }[char]));
}
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`BELILAS DIGITAL PRINTING running on port ${PORT}`);
});
