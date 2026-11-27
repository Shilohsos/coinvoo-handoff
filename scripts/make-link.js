// CLI: node scripts/make-link.js <brand> <campaign> [adset] [ad] [creative]
// e.g.  node scripts/make-link.js brand-one NG_Broad 18-34 vid_03
// Needs the same environment as the service (DB_PATH, PUBLIC_BASE, ...).
import { loadConfig } from '../src/config.js';
import { openDb, migrate } from '../src/db.js';
import { mintLink, linkUrls } from '../src/routes/links.js';

const [brand, campaign, adset, ad, creative] = process.argv.slice(2);
if (!brand) {
  console.error('usage: node scripts/make-link.js <brand> <campaign> [adset] [ad] [creative]');
  process.exit(2);
}

let config;
try {
  config = loadConfig(process.env);
} catch (e) {
  console.error(`[coinvoo] FATAL config: ${e.message}`);
  process.exit(1);
}

const db = openDb(config.dbPath);
migrate(db, { env: config.brandSeed });
const minted = mintLink(db, { brand, campaign: campaign || null, adset: adset || null, ad: ad || null, creative: creative || null });
if (!minted) {
  console.error(`unknown or inactive brand: ${brand}`);
  process.exit(1);
}
const urls = linkUrls(config, minted.brand, minted.token);
console.log(`token=${minted.token}`);
console.log(`url=${urls.url}`);
console.log(`telegram_url=${urls.telegram_url}`);
db.close();
