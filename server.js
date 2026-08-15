const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, init, seedDefaultCategories, adoptLegacyData } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

const SESSIONS = new Map();
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const LOGIN_ATTEMPTS = new Map();
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCK_MS = 5 * 60 * 1000;

const LAST_ACTIVE_WRITE = new Map();
const LAST_ACTIVE_THROTTLE_MS = 5 * 60 * 1000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-9]|2[0-9]|3[01])-(0[1-9]|[12]\d|3[01])$/;
const CURRENCIES = new Set(['GH₵', '$', '₦', 'KSh', 'R', '£', '€']);

function getIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

function loginLocked(email) {
  const rec = LOGIN_ATTEMPTS.get(email.toLowerCase());
  if (!rec) return false;
  if (rec.lockedUntil && rec.lockedUntil > Date.now()) return true;
  if (rec.lockedUntil && rec.lockedUntil <= Date.now()) LOGIN_ATTEMPTS.delete(email.toLowerCase());
  return false;
}

function recordLoginFailure(email) {
  const key = email.toLowerCase();
  const rec = LOGIN_ATTEMPTS.get(key) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_LOGIN_ATTEMPTS) {
    rec.lockedUntil = Date.now() + LOGIN_LOCK_MS;
    rec.count = 0;
  }
  LOGIN_ATTEMPTS.set(key, rec);
}

function recordLoginSuccess(email) {
  LOGIN_ATTEMPTS.delete(email.toLowerCase());
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), test);
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name || '',
    currency: user.currency || 'GH₵',
    income_type: user.income_type || '',
    income_frequency: user.income_frequency || '',
    onboarded: !!user.onboarded,
  };
}

function createSession(userId) {
  const token = generateToken();
  SESSIONS.set(token, { userId, expires: Date.now() + SESSION_TTL_MS });
  return token;
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'authentication required' });
  const session = SESSIONS.get(token);
  if (!session || session.expires < Date.now()) {
    if (session) SESSIONS.delete(token);
    return res.status(401).json({ error: 'authentication required' });
  }
  const user = await db.prepare(
    'SELECT id, email, name, currency, income_type, income_frequency, onboarded FROM users WHERE id = ?'
  ).get(session.userId);
  if (!user) {
    SESSIONS.delete(token);
    return res.status(401).json({ error: 'authentication required' });
  }
  req.user = user;
  req.token = token;
  const lastWrite = LAST_ACTIVE_WRITE.get(user.id) || 0;
  if (Date.now() - lastWrite >= LAST_ACTIVE_THROTTLE_MS) {
    try {
      await db.prepare(
        "UPDATE users SET last_active_at = datetime('now') WHERE id = ?"
      ).run(user.id);
      LAST_ACTIVE_WRITE.set(user.id, Date.now());
    } catch (_) {}
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

app.use((req, res, next) => {
  if (req.path === '/' || req.path.startsWith('/api/')) {
    const start = Date.now();
    res.on('finish', () => {
      console.log(
        `${new Date().toISOString()} ${getIp(req)} ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`
      );
    });
  }
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

app.get('/api/stats', requireAuth, async (req, res) => {
  const admin = String(process.env.ADMIN_EMAIL || '').toLowerCase();
  if (!admin || req.user.email.toLowerCase() !== admin) {
    return res.status(403).json({ error: 'not authorized' });
  }
  try {
    const totalUsers = (await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n;
    const activeToday = (await db.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE date(last_active_at) = date('now')"
    ).get()).n;
    const activeLast24h = (await db.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE last_active_at >= datetime('now', '-1 day')"
    ).get()).n;
    const activeLast7d = (await db.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE last_active_at >= datetime('now', '-7 day')"
    ).get()).n;
    const activeLast30d = (await db.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE last_active_at >= datetime('now', '-30 day')"
    ).get()).n;
    const totalTransactions = (await db.prepare('SELECT COUNT(*) AS n FROM transactions').get()).n;
    const totalBudgets = (await db.prepare('SELECT COUNT(*) AS n FROM budgets').get()).n;
    res.json({
      totalUsers,
      activeToday,
      activeLast24h,
      activeLast7d,
      activeLast30d,
      totalTransactions,
      totalBudgets,
    });
  } catch (err) {
    res.status(500).json({ error: 'stats unavailable' });
  }
});

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  const a = new Date(from + 'T00:00:00Z');
  const b = new Date(to + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

function cleanNote(note) {
  return typeof note === 'string' && note.trim() ? note.slice(0, 200) : null;
}

/* ---------------- Auth ---------------- */

app.post('/api/auth/register', async (req, res) => {
  const { email, password, name } = req.body || {};
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ error: 'Enter a valid email address' });
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  const existing = await db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(email.trim());
  if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

  const info = await db
    .prepare('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)')
    .run(email.trim().toLowerCase(), hashPassword(password), name && typeof name === 'string' ? name.trim().slice(0, 100) : null);
  const userId = info.lastInsertRowid;
  await adoptLegacyData(userId);
  await seedDefaultCategories(userId);
  const user = await db.prepare(
    'SELECT id, email, name, currency, income_type, income_frequency, onboarded FROM users WHERE id = ?'
  ).get(userId);
  const token = createSession(userId);
  res.status(201).json({ token, user: publicUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  const key = email.trim().toLowerCase();
  if (loginLocked(key)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }
  const user = await db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(key);
  if (!user || !verifyPassword(password, user.password_hash)) {
    recordLoginFailure(key);
    return res.status(401).json({ error: 'Incorrect email or password' });
  }
  recordLoginSuccess(key);
  const token = createSession(user.id);
  res.json({ token, user: publicUser(user) });
});

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  SESSIONS.delete(req.token);
  res.status(204).end();
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.put('/api/auth/password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (typeof current_password !== 'string' || typeof new_password !== 'string') {
    return res.status(400).json({ error: 'current and new password are required' });
  }
  const row = await db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(current_password, row.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(new_password), req.user.id);
  for (const [token, session] of SESSIONS) {
    if (session.userId === req.user.id) SESSIONS.delete(token);
  }
  const fresh = createSession(req.user.id);
  res.json({ token: fresh, user: publicUser({ ...req.user, onboarded: req.user.onboarded }) });
});

