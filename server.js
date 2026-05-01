require('dotenv').config();

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const execFileAsync = promisify(execFile);

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const STORAGE_DIR = path.join(ROOT, 'storage');
const TMP_DIR = path.join(STORAGE_DIR, 'tmp');
const DB_PATH = path.join(STORAGE_DIR, 'app.sqlite');

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-session-secret';
const DEVICE_HASH_SECRET = process.env.DEVICE_HASH_SECRET || 'dev-device-secret';
const VIEWER_TOKEN_SECRET = process.env.VIEWER_TOKEN_SECRET || 'dev-viewer-token-secret';
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || 'false') === 'true';

fs.mkdirSync(STORAGE_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS decks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('slides', 'video')),
  original_filename TEXT NOT NULL,
  file_path TEXT NOT NULL,
  video_filename TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS slides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deck_id TEXT NOT NULL,
  slide_no INTEGER NOT NULL,
  image_filename TEXT NOT NULL,
  FOREIGN KEY(deck_id) REFERENCES decks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS access_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  deck_id TEXT NOT NULL,
  max_devices INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(deck_id) REFERENCES decks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS access_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  access_code_id INTEGER NOT NULL,
  device_hash TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(access_code_id, device_hash),
  FOREIGN KEY(access_code_id) REFERENCES access_codes(id) ON DELETE CASCADE
);
`);

db.pragma('foreign_keys = ON');

function seedAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
  if (count > 0) return;
  const username = process.env.ADMIN_USER || 'admin';
  const password = process.env.ADMIN_PASS || 'admin12345';
  const hash = bcrypt.hashSync(password, 12);
  db.prepare('INSERT INTO admins(username, password_hash) VALUES(?, ?)').run(username, hash);
  console.log(`[setup] default admin created: ${username}`);
}
seedAdmin();

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:"],
      "media-src": ["'self'"],
      "object-src": ["'none'"],
      "frame-ancestors": ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  name: 'admin_sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: COOKIE_SECURE,
    maxAge: 1000 * 60 * 60 * 8
  }
}));

app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  next();
});

app.use(express.static(path.join(ROOT, 'public'), {
  etag: true,
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 1024 * 1024 * 500 }
});

function safeId(bytes = 12) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function normalizeCode(code) {
  return String(code || '').trim().replace(/\s+/g, '').toUpperCase();
}

function hashDeviceId(deviceId) {
  return crypto.createHmac('sha256', DEVICE_HASH_SECRET).update(String(deviceId)).digest('hex');
}

function signViewerToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', VIEWER_TOKEN_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyViewerToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', VIEWER_TOKEN_SECRET).update(body).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

function requireAdmin(req, res, next) {
  if (!req.session.adminId) return res.status(401).json({ error: 'Belum login sebagai admin.' });
  next();
}

function requireViewer(req, res, next) {
  try {
    const token = req.cookies.viewer_token;
    const payload = verifyViewerToken(token);
    if (!payload) return res.status(401).json({ error: 'Sesi akses tidak valid. Masukkan kode akses lagi.' });

    const row = db.prepare(`
      SELECT ac.id AS access_code_id, ac.code, ac.deck_id, ac.max_devices, ac.is_active, d.title, d.mode
      FROM access_codes ac
      JOIN decks d ON d.id = ac.deck_id
      WHERE ac.id = ? AND ac.deck_id = ?
    `).get(payload.accessCodeId, payload.deckId);

    if (!row || !row.is_active) return res.status(403).json({ error: 'Kode akses sudah tidak aktif.' });

    const device = db.prepare(`
      SELECT id FROM access_devices WHERE access_code_id = ? AND device_hash = ?
    `).get(payload.accessCodeId, payload.deviceHash);
    if (!device) return res.status(403).json({ error: 'Device ini belum terdaftar untuk kode akses tersebut.' });

    db.prepare('UPDATE access_devices SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?').run(device.id);
    req.viewer = { ...row, deviceHash: payload.deviceHash };
    next();
  } catch (err) {
    console.error(err);
    res.status(401).json({ error: 'Sesi akses tidak valid.' });
  }
}

function extOf(filename) {
  return path.extname(filename || '').toLowerCase();
}

async function moveUpload(file, targetPath) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await fsp.rename(file.path, targetPath);
}

async function cleanupDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

async function convertPresentationToPdf(inputPath, outDir) {
  const libreOfficeBin = process.env.LIBREOFFICE_BIN || 'soffice';
  await execFileAsync(libreOfficeBin, [
    '--headless',
    '--convert-to', 'pdf',
    '--outdir', outDir,
    inputPath
  ], { timeout: 1000 * 60 * 5 });

  const base = path.basename(inputPath, path.extname(inputPath));
  const outputPdf = path.join(outDir, `${base}.pdf`);
  if (!fs.existsSync(outputPdf)) {
    const pdfs = fs.readdirSync(outDir).filter(f => f.toLowerCase().endsWith('.pdf'));
    if (!pdfs.length) throw new Error('Konversi PPT/PPTX ke PDF gagal. Pastikan LibreOffice terinstal.');
    return path.join(outDir, pdfs[0]);
  }
  return outputPdf;
}

async function renderPdfToPng(pdfPath, slidesDir) {
  const pdftoppmBin = process.env.POPPLER_PDFTOPPM_BIN || 'pdftoppm';
  await fsp.mkdir(slidesDir, { recursive: true });
  const prefix = path.join(slidesDir, 'slide');
  await execFileAsync(pdftoppmBin, ['-png', '-r', '160', pdfPath, prefix], { timeout: 1000 * 60 * 5 });
  const files = fs.readdirSync(slidesDir)
    .filter(f => f.toLowerCase().endsWith('.png'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!files.length) throw new Error('Render PDF ke PNG gagal. Pastikan poppler-utils terinstal.');
  return files;
}

function mediaHeaders(res, contentType) {
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (contentType) res.type(contentType);
}

app.get('/', (req, res) => res.redirect('/viewer.html'));

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(String(username || '').trim());
  if (!admin || !bcrypt.compareSync(String(password || ''), admin.password_hash)) {
    return res.status(401).json({ error: 'Username atau password salah.' });
  }
  req.session.adminId = admin.id;
  req.session.username = admin.username;
  res.json({ ok: true, username: admin.username });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/admin/me', requireAdmin, (req, res) => {
  res.json({ ok: true, username: req.session.username });
});

app.get('/api/admin/decks', requireAdmin, (req, res) => {
  const decks = db.prepare(`
    SELECT d.*, COUNT(s.id) AS slide_count
    FROM decks d
    LEFT JOIN slides s ON s.deck_id = d.id
    GROUP BY d.id
    ORDER BY d.created_at DESC
  `).all();
  res.json({ decks });
});

app.post('/api/admin/decks', requireAdmin, upload.single('file'), async (req, res) => {
  let deckDir;
  try {
    if (!req.file) return res.status(400).json({ error: 'File belum diupload.' });

    const title = String(req.body.title || '').trim();
    const mode = String(req.body.mode || 'slides').trim();
    if (!title) return res.status(400).json({ error: 'Judul deck wajib diisi.' });
    if (!['slides', 'video'].includes(mode)) return res.status(400).json({ error: 'Mode harus slides atau video.' });

    const originalName = req.file.originalname;
    const ext = extOf(originalName);
    const allowedSlides = ['.ppt', '.pptx', '.pdf'];
    const allowedVideo = ['.mp4', '.webm'];

    if (mode === 'slides' && !allowedSlides.includes(ext)) {
      return res.status(400).json({ error: 'Mode slides hanya menerima .ppt, .pptx, atau .pdf.' });
    }
    if (mode === 'video' && !allowedVideo.includes(ext)) {
      return res.status(400).json({ error: 'Mode video hanya menerima .mp4 atau .webm.' });
    }

    const deckId = safeId(10);
    deckDir = path.join(STORAGE_DIR, 'decks', deckId);
    const originalPath = path.join(deckDir, `original${ext}`);
    await moveUpload(req.file, originalPath);

    let videoFilename = null;
    const insertDeck = db.prepare(`
      INSERT INTO decks(id, title, mode, original_filename, file_path, video_filename)
      VALUES(?, ?, ?, ?, ?, ?)
    `);

    if (mode === 'video') {
      videoFilename = `original${ext}`;
      insertDeck.run(deckId, title, mode, originalName, originalPath, videoFilename);
      return res.json({ ok: true, deckId, mode });
    }

    let pdfPath = originalPath;
    if (ext !== '.pdf') {
      pdfPath = await convertPresentationToPdf(originalPath, deckDir);
    }

    const slidesDir = path.join(deckDir, 'slides');
    const files = await renderPdfToPng(pdfPath, slidesDir);

    const trx = db.transaction(() => {
      insertDeck.run(deckId, title, mode, originalName, originalPath, null);
      const insertSlide = db.prepare('INSERT INTO slides(deck_id, slide_no, image_filename) VALUES(?, ?, ?)');
      files.forEach((filename, idx) => insertSlide.run(deckId, idx + 1, filename));
    });
    trx();

    res.json({ ok: true, deckId, mode, slideCount: files.length });
  } catch (err) {
    console.error(err);
    if (deckDir) await cleanupDir(deckDir).catch(() => {});
    if (req.file?.path && fs.existsSync(req.file.path)) await fsp.unlink(req.file.path).catch(() => {});
    res.status(500).json({ error: err.message || 'Upload/konversi gagal.' });
  }
});

app.delete('/api/admin/decks/:deckId', requireAdmin, async (req, res) => {
  const deckId = req.params.deckId;
  const deck = db.prepare('SELECT * FROM decks WHERE id = ?').get(deckId);
  if (!deck) return res.status(404).json({ error: 'Deck tidak ditemukan.' });
  db.prepare('DELETE FROM decks WHERE id = ?').run(deckId);
  await cleanupDir(path.join(STORAGE_DIR, 'decks', deckId));
  res.json({ ok: true });
});

app.get('/api/admin/codes', requireAdmin, (req, res) => {
  const codes = db.prepare(`
    SELECT ac.*, d.title AS deck_title, d.mode AS deck_mode,
      COUNT(ad.id) AS used_devices
    FROM access_codes ac
    JOIN decks d ON d.id = ac.deck_id
    LEFT JOIN access_devices ad ON ad.access_code_id = ac.id
    GROUP BY ac.id
    ORDER BY ac.created_at DESC
  `).all();
  res.json({ codes });
});

app.post('/api/admin/codes', requireAdmin, (req, res) => {
  const deckId = String(req.body.deckId || '').trim();
  const maxDevices = Math.max(1, Math.min(20, Number(req.body.maxDevices || 1)));
  const deck = db.prepare('SELECT id FROM decks WHERE id = ?').get(deckId);
  if (!deck) return res.status(400).json({ error: 'Deck tidak ditemukan.' });

  let code;
  for (let i = 0; i < 5; i++) {
    code = crypto.randomBytes(5).toString('base64url').replace(/[-_]/g, '').toUpperCase().slice(0, 8);
    if (!db.prepare('SELECT id FROM access_codes WHERE code = ?').get(code)) break;
  }

  const info = db.prepare('INSERT INTO access_codes(code, deck_id, max_devices) VALUES(?, ?, ?)')
    .run(code, deckId, maxDevices);
  res.json({ ok: true, id: info.lastInsertRowid, code, deckId, maxDevices });
});

app.delete('/api/admin/codes/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM access_codes WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/admin/codes/:id/reset-devices', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM access_devices WHERE access_code_id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/access/verify', (req, res) => {
  const code = normalizeCode(req.body.code);
  const deviceId = String(req.body.deviceId || '').trim();
  if (!code || !deviceId) return res.status(400).json({ error: 'Kode akses dan device ID wajib ada.' });

  const access = db.prepare(`
    SELECT ac.*, d.title AS deck_title, d.mode AS deck_mode
    FROM access_codes ac
    JOIN decks d ON d.id = ac.deck_id
    WHERE ac.code = ?
  `).get(code);

  if (!access || !access.is_active) return res.status(403).json({ error: 'Kode akses tidak valid atau sudah nonaktif.' });

  const deviceHash = hashDeviceId(deviceId);
  const existing = db.prepare('SELECT id FROM access_devices WHERE access_code_id = ? AND device_hash = ?')
    .get(access.id, deviceHash);

  if (!existing) {
    const used = db.prepare('SELECT COUNT(*) AS n FROM access_devices WHERE access_code_id = ?').get(access.id).n;
    if (used >= access.max_devices) {
      return res.status(403).json({ error: `Limit device tercapai. Kode ini hanya untuk ${access.max_devices} device.` });
    }
    db.prepare('INSERT INTO access_devices(access_code_id, device_hash, user_agent) VALUES(?, ?, ?)')
      .run(access.id, deviceHash, req.get('user-agent') || '');
  } else {
    db.prepare('UPDATE access_devices SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?').run(existing.id);
  }

  const token = signViewerToken({
    accessCodeId: access.id,
    deckId: access.deck_id,
    deviceHash,
    exp: Date.now() + 1000 * 60 * 60 * 8
  });

  res.cookie('viewer_token', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: COOKIE_SECURE,
    maxAge: 1000 * 60 * 60 * 8
  });

  res.json({ ok: true, deck: { id: access.deck_id, title: access.deck_title, mode: access.deck_mode }, code });
});

app.post('/api/access/logout', (req, res) => {
  res.clearCookie('viewer_token');
  res.json({ ok: true });
});

app.get('/api/view/deck', requireViewer, (req, res) => {
  const deck = db.prepare('SELECT * FROM decks WHERE id = ?').get(req.viewer.deck_id);
  if (!deck) return res.status(404).json({ error: 'Deck tidak ditemukan.' });

  if (deck.mode === 'video') {
    return res.json({
      deck: {
        id: deck.id,
        title: deck.title,
        mode: deck.mode,
        videoUrl: `/media/video/${encodeURIComponent(deck.id)}/${encodeURIComponent(deck.video_filename)}`,
        watermark: req.viewer.code
      }
    });
  }

  const slides = db.prepare('SELECT slide_no, image_filename FROM slides WHERE deck_id = ? ORDER BY slide_no ASC').all(deck.id);
  res.json({
    deck: {
      id: deck.id,
      title: deck.title,
      mode: deck.mode,
      slides: slides.map(s => ({
        slideNo: s.slide_no,
        url: `/media/slides/${encodeURIComponent(deck.id)}/${encodeURIComponent(s.image_filename)}`
      })),
      watermark: req.viewer.code
    }
  });
});

app.get('/media/slides/:deckId/:filename', requireViewer, (req, res) => {
  const deckId = req.params.deckId;
  const filename = path.basename(req.params.filename);
  if (deckId !== req.viewer.deck_id) return res.status(403).end('Forbidden');

  const slide = db.prepare('SELECT * FROM slides WHERE deck_id = ? AND image_filename = ?').get(deckId, filename);
  if (!slide) return res.status(404).end('Not found');

  mediaHeaders(res, 'image/png');
  res.sendFile(path.join(STORAGE_DIR, 'decks', deckId, 'slides', filename));
});

app.get('/media/video/:deckId/:filename', requireViewer, (req, res) => {
  const deckId = req.params.deckId;
  const filename = path.basename(req.params.filename);
  if (deckId !== req.viewer.deck_id) return res.status(403).end('Forbidden');

  const deck = db.prepare('SELECT * FROM decks WHERE id = ? AND video_filename = ?').get(deckId, filename);
  if (!deck) return res.status(404).end('Not found');

  mediaHeaders(res, filename.endsWith('.webm') ? 'video/webm' : 'video/mp4');
  res.sendFile(path.join(STORAGE_DIR, 'decks', deckId, filename));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Terjadi kesalahan server.' });
});

app.listen(PORT, () => {
  console.log(`PPT Secure Slideshow running on http://localhost:${PORT}`);
});
