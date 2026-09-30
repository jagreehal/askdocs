/**
 * One heading's worth of a document: the unit we index and rank.
 *
 * Searching whole files hands an agent 6,000 words to find one paragraph.
 * Markdown already says where the topics start, so we cut there.
 */
export type Section = {
  heading: string;
  /** Title plus every enclosing heading, so "Retries" under "Payments" matches "payments". */
  breadcrumb: string[];
  /** 0 for text before the first heading. */
  level: number;
  /**
   * The section's address: the 1-based line of its heading, or 0 for text before the
   * first heading. Unique within a file, so search and read_doc agree on which section.
   */
  line: number;
  /**
   * The section's searchable text: prose and code, with MDX import/export lines, JSX tags,
   * HTML comments and admonition markers removed. `read_doc` returns the source instead.
   */
  content: string;
  /** Languages of the fenced code blocks directly in this section, normalised (`ts` → `typescript`). */
  languages: string[];
};

export type CodeBlock = { language: string; code: string; line: number };

export type ParsedDoc = {
  title: string;
  frontmatter: Record<string, string>;
  sections: Section[];
};

const HEADING = /^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export function parseMarkdown(text: string, fallbackTitle: string): ParsedDoc {
  const lines = splitLines(text);
  const { frontmatter, bodyStart } = readFrontmatter(lines);
  const { headings, kinds } = scan(lines, bodyStart);
  const title = frontmatter.title ?? headings.find((h) => h.level === 1)?.text ?? fallbackTitle;

  const sections: Section[] = [];
  const stack: { level: number; text: string }[] = [];
  const bounds = [{ level: 0, text: title, index: bodyStart - 1, next: bodyStart }, ...headings];

  bounds.forEach((h, i) => {
    while (stack.length && stack.at(-1)!.level >= h.level) stack.pop();

    if (h.level > 0) stack.push(h);
    const end = bounds[i + 1]?.index ?? lines.length;
    const content = searchableText(lines, kinds, h.next, end);

    if (!content) return;
    const raw = lines.slice(h.next, end).join('\n');
    const trail = stack.flatMap((s) => (s.text === title ? [] : [s.text]));
    sections.push({
      heading: h.text,
      breadcrumb: [title, ...trail],
      level: h.level,
      line: h.level === 0 ? 0 : h.index + 1,
      content,
      languages: [...new Set(codeBlocks(raw).map((b) => b.language))].filter(Boolean),
    });
  });

  return { title, frontmatter, sections };
}

export type HeadingEntry = { level: number; text: string; line: number; path: string[] };

/** Every heading with its line and the chain of headings above it. */
export function listHeadings(text: string): HeadingEntry[] {
  const lines = splitLines(text);
  const stack: HeadingEntry[] = [];

  return scan(lines, readFrontmatter(lines).bodyStart).headings.map((h) => {
    while (stack.length && stack.at(-1)!.level >= h.level) stack.pop();

    const entry = {
      level: h.level,
      text: h.text,
      line: h.index + 1,
      path: [...stack.map((s) => s.text), h.text],
    };

    stack.push(entry);

    return entry;
  });
}

/**
 * The section at `line`: that heading and everything nested under it, or, for 0, the
 * text before the first heading. Undefined when no section starts there.
 */
export function sectionAt(text: string, line: number): string | undefined {
  const lines = splitLines(text);
  const { bodyStart } = readFrontmatter(lines);
  const { headings } = scan(lines, bodyStart);

  if (line === 0) {
    const preamble = lines
      .slice(bodyStart, headings[0]?.index ?? lines.length)
      .join('\n')
      .trim();

    return preamble || undefined;
  }

  const at = headings.findIndex((h) => h.index + 1 === line);
  const start = headings[at];

  if (!start) return undefined;
  const next = headings.slice(at + 1).find((h) => h.level <= start.level);

  return lines
    .slice(start.index, next?.index ?? lines.length)
    .join('\n')
    .trim();
}

/**
 * Headings matching `query`, which is a heading ("Errors") or the end of a heading path
 * ("Client B > Errors"). Case-insensitive. More than one match means the caller must choose.
 */
export function matchHeadings(text: string, query: string): HeadingEntry[] {
  const wanted = query
    .split('>')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);

  return listHeadings(text).filter((h) => {
    const tail = h.path.slice(-wanted.length).map((p) => p.toLowerCase());

    return tail.length === wanted.length && tail.every((p, i) => p === wanted[i]);
  });
}

/**
 * Every fenced code block, optionally only one language. `line` is 1-based within `text`.
 * Nested/longer fences close only on a matching fence, as CommonMark says.
 */
export function codeBlocks(text: string, language?: string): CodeBlock[] {
  const lines = splitLines(text);
  const wanted = language ? normaliseLanguage(language) : undefined;
  const out: CodeBlock[] = [];
  let open: { fence: string; language: string; start: number } | undefined;
  lines.forEach((line, i) => {
    const m = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);

    if (!open) {
      if (m) open = { fence: m[1]!, language: normaliseLanguage(m[2] ?? ''), start: i };

      return;
    }

    if (m && m[1]![0] === open.fence[0] && m[1]!.length >= open.fence.length && !m[2]) {
      if (!wanted || open.language === wanted) {
        out.push({
          language: open.language,
          code: lines.slice(open.start + 1, i).join('\n'),
          line: open.start + 1,
        });
      }

      open = undefined;
    }
  });

  return out;
}

const ALIASES = new Map(
  Object.entries({
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    sh: 'bash',
    shell: 'bash',
    zsh: 'bash',
    console: 'bash',
    py: 'python',
    yml: 'yaml',
    rb: 'ruby',
    golang: 'go',
  }),
);

