// Copies each wisdom template into place when the real file is missing, so a fresh clone builds.
// The real files are gitignored; see wisdom/README.md.
import { access, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const wisdomDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'wisdom');
const names = ['scullion-principles', 'magness-principles'];

for (const name of names) {
  const target = join(wisdomDir, `${name}.md`);
  try {
    await access(target);
  } catch {
    await copyFile(join(wisdomDir, `${name}.example.md`), target);
    console.log(`wisdom: created ${name}.md from its template`);
  }
}
