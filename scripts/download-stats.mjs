// How many times each installer was downloaded from GitHub Releases (public numbers, no account needed):
//   npm run stats
const REPO = 'rafa794/orion';
const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, { headers: { Accept: 'application/vnd.github+json' } });
if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
const releases = await res.json();
const NAMES = [
  [/mac/i, 'Mac'],
  [/\.exe$/i, 'Windows'],
  [/linux/i, 'Linux'],
  [/\.apk$/i, 'Android'],
];
const bySystem = {};
let total = 0;
for (const r of releases) {
  const rows = r.assets.filter((a) => !/\.(blockmap|yml)$/i.test(a.name));
  const sum = rows.reduce((n, a) => n + a.download_count, 0);
  total += sum;
  console.log(`\n${r.tag_name}${r.draft ? ' (draft)' : ''} — ${sum} downloads`);
  for (const a of rows.sort((x, y) => y.download_count - x.download_count)) {
    console.log(`  ${String(a.download_count).padStart(6)}  ${a.name}`);
    const sys = NAMES.find(([re]) => re.test(a.name))?.[1] ?? 'Other';
    bySystem[sys] = (bySystem[sys] ?? 0) + a.download_count;
  }
}
console.log(`\nBy system: ${Object.entries(bySystem).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
console.log(`Total: ${total} downloads`);
