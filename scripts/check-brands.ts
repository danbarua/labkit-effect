/**
 * Checks that every schema declared in the abstract layers (src/agent-machine, src/agent-policy)
 * decodes to a type with no unbranded `string` in it, however the schema is built. It asks the
 * TypeScript 7 checker through its API, which runs the compiler as a separate process.
 *
 * A schema is a declaration whose type has a `Type` property. A branded string is an intersection
 * (`string & Brand<...>`); string literals are not the `string` type.
 *
 * Prints the files and declarations examined, so a run over nothing is visible.
 *
 * retire-when: a lint rule with type information can check the same thing.
 */

import { API, type Type, TypeFlags, type UnionOrIntersectionType } from "typescript/unstable/async";
import { SyntaxKind } from "typescript/unstable/ast";

const root = process.cwd();
const api = new API({ cwd: root });
const snapshot = await api.updateSnapshot({ openProject: `${root}/tsconfig.json` });
const project = snapshot.getProjects()[0];
if (project === undefined) throw new Error("check:brands: tsconfig.json opened no project");
const { program, checker } = project;

/** The path to an unbranded string in `type`, or undefined. */
async function unbranded(type: Type | undefined, path: string, seen: ReadonlySet<number>): Promise<string | undefined> {
  if (type === undefined || seen.has(type.id)) return undefined;
  const within = new Set([...seen, type.id]);
  if (type.flags & TypeFlags.String) return path;
  if (type.flags & TypeFlags.Intersection) return undefined;
  if (type.flags & TypeFlags.Union) {
    for (const member of (await (type as UnionOrIntersectionType).getTypes()) ?? []) {
      const found = await unbranded(member, path, within);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (type.flags & TypeFlags.Object) {
    if ((await checker.isArrayType(type)) || (await checker.isTupleType(type))) {
      for (const element of await checker.getTypeArguments(type as never)) {
        const found = await unbranded(element, `${path}[]`, within);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if ((await checker.typeToString(type)).startsWith("Uint8Array")) return undefined;
    for (const property of await checker.getPropertiesOfType(type)) {
      const found = await unbranded(await checker.getTypeOfSymbol(property), `${path}.${property.name}`, within);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

const files = (await program.getSourceFileNames()).filter((file) => /\/src\/agent-(core|policy)\//.test(file));
const problems: Array<string> = [];
let schemas = 0;

for (const file of files) {
  const source = await program.getSourceFile(file);
  if (source === undefined) continue;
  const declarations: Array<{ name: { getText: (file: unknown) => string } }> = [];
  const walk = (node: { kind: number; forEachChild: (visit: (child: never) => void) => void }): void => {
    if (node.kind === SyntaxKind.VariableDeclaration) declarations.push(node as never);
    node.forEachChild(walk as never);
  };
  source.forEachChild(walk as never);
  for (const declaration of declarations) {
    const type = await checker.getTypeAtLocation(declaration.name as never);
    const decoded = type && (await checker.getPropertyOfType(type, "Type"));
    if (decoded === undefined) continue;
    schemas += 1;
    const found = await unbranded(await checker.getTypeOfSymbol(decoded), "", new Set());
    if (found !== undefined)
      problems.push(`${file.replace(`${root}/`, "")}: ${declaration.name.getText(source)} decodes to a plain string at Type${found}`);
  }
}

await api.close();
console.log(`check:brands examined ${schemas} schemas in ${files.length} files`);
if (files.length === 0 || schemas === 0) {
  console.error("check:brands: examined nothing");
  process.exit(1);
}
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