app.delete('/api/auth/account', requireAuth, async (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== 'string') {
    return res.status(400).json({ error: 'Enter your current password to delete your account' });
  }
  const row = await db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(password, row.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  const email = String(req.user.email || '').toLowerCase();
  await db.client.execute('BEGIN');
  try {
    await db.prepare('DELETE FROM transactions WHERE user_id = ?').run(req.user.id);
    await db.prepare('DELETE FROM budgets WHERE user_id = ?').run(req.user.id);
    await db.prepare('DELETE FROM budget_periods WHERE user_id = ?').run(req.user.id);
    await db.prepare('DELETE FROM categories WHERE user_id = ?').run(req.user.id);
    await db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
    await db.client.execute('COMMIT');
  } catch (err) {
    await db.client.execute('ROLLBACK').catch(() => {});
    throw err;
  }
  for (const [token, session] of SESSIONS) {
    if (session.userId === req.user.id) SESSIONS.delete(token);
  }
  LOGIN_ATTEMPTS.delete(email);
  try {
    await db.client.execute('VACUUM');
  } catch (_) {
    // VACUUM is best-effort (some hosted/libsql setups disallow it); logical
    // deletion above already removes every row belonging to the account.
  }
  res.status(204).end();
});

app.put('/api/onboarding', requireAuth, async (req, res) => {
  const { income_type, income_frequency, onboarded } = req.body || {};
  const updates = {};
  if (income_type !== undefined && typeof income_type === 'string') updates.income_type = income_type.trim().slice(0, 40);
  if (income_frequency !== undefined && typeof income_frequency === 'string') updates.income_frequency = income_frequency.trim().slice(0, 40);
  if (onboarded !== undefined) updates.onboarded = onboarded ? 1 : 0;
  if (Object.keys(updates).length) {
    const sets = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    const vals = Object.values(updates);
    await db.prepare(`UPDATE users SET ${sets} WHERE id = ?`).run(...vals, req.user.id);
  }
  const user = await db.prepare(
    'SELECT id, email, name, currency, income_type, income_frequency, onboarded FROM users WHERE id = ?'
  ).get(req.user.id);
  res.json({ user: publicUser(user) });
});

