import { describe, expect, it } from 'vitest';
import { githubRepoReader } from './access';

/**
 * Against the real GitHub API. Opt in with:
 *
 *   GITHUB_TOKEN=... ASKDOCS_LIVE_REPO=owner/name ASKDOCS_LIVE_READER=login pnpm test github.live
 *
 * READER must be able to read REPO. The unauthenticated check runs whenever ASKDOCS_LIVE=1.
 */
const live = process.env.ASKDOCS_LIVE === '1' || !!process.env.GITHUB_TOKEN;

const { GITHUB_TOKEN, ASKDOCS_LIVE_REPO: repo, ASKDOCS_LIVE_READER: reader } = process.env;

describe.skipIf(!live)('GitHub, for real', () => {
  it('fails closed when GitHub rejects the service token', async () => {
    const canRead = githubRepoReader({ token: 'not-a-real-token', ttlSeconds: 0 });
    expect(await canRead('octocat', 'octocat/Hello-World')).toBe(false);
  });

  it.skipIf(!GITHUB_TOKEN || !repo || !reader)(
    'grants a real reader, and refuses a login that cannot read',
    async () => {
      const canRead = githubRepoReader({ token: GITHUB_TOKEN!, ttlSeconds: 0 });
      expect(await canRead(reader!, repo!)).toBe(true);
      expect(await canRead('this-login-does-not-exist-askdocs-0', repo!)).toBe(false);
    },
  );
});
