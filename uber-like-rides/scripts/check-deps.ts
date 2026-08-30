/**
 * Dependency-direction lint (tasks.md 1.4, lld.md §1 build-depth tiers).
 *
 * Runtime code (`src/{fares,rides,location,matching}`) must never import from
 * harness directories (`src/{sim,testdata,load,e2e}`) — the deployable system
 * cannot depend on the tooling that tests it. Run via `npm run lint`; exits
 * non-zero on any violation.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HARNESS_DIRS = ['sim', 'testdata', 'load', 'e2e'];

/** Runtime = every top-level dir under src/ that is not harness — new runtime dirs are covered automatically. */
export function runtimeDirsOf(srcRoot: string): string[] {
  if (!existsSync(srcRoot)) return [];
  return readdirSync(srcRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !HARNESS_DIRS.includes(entry.name))
    .map((entry) => entry.name);
}

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

/** All module specifiers referenced by static/dynamic imports and requires. */
export function extractImports(source: string): string[] {
  return [...source.matchAll(IMPORT_RE)].map((m) => m[1] as string);
}

/** True when a relative specifier from `importerPath` resolves into a harness dir under `srcRoot`. */
export function isHarnessImport(importerPath: string, specifier: string, srcRoot: string): boolean {
  if (!specifier.startsWith('.')) return false; // bare specifier = npm/node dep
  const resolved = resolve(dirname(importerPath), specifier);
  const rel = relative(resolve(srcRoot), resolved);
  if (rel.startsWith('..')) return false; // escapes src/ entirely
  const top = rel.split(sep)[0];
  return top !== undefined && HARNESS_DIRS.includes(top);
}

export interface Violation {
  file: string;
  specifier: string;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(ts|mts|cts|js|mjs|cjs)$/.test(entry.name) ? [full] : [];
  });
}

export function findViolations(srcRoot: string): Violation[] {
  const violations: Violation[] = [];
  for (const runtimeDir of runtimeDirsOf(srcRoot)) {
    const root = join(srcRoot, runtimeDir);
    for (const file of walk(root)) {
      for (const specifier of extractImports(readFileSync(file, 'utf8'))) {
        if (isHarnessImport(file, specifier, srcRoot)) violations.push({ file, specifier });
      }
    }
  }
  return violations;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const srcRoot = resolve(process.cwd(), 'src');
  const violations = findViolations(srcRoot);
  if (violations.length > 0) {
    console.error('Dependency-direction violations (runtime → harness):');
    for (const v of violations) console.error(`  ${relative(process.cwd(), v.file)} imports '${v.specifier}'`);
    process.exit(1);
  }
  console.log('deps: runtime → harness imports: none');
}
