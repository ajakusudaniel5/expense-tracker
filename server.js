const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, init } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

const SESSIONS = new Map();
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const PIN_ATTEMPTS = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 10 * 60 * 1000;

function getIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

function pinLockedOut(ip) {
  const rec = PIN_ATTEMPTS.get(ip);
  if (!rec) return false;
  if (rec.lockedUntil && rec.lockedUntil > Date.now()) return true;
  if (rec.lockedUntil && rec.lockedUntil <= Date.now()) PIN_ATTEMPTS.delete(ip);
  return false;
}

function recordPinFailure(ip) {
  const rec = PIN_ATTEMPTS.get(ip) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = Date.now() + LOCKOUT_MS;
    rec.count = 0;
  }
  PIN_ATTEMPTS.set(ip, rec);
}

function recordPinSuccess(ip) {
  PIN_ATTEMPTS.delete(ip);
}

function hashPin(pin, salt) {
  return crypto.createHash('sha256').update(salt + ':' + pin).digest('hex');
}

function newSalt() {
  return crypto.randomBytes(16).toString('hex');
}

const ENV_PIN = process.env.APP_PIN || null;

async function getPinRow() {
  return db.prepare("SELECT value FROM settings WHERE key = 'pin_hash'").get();
}

async function getSaltRow() {
  return db.prepare("SELECT value FROM settings WHERE key = 'pin_salt'").get();
}

async function pinEnabled() {
  if (ENV_PIN) return true;
  const row = await getPinRow();
  return !!(row && row.value);
}

async function pinMatches(pin) {
  if (ENV_PIN) {
    return crypto.timingSafeEqual(
      Buffer.from(hashPin(pin, 'env')),
      Buffer.from(hashPin(ENV_PIN, 'env'))
    );
  }
  const salt = (await getSaltRow()).value;
  const expected = (await getPinRow()).value;
  return hashPin(pin, salt) === expected;
}

function pinChangeable() {
  return !ENV_PIN;
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function requireAuth(req, res, next) {
  if (!(await pinEnabled())) {
    return res.status(403).json({ error: 'setup required' });
  }
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unlocked required' });
  const session = SESSIONS.get(token);
  if (!session || session.expires < Date.now()) {
    if (session) SESSIONS.delete(token);
    return res.status(401).json({ error: 'unlocked required' });
  }
  next();
}

const sessionCleanup = setInterval(() => {
  const now = Date.now();
  for (const [token, session] of SESSIONS) {
    if (session.expires < now) SESSIONS.delete(token);
  }
}, 60 * 60 * 1000);

if (typeof process !== 'undefined' && process.on) {
  process.on('exit', () => clearInterval(sessionCleanup));
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/api/health', async (req, res) => {
  try {
    await db.prepare('SELECT 1').get();
    res.json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'disconnected' });
  }
});

app.get('/api/pin/status', async (req, res) => {
  res.json({ enabled: await pinEnabled(), changeable: pinChangeable() });
});

app.post('/api/pin/set', async (req, res) => {
  if (ENV_PIN) {
    return res.status(409).json({ error: 'a PIN is already set' });
  }
  const { pin } = req.body;
  if (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin)) {
    return res.status(400).json({ error: 'PIN must be 4-8 digits' });
  }
  if (await pinEnabled()) {
    return res.status(409).json({ error: 'a PIN is already set' });
  }
  const salt = newSalt();
  await db.prepare(
    "INSERT INTO settings (key, value) VALUES ('pin_hash', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"
  ).run(hashPin(pin, salt));
  await db.prepare(
    "INSERT INTO settings (key, value) VALUES ('pin_salt', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"
  ).run(salt);
  res.status(201).json({ enabled: true });
});

