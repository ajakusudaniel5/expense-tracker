const express = require('express');
const path = require('node:path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', db: db.isOpen ? 'connected' : 'error' });
});

app.get('/api/categories', (req, res) => {
  const rows = db.prepare('SELECT * FROM categories ORDER BY name').all();
  res.json(rows);
});

app.post('/api/categories', (req, res) => {
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

app.delete('/api/categories/:id', (req, res) => {
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

app.get('/api/transactions', (req, res) => {
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

app.post('/api/transactions', (req, res) => {
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

app.put('/api/transactions/:id', (req, res) => {
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

app.delete('/api/transactions/:id', (req, res) => {
  const info = db.prepare('DELETE FROM transactions WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

app.get('/api/budgets', (req, res) => {
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

app.post('/api/budgets', (req, res) => {
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

app.delete('/api/budgets/:id', (req, res) => {
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
