import { addInviteLink, addKeyword, getDb } from './db.js';

const [,, command, ...args] = process.argv;

function printHelp() {
  console.log(`
Управление ссылками и ключевыми словами:

  node src/manage-links.js add-link <https://chat.whatsapp.com/XXX>
  node src/manage-links.js add-link <https://chat.whatsapp.com/XXX> <https://...> ...

  node src/manage-links.js add-keyword <слово>
  node src/manage-links.js add-keyword <слово1> <слово2> ...

  node src/manage-links.js list-links
  node src/manage-links.js list-keywords
  node src/manage-links.js stats
  node src/manage-links.js matches
  `);
}

switch (command) {
  case 'add-link':
    if (!args.length) { console.log('Укажи хотя бы одну ссылку'); break; }
    for (const link of args) {
      const r = addInviteLink(link.trim());
      console.log(r.success ? `[+] Добавлено: ${link}` : `[-] Ошибка (${link}): ${r.error}`);
    }
    break;

  case 'add-keyword':
    if (!args.length) { console.log('Укажи хотя бы одно слово'); break; }
    for (const word of args) {
      addKeyword(word.trim());
      console.log(`[+] Ключевое слово добавлено: ${word}`);
    }
    break;

  case 'list-links':
    getDb().prepare('SELECT id, link, status, group_name, error FROM invite_links').all()
      .forEach(r => console.log(`[${r.id}] ${r.status.padEnd(8)} | ${(r.group_name || r.link).substring(0, 60)} ${r.error ? '| ERR: ' + r.error : ''}`));
    break;

  case 'list-keywords':
    getDb().prepare('SELECT word FROM keywords WHERE active = 1').all()
      .forEach(r => console.log(`  - ${r.word}`));
    break;

  case 'stats':
    const stats = getDb().prepare('SELECT status, COUNT(*) as c FROM invite_links GROUP BY status').all();
    const msgs = getDb().prepare('SELECT COUNT(*) as c FROM messages').get();
    console.log('Ссылки по статусу:');
    stats.forEach(s => console.log(`  ${s.status}: ${s.c}`));
    console.log(`Сообщений с совпадениями: ${msgs.c}`);
    break;

  case 'matches':
    const rows = getDb().prepare(
      'SELECT group_name, sender, message, matched_keywords, received_at FROM messages ORDER BY received_at DESC LIMIT 50'
    ).all();
    if (!rows.length) { console.log('Совпадений пока нет'); break; }
    rows.forEach(r => {
      console.log(`\n[${r.received_at}] Группа: ${r.group_name}`);
      console.log(`  От: ${r.sender}`);
      console.log(`  Ключевые слова: ${r.matched_keywords}`);
      console.log(`  Сообщение: ${r.message}`);
    });
    break;

  default:
    printHelp();
}
