import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { addLogListener, log } from './log.js';
import { addInviteLink, addKeyword, updateLinkStatus, getDb } from './db.js';
import { joinLink } from './ui.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app        = express();
const httpServer = createServer(app);
const wss        = new WebSocketServer({ server: httpServer });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── WebSocket ────────────────────────────────────────────────────────────────

const clients = new Set();

wss.on('connection', ws => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  // send current stats immediately on connect
  sendStats(ws);
});

export function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  for (const c of clients) {
    if (c.readyState === 1) c.send(msg);
  }
}

function sendStats(ws) {
  try {
    const db = getDb();
    const stats = buildStats(db);
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'stats', data: stats }));
  } catch {}
}

function broadcastStats() {
  try { broadcast('stats', buildStats(getDb())); } catch {}
}

function buildStats(db) {
  return {
    links:    db.prepare('SELECT status, COUNT(*) as c FROM invite_links GROUP BY status').all(),
    messages: db.prepare('SELECT COUNT(*) as c FROM messages').get()?.c ?? 0,
    keywords: db.prepare('SELECT COUNT(*) as c FROM keywords WHERE active = 1').get()?.c ?? 0,
  };
}

// Forward all logs to web clients in real time
addLogListener(entry => broadcast('log', entry));

// ─── API ─────────────────────────────────────────────────────────────────────

app.get('/api/links', (_req, res) => {
  res.json(getDb().prepare('SELECT * FROM invite_links ORDER BY created_at DESC').all());
});

app.post('/api/links', async (req, res) => {
  const { link } = req.body ?? {};
  if (!link?.match(/chat\.whatsapp\.com\/[A-Za-z0-9]+/)) {
    return res.status(400).json({ error: 'Некорректная ссылка' });
  }
  addInviteLink(link.trim());
  res.json({ ok: true });
  joinLink(link.trim()).then(() => broadcastStats());
});

app.get('/api/keywords', (_req, res) => {
  res.json(getDb().prepare('SELECT * FROM keywords ORDER BY word').all());
});

app.post('/api/keywords', (req, res) => {
  const { words } = req.body ?? {};
  if (!Array.isArray(words)) return res.status(400).json({ error: 'words must be array' });
  for (const w of words) addKeyword(w);
  broadcastStats();
  res.json({ ok: true });
});

app.patch('/api/keywords/:id', (req, res) => {
  const { active } = req.body ?? {};
  getDb().prepare('UPDATE keywords SET active = ? WHERE id = ?').run(active ? 1 : 0, req.params.id);
  broadcastStats();
  res.json({ ok: true });
});

app.delete('/api/keywords/:id', (req, res) => {
  getDb().prepare('DELETE FROM keywords WHERE id = ?').run(req.params.id);
  broadcastStats();
  res.json({ ok: true });
});

app.get('/api/stats', (_req, res) => {
  try { res.json(buildStats(getDb())); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/matches', (_req, res) => {
  res.json(getDb().prepare('SELECT * FROM messages ORDER BY received_at DESC LIMIT 100').all());
});

// ─── Start ────────────────────────────────────────────────────────────────────

export function startServer(port = 3000) {
  return new Promise(resolve => {
    httpServer.listen(port, '0.0.0.0', () => {
      log('info', `Веб-интерфейс: http://localhost:${port}`);
      resolve();
    });
  });
}
