import chalk from 'chalk';
import inquirer from 'inquirer';
import readline from 'readline';
import { addInviteLink, addKeyword, updateLinkStatus, getKeywords, getDb } from './db.js';

let waSocket = null;
let isPrompting = false;
const pendingLogs = [];

// ─── Logging ─────────────────────────────────────────────────────────────────

const ICONS = {
  info:    chalk.cyan('ℹ'),
  success: chalk.green('✓'),
  error:   chalk.red('✗'),
  stage:   chalk.yellow('→'),
  match:   chalk.magenta('★'),
  warn:    chalk.yellow('⚠'),
  connect: chalk.blue('⟳'),
};

export function log(type, message) {
  const time = chalk.gray(new Date().toLocaleTimeString('ru-RU', { hour12: false }));
  const icon = ICONS[type] ?? ICONS.info;
  const line = `${time} ${icon}  ${message}`;
  if (isPrompting) {
    pendingLogs.push(line);
  } else {
    console.log(line);
  }
}

function flushPending() {
  while (pendingLogs.length) console.log(pendingLogs.shift());
}

// ─── Interactive mode ─────────────────────────────────────────────────────────

export function startInteractiveMode(sock) {
  waSocket = sock;

  if (!process.stdin.isTTY) {
    log('warn', 'Нет TTY — интерактивный ввод недоступен. Запускай без флага -d или через docker attach.');
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
    if (key.ctrl && key.name === 'c') {
      console.log('\n' + chalk.dim('Выход.'));
      process.exit(0);
    }
    switch ((key.name ?? str)?.toLowerCase()) {
      case 'a': await cmdAddLink(); break;
      case 'k': await cmdManageKeywords(); break;
      case 's': cmdStats(); break;
    }
  });
}

function printHelpBar() {
  console.log(chalk.dim('\n  Клавиши: [A] добавить ссылку  [K] ключевые слова  [S] статистика  [Ctrl+C] выход\n'));
}

// ─── withPrompt wrapper ───────────────────────────────────────────────────────

