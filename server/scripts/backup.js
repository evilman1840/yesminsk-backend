/**
 * Бэкап базы в папку: по файлу на коллекцию (Extended JSON, типы сохраняются).
 *   node scripts/backup.js "mongodb+srv://..."              → ~/yesminsk-backup-<дата>
 * Восстановить (перезапишет коллекции из бэкапа!):
 *   node scripts/backup.js --restore ~/yesminsk-backup-<дата> "mongodb+srv://..."
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { MongoClient } = require('mongodb');
const { EJSON } = require('bson');

async function backup(uri) {
  const client = await MongoClient.connect(uri, { retryReads: true, socketTimeoutMS: 120000 });
  const db = client.db();
  const dir = path.join(os.homedir(), `yesminsk-backup-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`База: ${db.databaseName}`);
  for (const { name } of await db.listCollections().toArray()) {
    // Порциями по 20 и с повтором: бесплатная база рвёт соединение на больших ответах
    const docs = [];
    let lastId = null;
    for (let tries = 0; ; ) {
      try {
        const batch = await db
          .collection(name)
          .find(lastId ? { _id: { $gt: lastId } } : {})
          .sort({ _id: 1 })
          .limit(20)
          .toArray();
        if (!batch.length) break;
        docs.push(...batch);
        lastId = batch[batch.length - 1]._id;
        tries = 0;
        if (docs.length % 100 < 20 && docs.length >= 100) process.stdout.write(`  ${name}: ${docs.length}…\r`);
      } catch (e) {
        if (++tries > 5) throw e;
        console.log(`  ${name}: обрыв, пробую ещё раз (${tries}/5)`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    fs.writeFileSync(path.join(dir, `${name}.json`), EJSON.stringify(docs, { relaxed: false }));
    console.log(`  ${name}: ${docs.length}      `);
  }
  await client.close();
  console.log(`\n✅ Готово: ${dir}`);
}

async function restore(dir, uri) {
  const client = await MongoClient.connect(uri);
  const db = client.db();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const name = file.slice(0, -5);
    const docs = EJSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'), { relaxed: false });
    await db.collection(name).deleteMany({});
    if (docs.length) await db.collection(name).insertMany(docs);
    console.log(`  ${name}: ${docs.length}`);
  }
  await client.close();
  console.log('\n✅ Восстановлено');
}

const args = process.argv.slice(2);
if (!(args[0] === '--restore' ? args[2] : args[0])) {
  console.log('Нужна строка подключения: node scripts/backup.js "mongodb+srv://..."');
  process.exit(1);
}
const run = args[0] === '--restore' ? restore(args[1], args[2]) : backup(args[0]);
run.catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