app.post('/api/pin/verify', async (req, res) => {
  const ip = getIp(req);
  if (pinLockedOut(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 10 minutes.' });
  }
  const { pin } = req.body;
  if (!(await pinEnabled())) return res.status(400).json({ error: 'no PIN is set' });
  if (typeof pin !== 'string' || !pin) {
    return res.status(400).json({ error: 'pin is required' });
  }
  if (!(await pinMatches(pin))) {
    recordPinFailure(ip);
    return res.status(401).json({ error: 'incorrect PIN' });
  }
  recordPinSuccess(ip);
  const token = generateToken();
  SESSIONS.set(token, { expires: Date.now() + SESSION_TTL_MS });
  res.json({ token });
});

app.post('/api/pin/change', requireAuth, async (req, res) => {
  const { current_pin, new_pin } = req.body;
  if (!(await pinEnabled())) return res.status(400).json({ error: 'no PIN is set' });
  if (!pinChangeable()) {
    return res.status(403).json({ error: 'PIN is managed by the server and cannot be changed in-app' });
  }
  if (typeof new_pin !== 'string' || !/^\d{4,8}$/.test(new_pin)) {
    return res.status(400).json({ error: 'PIN must be 4-8 digits' });
  }
  if (!(await pinMatches(current_pin))) {
    return res.status(401).json({ error: 'current PIN is incorrect' });
  }
  await db.prepare("UPDATE settings SET value = ? WHERE key = 'pin_hash'").run(hashPin(new_pin, (await getSaltRow()).value));
  for (const [token, session] of SESSIONS) {
    if (session.expires > Date.now()) SESSIONS.delete(token);
  }
  res.json({ enabled: true });
});

async function getSetting(key) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

async function setSetting(key, value) {
  await db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

app.get('/api/profile', requireAuth, async (req, res) => {
  res.json({
    name: (await getSetting('profile_name')) || '',
    email: (await getSetting('profile_email')) || '',
    currency: (await getSetting('profile_currency')) || 'GH₵',
  });
});

app.put('/api/profile', requireAuth, async (req, res) => {
  const { name, email } = req.body;
  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length > 100) {
      return res.status(400).json({ error: 'name must be a string up to 100 characters' });
    }
    await setSetting('profile_name', name.trim());
  }
  if (email !== undefined) {
    if (typeof email !== 'string' || email.length > 200) {
      return res.status(400).json({ error: 'email must be a string up to 200 characters' });
    }
    await setSetting('profile_email', email.trim());
  }
  res.json({
    name: (await getSetting('profile_name')) || '',
    email: (await getSetting('profile_email')) || '',
    currency: (await getSetting('profile_currency')) || 'GH₵',
  });
});

app.post('/api/reports/delete', requireAuth, async (req, res) => {
  const { scope, month } = req.body;
  let info;
  if (scope === 'all') {
    info = await db.prepare('DELETE FROM transactions').run();
  } else if (scope === 'month') {
    if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'month must be YYYY-MM' });
    }
    info = await db.prepare("DELETE FROM transactions WHERE substr(date, 1, 7) = ?").run(month);
  } else {
    return res.status(400).json({ error: "scope must be 'all' or 'month'" });
  }
  res.json({ deleted: info.changes });
});

app.get('/api/categories', requireAuth, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM categories ORDER BY name').all();
  res.json(rows);
});

app.post('/api/categories', requireAuth, async (req, res) => {
  const { name, type, icon } = req.body;
  if (!name || !type) {
    return res.status(400).json({ error: 'name and type are required' });
  }
  if (!['income', 'expense'].includes(type)) {
    return res.status(400).json({ error: 'type must be income or expense' });
  }
  try {
    const info = await db
      .prepare('INSERT INTO categories (name, type, icon) VALUES (?, ?, ?)')
      .run(name, type, icon || null);
    res.status(201).json({ id: info.lastInsertRowid, name, type, icon: icon || null });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'category already exists' });
    }
    throw err;
  }
});

app.delete('/api/categories/:id', requireAuth, async (req, res) => {
  const used = await db
    .prepare('SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?')
    .get(req.params.id);
  if (used.n > 0) {
    return res.status(409).json({ error: 'category is used by transactions' });
  }
  const budgeted = await db
    .prepare('SELECT COUNT(*) AS n FROM budgets WHERE category_id = ?')
    .get(req.params.id);
  if (budgeted.n > 0) {
    return res.status(409).json({ error: 'category is used by budgets' });
  }
  const info = await db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

app.put('/api/categories/:id', requireAuth, async (req, res) => {
  const { name, type, icon } = req.body;
  const existing = await db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const updated = {
    name: name !== undefined ? name : existing.name,
    type: type !== undefined ? type : existing.type,
    icon: icon !== undefined ? icon : existing.icon,
  };
  if (!updated.name) {
    return res.status(400).json({ error: 'name cannot be empty' });
  }
  if (!['income', 'expense'].includes(updated.type)) {
    return res.status(400).json({ error: 'type must be income or expense' });
  }
  try {
    await db.prepare('UPDATE categories SET name = ?, type = ?, icon = ? WHERE id = ?').run(
      updated.name,
      updated.type,
      updated.icon || null,
      req.params.id
    );
    res.json({ id: Number(req.params.id), ...updated, icon: updated.icon || null });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'category already exists' });
    }
    throw err;
  }
});