async function withPrompt(fn) {
  isPrompting = true;
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  console.log('');
  try {
    await fn();
  } catch (e) {
    if (e?.name !== 'ExitPromptError') {
      log('error', `Ошибка ввода: ${e.message}`);
    }
  }
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  isPrompting = false;
  flushPending();
  printHelpBar();
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdAddLink() {
  await withPrompt(async () => {
    const { link } = await inquirer.prompt([{
      type: 'input',
      name: 'link',
      message: chalk.bold('Ссылка на группу') + chalk.dim(' (https://chat.whatsapp.com/...):'),
      validate: v =>
        v.trim().match(/chat\.whatsapp\.com\/[A-Za-z0-9]+/)
          ? true
          : chalk.red('Некорректная ссылка. Нужно: https://chat.whatsapp.com/XXXX'),
    }]);

    const trimmed = link.trim();
    addInviteLink(trimmed);

    // выключить режим промпта чтобы joinLink логировал сразу
    isPrompting = false;
    flushPending();

    await joinLink(trimmed);
  });
}

async function cmdManageKeywords() {
  await withPrompt(async () => {
    const db = getDb();
    const all = db.prepare('SELECT id, word, active FROM keywords ORDER BY word').all();

    if (all.length > 0) {
      console.log(chalk.bold('  Текущие ключевые слова:'));
      const { activeIds } = await inquirer.prompt([{
        type: 'checkbox',
        name: 'activeIds',
        message: 'Отмечены активные (Space = вкл/выкл, Enter = сохранить):',
        choices: all.map(k => ({
          name:    k.word,
          value:   k.id,
          checked: k.active === 1,
        })),
        pageSize: 15,
      }]);

      db.prepare('UPDATE keywords SET active = 0').run();
      for (const id of activeIds) {
        db.prepare('UPDATE keywords SET active = 1 WHERE id = ?').run(id);
      }
      log('success', `Активных слов: ${chalk.bold(activeIds.length)} из ${all.length}`);
    } else {
      console.log(chalk.dim('  Ключевых слов ещё нет.\n'));
    }

    const { newWords } = await inquirer.prompt([{
      type: 'input',
      name: 'newWords',
      message: 'Добавить новые слова через запятую' + chalk.dim(' (или Enter, чтобы пропустить)') + ':',
    }]);

    if (newWords.trim()) {
      const words = newWords.split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
      for (const w of words) {
        addKeyword(w);
        log('success', `Добавлено: ${chalk.bold(w)}`);
      }
    }
  });
}

function cmdStats() {
  const db = getDb();
  const links  = db.prepare('SELECT status, COUNT(*) as c FROM invite_links GROUP BY status').all();
  const msgs   = db.prepare('SELECT COUNT(*) as c FROM messages').get();
  const kwsAct = db.prepare('SELECT COUNT(*) as c FROM keywords WHERE active = 1').get();
  const kwsAll = db.prepare('SELECT COUNT(*) as c FROM keywords').get();

  console.log(chalk.bold('\n  СТАТИСТИКА:'));
  if (!links.length) console.log(chalk.dim('    Ссылок нет.'));
  for (const l of links) {
    const dot = l.status === 'joined' ? chalk.green('●') : l.status === 'failed' ? chalk.red('●') : chalk.yellow('●');
    console.log(`    ${dot}  ${l.status.padEnd(12)} ${chalk.bold(l.c)}`);
  }
  console.log(`    ${chalk.blue('●')}  ${'ключ. слов'.padEnd(12)} ${chalk.bold(kwsAct.c)} / ${kwsAll.c} всего`);
  console.log(`    ${chalk.magenta('●')}  ${'совпадений'.padEnd(12)} ${chalk.bold(msgs.c)}`);
  console.log('');
}

// ─── Join logic ───────────────────────────────────────────────────────────────

export async function joinLink(link) {
  const db  = getDb();
  const row = db.prepare('SELECT id FROM invite_links WHERE link = ?').get(link);
  const m   = link.match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/);

  if (!m) {
    log('error', `Нет кода приглашения в ссылке: ${chalk.dim(link)}`);
    if (row) updateLinkStatus(row.id, 'invalid', { error: 'Нет кода' });
    return;
  }

  const code = m[1];
  log('stage', `Ссылка: ${chalk.dim(link)}`);
  log('stage', `Код приглашения: ${chalk.bold(code)}`);

  if (!waSocket) {
    log('error', 'WhatsApp не подключён, попробуй позже');
    return;
  }

  log('stage', 'Отправляю запрос на вступление...');

  try {
    const jid = await waSocket.groupAcceptInvite(code);
    log('stage', `JID получен: ${chalk.dim(jid)}`);
    log('stage', 'Получаю данные группы...');

    await new Promise(r => setTimeout(r, 2000));
    const meta  = await waSocket.groupMetadata(jid).catch(() => null);
    const name  = meta?.subject ?? jid;
    const count = meta?.participants?.length ?? '?';

    if (row) updateLinkStatus(row.id, 'joined', { jid, name });
    log('success',
      `${chalk.green.bold('ВСТУПИЛ')}  "${chalk.bold(name)}"  участников: ${chalk.bold(count)}  ${chalk.dim(jid)}`
    );
  } catch (e) {
    const statusCode = e?.output?.statusCode ?? e?.data?.code ?? '';
    const reason     = resolveWaError(e, statusCode);
    const tag        = statusCode ? chalk.bold(`[${statusCode}]`) : '';
    const errStr     = [statusCode && `[${statusCode}]`, reason].filter(Boolean).join(' ');

    if (row) updateLinkStatus(row.id, 'failed', { error: errStr });
    log('error', `${chalk.red.bold('ОШИБКА')} ${tag}  ${reason}`);
    if (e.message && e.message !== reason) {
      log('error', `Детали: ${chalk.dim(e.message)}`);
    }
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
