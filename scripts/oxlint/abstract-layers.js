/**
 * Rules for functional code: no `let` or `var`, no loop statements, no call or assignment that
 * changes a value in place (`a.b = …`, `a.b++`, `delete a.b`); a log event named from a log key
 * table, not by a string; for the abstract layers
 * (`scripts/abstract-layers.ts`), every string branded; for tests, no sleeping (`Effect.sleep`,
 * `Bun.sleep`, `setTimeout`); and, for all code, no cast through `unknown` or `any`
 * (`x as unknown as T`), no cast to `never`, and no clock or random read in a workflow's body
 * outside an activity. The rules read syntax only: a method named `push` or `set` on a type of our
 * own is reported too, but a function of a module imported from effect (`Ref.set`) is not; a
 * workflow is recognised by `Workflow.make` in the same file.
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
    "no-double-cast": {
      create: (context) => {
        const unwrapped = (node) => (node?.type === "ParenthesizedExpression" ? unwrapped(node.expression) : node);
        const cast = (node) => node?.type === "TSAsExpression" || node?.type === "TSTypeAssertion";
        const toAnything = (node) => node.typeAnnotation.type === "TSUnknownKeyword" || node.typeAnnotation.type === "TSAnyKeyword";
        const fix =
          "Build a value of the type, decode it at the boundary (`Schema.decodeUnknown…`), widen the other side to `unknown` with an annotation (`const actual: unknown = x; expect(actual).toEqual(…)`), or, where no checked form exists, write why on the line above: `// oxlint-disable-next-line abstract/no-double-cast -- <reason>`.";
        const check = (node) => {
          const inner = unwrapped(node.expression);
          if (cast(inner) && toAnything(inner)) context.report({ node, message: `A cast through \`unknown\` or \`any\` stops the compiler checking the value. ${fix}` });
          if (node.typeAnnotation.type === "TSNeverKeyword") context.report({ node, message: `A cast to \`never\` is accepted anywhere, so the compiler checks nothing there. ${fix}` });
        };
        return { TSAsExpression: check, TSTypeAssertion: check };
      },
    },
    "no-sleep-in-tests": {
      create: (context) => {
        const message =
          "A test that sleeps waits for real time instead of for the event. Synchronize with a `Deferred`, `Queue` or `Latch`, or move the test clock (`TestClock.adjust`). A wait for a real process or server is allowed with a bound, with the reason on the line above: `// oxlint-disable-next-line abstract/no-sleep-in-tests -- <reason>`.";
        const sleeps = new Set(["Effect.sleep", "Bun.sleep", "Bun.sleepSync"]);
        return {
          CallExpression(node) {
            const callee = node.callee;
            const named =
              callee.type === "Identifier"
                ? callee.name
                : callee.type === "MemberExpression" && !callee.computed && callee.object.type === "Identifier"
                  ? `${callee.object.name}.${callee.property.name}`
                  : undefined;
            if (named === "setTimeout" || sleeps.has(named)) context.report({ node, message });
          },
        };
      },
    },
    "workflow-deterministic": {
      create: (context) => {
        // A workflow's body runs again from its first line on every replay, so a value it reads from a
        // clock or a random source differs between replays. An activity's result is stored and
        // replayed, so the same call inside an activity's `execute` is deterministic.
        const message =
          "A clock or random read in a workflow's body differs on each replay, so an activity named from it runs again. Read it in an activity's `execute`, whose result is stored, or take the value from the journalled message that started the work.";
        const nondeterministic = new Set(["crypto.randomUUID", "crypto.getRandomValues", "Math.random", "Date.now", "performance.now"]);
        const workflows = new Set();
        const memberName = (node) =>
          node?.type === "MemberExpression" && !node.computed && node.object.type === "Identifier" ? `${node.object.name}.${node.property.name}` : undefined;
        const isWorkflowMake = (node) => node?.type === "CallExpression" && memberName(node.callee) === "Workflow.make";
        const isToLayer = (node) =>
          node.type === "CallExpression" &&
          node.callee.type === "MemberExpression" &&
          !node.callee.computed &&
          node.callee.property.name === "toLayer" &&
          ((node.callee.object.type === "Identifier" && workflows.has(node.callee.object.name)) || isWorkflowMake(node.callee.object));
        const isActivityExecute = (node) =>
          node.type === "Property" &&
          node.key.type === "Identifier" &&
          node.key.name === "execute" &&
          node.parent?.type === "ObjectExpression" &&
          node.parent.parent?.type === "CallExpression" &&
          memberName(node.parent.parent.callee) === "Activity.make";
        const check = (node) => {
          for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
            if (isActivityExecute(ancestor)) return;
            if (isToLayer(ancestor)) return context.report({ node, message });
          }
        };
        return {
          VariableDeclarator(node) {
            if (node.id.type === "Identifier" && isWorkflowMake(node.init)) workflows.add(node.id.name);
          },
          CallExpression(node) {
            if (nondeterministic.has(memberName(node.callee))) check(node);
          },
          NewExpression(node) {
            if (node.callee.type === "Identifier" && node.callee.name === "Date" && node.arguments.length === 0) check(node);
          },
        };
      },
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
