// Retrieval eval: public corpora pinned to a commit, questions with known answering sections,
// and questions with no answer at all. `pnpm eval` fails on a regression beyond TOLERANCE.
//
//   pnpm eval                 run, compare with eval/baseline.json
//   pnpm eval --update        run and write the baseline
//   pnpm eval --sweep         print the no-answer trade-off for a range of coverage thresholds
//   pnpm eval --misses        also print every miss, for debugging ranking
//   pnpm eval --only=<id>     one corpus
//   pnpm eval --embed=<spec>  also score vector-only and hybrid (keyword + vector) retrieval, e.g.
//                             --embed=ollama:embeddinggemma. Keyword rows still gate the baseline.
//   pnpm eval --corpora=<file>
//                             corpora from elsewhere, e.g. private docs that must not live here.
//                             Questions are read from questions/<id>.json and the baseline from
//                             baseline.json, both next to that file. A corpus may list local
//                             `libraries` ({ id, path, include }), indexed together and searched
//                             together, and an answer may then name its `library`.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  embedderFrom,
  embedLibrary,
  indexLibrary,
  listLibraries,
  loadSource,
  openStore,
  search,
  searchSemantic,
} from '../dist/index.js';
import { z } from 'zod';
import { corpora as publicCorpora, fetchCorpus } from './fetch.mjs';

const TOLERANCE = 0.02;

const K = 10;

const args = new Set(process.argv.slice(2));

const here = import.meta.dirname;

const corporaFile = process.argv.find((a) => a.startsWith('--corpora='))?.slice('--corpora='.length);

const home = corporaFile ? dirname(resolve(corporaFile)) : here;

const corpora = corporaFile ? JSON.parse(readFileSync(corporaFile, 'utf8')) : publicCorpora;

