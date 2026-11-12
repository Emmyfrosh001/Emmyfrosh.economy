// node setup.js [adminUsername]
// Creates .env with random secrets and prints them once.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const file = path.join(__dirname, '.env');
if (fs.existsSync(file)) {
  console.log('.env already exists — not touching it. Delete it first if you want new secrets.');
  process.exit(0);
}
const user = (process.argv[2] || 'admin').replace(/[^A-Za-z0-9_.-]/g, '') || 'admin';
const key  = crypto.randomBytes(24).toString('hex');
const pass = crypto.randomBytes(9).toString('base64url');

const env = fs.readFileSync(path.join(__dirname, '.env.example'), 'utf8')
  .replace('put-a-long-random-secret-here', key)
  .replace('ADMIN_USER=admin', 'ADMIN_USER=' + user)
  .replace('change-me-please', pass);
fs.writeFileSync(file, env, { mode: 0o600 });

console.log('\n✅ .env created\n');
console.log('   Admin login   : ' + user + ' / ' + pass);
console.log('   COUPON_API_KEY: ' + key);
console.log('\nPut the SAME COUPON_API_KEY in your bot .env, plus COUPON_API_URL=<your site address>.');
console.log('Save the admin password somewhere safe — it is not shown again.\n');
