import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getPendingLinks,
  updateLinkStatus,
  saveMessage,
  getKeywords,
  getDb
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(__dirname, '../data/auth');

const logger = pino({ level: 'silent' });

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['WhatsApp Analyzer', 'Chrome', '120.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n[AUTH] Отсканируй QR-код в WhatsApp (Связанные устройства → Привязать устройство):\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('[+] Подключено к WhatsApp');
      await processInviteLinks(sock);
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (reason === DisconnectReason.loggedOut) {
        console.log('[!] Аккаунт разлогинен, удали папку data/auth и перезапусти');
        process.exit(1);
      } else {
        console.log(`[~] Переподключение (причина: ${reason})...`);
        setTimeout(() => connectToWhatsApp(), 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    const keywords = getKeywords();
    if (keywords.length === 0) return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      if (!jid?.endsWith('@g.us')) continue;

      const text = extractText(msg.message);
      if (!text) continue;

      const matched = keywords.filter(kw => text.toLowerCase().includes(kw));
      if (matched.length === 0) continue;

      const groupMeta = await sock.groupMetadata(jid).catch(() => null);
      const groupName = groupMeta?.subject || jid;
      const sender = msg.key.participant || msg.key.remoteJid;

      saveMessage(jid, groupName, sender, text, matched);
      console.log(`[MATCH] Группа: "${groupName}" | Ключевые слова: ${matched.join(', ')}`);
      console.log(`        Сообщение: ${text.substring(0, 100)}`);
    }
  });

  return sock;
}

async function processInviteLinks(sock) {
  const pending = getPendingLinks();
  if (pending.length === 0) {
    console.log('[i] Нет ожидающих ссылок. Добавь ссылки через src/manage-links.js');
    return;
  }

  console.log(`[i] Пробую вступить в ${pending.length} групп(ы)...`);

  for (const row of pending) {
    const code = extractInviteCode(row.link);
    if (!code) {
      updateLinkStatus(row.id, 'invalid', { error: 'Не удалось извлечь код из ссылки' });
      console.log(`[-] Невалидная ссылка: ${row.link}`);
      continue;
    }

    try {
      console.log(`[~] Вступаю: ${row.link}`);
      const result = await sock.groupAcceptInvite(code);
      const jid = result;

      await new Promise(r => setTimeout(r, 2000));

      const meta = await sock.groupMetadata(jid).catch(() => null);
      const name = meta?.subject || jid;

      updateLinkStatus(row.id, 'joined', { jid, name });
      console.log(`[+] Вступил в группу: "${name}" (${jid})`);

      await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
      const errMsg = e.message || String(e);
      updateLinkStatus(row.id, 'failed', { error: errMsg });
      console.log(`[-] Ошибка для ${row.link}: ${errMsg}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log('[i] Обработка ссылок завершена. Слушаю сообщения...');
  printStats();
}

function extractInviteCode(link) {
  const match = link.match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/);
  return match ? match[1] : null;
}

function extractText(message) {
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    null
  );
}

function printStats() {
  const db = getDb();
  const stats = db.prepare(`
    SELECT status, COUNT(*) as count FROM invite_links GROUP BY status
  `).all();
  const msgs = db.prepare('SELECT COUNT(*) as count FROM messages').get();

  console.log('\n[СТАТИСТИКА]');
  stats.forEach(s => console.log(`  ${s.status}: ${s.count}`));
  console.log(`  Сообщений с совпадениями: ${msgs.count}`);
}

connectToWhatsApp();
