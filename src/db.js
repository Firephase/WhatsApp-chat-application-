import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '../data/chats.db');

let db;

export function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS invite_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      link TEXT UNIQUE NOT NULL,
      group_jid TEXT,
      group_name TEXT,
      status TEXT DEFAULT 'pending',
      joined_at DATETIME,
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_jid TEXT NOT NULL,
      group_name TEXT,
      sender TEXT,
      message TEXT,
      matched_keywords TEXT,
      received_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS keywords (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word TEXT UNIQUE NOT NULL,
      active INTEGER DEFAULT 1
    );
  `);
}

export function addInviteLink(link) {
  const db = getDb();
  try {
    db.prepare('INSERT OR IGNORE INTO invite_links (link) VALUES (?)').run(link);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export function getPendingLinks() {
  return getDb().prepare("SELECT * FROM invite_links WHERE status = 'pending'").all();
}

export function updateLinkStatus(id, status, data = {}) {
  const db = getDb();
  db.prepare(`
    UPDATE invite_links
    SET status = ?, group_jid = ?, group_name = ?, joined_at = CURRENT_TIMESTAMP, error = ?
    WHERE id = ?
  `).run(status, data.jid || null, data.name || null, data.error || null, id);
}

export function saveMessage(groupJid, groupName, sender, message, matchedKeywords) {
  getDb().prepare(`
    INSERT INTO messages (group_jid, group_name, sender, message, matched_keywords)
    VALUES (?, ?, ?, ?, ?)
  `).run(groupJid, groupName, sender, message, matchedKeywords.join(','));
}

export function getKeywords() {
  return getDb().prepare("SELECT word FROM keywords WHERE active = 1").all().map(r => r.word);
}

export function addKeyword(word) {
  try {
    getDb().prepare('INSERT OR IGNORE INTO keywords (word) VALUES (?)').run(word.toLowerCase());
    return true;
  } catch {
    return false;
  }
}