app.put('/api/me', requireAuth, async (req, res) => {
  const { name, currency } = req.body || {};
  if (name !== undefined && (typeof name !== 'string' || name.trim().length > 100)) {
    return res.status(400).json({ error: 'name must be a string up to 100 characters' });
  }
  if (currency !== undefined && !CURRENCIES.has(currency)) {
    return res.status(400).json({ error: 'unsupported currency' });
  }
  const sets = [];
  const vals = [];
  if (name !== undefined) { sets.push('name = ?'); vals.push(name.trim()); }
  if (currency !== undefined) { sets.push('currency = ?'); vals.push(currency); }
  if (sets.length) {
    await db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals, req.user.id);
  }
  const user = await db.prepare(
    'SELECT id, email, name, currency, income_type, income_frequency, onboarded FROM users WHERE id = ?'
  ).get(req.user.id);
  res.json({ user: publicUser(user) });
});

/* ---------------- Categories ---------------- */

app.get('/api/categories', requireAuth, async (req, res) => {
  const rows = await db.prepare(
    'SELECT * FROM categories WHERE user_id = ? ORDER BY type DESC, name'
  ).all(req.user.id);
  res.json(rows);
});

app.post('/api/categories', requireAuth, async (req, res) => {
  const { name, type, icon } = req.body || {};
  if (!name || !type) return res.status(400).json({ error: 'name and type are required' });
  if (!['income', 'expense'].includes(type)) {
    return res.status(400).json({ error: 'type must be income or expense' });
  }
  try {
    const trimmed = name.trim().slice(0, 60);
    const info = await db
      .prepare('INSERT INTO categories (user_id, name, type, icon) VALUES (?, ?, ?, ?)')
      .run(req.user.id, trimmed, type, icon || null);
    res.status(201).json({ id: info.lastInsertRowid, user_id: req.user.id, name: trimmed, type, icon: icon || null });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'You already have a category with this name' });
    throw err;
  }
});

app.put('/api/categories/:id', requireAuth, async (req, res) => {
  const { name, type, icon } = req.body || {};
  const existing = await db.prepare(
    'SELECT * FROM categories WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const updated = {
    name: name !== undefined ? name.trim().slice(0, 60) : existing.name,
    type: type !== undefined ? type : existing.type,
    icon: icon !== undefined ? icon : existing.icon,
  };
  if (!updated.name) return res.status(400).json({ error: 'name cannot be empty' });
  if (!['income', 'expense'].includes(updated.type)) {
    return res.status(400).json({ error: 'type must be income or expense' });
  }
  try {
    await db.prepare('UPDATE categories SET name = ?, type = ?, icon = ? WHERE id = ? AND user_id = ?').run(
      updated.name, updated.type, updated.icon || null, req.params.id, req.user.id
    );
    res.json({ id: Number(req.params.id), ...updated, icon: updated.icon || null });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'You already have a category with this name' });
    throw err;
  }
});

