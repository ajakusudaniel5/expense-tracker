const { createClient } = require('@libsql/client');

const url = process.env.TURSO_URL || 'file:./data/tracker.db';

const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN, rowMode: 'object', intMode: 'number' });

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT,
    currency TEXT NOT NULL DEFAULT 'GH₵',
    income_type TEXT,
    income_frequency TEXT,
    onboarded INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS budget_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
    icon TEXT,
    UNIQUE (user_id, name),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 0,
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
    user_id INTEGER NOT NULL DEFAULT 0,
    category_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    budget_period_id INTEGER NOT NULL,
    UNIQUE (budget_period_id, category_id),
    FOREIGN KEY (category_id) REFERENCES categories(id),
    FOREIGN KEY (budget_period_id) REFERENCES budget_periods(id)
  );
`;

const DEFAULT_EXPENSE_CATEGORIES = [
  ['Food', '🍔'],
  ['Transport', '🚌'],
  ['Data & Airtime', '📶'],
  ['School', '📚'],
  ['Entertainment', '🎬'],
  ['Shopping', '🛍️'],
  ['Bills', '🧾'],
  ['Giving', '🎁'],
  ['Other', '📦'],
];

const DEFAULT_INCOME_CATEGORIES = [
  ['Allowance', '🪙'],
  ['Salary', '💼'],
  ['Freelance', '💻'],
  ['Gift', '🎁'],
  ['Other income', '💰'],
];

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

async function hasColumn(table, column) {
  const res = await client.execute({ sql: `PRAGMA table_info(${table})`, args: [] });
  return res.rows.some((r) => r.name === column);
}

async function lastDayOfMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

async function migrateLegacy() {
  const catsMigrated = await hasColumn('categories', 'user_id');
  const txsMigrated = await hasColumn('transactions', 'user_id');
  const budgetsMigrated = await hasColumn('budgets', 'budget_period_id');
  if (catsMigrated && txsMigrated && budgetsMigrated) {
    await prepare('DROP TABLE IF EXISTS settings').run();
    return;
  }

  console.log('Migrating legacy single-user database to multi-user schema...');

  await client.execute('PRAGMA foreign_keys = OFF');
  await client.execute('BEGIN');
  try {
    await prepare('DROP TABLE IF EXISTS settings').run();

    if (!catsMigrated) {
      await prepare(
        `CREATE TABLE categories_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL DEFAULT 0,
          name TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
          icon TEXT,
          UNIQUE (user_id, name)
        )`
      ).run();
      await prepare(
        'INSERT INTO categories_new (id, user_id, name, type, icon) SELECT id, 0, name, type, icon FROM categories'
      ).run();
      await prepare('DROP TABLE categories').run();
      await prepare('ALTER TABLE categories_new RENAME TO categories').run();
    }

    if (!txsMigrated) {
      await prepare('ALTER TABLE transactions ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0').run();
    }

    if (!budgetsMigrated) {
      const monthRows = await prepare('SELECT DISTINCT month FROM budgets').all();
      const monthToPeriodId = {};
      for (const { month } of monthRows) {
        const incomeRows = await prepare(
          "SELECT amount FROM transactions WHERE type = 'income' AND substr(date, 1, 7) = ?"
        ).all(month);
        const income = incomeRows.reduce((s, r) => s + r.amount, 0);
        const periodInfo = await prepare(
          'INSERT INTO budget_periods (user_id, amount, start_date, end_date) VALUES (?, ?, ?, ?)'
        ).run(0, income, `${month}-01`, await lastDayOfMonth(month));
        monthToPeriodId[month] = periodInfo.lastInsertRowid;
      }

      const oldBudgets = await prepare('SELECT * FROM budgets').all();
      await prepare('DROP TABLE budgets').run();
      await prepare(
        `CREATE TABLE budgets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL DEFAULT 0,
          category_id INTEGER NOT NULL,
          amount REAL NOT NULL,
          budget_period_id INTEGER NOT NULL,
          UNIQUE (budget_period_id, category_id)
        )`
      ).run();
      for (const b of oldBudgets) {
        const pid = monthToPeriodId[b.month];
        if (pid == null) continue;
        await prepare(
          'INSERT INTO budgets (user_id, category_id, amount, budget_period_id) VALUES (0, ?, ?, ?)'
        ).run(b.category_id, b.limit_amount, pid);
      }
    }

    await client.execute('COMMIT');
    console.log('Legacy migration complete.');
  } catch (err) {
    await client.execute('ROLLBACK');
    throw err;
  } finally {
    await client.execute('PRAGMA foreign_keys = ON');
  }
}

async function seedDefaultCategories(userId) {
  const insert = prepare(
    'INSERT OR IGNORE INTO categories (user_id, name, type, icon) VALUES (?, ?, ?, ?)'
  );
  for (const [name, icon] of DEFAULT_EXPENSE_CATEGORIES) {
    await insert.run(userId, name, 'expense', icon);
  }
  for (const [name, icon] of DEFAULT_INCOME_CATEGORIES) {
    await insert.run(userId, name, 'income', icon);
  }
}

async function adoptLegacyData(userId) {
  await prepare('UPDATE categories SET user_id = ? WHERE user_id = 0').run(userId);
  await prepare('UPDATE transactions SET user_id = ? WHERE user_id = 0').run(userId);
  await prepare('UPDATE budgets SET user_id = ? WHERE user_id = 0').run(userId);
  await prepare('UPDATE budget_periods SET user_id = ? WHERE user_id = 0').run(userId);
}

async function init() {
  await client.executeMultiple(SCHEMA);
  await migrateLegacy();
}

module.exports = { db: { prepare, client }, init, seedDefaultCategories, adoptLegacyData };