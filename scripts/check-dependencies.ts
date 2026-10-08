/**
 * Checks that every package the source imports outside the tests is in `package.json`'s
 * `dependencies` or `peerDependencies`. A package that installs labkit-effect gets neither its dev
 * dependencies nor this repository's `node_modules`, and labkit-web runs and typechecks the source
 * (`src/agent-acp/main.ts` and the modules it imports).
 *
 * - The files are `src/` and `bin/`, except `*.test.ts`. `tests/` and `scripts/` are this
 *   repository's own.
 * - An import is an `import` or `export … from` declaration, type-only ones included, because the
 *   consumer's typecheck reads them; an `import("…")` call; and an `import("…")` type.
 * - A relative path, a `node:` or `bun:` module, `bun`, and a Node built-in are not packages.
 *
 * It asks the TypeScript 7 parser through its API, so a comment or a string is never read as an
 * import. Prints how many files and packages it examined; fails when it examined no file, so that a
 * moved folder makes the check fail instead of passing over nothing.
 */

import { builtinModules } from "node:module";
import { API } from "typescript/unstable/async";
import { SyntaxKind } from "typescript/unstable/ast";

const root = process.cwd();
const manifest = (await Bun.file(`${root}/package.json`).json()) as {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
};
const allowed = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]);
const builtins = new Set(builtinModules);

/** The package that `specifier` names, or undefined when it names no package. */
const packageOf = (specifier: string): string | undefined => {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:") || specifier.startsWith("bun:") || specifier === "bun") return undefined;
  const [first = "", second = ""] = specifier.split("/");
  const named = first.startsWith("@") ? `${first}/${second}` : first;
  return builtins.has(named) ? undefined : named;
};

interface Node {
  readonly kind: number;
  readonly forEachChild: (visit: (child: Node) => void) => void;
}
interface Literal extends Node {
  readonly text: string;
}

/** The module specifier that `node` imports, if it is an import. */
const specifierOf = (node: Node): string | undefined => {
  const literal = (candidate: unknown): string | undefined =>
    candidate !== undefined && (candidate as Node).kind === SyntaxKind.StringLiteral ? (candidate as Literal).text : undefined;
  if (node.kind === SyntaxKind.ImportDeclaration || node.kind === SyntaxKind.ExportDeclaration) return literal((node as Node & { moduleSpecifier?: unknown }).moduleSpecifier);
  if (node.kind === SyntaxKind.ImportType) return literal((node as Node & { argument?: { literal?: unknown } }).argument?.literal);
  if (node.kind === SyntaxKind.CallExpression) {
    const call = node as Node & { expression: Node; arguments: ReadonlyArray<unknown> };
    return call.expression.kind === SyntaxKind.ImportKeyword ? literal(call.arguments[0]) : undefined;
  }
  return undefined;
};

const api = new API({ cwd: root });
const snapshot = await api.updateSnapshot({ openProject: `${root}/tsconfig.json` });
const project = snapshot.getProjects()[0];
if (project === undefined) throw new Error("check:dependencies: tsconfig.json opened no project");
const { program } = project;

const shipped = (file: string): boolean => (file.startsWith(`${root}/src/`) || file.startsWith(`${root}/bin/`)) && !file.endsWith(".test.ts");
const files = (await program.getSourceFileNames()).filter(shipped);
const imported = new Set<string>();
const problems: Array<string> = [];

for (const file of files) {
  const source = await program.getSourceFile(file);
  if (source === undefined) continue;
  const walk = (node: Node): void => {
    const specifier = specifierOf(node);
    const named = specifier === undefined ? undefined : packageOf(specifier);
    if (named !== undefined) {
      imported.add(named);
      if (!allowed.has(named)) problems.push(`${file.replace(`${root}/`, "")}: imports ${specifier}, and ${named} is not in dependencies or peerDependencies`);
    }
    node.forEachChild(walk);
  };
  (source as unknown as Node).forEachChild(walk);
}

await api.close();
console.log(`check:dependencies examined ${files.length} files, which import ${imported.size} packages`);
if (files.length === 0) {
  console.error("check:dependencies: no file in src/ or bin/ was examined");
  process.exit(1);
}
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
