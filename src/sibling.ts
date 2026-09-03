// Resolving a module that sits beside this one.
//
// Several places name a sibling by path: a plugin names the setup file it
// adds to `setupFiles`, a generated config names the plugin it imports, a
// verb names the hook it preloads. Written as a literal `./x.ts`, every
// one of those breaks in a published package, where the file beside it is
// `x.js`: the source tree and the build have the same shape and different
// extensions.
//
// Reading the extension off this module's own URL is what makes one string
// correct in both. It is not a detail worth rediscovering: npm publishes
// the build, and the failure only appears once the package is installed
// somewhere else.
const EXTENSION = import.meta.url.endsWith(".ts") ? ".ts" : ".js";

/**
 * The absolute path of another of depug's own modules, named relative to
 * `from` without its extension.
 */
export function modulePath(relative: string, from: string): string {
  return new URL(`${relative}${EXTENSION}`, from).pathname;
}

/** The absolute path of a module in the same directory as `from`. */
export function siblingPath(name: string, from: string): string {
  return modulePath(`./${name}`, from);
}