// Fence info strings carry extras (`ts title="x.ts"`, `js{1,3}`); the language is the leading word.
export function normaliseLanguage(info: string): string {
  const lang = (/^[\w+#.-]*/.exec(info.trim().toLowerCase())?.[0] ?? '').replace(/^\./, '');

  return ALIASES.get(lang) ?? lang;
}

/** Lines of a document, without a UTF-8 byte order mark (which would hide a first-line heading). */
function splitLines(text: string): string[] {
  return text.replace(/^﻿/, '').split(/\r?\n/);
}

type Kind = 'text' | 'code' | 'comment' | 'heading';

type Heading = { level: number; text: string; index: number; next: number };

/**
 * One pass over the lines: which are code, HTML comments, headings or text. Fence- and
 * comment-aware (a `# comment` in a bash block, or a heading inside `<!-- -->`, is not a
 * heading), and understands setext headings (`Title` over `===` or `---`). `next` is the
 * first line after the heading, which is two lines on for setext.
 */
function scan(lines: string[], from: number) {
  const headings: Heading[] = [];
  const kinds: Kind[] = [];
  let fence: string | undefined;
  let comment = false;

  for (let i = from; i < lines.length; i++) {
    const line = lines[i]!;

    if (fence) {
      kinds[i] = 'code';
      const f = FENCE.exec(line)?.[1];

      if (f && f[0] === fence[0] && f.length >= fence.length && !line.trim().slice(f.length))
        fence = undefined;
      continue;
    }

    if (comment) {
      kinds[i] = 'comment';

      if (line.includes('-->')) comment = false;
      continue;
    }

    const f = FENCE.exec(line)?.[1];

    if (f) {
      kinds[i] = 'code';
      fence = f;
      continue;
    }

    if (/^\s*<!--/.test(line) && !line.includes('-->')) {
      kinds[i] = 'comment';
      comment = true;
      continue;
    }

    const atx = HEADING.exec(line);

    if (atx) {
      kinds[i] = 'heading';
      headings.push({ level: atx[1]!.length, text: headingText(atx[2]!), index: i, next: i + 1 });
      continue;
    }

    const setext = /^ {0,3}(=+|-+)\s*$/.exec(line);
    const above = lines[i - 1];

    if (
      setext &&
      i - 1 >= from &&
      kinds[i - 1] === 'text' &&
      above?.trim() &&
      !/^\s*([-*+>|]|\d+[.)])(\s|$)/.test(above)
    ) {
      kinds[i - 1] = 'heading';
      kinds[i] = 'heading';
      headings.push({
        level: setext[1]![0] === '=' ? 1 : 2,
        text: headingText(above),
        index: i - 1,
        next: i + 1,
      });
      continue;
    }

    kinds[i] = 'text';
  }

  return { headings, kinds };
}

/** Heading text as a reader sees it: no Docusaurus custom id, `{#id}` (v2) or `{/* #id *\/}` (v3 MDX). */
function headingText(raw: string): string {
  return raw.replace(/\s*\{(?:#[\w-]+|\/\*\s*#[\w-]+\s*\*\/)\}\s*$/, '').trim();
}

const MDX_STATEMENT =
  /^(import|export)\s+(\{|\*|type\s|default\s|const\s|let\s|function\s|async\s|['"]|[\w$]+\s*(,|from\s|=))/;

const TAG = /<\/?[A-Za-z][\w.:-]*((?:\s+[^<>]*?)?)\s*\/?>/g;

/**
 * What a reader would read in lines [from, to): code verbatim; prose without MDX
 * import/export statements, JSX/HTML tags (a tab's `label` or `title` is kept, it is text
 * the reader sees), HTML comments, `{/* MDX comments *\/}`, admonition fences
 * (`:::note[Title]` keeps "Title") or GitHub alert markers (`> [!NOTE]`).
 */
function searchableText(lines: string[], kinds: Kind[], from: number, to: number): string {
  const out: string[] = [];
  let statement = false;

  for (let i = from; i < to; i++) {
    const line = lines[i]!;

    if (kinds[i] === 'code') {
      if (!FENCE.test(line)) out.push(line);
      continue;
    }

    if (kinds[i] !== 'text') continue;

    if (statement || MDX_STATEMENT.test(line)) {
      // A multi-line `import {\n a,\n} from 'x'` ends at its `from '...'` (or a bare `import 'x'`).
      statement = !/from\s+['"]|^import\s+['"]|;\s*$|^export\s+(const|let|default)\s.*[^,{(]\s*$/.test(line);
      continue;
    }

    out.push(
      line
        .replace(/<!--.*?-->/g, '')
        .replace(/\{\/\*.*?\*\/\}/g, '')
        .replace(TAG, (_tag, attrs: string) =>
          [...attrs.matchAll(/\b(?:label|title)=(["'])(.*?)\1/g)].map((m) => ` ${m[2]} `).join(''),
        )
        .replace(/^\s*:{3,}\s*[\w-]*\s*(?:\[(.*)\]|([^{]*))?\s*(\{.*\})?\s*$/, (_m, bracket, rest) =>
          (bracket ?? rest ?? '').trim(),
        )
        .replace(/^(\s*>)+\s?/, '')
        .replace(/^\s*\[!\w+\]\s*$/, ''),
    );
  }

  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Frontmatter as flat `key: value` pairs. */
function readFrontmatter(lines: string[]) {
  const frontmatter: Record<string, string> = {};

  if (lines[0]?.trim() !== '---') return { frontmatter, bodyStart: 0 };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');

  if (end < 0) return { frontmatter, bodyStart: 0 };

  for (const line of lines.slice(1, end)) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line);

    if (m && m[2]) frontmatter[m[1]!] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }

  return { frontmatter, bodyStart: end + 1 };
}
