const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'tracker.db');
const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
    icon TEXT
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount REAL NOT NULL,
    date TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
    category_id INTEGER,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (category_id) REFERENCES categories(id)
  );

  CREATE TABLE IF NOT EXISTS budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL,
    month TEXT NOT NULL,
    limit_amount REAL NOT NULL,
    UNIQUE (category_id, month),
    FOREIGN KEY (category_id) REFERENCES categories(id)
  );

  CREATE TABLE IF NOT EXISTS seed_marker (id INTEGER PRIMARY KEY);
`);

const seed = db.prepare('SELECT id FROM seed_marker WHERE id = 1').get();
if (!seed) {
  const insertCat = db.prepare(
    'INSERT OR IGNORE INTO categories (name, type, icon) VALUES (?, ?, ?)'
  );
  insertCat.run('Food', 'expense', '🍔');
  insertCat.run('Transport', 'expense', '🚗');
  insertCat.run('Housing', 'expense', '🏠');
  insertCat.run('Utilities', 'expense', '💡');
  insertCat.run('Health', 'expense', '💊');
  insertCat.run('Entertainment', 'expense', '🎬');
  insertCat.run('Allowance', 'income', '🪙');
  insertCat.run('Gifts', 'income', '🎁');
  insertCat.run('Other', 'expense', '📦');
  db.prepare('INSERT OR IGNORE INTO seed_marker (id) VALUES (1)').run();
}

module.exports = db;
