'use strict';
// Start here (npm start). Restores the data from MongoDB, then starts server.js.
const fs = require('fs');
const path = require('path');

// same tiny .env reader as server.js, so MONGO_URL / DATA_DIR work locally too
try {
  const t = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of t.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  if (!String(process.env.MONGO_URL || '').trim()) {
    console.warn('⚠️  MONGO_URL is not set: bans, bets and accounts are only kept on this server\'s disk and are lost on a Render restart.');
    require('./server');
    return;
  }
  const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const store = require('./mongo-store').create(DATA_DIR);

  // Never start with an empty database while a good copy may be sitting in MongoDB:
  // the empty one would be saved over it. Retry, and if MongoDB stays unreachable stop (Render restarts us).
  let ok = false;
  for (let i = 1; i <= 6 && !ok; i++) {
    try { await store.restore(); ok = true; }
    catch (e) {
      console.error('🗄️  could not load from MongoDB (try ' + i + '/6): ' + String(e.message).replace(/\/\/[^@\s]*@/g, '//***@'));
      if (i < 6) await sleep(4000 * i);
    }
  }
  if (!ok) {
    console.error('🗄️  MongoDB is not reachable, so the site will NOT start (it would overwrite your saved data with an empty copy). Check MONGO_URL and the Atlas "Network Access" list (allow 0.0.0.0/0).');
    process.exit(1);
  }

  require('./server');
  store.startSync(2000);

  // the games call process.exit() inside their SIGTERM handlers; give MongoDB one last copy first
  const realExit = process.exit.bind(process);
  let leaving = false;
  process.exit = (code) => {
    if (leaving) return;
    leaving = true;
    (async () => {
      await sleep(250);                                   // let every handler finish writing its file
      await Promise.race([store.flushAll(), sleep(8000)]);
    })().catch(() => {}).finally(() => realExit(code));
  };
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
})();
