// How zero-config startup, memory and search latency grow with the number of docs.
//   pnpm bench:scale            100, 1,000 and 10,000 docs
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SIZES = (process.argv[2] ?? '100,1000,10000').split(',').map(Number);

// Zipf-ish vocabulary, so term statistics look like real prose rather than uniform noise.
const VOCAB = Array.from({ length: 5000 }, (_, i) => `w${i.toString(36)}`);

let seed = 42;

const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;

const word = () => VOCAB[Math.floor(VOCAB.length * rand() ** 3)];

const para = (n) => Array.from({ length: n }, word).join(' ') + '.';

function corpus(n) {
  const dir = mkdtempSync(join(tmpdir(), `askdocs-scale-${n}-`));
  execFileSync('git', ['init', '-q'], { cwd: dir });

  for (let i = 0; i < n; i++) {
    const sub = join(dir, 'docs', `area-${i % 50}`);
    mkdirSync(sub, { recursive: true });

    const sections = Array.from(
      { length: 5 },
      (_, s) => `## Section ${s} ${word()}\n\n${para(40)} ${para(30)}\n`,
    );

    writeFileSync(
      join(sub, `doc-${i}.md`),
      `---\ndescription: ${para(8)}\n---\n# Doc ${i} ${word()}\n\n${para(20)}\n\n${sections.join('\n')}`,
    );
  }

  return dir;
}

const probe = `
  const { loadSource, indexLibrary, openStore, search } = await import(${JSON.stringify(join(import.meta.dirname, '../dist/index.js'))});
  const [dir, dbFile] = process.argv.slice(1);
  const t0 = performance.now();
  const { library, files } = await loadSource(dir, { name: 'bench' });
  const read = performance.now() - t0;
  const db = openStore(dbFile);
  const { sections } = indexLibrary(db, library, files);
  const startup = performance.now() - t0;
  const rss = process.memoryUsage().rss;
  const times = [];
  for (let i = 0; i < 60; i++) {
    const q = ['w1 w2 w3', 'w5 wa', 'section w9 w1a', '"w1 w2"', 'w' + i.toString(36) + ' w3'][i % 5];
    const s = performance.now(); search(db, { text: q }, 'all'); times.push(performance.now() - s);
  }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ files: files.length, sections, read, startup, rss, p50: times[30], p95: times[57] }));
`;

console.log('docs     sections  startup (read+index)  peak RSS   search p50   p95    index on disk');

for (const n of SIZES) {
  const dir = corpus(n);
  const dbFile = join(mkdtempSync(join(tmpdir(), 'askdocs-scale-db-')), 'docs.db');

  const r = JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', probe, dir, dbFile], {
      encoding: 'utf8',
      maxBuffer: 1e7,
    }),
  );

  const size = Number(execFileSync('du', ['-k', dbFile], { encoding: 'utf8' }).split('\t')[0]) / 1024;
  console.log(
    `${String(n).padEnd(8)} ${String(r.sections).padStart(8)}  ${`${(r.startup / 1000).toFixed(2)}s (${(r.read / 1000).toFixed(2)}s read)`.padEnd(20)}  ${`${Math.round(r.rss / 2 ** 20)} MB`.padStart(8)}   ${`${r.p50.toFixed(1)} ms`.padStart(9)}  ${`${r.p95.toFixed(1)} ms`.padStart(7)}   ${size.toFixed(1)} MB`,
  );
}
