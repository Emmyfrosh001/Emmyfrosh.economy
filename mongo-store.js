'use strict';
// ────────────────────────────────────────────────────────────────────
// MongoDB backup for the data folder.
//
// Render wipes the server's disk on every restart / redeploy, so bans, site
// accounts, coupons, chats, bets and transfers disappeared with it. This module
// copies every *.json file in DATA_DIR (db.json, aviator.json, football.json,
// slots.json) into MongoDB and puts them back before the server starts.
//
//   boot  : restore()   Mongo -> DATA_DIR   (before server.js reads anything)
//   run   : startSync() DATA_DIR -> Mongo   (every 2 s, only files that changed)
//   exit  : flushAll()  last copy while Render shuts the old instance down
//
// Files are gzipped and cut into 8 MB pieces (Mongo's limit is 16 MB a document).
// A new version is written first and the old pieces are removed after, so a
// crash in the middle never leaves you with half a file.
// ────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const CHUNK = 8 * 1024 * 1024;
const COLLECTION = process.env.MONGO_COLLECTION || 'site_files';
const sha = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function create(dir, opts = {}) {
  const log = opts.log || console;
  let client = null, col = null, Binary = null;
  const lastHash = {};          // name -> hash of what Mongo holds
  const lastStat = {};          // name -> "mtime:size" last looked at
  let syncing = false, timer = null, lastErrAt = 0;

  async function connect() {
    if (opts.collection) { col = opts.collection; Binary = opts.Binary || function (b) { return b; }; return; }   // tests
    const { MongoClient, Binary: B } = require('mongodb');
    Binary = B;
    client = new MongoClient(String(process.env.MONGO_URL).trim(), { serverSelectionTimeoutMS: 15000 });
    await client.connect();
    const dbName = process.env.MONGO_DB || (client.options && client.options.dbName && client.options.dbName !== 'test' ? client.options.dbName : 'emmyfrosh');
    col = client.db(dbName).collection(COLLECTION);
    log.log('🗄️  MongoDB connected · database "' + dbName + '" · collection "' + COLLECTION + '"');
  }

  const jsonFiles = () => fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.endsWith('.tmp'));
  const toBuf = (d) => Buffer.isBuffer(d) ? d : (d && d.buffer ? Buffer.from(d.buffer) : Buffer.from(d));

  async function pushFile(name) {
    const file = path.join(dir, name);
    let raw;
    try { raw = fs.readFileSync(file); } catch { return false; }
    if (!raw.length) return false;
    const hash = sha(raw);
    if (lastHash[name] === hash) return false;
    const gz = zlib.gzipSync(raw, { level: 6 });
    const ver = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    const n = Math.max(1, Math.ceil(gz.length / CHUNK));
    const docs = [];
    for (let i = 0; i < n; i++) docs.push({ _id: 'chunk:' + name + ':' + ver + ':' + i, kind: 'chunk', name, ver, i, data: new Binary(gz.subarray(i * CHUNK, (i + 1) * CHUNK)) });
    await col.insertMany(docs);
    await col.updateOne({ _id: 'meta:' + name }, { $set: { kind: 'meta', name, ver, n, hash, size: raw.length, at: Date.now() } }, { upsert: true });
    await col.deleteMany({ kind: 'chunk', name, ver: { $ne: ver } });
    lastHash[name] = hash;
    return true;
  }

  async function pullFile(meta) {
    const docs = await col.find({ kind: 'chunk', name: meta.name, ver: meta.ver }).toArray();
    docs.sort((a, b) => a.i - b.i);
    if (docs.length !== meta.n) throw new Error(meta.name + ': ' + docs.length + ' of ' + meta.n + ' pieces found in MongoDB');
    const raw = zlib.gunzipSync(Buffer.concat(docs.map(d => toBuf(d.data))));
    if (sha(raw) !== meta.hash) throw new Error(meta.name + ': checksum mismatch');
    const file = path.join(dir, meta.name), tmp = file + '.tmp';
    fs.writeFileSync(tmp, raw);
    fs.renameSync(tmp, file);
    lastHash[meta.name] = meta.hash;
    return raw.length;
  }

  // Mongo -> disk. Throws on any problem so the caller can retry / refuse to start with empty data.
  async function restore() {
    await connect();
    fs.mkdirSync(dir, { recursive: true });
    const metas = await col.find({ kind: 'meta' }).toArray();
    const have = new Set(metas.map(m => m.name));
    for (const m of metas) {
      if (!/^[A-Za-z0-9_.-]+\.json$/.test(m.name)) continue;
      const file = path.join(dir, m.name);
      let localNewer = false;
      try { localNewer = fs.statSync(file).mtimeMs > m.at + 2000; } catch {}
      if (localNewer) { log.log('🗄️  ' + m.name + ': the disk copy is newer than MongoDB, keeping the disk copy'); continue; }
      const size = await pullFile(m);
      log.log('🗄️  restored ' + m.name + ' from MongoDB (' + Math.round(size / 1024) + ' KB)');
    }
    // first run (or a file MongoDB has never seen): upload what is on disk
    for (const f of jsonFiles()) if (!have.has(f)) { try { if (await pushFile(f)) log.log('🗄️  uploaded ' + f + ' to MongoDB'); } catch (e) { log.error('🗄️  upload failed:', e.message); } }
    if (!metas.length && !jsonFiles().length) log.log('🗄️  MongoDB is empty: starting fresh');
  }

  async function syncOnce(force) {
    if (syncing || !col) return;
    syncing = true;
    try {
      for (const f of jsonFiles()) {
        let st; try { st = fs.statSync(path.join(dir, f)); } catch { continue; }
        const key = st.mtimeMs + ':' + st.size;
        if (!force && lastStat[f] === key) continue;
        try { await pushFile(f); lastStat[f] = key; }
        catch (e) { if (Date.now() - lastErrAt > 60000) { lastErrAt = Date.now(); log.error('🗄️  MongoDB save failed (will retry):', e.message); } }
      }
    } finally { syncing = false; }
  }
  function startSync(ms) { timer = setInterval(() => syncOnce(false), ms || 2000); }
  async function flushAll() {
    for (let i = 0; i < 40 && syncing; i++) await sleep(100);   // let a running copy finish
    await syncOnce(false);
  }
  async function close() { clearInterval(timer); try { if (client) await client.close(); } catch {} }

  return { restore, startSync, flushAll, syncOnce, close, pushFile };
}

module.exports = { create };
