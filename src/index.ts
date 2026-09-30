export {
  parseMarkdown,
  sectionAt,
  matchHeadings,
  listHeadings,
  codeBlocks,
  type Section,
  type ParsedDoc,
  type HeadingEntry,
  type CodeBlock,
} from './markdown';

export {
  openStore,
  indexLibrary,
  removeLibrary,
  listLibraries,
  search,
  readDoc,
  recordAudit,
  recentAudit,
  queryStats,
  exportIndex,
  importIndex,
  parseIndexDump,
  attachStore,
  type Database,
  type IndexDump,
  type Library,
  type Scope,
  type SearchHit,
  type SearchResult,
  type AuditEvent,
  type Gap,
} from './store';

export { loadSource, type LoadedSource } from './sources';

export {
  aiSdkEmbedder,
  embedderFrom,
  embedLibrary,
  searchSemantic,
  workersAiEmbedder,
  type Embedder,
} from './vectors';

export { createServer, type Caller } from './server';

export { createHttpHandler, devAuth, type DevAuth } from './http';

export {
  loadAccess,
  parseAccess,
  allowedLibraries,
  githubRepoReader,
  type Access,
  type GithubConfig,
  type RepoReader,
} from './access';
