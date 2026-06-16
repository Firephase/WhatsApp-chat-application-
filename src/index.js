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
import { saveMessage, getKeywords, getDb } from './db.js';
import { log, startInteractiveMode, joinLink } from './ui.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR  = path.join(__dirname, '../data/auth');
const logger    = pino({ level: 'silent' });

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version }          = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth:               state,
    logger,
    printQRInTerminal:  false,
    browser:            ['WhatsApp Analyzer', 'Chrome', '120.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      log('connect', 'Отсканируй QR-код в WhatsApp → Связанные устройства → Привязать:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      log('success', 'Подключено к WhatsApp');
      startInteractiveMode(sock);
      await processPendingLinks();
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (reason === DisconnectReason.loggedOut) {
        log('error', 'Аккаунт разлогинен. Удали папку data/auth/ и перезапусти.');
        process.exit(1);
      } else {
        log('warn', `Соединение закрыто (код ${reason}), переподключаюсь через 5с...`);
        setTimeout(connectToWhatsApp, 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    const keywords = getKeywords();
    if (!keywords.length) return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      if (!jid?.endsWith('@g.us')) continue;

      const text = extractText(msg.message);
      if (!text) continue;

      const matched = keywords.filter(kw => text.toLowerCase().includes(kw));
      if (!matched.length) continue;

      const meta      = await sock.groupMetadata(jid).catch(() => null);
      const groupName = meta?.subject ?? jid;
      const sender    = msg.key.participant ?? jid;

      saveMessage(jid, groupName, sender, text, matched);
      log('match', `"${groupName}"  [${matched.join(', ')}]  ${text.substring(0, 100)}`);
    }
  });
}

async function processPendingLinks() {
  const db      = getDb();
  const pending = db.prepare("SELECT link FROM invite_links WHERE status = 'pending'").all();
  if (!pending.length) return;

  log('info', `Обрабатываю ${pending.length} ожидающих ссылок из базы...`);
  for (const row of pending) {
    await joinLink(row.link);
    await new Promise(r => setTimeout(r, 3000));
  }
}

function extractText(message) {
  return (
    message.conversation              ??
    message.extendedTextMessage?.text ??
    message.imageMessage?.caption     ??
    message.videoMessage?.caption     ??
    null
  );
}

connectToWhatsApp();
