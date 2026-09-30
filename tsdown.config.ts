import { defineConfig } from 'tsdown';

export default defineConfig({
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
    cloudflare: 'src/cloudflare.ts',
    lambda: 'src/lambda.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  target: false,
});
