// Prints the CHANGELOG.md section for a version (used as the GitHub release body).
// Usage: node scripts/release-notes.mjs <version> [image]
import fs from 'node:fs';

const [version, image] = process.argv.slice(2);
if (!version) {
  console.error('usage: release-notes.mjs <version> [image]');
  process.exit(1);
}

const lines = fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').split(/\r?\n/);
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
let body = '';
if (start >= 0) {
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## ['));
  body = lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}
if (!body) body = `Release ${version}`;
if (image) body += `\n\n**Docker image:** \`${image}:${version}\``;
process.stdout.write(body + '\n');
