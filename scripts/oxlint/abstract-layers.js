/**
 * Rules for functional code: no `let` or `var`, no loop statements, no call or assignment that
 * changes a value in place (`a.b = …`, `a.b++`, `delete a.b`); a log event named from a log key
 * table, not by a string; and, for the abstract layers
 * (`scripts/abstract-layers.ts`), every string branded. The rules read syntax only: a method named
 * `push` or `set` on a type of our own is reported too, but a function of a module imported from
 * effect (`Ref.set`) is not.
 */

const inPlace = new Set(["push", "set", "delete", "splice", "sort", "reverse", "fill"]);

/** Effect's functions that log an event: their first argument is the event's name. */
const logFunctions = new Set(["log", "logTrace", "logDebug", "logInfo", "logWarning", "logError", "logFatal"]);

const report = (message) => (context) => (node) => context.report({ node, message });

export default {
  meta: { name: "abstract" },
  rules: {
    "no-let": {
      create: (context) => ({
        VariableDeclaration(node) {
          if (node.kind !== "const") context.report({ node, message: `\`${node.kind}\`: functional code uses \`const\`; state that changes lives in a \`Ref\`.` });
        },
      }),
    },
    "no-loop": {
      create: (context) => {
        const loop = report("A loop statement: functional code uses map, flatMap, reduce or recursion.")(context);
        return {
          ForStatement: loop,
          ForInStatement: loop,
          ForOfStatement: loop,
          WhileStatement: loop,
          DoWhileStatement: loop,
        };
      },
    },
    "no-in-place-change": {
      create: (context) => {
        // A call on a module imported from effect (`Ref.set`, `HashMap.set`) returns a new value or an
        // effect on a managed reference; it does not change a JavaScript value in place.
        const fromEffect = new Set();
        return {
          ImportDeclaration(node) {
            if (node.source.value !== "effect" && !node.source.value.startsWith("effect/")) return;
            for (const specifier of node.specifiers) fromEffect.add(specifier.local.name);
          },
          CallExpression(node) {
          const callee = node.callee;
          if (callee.type !== "MemberExpression" || callee.computed) return;
          if (callee.object.type === "Identifier" && fromEffect.has(callee.object.name)) return;
          const name = callee.property.name;
          if (inPlace.has(name))
            context.report({ node, message: `\`.${name}()\` changes a value in place: build a new value instead.` });
          if (callee.object.type === "Identifier" && callee.object.name === "Object" && name === "assign")
            context.report({ node, message: "`Object.assign` changes a value in place: spread into a new object instead." });
          },
        };
      },
    },
    "log-event-from-table": {
      create: (context) => ({
        CallExpression(node) {
          const callee = node.callee;
          if (callee.type !== "MemberExpression" || callee.computed) return;
          if (callee.object.type !== "Identifier" || callee.object.name !== "Effect" || !logFunctions.has(callee.property.name)) return;
          const event = node.arguments[0];
          if (event?.type === "Literal" || event?.type === "TemplateLiteral")
            context.report({ node: event, message: "A log event named by a string: name it from the module's log key table (`logKeys`), where it is described." });
        },
      }),
    },
    "no-property-assignment": {
      create: (context) => {
        const member = (node) => node?.type === "MemberExpression";
        const changed = "Assignment to a property changes a value in place: build a new value, or keep the state in a `Ref`.";
        return {
          AssignmentExpression(node) {
            if (member(node.left)) context.report({ node, message: changed });
          },
          UpdateExpression(node) {
            if (member(node.argument)) context.report({ node, message: changed });
          },
          UnaryExpression(node) {
            if (node.operator === "delete" && member(node.argument)) context.report({ node, message: "`delete` changes a value in place: build a new value without the property." });
          },
        };
      },
    },
    "no-string-keyword": {
      create: (context) => ({
        TSStringKeyword(node) {
          context.report({ node, message: "The `string` type: use a branded string." });
        },
      }),
    },
    "branded-schema-string": {
      create: (context) => ({
        MemberExpression(node) {
          if (node.object.type !== "Identifier" || node.object.name !== "Schema" || node.property.name !== "String") return;
          const pipe = node.parent;
          const call = pipe?.parent;
          const branded =
            pipe?.type === "MemberExpression" &&
            pipe.property.name === "pipe" &&
            call?.type === "CallExpression" &&
            call.arguments[0]?.callee?.property?.name === "brand";
          if (!branded) context.report({ node, message: "`Schema.String` without `.pipe(Schema.brand(...))`." });
        },
      }),
    },
  },
};