const norm = (h) =>
  h
    .replace(/\s*\{(?:#[\w-]+|\/\*\s*#[\w-]+\s*\*\/)\}\s*$/, '')
    .trim()
    .toLowerCase();

/** A hit answers when it is in an accepted section: the same heading, or nested under it. */
function answers(hit, a) {
  if (hit.path !== a.path || (a.library && hit.library !== a.library)) return false;

  if (a.heading === '(intro)') return hit.line === 0;

  if (!a.heading) return true;

  return hit.breadcrumb.split(' > ').some((part) => norm(part) === norm(a.heading));
}

async function load(corpus) {
  const db = openStore();

  const sources = corpus.libraries
    ? corpus.libraries.map((l) => ({ dir: resolve(home, l.path), name: l.id, include: l.include }))
    : [{ dir: fetchCorpus(corpus), name: corpus.id }];

  const counts = { files: 0, sections: 0 };

  for (const { dir, name, include } of sources) {
    const { library, files } = await loadSource(dir, { name, include });
    const indexed = indexLibrary(db, library, files);
    counts.files += indexed.files;
    counts.sections += indexed.sections;
  }

  const questions = JSON.parse(readFileSync(join(home, 'questions', `${corpus.id}.json`), 'utf8'));

  return { corpus, db, questions, counts };
}

function score({ db, questions, modes }, minCoverage, mode) {
  const m = { answerable: 0, noAnswer: 0, r1: 0, r3: 0, rr: 0, abstainRight: 0, abstainWrong: 0, misses: [] };

  for (const { q, answers: accepted } of questions) {
    // Searched once per mode up front; `answered` is re-judged here, so --sweep can vary the threshold.
    const { hits, answered } = mode
      ? {
          hits: modes[mode].get(q).hits,
          // The search's own verdict (which can also count a clear semantic match); --sweep
          // re-judges keyword coverage alone at each threshold.
          answered:
            minCoverage === undefined
              ? modes[mode].get(q).answered
              : modes[mode]
                  .get(q)
                  .hits.slice(0, 3)
                  .some((h) => h.coverage >= minCoverage),
        }
      : search(db, { text: q, limit: K, minCoverage }, 'all');

    if (!accepted.length) {
      m.noAnswer++;

      if (!answered) m.abstainRight++;
      else
        m.misses.push({
          q,
          kind: 'answered a no-answer question',
          top: hits[0] && `${corporaFile ? `${hits[0].library}: ` : ''}${hits[0].path} # ${hits[0].heading}`,
        });
      continue;
    }

    m.answerable++;

    if (!answered) m.abstainWrong++;
    const rank = hits.findIndex((h) => accepted.some((a) => answers(h, a))) + 1;

    if (rank === 1) m.r1++;

    if (rank >= 1 && rank <= 3) m.r3++;

    if (rank >= 1) m.rr += 1 / rank;

    if (rank !== 1) {
      m.misses.push({
        q,
        kind: rank ? `rank ${rank}` : `not in top ${K}`,
        want: accepted.map((a) => `${a.library ? `${a.library}: ` : ''}${a.path} # ${a.heading}`).join(' | '),
        top: hits[0] && `${corporaFile ? `${hits[0].library}: ` : ''}${hits[0].path} # ${hits[0].heading}`,
      });
    }
  }

  return m;
}

const metrics = (m) => ({
  questions: m.answerable + m.noAnswer,
  'recall@1': m.r1 / m.answerable,
  'recall@3': m.r3 / m.answerable,
  MRR: m.rr / m.answerable,
  'no-answer correct': m.abstainRight / m.noAnswer,
  'false no-answer': m.abstainWrong / m.answerable,
});

function sum(ms) {
  const total = { answerable: 0, noAnswer: 0, r1: 0, r3: 0, rr: 0, abstainRight: 0, abstainWrong: 0 };

  for (const m of ms) for (const k of Object.keys(total)) total[k] += m[k];

  return total;
}

const loaded = [];

const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length);

for (const c of corpora) if (!only || c.id === only) loaded.push(await load(c));

const embedSpec = process.argv.find((a) => a.startsWith('--embed='))?.slice('--embed='.length);

const MODES = embedSpec ? ['vector', 'hybrid'] : [];

if (embedSpec) {
  const embedder = await embedderFrom(embedSpec);

  for (const l of loaded) {
    const started = performance.now();

    for (const lib of listLibraries(l.db, 'all')) await embedLibrary(l.db, lib.id, embedder);
    console.error(
      `${l.corpus.id}: embedded with ${embedSpec} in ${((performance.now() - started) / 1000).toFixed(1)}s`,
    );
    l.modes = {};

    for (const mode of MODES) {
      l.modes[mode] = new Map();

      for (const { q } of l.questions)
        l.modes[mode].set(q, await searchSemantic(l.db, { text: q, limit: K }, 'all', embedder, mode));
    }
  }
}

if (args.has('--sweep')) {
  for (const mode of [undefined, ...MODES]) {
    console.log(`\n${mode ?? 'keyword'}\nthreshold  recall@1  recall@3  no-answer correct  false no-answer`);

    for (let t = 0.3; t <= 0.951; t += 0.05) {
      const r = metrics(sum(loaded.map((l) => score(l, t, mode))));
      console.log(
        `${t.toFixed(2).padStart(9)}  ${pct(r['recall@1'])}  ${pct(r['recall@3'])}  ${pct(r['no-answer correct']).padStart(17)}  ${pct(r['false no-answer']).padStart(15)}`,
      );
    }
  }

  process.exit(0);
}

const results = {};

const all = [];

for (const l of loaded) {
  const m = score(l);
  all.push(m);
  results[l.corpus.id] = { ...metrics(m), docs: l.counts.files, sections: l.counts.sections };

  if (args.has('--misses')) {
    console.log(`\n${l.corpus.id} misses:`);

    for (const x of m.misses)
      console.log(`  [${x.kind}] ${x.q}\n      want ${x.want ?? '-'}\n      got  ${x.top ?? '-'}`);
  }
}

results.overall = metrics(sum(all));

for (const mode of MODES) {
  const each = loaded.map((l) => score(l, undefined, mode));

  loaded.forEach((l, i) => {
    results[`${l.corpus.id} ${mode}`] = {
      ...metrics(each[i]),
      docs: l.counts.files,
      sections: l.counts.sections,
    };
  });
  results[`overall ${mode}`] = metrics(sum(each));
}

function pct(x) {
  return `${(x * 100).toFixed(1)}%`.padStart(8);
}

console.log(
  `\n${'corpus'.padEnd(18)} docs  questions  recall@1  recall@3      MRR  no-answer ok  false no-answer`,
);

for (const [id, r] of Object.entries(results)) {
  console.log(
    `${id.padEnd(18)} ${String(r.docs ?? '').padStart(4)}  ${String(r.questions).padStart(9)}  ${pct(r['recall@1'])}  ${pct(r['recall@3'])}  ${r.MRR.toFixed(3).padStart(7)}  ${pct(r['no-answer correct']).padStart(12)}  ${pct(r['false no-answer']).padStart(15)}`,
  );
}

// A checkout with no commits yet records itself as such in the baseline.
const commit = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: here,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  } catch {
    return 'uncommitted';
  }
})();

const baselineFile = join(home, 'baseline.json');

if (args.has('--update')) {
  writeFileSync(
    baselineFile,
    JSON.stringify({ date: new Date().toISOString().slice(0, 10), commit, results }, null, 2) + '\n',
  );
  console.log(`\nWrote ${baselineFile}`);
  process.exit(0);
}

// Higher is better for every metric except "false no-answer".
// Every metric is a number, per corpus; a baseline of another shape is a broken file, not a pass.
const Baseline = z.object({
  date: z.string(),
  commit: z.string(),
  results: z.record(z.string(), z.record(z.string(), z.number())),
});

const baseline = Baseline.parse(JSON.parse(readFileSync(baselineFile, 'utf8')));

const regressions = [];

for (const [id, r] of Object.entries(results)) {
  for (const [metric, value] of Object.entries(r)) {
    const before = baseline.results[id]?.[metric];

    if (before === undefined || ['questions', 'docs', 'sections'].includes(metric)) continue;
    const worse = metric === 'false no-answer' ? value - before : before - value;

    if (worse > TOLERANCE) regressions.push(`${id} ${metric}: ${before.toFixed(3)} -> ${value.toFixed(3)}`);
  }
}

if (regressions.length) {
  console.error(
    `\nRegressed beyond ${TOLERANCE} against the baseline (${baseline.date}, ${baseline.commit}):\n  ${regressions.join('\n  ')}`,
  );
  process.exit(1);
}

console.log(
  `\nNo regression beyond ${TOLERANCE} against the baseline (${baseline.date}, ${baseline.commit}).`,
);