app.get('/api/transactions', requireAuth, async (req, res) => {
  const { month } = req.query;
  let sql =
    'SELECT t.*, c.name AS category_name, c.icon AS category_icon ' +
    'FROM transactions t LEFT JOIN categories c ON c.id = t.category_id ';
  const params = [];
  if (month) {
    sql += 'WHERE substr(t.date, 1, 7) = ? ';
    params.push(month);
  }
  sql += 'ORDER BY t.date DESC, t.id DESC';
  res.json(await db.prepare(sql).all(...params));
});

app.post('/api/transactions', requireAuth, async (req, res) => {
  const { amount, date, type, category_id, note } = req.body;
  if (amount == null || !date || !type) {
    return res.status(400).json({ error: 'amount, date and type are required' });
  }
  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }
  if (!['income', 'expense'].includes(type)) {
    return res.status(400).json({ error: 'type must be income or expense' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }
  if (category_id != null) {
    const cat = await db.prepare('SELECT id FROM categories WHERE id = ?').get(category_id);
    if (!cat) return res.status(400).json({ error: 'invalid category_id' });
  }
  const info = await db
    .prepare(
      'INSERT INTO transactions (amount, date, type, category_id, note) VALUES (?, ?, ?, ?, ?)'
    )
    .run(amount, date, type, category_id ?? null, note || null);
  res.status(201).json({
    id: info.lastInsertRowid,
    amount,
    date,
    type,
    category_id: category_id ?? null,
    note: note || null,
  });
});

app.put('/api/transactions/:id', requireAuth, async (req, res) => {
  const { amount, date, type, category_id, note } = req.body;
  const existing = await db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (amount !== undefined && (typeof amount !== 'number' || amount <= 0)) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }
  if (type !== undefined && !['income', 'expense'].includes(type)) {
    return res.status(400).json({ error: 'type must be income or expense' });
  }
  if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }
  const updated = {
    amount: amount ?? existing.amount,
    date: date ?? existing.date,
    type: type ?? existing.type,
    category_id: category_id !== undefined ? category_id : existing.category_id,
    note: note !== undefined ? note : existing.note,
  };
  if (category_id != null) {
    const cat = await db.prepare('SELECT id FROM categories WHERE id = ?').get(category_id);
    if (!cat) return res.status(400).json({ error: 'invalid category_id' });
  }
  await db.prepare(
    'UPDATE transactions SET amount = ?, date = ?, type = ?, category_id = ?, note = ? WHERE id = ?'
  ).run(updated.amount, updated.date, updated.type, updated.category_id, updated.note, req.params.id);
  res.json({ id: Number(req.params.id), ...updated });
});

app.delete('/api/transactions/:id', requireAuth, async (req, res) => {
  const info = await db.prepare('DELETE FROM transactions WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

app.get('/api/budgets', requireAuth, async (req, res) => {
  const { month } = req.query;
  let sql =
    'SELECT b.*, c.name AS category_name, c.icon AS category_icon ' +
    'FROM budgets b LEFT JOIN categories c ON c.id = b.category_id ';
  const params = [];
  if (month) {
    sql += 'WHERE b.month = ? ';
    params.push(month);
  }
  sql += 'ORDER BY b.month DESC, c.name';
  res.json(await db.prepare(sql).all(...params));
});

app.post('/api/budgets', requireAuth, async (req, res) => {
  const { category_id, month, limit_amount } = req.body;
  if (!category_id || !month || limit_amount == null) {
    return res.status(400).json({ error: 'category_id, month and limit_amount are required' });
  }
  if (typeof limit_amount !== 'number' || limit_amount <= 0) {
    return res.status(400).json({ error: 'limit_amount must be a positive number' });
  }
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month must be YYYY-MM' });
  }
  const cat = await db.prepare('SELECT id FROM categories WHERE id = ?').get(category_id);
  if (!cat) return res.status(400).json({ error: 'invalid category_id' });
  await db.prepare(
    'INSERT INTO budgets (category_id, month, limit_amount) VALUES (?, ?, ?) ' +
      'ON CONFLICT (category_id, month) DO UPDATE SET limit_amount = excluded.limit_amount'
  ).run(category_id, month, limit_amount);
  res.status(201).json({ category_id, month, limit_amount });
});

app.delete('/api/budgets/:id', requireAuth, async (req, res) => {
  const info = await db.prepare('DELETE FROM budgets WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

app.use((req, res) => {
  res.status(404).json({ error: 'not found' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Expense tracker running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
