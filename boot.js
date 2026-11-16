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

// Clean up the usual copy/paste mistakes in MONGO_URL and say what is wrong.
function cleanMongoUrl(raw) {
  let u = String(raw || '').trim();
  u = u.replace(/^MONGO_URL\s*=\s*/i, '').replace(/^mongosh\s+/i, '').trim();   // pasted "MONGO_URL=..." or the "mongosh ..." command
  u = u.replace(/^["'`]+|["'`]+$/g, '').trim();                                    // quotes around it
  const m = u.match(/mongodb(?:\+srv)?:\/\/\S+/i);                                    // anything else around it
  if (m) u = m[0].replace(/["'`]+$/g, '');
  return u;
}

(async () => {
  const given = String(process.env.MONGO_URL || '').trim();
  const url = cleanMongoUrl(given);
  let problem = '';
  if (!given) problem = 'MONGO_URL is not set.';
  else if (!/^mongodb(\+srv)?:\/\//i.test(url)) problem = 'MONGO_URL is not a MongoDB link. It must start with mongodb+srv:// (or mongodb://). What Render has starts with: "' + given.slice(0, 12).replace(/[^\x20-\x7e]/g, '?') + '…"';
  else if (/[<>]/.test(url)) problem = 'MONGO_URL still has <password> (or another <…> placeholder) in it. Replace it with your real database password, without the < > signs.';
  if (problem) {
    console.warn('⚠️  ' + problem);
    console.warn('⚠️  Starting WITHOUT MongoDB: bans, bets and accounts are only kept on this server\'s disk and are lost on a restart. Fix MONGO_URL in Render → Environment and redeploy.');
    require('./server');
    return;
  }
  process.env.MONGO_URL = url;
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
