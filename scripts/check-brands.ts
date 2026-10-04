/**
 * Checks that every schema declared in the abstract layers (`abstract-layers.ts`) decodes to a type
 * with no unbranded `string` in it, however the schema is built. It asks the
 * TypeScript 7 checker through its API, which runs the compiler as a separate process.
 *
 * A schema is a declaration whose type has a `Type` property. A branded string is an intersection
 * (`string & Brand<...>`); string literals are not the `string` type.
 *
 * Prints how many schemas it examined in each layer, and fails when a layer contributed none: a
 * layer that is renamed or emptied makes the check fail instead of passing over fewer files.
 *
 * retire-when: a lint rule with type information can check the same thing.
 */

import { API, type Type, TypeFlags, type UnionOrIntersectionType } from "typescript/unstable/async";
import { SyntaxKind } from "typescript/unstable/ast";
import { type AbstractLayer, abstractLayers } from "./abstract-layers.ts";

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

/** The abstract layer a source file belongs to, if it belongs to one. */
const layerOf = (file: string): AbstractLayer | undefined => abstractLayers.find((layer) => file.startsWith(`${root}/src/${layer}/`));

const files = (await program.getSourceFileNames()).filter((file) => layerOf(file) !== undefined && !file.endsWith(".test.ts"));
const problems: Array<string> = [];
/** How many schemas each layer's files declare. A layer with none means the check missed it. */
const schemasIn = new Map<AbstractLayer, number>(abstractLayers.map((layer) => [layer, 0]));

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
    const layer = layerOf(file);
    if (layer !== undefined) schemasIn.set(layer, (schemasIn.get(layer) ?? 0) + 1);
    const found = await unbranded(await checker.getTypeOfSymbol(decoded), "", new Set());
    if (found !== undefined)
      problems.push(`${file.replace(`${root}/`, "")}: ${declaration.name.getText(source)} decodes to a plain string at Type${found}`);
  }
}

await api.close();
for (const [layer, count] of schemasIn) console.log(`check:brands examined ${count} schemas in src/${layer}`);
const missed = [...schemasIn].filter(([, count]) => count === 0).map(([layer]) => layer);
if (missed.length > 0) {
  console.error(`check:brands: no schema was examined in ${missed.map((layer) => `src/${layer}`).join(", ")}`);
  process.exit(1);
}
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
