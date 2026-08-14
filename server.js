const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

const SESSIONS = new Map();
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashPin(pin, salt) {
  return crypto.createHash('sha256').update(salt + ':' + pin).digest('hex');
}

function newSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function getPinRow() {
  return db.prepare("SELECT value FROM settings WHERE key = 'pin_hash'").get();
}

function getSaltRow() {
  return db.prepare("SELECT value FROM settings WHERE key = 'pin_salt'").get();
}

function pinEnabled() {
  const row = getPinRow();
  return !!(row && row.value);
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function requireAuth(req, res, next) {
  if (!pinEnabled()) return next();
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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', db: db.isOpen ? 'connected' : 'error' });
});

app.get('/api/pin/status', (req, res) => {
  res.json({ enabled: pinEnabled() });
});

app.post('/api/pin/set', (req, res) => {
  const { pin } = req.body;
  if (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin)) {
    return res.status(400).json({ error: 'PIN must be 4-8 digits' });
  }
  if (pinEnabled()) {
    return res.status(409).json({ error: 'a PIN is already set' });
  }
  const salt = newSalt();
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('pin_hash', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"
  ).run(hashPin(pin, salt));
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('pin_salt', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"
  ).run(salt);
  res.status(201).json({ enabled: true });
});

app.post('/api/pin/verify', (req, res) => {
  const { pin } = req.body;
  if (!pinEnabled()) return res.status(400).json({ error: 'no PIN is set' });
  if (typeof pin !== 'string' || !pin) {
    return res.status(400).json({ error: 'pin is required' });
  }
  const salt = getSaltRow().value;
  const expected = getPinRow().value;
  if (hashPin(pin, salt) !== expected) {
    return res.status(401).json({ error: 'incorrect PIN' });
  }
  const token = generateToken();
  SESSIONS.set(token, { expires: Date.now() + SESSION_TTL_MS });
  res.json({ token });
});

app.post('/api/pin/change', requireAuth, (req, res) => {
  const { current_pin, new_pin } = req.body;
  if (!pinEnabled()) return res.status(400).json({ error: 'no PIN is set' });
  if (typeof new_pin !== 'string' || !/^\d{4,8}$/.test(new_pin)) {
    return res.status(400).json({ error: 'PIN must be 4-8 digits' });
  }
  const salt = getSaltRow().value;
  const expected = getPinRow().value;
  if (hashPin(current_pin, salt) !== expected) {
    return res.status(401).json({ error: 'current PIN is incorrect' });
  }
  db.prepare("UPDATE settings SET value = ? WHERE key = 'pin_hash'").run(hashPin(new_pin, salt));
  res.json({ enabled: true });
});

app.post('/api/pin/remove', requireAuth, (req, res) => {
  const { pin } = req.body;
  if (!pinEnabled()) return res.status(400).json({ error: 'no PIN is set' });
  const salt = getSaltRow().value;
  const expected = getPinRow().value;
  if (hashPin(pin, salt) !== expected) {
    return res.status(401).json({ error: 'PIN is incorrect' });
  }
  db.prepare("DELETE FROM settings WHERE key = 'pin_hash'").run();
  db.prepare("DELETE FROM settings WHERE key = 'pin_salt'").run();
  res.json({ enabled: false });
});

app.get('/api/categories', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM categories ORDER BY name').all();
  res.json(rows);
});

app.post('/api/categories', requireAuth, (req, res) => {
  const { name, type, icon } = req.body;
  if (!name || !type) {
    return res.status(400).json({ error: 'name and type are required' });
  }
  if (!['income', 'expense'].includes(type)) {
    return res.status(400).json({ error: 'type must be income or expense' });
  }
  try {
    const info = db
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

app.delete('/api/categories/:id', requireAuth, (req, res) => {
  const used = db
    .prepare('SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?')
    .get(req.params.id);
  if (used.n > 0) {
    return res.status(409).json({ error: 'category is used by transactions' });
  }
  const info = db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

app.put('/api/categories/:id', requireAuth, (req, res) => {
  const { name, type, icon } = req.body;
  const existing = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
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
    db.prepare('UPDATE categories SET name = ?, type = ?, icon = ? WHERE id = ?').run(
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

app.get('/api/transactions', requireAuth, (req, res) => {
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
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/transactions', requireAuth, (req, res) => {
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
    const cat = db.prepare('SELECT id FROM categories WHERE id = ?').get(category_id);
    if (!cat) return res.status(400).json({ error: 'invalid category_id' });
  }
  const info = db
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

app.put('/api/transactions/:id', requireAuth, (req, res) => {
  const { amount, date, type, category_id, note } = req.body;
  const existing = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
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
    const cat = db.prepare('SELECT id FROM categories WHERE id = ?').get(category_id);
    if (!cat) return res.status(400).json({ error: 'invalid category_id' });
  }
  db.prepare(
    'UPDATE transactions SET amount = ?, date = ?, type = ?, category_id = ?, note = ? WHERE id = ?'
  ).run(updated.amount, updated.date, updated.type, updated.category_id, updated.note, req.params.id);
  res.json({ id: Number(req.params.id), ...updated });
});

app.delete('/api/transactions/:id', requireAuth, (req, res) => {
  const info = db.prepare('DELETE FROM transactions WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

app.get('/api/budgets', requireAuth, (req, res) => {
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
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/budgets', requireAuth, (req, res) => {
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
  const cat = db.prepare('SELECT id FROM categories WHERE id = ?').get(category_id);
  if (!cat) return res.status(400).json({ error: 'invalid category_id' });
  db.prepare(
    'INSERT INTO budgets (category_id, month, limit_amount) VALUES (?, ?, ?) ' +
      'ON CONFLICT (category_id, month) DO UPDATE SET limit_amount = excluded.limit_amount'
  ).run(category_id, month, limit_amount);
  res.status(201).json({ category_id, month, limit_amount });
});

app.delete('/api/budgets/:id', requireAuth, (req, res) => {
  const info = db.prepare('DELETE FROM budgets WHERE id = ?').run(req.params.id);
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

app.listen(PORT, () => {
  console.log(`Expense tracker running at http://localhost:${PORT}`);
});
