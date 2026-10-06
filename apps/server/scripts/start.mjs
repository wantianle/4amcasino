// Boot the prebuilt bundle when it exists (production - node starts in well
// under a second, which is most of what keeps the deploy gap short), else
// compile on the fly with tsx (fresh checkouts, `npm start` without a build).
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load the repo-root .env so local secrets (e.g. BOT_IDENTITY_KEY) survive a
// restart instead of depending on whatever the launching shell happened to
// export. Values already present in the environment take precedence.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const envFile = resolve(repoRoot, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const built = new URL('../dist/index.js', import.meta.url);
if (existsSync(built)) {
  await import(built.href);
} else {
  const { register } = await import('tsx/esm/api');
  register();
  await import('../src/index.ts');
}
