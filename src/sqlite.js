import Database from 'better-sqlite3';

export function createDatabase(databaseFilePath) {
  const db = new Database(databaseFilePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','agent','admin'))
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','pending','resolved','closed')),
      priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
      requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0,
      due_at TEXT,
      last_commented_at TEXT
    );

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS timeline (
      id INTEGER PRIMARY KEY,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tickets_updated_at ON tickets(updated_at);
    CREATE INDEX IF NOT EXISTS idx_tickets_due_at ON tickets(due_at);
    CREATE INDEX IF NOT EXISTS idx_comments_ticket ON comments(ticket_id);
  `);

  // Seed a few users for demo
  const existing = db.prepare('SELECT COUNT(*) as c FROM users').get();
  if (existing.c === 0) {
    const seed = db.prepare('INSERT INTO users (email, name, role) VALUES (?, ?, ?)');
    seed.run('alice@example.com', 'Alice', 'user');
    seed.run('bob@example.com', 'Bob', 'agent');
    seed.run('carol@example.com', 'Carol', 'admin');
  }

  return db;
}

export function nowIso() {
  return new Date().toISOString();
}