app.delete('/api/categories/:id', requireAuth, async (req, res) => {
  const cat = await db.prepare('SELECT * FROM categories WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!cat) return res.status(404).json({ error: 'not found' });
  const used = await db.prepare(
    'SELECT COUNT(*) AS n FROM transactions WHERE category_id = ? AND user_id = ?'
  ).get(req.params.id, req.user.id);
  if (used.n > 0) return res.status(409).json({ error: 'This category is used by transactions' });
  const budgeted = await db.prepare(
    'SELECT COUNT(*) AS n FROM budgets WHERE category_id = ? AND user_id = ?'
  ).get(req.params.id, req.user.id);
  if (budgeted.n > 0) return res.status(409).json({ error: 'This category is used by budgets' });
  await db.prepare('DELETE FROM categories WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.status(204).end();
});

/* ---------------- Transactions ---------------- */

app.get('/api/transactions', requireAuth, async (req, res) => {
  const { type, category_id, period_id } = req.query;
  let sql =
    'SELECT t.*, c.name AS category_name, c.icon AS category_icon ' +
    'FROM transactions t LEFT JOIN categories c ON c.id = t.category_id ' +
    'WHERE t.user_id = ?';
  const params = [req.user.id];
  if (type === 'income' || type === 'expense') {
    sql += ' AND t.type = ?';
    params.push(type);
  }
  if (category_id) {
    sql += ' AND t.category_id = ?';
    params.push(category_id);
  }
  if (period_id) {
    const period = await db.prepare('SELECT * FROM budget_periods WHERE id = ? AND user_id = ?').get(period_id, req.user.id);
    if (!period) return res.status(404).json({ error: 'period not found' });
    sql += ' AND t.date BETWEEN ? AND ?';
    params.push(period.start_date, period.end_date);
  }
  sql += ' ORDER BY t.date DESC, t.id DESC';
  res.json(await db.prepare(sql).all(...params));
});

app.post('/api/transactions', requireAuth, async (req, res) => {
  const { amount, date, type, category_id, note } = req.body || {};
  if (amount == null || !date || !type) {
    return res.status(400).json({ error: 'amount, date and type are required' });
  }
  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }
  if (!['income', 'expense'].includes(type)) {
    return res.status(400).json({ error: 'type must be income or expense' });
  }
  if (!DATE_RE.test(date)) {
    return res.status(400).json({ error: 'enter a valid date' });
  }
  if (category_id != null) {
    const cat = await db.prepare('SELECT id FROM categories WHERE id = ? AND user_id = ?').get(category_id, req.user.id);
    if (!cat) return res.status(400).json({ error: 'invalid category' });
  }
  const info = await db
    .prepare('INSERT INTO transactions (user_id, amount, date, type, category_id, note) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.user.id, amount, date, type, category_id ?? null, cleanNote(note));
  res.status(201).json({
    id: info.lastInsertRowid, user_id: req.user.id, amount, date, type,
    category_id: category_id ?? null, note: cleanNote(note),
  });
});

app.put('/api/transactions/:id', requireAuth, async (req, res) => {
  const { amount, date, type, category_id, note } = req.body || {};
  const existing = await db.prepare(
    'SELECT * FROM transactions WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (amount !== undefined && (typeof amount !== 'number' || amount <= 0)) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }
  if (type !== undefined && !['income', 'expense'].includes(type)) {
    return res.status(400).json({ error: 'type must be income or expense' });
  }
  if (date !== undefined && !DATE_RE.test(date)) {
    return res.status(400).json({ error: 'enter a valid date' });
  }
  const updated = {
    amount: amount ?? existing.amount,
    date: date ?? existing.date,
    type: type ?? existing.type,
    category_id: category_id !== undefined ? category_id : existing.category_id,
    note: note !== undefined ? cleanNote(note) : existing.note,
  };
  if (updated.category_id != null) {
    const cat = await db.prepare('SELECT id FROM categories WHERE id = ? AND user_id = ?').get(updated.category_id, req.user.id);
    if (!cat) return res.status(400).json({ error: 'invalid category' });
  }
  await db.prepare(
    'UPDATE transactions SET amount = ?, date = ?, type = ?, category_id = ?, note = ? WHERE id = ? AND user_id = ?'
  ).run(updated.amount, updated.date, updated.type, updated.category_id, updated.note, req.params.id, req.user.id);
  res.json({ id: Number(req.params.id), ...updated });
});

app.delete('/api/transactions/:id', requireAuth, async (req, res) => {
  const info = await db.prepare(
    'DELETE FROM transactions WHERE id = ? AND user_id = ?'
  ).run(req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

/* ---------------- Budget periods ---------------- */

function computePeriodStatus(period, spent) {
  const today = todayStr();
  const daysTotal = daysBetween(period.start_date, period.end_date) + 1;
  const daysElapsed = Math.max(1, daysBetween(period.start_date, today) + 1);
  const daysRemaining = Math.max(0, daysBetween(today, period.end_date) + 1);
  const available = period.amount - spent;
  const plannedRate = period.amount / Math.max(1, daysTotal);
  const pace = spent / daysElapsed;
  const safePerDay = daysRemaining > 0 ? Math.max(0, available) / daysRemaining : 0;

  let tone = 'green';
  let title = "You're on track.";
  let message = 'Keep it up — you’re spending within your plan.';
  if (spent >= period.amount) {
    tone = 'red';
    title = 'This budget is spent.';
    message = 'You’ve used all the money in this budget period.';
  } else if (daysRemaining <= 0) {
    tone = spent <= period.amount ? 'green' : 'red';
    title = 'This budget period has ended.';
    message = 'Add your next income to start a new one.';
  } else if (pace * daysRemaining > available) {
    tone = 'red';
    title = 'You may run out before your next income.';
    message = 'At your current pace, you might run out before your next income.';
  } else if (pace > plannedRate * 1.05) {
    tone = 'yellow';
    title = 'You’re spending faster than planned.';
    message = 'You’re still on track, but try slowing down a little.';
  } else {
    tone = 'green';
    title = 'You’re on track.';
    message = 'Your spending is within your planned budget.';
  }

  return {
    tone,
    title,
    message,
    available,
    daysTotal,
    daysElapsed,
    daysRemaining,
    plannedRate,
    pace,
    safePerDay,
  };
}

async function currentPeriod(userId) {
  return db.prepare(
    'SELECT * FROM budget_periods WHERE user_id = ? ORDER BY start_date DESC, id DESC LIMIT 1'
  ).get(userId);
}

app.get('/api/periods', requireAuth, async (req, res) => {
  const periods = await db.prepare(
    'SELECT * FROM budget_periods WHERE user_id = ? ORDER BY start_date DESC, id DESC'
  ).all(req.user.id);
  const current = await currentPeriod(req.user.id);
  const result = [];
  for (const p of periods) {
    const spentRows = await db.prepare(
      'SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE user_id = ? AND type = ? AND date BETWEEN ? AND ?'
    ).get(req.user.id, 'expense', p.start_date, p.end_date);
    result.push({ ...p, spent: spentRows.s, ...computePeriodStatus(p, spentRows.s) });
  }
  res.json({ periods: result, currentId: current ? current.id : null });
});

app.post('/api/income', requireAuth, async (req, res) => {
  const { amount, date, category_id, note, end_date, period_days } = req.body || {};
  if (amount == null || !date) {
    return res.status(400).json({ error: 'amount and date are required' });
  }
  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }
  if (!DATE_RE.test(date)) return res.status(400).json({ error: 'enter a valid date' });
  if (category_id != null) {
    const cat = await db.prepare(
      'SELECT id FROM categories WHERE id = ? AND user_id = ? AND type = ?'
    ).get(category_id, req.user.id, 'income');
    if (!cat) return res.status(400).json({ error: 'invalid income category' });
  }

  let finalEnd = null;
  if (end_date) {
    if (!DATE_RE.test(end_date)) return res.status(400).json({ error: 'enter a valid end date' });
    if (end_date <= date) return res.status(400).json({ error: 'end date must be after the income date' });
    finalEnd = end_date;
  } else if (period_days != null) {
    if (typeof period_days !== 'number' || period_days < 1 || period_days > 365) {
      return res.status(400).json({ error: 'invalid period length' });
    }
    finalEnd = addDays(date, period_days - 1);
  }

  const txInfo = await db
    .prepare('INSERT INTO transactions (user_id, amount, date, type, category_id, note) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.user.id, amount, date, 'income', category_id ?? null, cleanNote(note));

  let period = null;
  if (finalEnd) {
    const pInfo = await db
      .prepare('INSERT INTO budget_periods (user_id, amount, start_date, end_date) VALUES (?, ?, ?, ?)')
      .run(req.user.id, amount, date, finalEnd);
    period = { id: pInfo.lastInsertRowid, user_id: req.user.id, amount, start_date: date, end_date: finalEnd };
  }

  res.status(201).json({
    transaction: { id: txInfo.lastInsertRowid, amount, date, type: 'income', category_id: category_id ?? null, note: cleanNote(note) },
    period,
  });
});

app.delete('/api/periods/:id', requireAuth, async (req, res) => {
  const period = await db.prepare(
    'SELECT * FROM budget_periods WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.user.id);
  if (!period) return res.status(404).json({ error: 'not found' });
  await db.prepare('DELETE FROM budgets WHERE budget_period_id = ? AND user_id = ?').run(req.params.id, req.user.id);
  await db.prepare('DELETE FROM budget_periods WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.status(204).end();
});

/* ---------------- Budgets ---------------- */

app.get('/api/budgets', requireAuth, async (req, res) => {
  const { period_id } = req.query;
  let pid = period_id;
  if (!pid) {
    const cur = await currentPeriod(req.user.id);
    pid = cur ? cur.id : null;
  }
  if (!pid) return res.json({ budgets: [], totalBudgeted: 0, period: null });
  const period = await db.prepare('SELECT * FROM budget_periods WHERE id = ? AND user_id = ?').get(pid, req.user.id);
  if (!period) return res.status(404).json({ error: 'period not found' });
  const budgets = await db.prepare(
    'SELECT b.*, c.name AS category_name, c.icon AS category_icon, ' +
    '(SELECT COALESCE(SUM(t.amount), 0) FROM transactions t ' +
    ' WHERE t.user_id = b.user_id AND t.type = ? AND t.category_id = b.category_id ' +
    ' AND t.date BETWEEN ? AND ?) AS spent ' +
    'FROM budgets b JOIN categories c ON c.id = b.category_id ' +
    'WHERE b.user_id = ? AND b.budget_period_id = ? ' +
    'ORDER BY spent DESC'
  ).all('expense', period.start_date, period.end_date, req.user.id, pid);
  const totalBudgeted = budgets.reduce((s, b) => s + b.amount, 0);
  res.json({ budgets, totalBudgeted, period });
});

app.post('/api/budgets', requireAuth, async (req, res) => {
  const { category_id, budget_period_id, amount } = req.body || {};
  if (!category_id || !budget_period_id || amount == null) {
    return res.status(400).json({ error: 'category, budget period and amount are required' });
  }
  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }
  const period = await db.prepare(
    'SELECT * FROM budget_periods WHERE id = ? AND user_id = ?'
  ).get(budget_period_id, req.user.id);
  if (!period) return res.status(404).json({ error: 'budget period not found' });
  const cat = await db.prepare(
    'SELECT id FROM categories WHERE id = ? AND user_id = ? AND type = ?'
  ).get(category_id, req.user.id, 'expense');
  if (!cat) return res.status(400).json({ error: 'invalid expense category' });

  const existing = await db.prepare(
    'SELECT * FROM budgets WHERE budget_period_id = ? AND category_id = ?'
  ).get(budget_period_id, category_id);
  const currentOther = await db.prepare(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM budgets WHERE budget_period_id = ? AND category_id <> ?'
  ).get(budget_period_id, category_id);
  if (currentOther.total + amount > period.amount) {
    return res.status(400).json({
      error: `Total budgeted (${(currentOther.total + amount).toFixed(2)}) exceeds this period's income (${period.amount.toFixed(2)})`,
    });
  }
  await db.prepare(
    'INSERT INTO budgets (user_id, category_id, amount, budget_period_id) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT (budget_period_id, category_id) DO UPDATE SET amount = excluded.amount'
  ).run(req.user.id, category_id, amount, budget_period_id);
  res.status(201).json({ category_id, budget_period_id, amount });
});

app.delete('/api/budgets/:id', requireAuth, async (req, res) => {
  const info = await db.prepare(
    'DELETE FROM budgets WHERE id = ? AND user_id = ?'
  ).run(req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

/* ---------------- Overview & insights ---------------- */

app.get('/api/overview', requireAuth, async (req, res) => {
  const period = await currentPeriod(req.user.id);
  const cats = await db.prepare(
    'SELECT id, name, icon, type FROM categories WHERE user_id = ? ORDER BY type DESC, name'
  ).all(req.user.id);

  const base = {
    user: publicUser(req.user),
    categories: cats,
    period: null,
    status: null,
    moneyAvailable: 0,
    totalIncome: 0,
    totalExpense: 0,
    daysTotal: 0,
    daysElapsed: 0,
    daysRemaining: 0,
    safePerDay: 0,
    plannedPerDay: 0,
    budget: { totalBudgeted: 0, categories: [] },
  };

  const hasTxRow = await db.prepare(
    'SELECT COUNT(*) AS c FROM transactions WHERE user_id = ?'
  ).get(req.user.id);
  base.hasTransactions = hasTxRow.c > 0;

  if (!period) {
    if (base.hasTransactions) {
      const aggAll = await db.prepare(
        'SELECT type, COALESCE(SUM(amount), 0) AS total FROM transactions WHERE user_id = ? GROUP BY type'
      ).all(req.user.id);
      for (const row of aggAll) {
        if (row.type === 'income') base.totalIncome = row.total;
        else base.totalExpense = row.total;
      }
    }
    return res.json(base);
  }

  const agg = await db.prepare(
    "SELECT type, COALESCE(SUM(amount), 0) AS total FROM transactions " +
    "WHERE user_id = ? AND date BETWEEN ? AND ? GROUP BY type"
  ).all(req.user.id, period.start_date, period.end_date);
  const totals = { income: 0, expense: 0 };
  for (const row of agg) totals[row.type] = row.total;
  const spent = totals.expense;

  const budgets = await db.prepare(
    'SELECT b.*, c.name AS category_name, c.icon AS category_icon, ' +
    '(SELECT COALESCE(SUM(t.amount), 0) FROM transactions t ' +
    ' WHERE t.user_id = b.user_id AND t.type = ? AND t.category_id = b.category_id ' +
    ' AND t.date BETWEEN ? AND ?) AS spent ' +
    'FROM budgets b JOIN categories c ON c.id = b.category_id ' +
    'WHERE b.user_id = ? AND b.budget_period_id = ? ' +
    'ORDER BY spent DESC'
  ).all('expense', period.start_date, period.end_date, req.user.id, period.id);

  const status = computePeriodStatus(period, spent);
  const budgetCats = [];
  for (const b of budgets) {
    const spentRow = await db.prepare(
      'SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE user_id = ? AND type = ? AND category_id = ? AND date BETWEEN ? AND ?'
    ).get(req.user.id, 'expense', b.category_id, period.start_date, period.end_date);
    const spentCat = spentRow.s;
    const pct = b.amount > 0 ? (spentCat / b.amount) * 100 : 0;
    const catStatus = spentCat >= b.amount ? 'over' : pct >= 70 ? 'close' : 'safe';
    budgetCats.push({
      id: b.id,
      category_id: b.category_id,
      name: b.category_name,
      icon: b.category_icon,
      amount: b.amount,
      spent: spentCat,
      remaining: b.amount - spentCat,
      pct,
      status: catStatus,
    });
  }
  const totalBudgeted = budgets.reduce((s, b) => s + b.amount, 0);

  res.json({
    user: publicUser(req.user),
    categories: cats,
    period,
    status,
    moneyAvailable: status.available,
    totalIncome: totals.income,
    totalExpense: spent,
    daysTotal: status.daysTotal,
    daysElapsed: status.daysElapsed,
    daysRemaining: status.daysRemaining,
    safePerDay: status.safePerDay,
    plannedPerDay: status.plannedRate,
    budget: { totalBudgeted, categories: budgetCats },
  });
});

app.get('/api/insights', requireAuth, async (req, res) => {
  const insights = [];
  const period = await currentPeriod(req.user.id);
  let periodSpent = 0;
  const tx = await db.prepare(
    'SELECT t.*, c.name AS category_name, c.icon AS category_icon FROM transactions t ' +
    'LEFT JOIN categories c ON c.id = t.category_id WHERE t.user_id = ? ORDER BY t.date DESC'
  ).all(req.user.id);

  if (!period && tx.length === 0) {
    return res.json([{ icon: '👋', tone: 'neutral', text: 'Add your income to get started and see how your money is doing.' }]);
  }

  if (period) {
    const spentRows = await db.prepare(
      'SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE user_id = ? AND type = ? AND date BETWEEN ? AND ?'
    ).get(req.user.id, 'expense', period.start_date, period.end_date);
    const spent = spentRows.s;
    periodSpent = spent;
    const remaining = period.amount - spent;
    if (remaining > 0) {
      insights.push({ icon: '💰', tone: 'neutral', text: `You have ${req.user.currency}${remaining.toFixed(2)} remaining for this budget period.` });
    }

    const periodExpenses = tx.filter(
      (t) => t.type === 'expense' && t.date >= period.start_date && t.date <= period.end_date
    );
    const hasMeaningfulData = spent >= 20 && periodExpenses.length >= 2;

    if (hasMeaningfulData) {
      const cats = await db.prepare(
        'SELECT category_id, category_name, category_icon, amount, spent FROM ' +
        '(SELECT b.category_id, c.name AS category_name, c.icon AS category_icon, b.amount, ' +
        '(SELECT COALESCE(SUM(t.amount), 0) FROM transactions t WHERE t.user_id = b.user_id AND t.type = ? AND t.category_id = b.category_id AND t.date BETWEEN ? AND ?) AS spent ' +
        'FROM budgets b JOIN categories c ON c.id = b.category_id WHERE b.user_id = ? AND b.budget_period_id = ?)'
      ).all('expense', period.start_date, period.end_date, req.user.id, period.id);

      const biggest = cats.slice().sort((a, b) => b.spent - a.spent)[0];
      if (biggest && biggest.spent > 0) {
        insights.push({ icon: biggest.category_icon || '🍔', tone: 'neutral', text: `${biggest.category_name} is your biggest expense this period (${req.user.currency}${biggest.spent.toFixed(2)}).` });
      }

      for (const c of cats) {
        if (c.spent > c.amount) {
          insights.push({ icon: '⚠️', tone: 'danger', text: `You've gone over your ${c.category_name} budget by ${req.user.currency}${(c.spent - c.amount).toFixed(2)}.` });
        } else if (c.amount > 0 && (c.spent / c.amount) >= 0.8) {
          insights.push({ icon: '⚠️', tone: 'warn', text: `You've used ${Math.round((c.spent / c.amount) * 100)}% of your ${c.category_name} budget (${req.user.currency}${c.spent.toFixed(2)} / ${req.user.currency}${c.amount.toFixed(2)}).` });
        }
      }
    } else if (periodExpenses.length > 0) {
      insights.push({ icon: '🌱', tone: 'neutral', text: 'Keep tracking your spending and we’ll start showing useful patterns here.' });
    }

    const prevPeriod = await db.prepare(
      'SELECT * FROM budget_periods WHERE user_id = ? AND start_date < ? ORDER BY start_date DESC LIMIT 1'
    ).get(req.user.id, period.start_date);
    if (prevPeriod) {
      const prevSpentRows = await db.prepare(
        'SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE user_id = ? AND type = ? AND date BETWEEN ? AND ?'
      ).get(req.user.id, 'expense', prevPeriod.start_date, prevPeriod.end_date);
      const prevSpent = prevSpentRows.s;
      if (prevSpent > 0 && spent > prevSpent) {
        insights.push({ icon: '📈', tone: 'warn', text: `You've spent more this period (${req.user.currency}${spent.toFixed(2)}) than your previous period (${req.user.currency}${prevSpent.toFixed(2)}).` });
      } else if (prevSpent > 0 && spent < prevSpent) {
        insights.push({ icon: '🟢', tone: 'good', text: `Nice work — you've spent ${req.user.currency}${(prevSpent - spent).toFixed(2)} less this period than your previous one.` });
      }
    }
  }

  const today = todayStr();
  const thisWeek = tx.filter((t) => t.type === 'expense' && t.date >= addDays(today, -6));
  const lastWeek = tx.filter((t) => t.type === 'expense' && t.date >= addDays(today, -13) && t.date < addDays(today, -6));
  const thisTotal = thisWeek.reduce((s, t) => s + t.amount, 0);
  const lastTotal = lastWeek.reduce((s, t) => s + t.amount, 0);
  if (thisWeek.length || lastWeek.length) {
    if (thisTotal > lastTotal && lastTotal > 0) {
      insights.push({ icon: '📈', tone: 'warn', text: `You spent ${req.user.currency}${(thisTotal - lastTotal).toFixed(2)} more this week than last week.` });
    } else if (lastTotal > thisTotal && lastTotal > 0) {
      insights.push({ icon: '🟢', tone: 'good', text: `Nice work — you spent ${req.user.currency}${(lastTotal - thisTotal).toFixed(2)} less this week than last week.` });
    }
  }

  if (period) {
    const status = computePeriodStatus(period, periodSpent);
    if (status.tone === 'green') {
      insights.push({ icon: '🟢', tone: 'good', text: 'Your spending is currently within your planned budget.' });
    } else if (status.tone === 'yellow') {
      insights.push({ icon: '🟡', tone: 'warn', text: 'You’re spending faster than planned this period.' });
    } else if (status.tone === 'red') {
      insights.push({ icon: '🔴', tone: 'danger', text: 'Your current spending rate may cause you to run out before this period ends.' });
    }
  }

  res.json(insights);
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
      console.log(`StayOn running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });