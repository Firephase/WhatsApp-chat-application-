import chalk from 'chalk';
import inquirer from 'inquirer';
import readline from 'readline';
import { addLogListener, log } from './log.js';
import { addInviteLink, addKeyword, updateLinkStatus, getDb } from './db.js';

export { log };

// ─── Console printer (registered as log listener) ────────────────────────────

let isPrompting = false;
const pendingConsole = [];

const ICONS = {
  info:    chalk.cyan('ℹ'),
  success: chalk.green('✓'),
  error:   chalk.red('✗'),
  stage:   chalk.yellow('→'),
  match:   chalk.magenta('★'),
  warn:    chalk.yellow('⚠'),
  connect: chalk.blue('⟳'),
};

addLogListener(entry => {
  const t    = new Date(entry.time).toLocaleTimeString('ru-RU', { hour12: false });
  const icon = ICONS[entry.type] ?? ICONS.info;
  const line = `${chalk.gray(t)} ${icon}  ${entry.message}`;
  if (isPrompting) pendingConsole.push(line);
  else console.log(line);
});

function flushConsole() {
  while (pendingConsole.length) console.log(pendingConsole.shift());
}

// ─── Terminal interactive mode ────────────────────────────────────────────────

let waSocket = null;

export function startInteractiveMode(sock) {
  waSocket = sock;

  if (!process.stdin.isTTY) {
    log('info', 'Терминальный ввод недоступен (нет TTY) — управляй через веб-интерфейс');
    return;
  }

  process.on('SIGINT', () => {
    try { process.stdin.setRawMode(false); } catch {}
    console.log('\n' + chalk.dim('Выход.'));
    process.exit(0);
  });

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  printHelpBar();

  process.stdin.on('keypress', async (str, key) => {
    if (isPrompting) return;
    if (key.ctrl && key.name === 'c') { console.log(''); process.exit(0); }
    switch ((key.name ?? str)?.toLowerCase()) {
      case 'a': await cmdAddLink(); break;
      case 'k': await cmdManageKeywords(); break;
    }
  });
}

function printHelpBar() {
  console.log(chalk.dim('\n  [A] добавить ссылку  [K] ключевые слова  [Ctrl+C] выход\n'));
}

async function withPrompt(fn) {
  isPrompting = true;
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  console.log('');
  try { await fn(); } catch (e) {
    if (e?.name !== 'ExitPromptError') log('error', `Ошибка ввода: ${e.message}`);
  }
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  isPrompting = false;
  flushConsole();
  printHelpBar();
}

async function cmdAddLink() {
  await withPrompt(async () => {
    const { link } = await inquirer.prompt([{
      type: 'input',
      name: 'link',
      message: 'Ссылка на группу:',
      validate: v => v.trim().match(/chat\.whatsapp\.com\/[A-Za-z0-9]+/) || 'Некорректная ссылка',
    }]);
    const trimmed = link.trim();
    addInviteLink(trimmed);
    isPrompting = false;
    flushConsole();
    await joinLink(trimmed);
  });
}

async function cmdManageKeywords() {
  await withPrompt(async () => {
    const db  = getDb();
    const all = db.prepare('SELECT id, word, active FROM keywords ORDER BY word').all();

    if (all.length) {
      const { activeIds } = await inquirer.prompt([{
        type: 'checkbox',
        name: 'activeIds',
        message: 'Ключевые слова (Space = вкл/выкл):',
        choices: all.map(k => ({ name: k.word, value: k.id, checked: k.active === 1 })),
      }]);
      db.prepare('UPDATE keywords SET active = 0').run();
      for (const id of activeIds) db.prepare('UPDATE keywords SET active = 1 WHERE id = ?').run(id);
      log('success', `Активных слов: ${activeIds.length}`);
    }

    const { newWords } = await inquirer.prompt([{
      type: 'input',
      name: 'newWords',
      message: 'Добавить слова через запятую (или Enter пропустить):',
    }]);
    if (newWords.trim()) {
      for (const w of newWords.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) {
        addKeyword(w);
        log('success', `Добавлено: ${chalk.bold(w)}`);
      }
    }
  });
}

// ─── Join logic (used by both terminal and web server) ───────────────────────

export function setSocket(sock) { waSocket = sock; }

export async function joinLink(link) {
  const db  = getDb();
  const row = db.prepare('SELECT id FROM invite_links WHERE link = ?').get(link);
  const m   = link.match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/);

  if (!m) {
    log('error', `Нет кода приглашения в ссылке: ${link}`);
    if (row) updateLinkStatus(row.id, 'invalid', { error: 'Нет кода' });
    return;
  }

  const code = m[1];
  log('stage', `Ссылка:          ${chalk.dim(link)}`);
  log('stage', `Код приглашения: ${chalk.bold(code)}`);

  if (!waSocket) {
    log('error', 'WhatsApp не подключён — дождись QR и авторизации');
    return;
  }

  log('stage', 'Отправляю запрос на вступление...');

  try {
    const jid = await waSocket.groupAcceptInvite(code);
    log('stage', `JID: ${chalk.dim(jid)}`);
    log('stage', 'Получаю данные группы...');

    await new Promise(r => setTimeout(r, 2000));
    const meta  = await waSocket.groupMetadata(jid).catch(() => null);
    const name  = meta?.subject ?? jid;
    const count = meta?.participants?.length ?? '?';

    if (row) updateLinkStatus(row.id, 'joined', { jid, name });
    log('success', `ВСТУПИЛ → "${chalk.bold(name)}"  участников: ${chalk.bold(count)}  ${chalk.dim(jid)}`);
  } catch (e) {
    const statusCode = e?.output?.statusCode ?? e?.data?.code ?? '';
    const reason     = resolveWaError(e, statusCode);
    const errStr     = [statusCode && `[${statusCode}]`, reason].filter(Boolean).join(' ');
    if (row) updateLinkStatus(row.id, 'failed', { error: errStr });
    log('error', `ОШИБКА ${statusCode ? `[${statusCode}] ` : ''}${reason}`);
    if (e.message && e.message !== reason) log('error', `Детали: ${chalk.dim(e.message)}`);
  }
}

function resolveWaError(e, code) {
  const msg = (e?.message ?? '').toLowerCase();
  if (msg.includes('invite-code') || code === 400)  return 'Ссылка недействительна или устарела';
  if (code === 401)                                  return 'Нет авторизации';
  if (code === 403)                                  return 'Требуется одобрение администратора';
  if (code === 404)                                  return 'Группа не найдена';
  if (code === 408 || msg.includes('timed out'))     return 'Превышено время ожидания';
  if (code === 409)                                  return 'Уже являетесь участником';
  if (code === 429)                                  return 'Слишком много запросов, подождите';
  if (code === 500)                                  return 'Ошибка сервера WhatsApp';
  return e?.message ?? 'Неизвестная ошибка';
}
