
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## Effect source

`repos/effect` is the Effect repository at the tag of the version installed
(`effect@4.0.0-rc.118`), vendored with `git subtree --squash`. It is reference
material: read it for APIs, examples and implementation details; do not edit it
or import from it. `~/Code/lib/effect` is an older beta and does not match what
is installed.

To move to another version, install it, then:
`git subtree pull --prefix=repos/effect https://github.com/Effect-TS/effect.git "effect@<version>" --squash`

## Output written to files

Run commands whose output goes to a file with `FORCE_COLOR=0 NO_COLOR=1`. Claude Code's shell sets
`FORCE_COLOR`, which overrides `NO_COLOR`, so without both the files under `logs/` fill with
terminal colour codes.
