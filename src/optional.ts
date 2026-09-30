/**
 * Load an optional package at run time. The name isn't a literal, so bundlers (esbuild in CDK's
 * NodejsFunction, wrangler) leave it alone rather than failing when it isn't installed: it comes
 * from node_modules when used, or not at all.
 */
export function optional<Module>(name: string): Promise<Module> {
  return import(name);
}
