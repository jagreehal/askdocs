import { describe, expect, it } from 'vitest';
import { codeBlocks, matchHeadings, parseMarkdown, sectionAt } from './markdown';

const doc = `---
title: "Payments"
owner: payments-team
---
Intro before any heading.

## Retries

We retry with backoff.

\`\`\`bash
# not a heading
curl /payouts
\`\`\`

### Idempotency

Every payout carries an idempotency key.

## Reconciliation

Nightly.
`;

describe('parseMarkdown', () => {
  it('cuts one section per heading, with breadcrumbs, ignoring # inside code fences', () => {
    const { title, frontmatter, sections } = parseMarkdown(doc, 'fallback');
    expect(title).toBe('Payments');
    expect(frontmatter.owner).toBe('payments-team');
    expect(sections.map((s) => s.breadcrumb.join(' > '))).toEqual([
      'Payments',
      'Payments > Retries',
      'Payments > Retries > Idempotency',
      'Payments > Reconciliation',
    ]);
    expect(sections[1]!.content).toContain('# not a heading');
    expect(sections[2]!.line).toBe(16);
  });

  it('falls back to the first h1, then the given title', () => {
    expect(parseMarkdown('# Auth\n\nbody', 'x').title).toBe('Auth');
    expect(parseMarkdown('body', 'docs/auth').title).toBe('docs/auth');
  });
});

describe('sectionAt and matchHeadings', () => {
  it('returns the heading plus nested subsections, stopping at the next sibling', () => {
    const [retries] = matchHeadings(doc, 'retries');
    const section = sectionAt(doc, retries!.line)!;
    expect(section.startsWith('## Retries')).toBe(true);
    expect(section).toContain('### Idempotency');
    expect(section).not.toContain('Reconciliation');
    expect(matchHeadings(doc, 'nope')).toEqual([]);
    expect(sectionAt(doc, 3)).toBeUndefined(); // no heading on that line
  });

  it('addresses the text before the first heading as line 0, after any frontmatter', () => {
    expect(sectionAt(doc, 0)).toBe('Intro before any heading.');
    expect(parseMarkdown(doc, 'x').sections[0]!.line).toBe(0);
  });
});

describe('codeBlocks', () => {
  const md = [
    '## Setup',
    '',
    '```ts title="client.ts"',
    'const a = 1;',
    '```',
    '',
    '````md',
    '```bash',
    'not a real block',
    '```',
    '````',
    '',
    '~~~sh',
    'pnpm i',
    '~~~',
  ].join('\n');

  it('normalises languages, reads past info strings, and treats a longer outer fence as one block', () => {
    expect(codeBlocks(md).map((b) => b.language)).toEqual(['typescript', 'md', 'bash']);
    expect(codeBlocks(md, 'typescript')).toEqual([{ language: 'typescript', code: 'const a = 1;', line: 3 }]);
    expect(codeBlocks(md, 'shell').map((b) => b.code)).toEqual(['pnpm i']);
  });

  it('records each section’s languages for filtering', () => {
    const { sections } = parseMarkdown(md, 'x');
    expect(sections[0]!.languages).toEqual(['typescript', 'md', 'bash']);
  });
});

const headings = (text: string) => parseMarkdown(text, 'x').sections.map((s) => s.breadcrumb.join(' > '));

const content = (text: string, heading: string) =>
  parseMarkdown(text, 'x').sections.find((s) => s.heading === heading)?.content;

