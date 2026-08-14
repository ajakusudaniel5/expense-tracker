const { createClient } = require('@libsql/client');

const url = process.env.TURSO_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url) {
  throw new Error('TURSO_URL env var is required');
}

const client = createClient({ url, authToken, rowMode: 'object', intMode: 'number' });

const SCHEMA = `
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

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`;

function prepare(sql) {
  return {
    async get(...args) {
      const res = await client.execute({ sql, args });
      return res.rows[0];
    },
    async all(...args) {
      const res = await client.execute({ sql, args });
      return res.rows;
    },
    async run(...args) {
      const res = await client.execute({ sql, args });
      const lastInsertRowid =
        typeof res.lastInsertRowid === 'bigint'
          ? Number(res.lastInsertRowid)
          : res.lastInsertRowid;
      return { changes: res.rowsAffected, lastInsertRowid };
    },
  };
}

async function init() {
  await client.executeMultiple(SCHEMA);
  const seed = await prepare('SELECT id FROM seed_marker WHERE id = 1').get();
  if (!seed) {
    const insertCat = prepare(
      'INSERT OR IGNORE INTO categories (name, type, icon) VALUES (?, ?, ?)'
    );
    await insertCat.run('Food', 'expense', '🍔');
    await insertCat.run('Transport', 'expense', '🚗');
    await insertCat.run('Housing', 'expense', '🏠');
    await insertCat.run('Utilities', 'expense', '💡');
    await insertCat.run('Health', 'expense', '💊');
    await insertCat.run('Entertainment', 'expense', '🎬');
    await insertCat.run('Allowance', 'income', '🪙');
    await insertCat.run('Gifts', 'income', '🎁');
    await insertCat.run('Other', 'expense', '📦');
    await prepare('INSERT OR IGNORE INTO seed_marker (id) VALUES (1)').run();
  }
}

module.exports = { db: { prepare, client }, init };