# Evaluation

How well askdocs finds the section that answers a question, how honestly it says when nothing does, and how it scales. For contributors changing ranking, parsing or thresholds: a change that moves these numbers should say so in its commit.

## Retrieval

`pnpm eval` indexes three public doc sets, each pinned to a commit ([corpora.json](corpora.json)), and asks 255 questions written the way a developer would ask them ([questions/](questions)). Each answerable question names the section that answers it. 46 have no answer in the docs at all.

| Docs                                    | Docs | Questions |
| --------------------------------------- | ---: | --------: |
| Astro (`withastro/docs`, MDX)           |  422 |        82 |
| Docusaurus (`website/docs`, MDX + tabs) |   94 |        93 |
| Prettier (`docs/`, plain Markdown)      |   24 |        80 |

### Metrics

- **recall@k:** the answering section, or one nested inside it, is among the top k results.
- **MRR:** mean reciprocal rank of the first answering section (0 when it isn't in the top 10).
- **No-answer caught:** of the questions the docs don't answer, the share flagged as weak matches.
- **False no-answer:** of the questions the docs do answer, the share wrongly flagged as weak.

### Keyword search (the default)

| Docs       |  recall@1 |  recall@3 |       MRR | No-answer caught | False no-answer |
| ---------- | --------: | --------: | --------: | ---------------: | --------------: |
| Astro      |     61.2% |     83.6% |     0.724 |            73.3% |           20.9% |
| Docusaurus |     63.6% |     84.4% |     0.751 |            75.0% |           22.1% |
| Prettier   |     60.0% |     69.2% |     0.669 |            80.0% |           29.2% |
| **All**    | **61.7%** | **79.4%** | **0.717** |        **76.1%** |       **23.9%** |

Measured 2026-09-29 at commit `95c3414`. The misses are mostly paraphrases ("caret" for "cursor", "keeps changing my quotes" for the `singleQuote` option), which keyword search can't bridge. `pnpm eval --misses` lists them.

### Semantic search

`pnpm eval --embed=ollama:embeddinggemma` also scores vector-only and hybrid retrieval (keyword and vector rankings fused by reciprocal rank), on the same questions.

| Public (255 questions) | recall@1 | recall@3 |   MRR | No-answer caught | False no-answer |
| ---------------------- | -------: | -------: | ----: | ---------------: | --------------: |
| Keyword                |    61.7% |    79.4% | 0.717 |            76.1% |           23.9% |
| Vector                 |    71.8% |    87.6% | 0.809 |            87.0% |           29.2% |
| Hybrid                 |    72.2% |    89.0% | 0.809 |            82.6% |           22.5% |

## How the thresholds were chosen

- **Ranking.** Sections matching any word of the question are ranked by `bm25`, with titles and heading paths weighted above body text. Ranking by term coverage first looked right on hand-made examples and scored 8 points lower on recall@3.
- **Several libraries.** Each library has its own index and statistics, so their raw scores don't compare. With more than one library, candidates are re-scored with statistics shared across everything the caller can see. A single library ranks as before.
- **"Answered" by keywords: 45%.** A search counts as answered when one of the top three sections contains at least 45% of the question, each word weighted by how rare it is. `pnpm eval --sweep` prints the trade-off at other thresholds; 0.45 maximises no-answers caught minus answerable questions wrongly flagged.
- **"Answered" by meaning: a gap, measured per model.** With an embedder, a search also counts as answered when one of the top three hits is a match by meaning whose similarity stands above the 10th-best match by at least a gap measured for that model: 0.16 for embeddinggemma, 0.13 for nomic-embed-text. Each is the smallest gap that improved the results, by the same measure. A gap beats a fixed similarity cutoff because similarity levels differ more between doc sets (the median for answerable questions ranges from 0.55 to 0.63) than between answerable and unanswerable questions within one. Models without a measured gap use the keyword rule alone.

## Running it

```bash
pnpm eval                       # run, and compare with baseline.json
pnpm eval --update              # run, and write baseline.json
pnpm eval --sweep               # the no-answer trade-off across thresholds
pnpm eval --misses              # every miss, for debugging ranking
pnpm eval --only=<id>           # one corpus
pnpm eval --embed=<spec>        # also vector and hybrid, e.g. ollama:embeddinggemma
pnpm eval --corpora=<file>      # corpora kept elsewhere
```

`--corpora` takes a JSON file like [corpora.json](corpora.json), for docs that must not live in this repository. Questions are read from `questions/<id>.json` and the baseline from `baseline.json`, both next to that file. A corpus may list local libraries, which are indexed and searched together, and an answer may then name its library:

```json
[{ "id": "acme", "libraries": [{ "id": "payments", "path": "../payments", "include": "docs/**/*.md" }] }]
```

```json
[
  {
    "q": "why can't we run two processors?",
    "answers": [{ "library": "payments", "path": "docs/processor.md", "heading": "Why one instance" }]
  }
]
```

`heading` is the exact heading text; `"(intro)"` means the text before the first heading, and leaving it out accepts the whole document.

## The baseline in CI

CI runs `pnpm eval` and fails if any metric in [baseline.json](baseline.json) gets worse by more than 2 points. Only keyword rows are gated: `--embed` needs an Ollama server, which CI doesn't have. A change that is meant to move the numbers updates the baseline with `pnpm eval --update` in the same commit.

## Scale

`pnpm bench:scale` measures how zero-config startup, memory and search latency grow with the number of docs (on an M-series Mac, each doc about 1.5KB across five sections):

|   Docs | Sections | Startup (read + index) | Memory | Search p50 | Search p95 | Index on disk |
| -----: | -------: | ---------------------: | -----: | ---------: | ---------: | ------------: |
|    100 |      600 |                 0.06 s |  87 MB |     0.9 ms |     1.4 ms |        0.7 MB |
|  1,000 |    6,000 |                 0.25 s | 116 MB |     4.6 ms |     5.5 ms |        6.7 MB |
| 10,000 |   60,000 |                  2.4 s | 175 MB |      39 ms |      53 ms |         80 MB |

Search times are for queries built from the corpus's most common words, which is close to the worst case.