describe('real-world Markdown and MDX', () => {
  it('indexes the text inside MDX components and tabs, not the import/export/JSX syntax', () => {
    const mdx = [
      '---',
      'title: Install',
      '---',
      "import { Tabs, TabItem } from '@astrojs/starlight/components';",
      'export const meta = { draft: false };',
      '',
      '## Package managers',
      '',
      '<Tabs>',
      '  <TabItem label="pnpm">',
      '  Run pnpm add astro.',
      '  </TabItem>',
      '  <TabItem value="yarn" label="Yarn Berry">Run yarn add astro.</TabItem>',
      '</Tabs>',
      '',
      '```js',
      "import astro from 'astro'; // code keeps its imports",
      '```',
    ].join('\n');

    const sections = parseMarkdown(mdx, 'x').sections;
    expect(sections.map((s) => s.heading)).toEqual(['Package managers']); // the import-only preamble is empty
    const text = sections[0]!.content;
    expect(text).toContain('Run pnpm add astro.');
    expect(text).toContain('Run yarn add astro.');
    expect(text).toContain('Yarn Berry'); // a tab's label is the words a reader sees
    expect(text).not.toMatch(/<\/?Tab|TabItem|export const/);
    expect(text).toContain("import astro from 'astro'");
  });

  it('keeps admonition text and titles, drops the markers', () => {
    const md =
      '## Caching\n\n:::caution[Stale data]\nCaches expire hourly.\n:::\n\n> [!NOTE]\n> Purge with the CLI.\n';

    const text = content(md, 'Caching')!;
    expect(text).toContain('Stale data');
    expect(text).toContain('Caches expire hourly.');
    expect(text).toContain('Purge with the CLI.');
    expect(text).not.toMatch(/:::|\[!NOTE\]/);
  });

  it('recognises setext headings, and not a thematic break after a list', () => {
    const md = 'Guide\n=====\n\nIntro.\n\nSetup\n-----\n\nSteps.\n\n- item\n\n---\n\nAfter the rule.\n';
    expect(headings(md)).toEqual(['Guide', 'Guide > Setup']);
    expect(content(md, 'Setup')).toContain('After the rule.');
    expect(content(md, 'Guide')).toBe('Intro.');
    const [setup] = matchHeadings(md, 'Setup');
    expect(sectionAt(md, setup!.line)).toMatch(/^Setup\n-----\n\nSteps\./);
  });

  it('ignores headings inside ~~~ fences, nested fences and HTML comments', () => {
    const md = [
      '# Doc',
      '~~~bash',
      '# not a heading',
      '~~~',
      '````md',
      '```',
      '## still not a heading',
      '```',
      '````',
      '<!--',
      '## commented out',
      'secret draft text',
      '-->',
      '## Real',
      'Body <!-- inline note --> end.',
    ].join('\n');

    expect(headings(md)).toEqual(['Doc', 'Doc > Real']);
    expect(content(md, 'Doc')).not.toContain('secret draft text');
    expect(content(md, 'Real')).toBe('Body  end.');
  });

  it('keeps duplicate headings apart by breadcrumb', () => {
    const md = '# API\n\n## Users\n\n### Errors\n\nU.\n\n## Orders\n\n### Errors\n\nO.\n';
    expect(headings(md)).toEqual(['API > Users > Errors', 'API > Orders > Errors']);
  });

  it('indexes a doc with no headings as one section, addressed as line 0', () => {
    expect(parseMarkdown('Just text.', 'notes').sections).toMatchObject([{ heading: 'notes', line: 0 }]);
  });

  it('indexes table cells as text', () => {
    const md = '## Limits\n\n| Plan | Requests |\n| ---- | -------- |\n| Free | 100/min |\n';
    expect(content(md, 'Limits')).toMatch(/Free.*100\/min/s);
  });

  it('handles CRLF line endings and a UTF-8 byte order mark', () => {
    const md = '﻿---\r\ntitle: Windows doc\r\n---\r\n# Heading\r\n\r\nBody.\r\n\r\n## Sub\r\n\r\nMore.\r\n';
    const parsed = parseMarkdown(md, 'x');
    expect(parsed.title).toBe('Windows doc');
    expect(parsed.sections.map((s) => [s.heading, s.content])).toEqual([
      ['Heading', 'Body.'],
      ['Sub', 'More.'],
    ]);
    expect(parseMarkdown('﻿# Title\n\nx', 'f').title).toBe('Title');
  });

  it('drops a Docusaurus {#custom-id} from the heading text', () => {
    expect(headings('## Sidebar ordering {#ordering}\n\nx')).toEqual(['x > Sidebar ordering']);
    expect(headings('## Line numbering {/* #line-numbering */}\n\nx')).toEqual(['x > Line numbering']);
  });
});
