# AGENTS.md - Rybbit

Read the repository guidance before making changes:

@CLAUDE.md
@CONTEXT.md
@PRODUCT.md
@DESIGN.md
@CONTRIBUTE.md

Use the package-specific guidance for the area being changed:

@server/AGENTS.md
@client/AGENTS.md

## Scope

- Keep changes focused and avoid unrelated refactors.
- Follow the closest `AGENTS.md` when instructions differ by package.
- Preserve Rybbit's organization, team, and Site access boundaries in every API and data query.
- Never interpolate untrusted values into SQL.
- Do not run database migration, push, pull, or drop commands unless the user explicitly requests it.
- Do not edit generated output such as `dist/`, `.next/`, or `node_modules/`.

## Verification

- Server changes: run `npm run build` and `npm run test:run` from `server/`.
- Client changes: run `npm run lint`, `npx tsc --noEmit`, and relevant tests from `client/`.
- Run `npm run build` from `client/` for route, configuration, bundling, or Next.js behavior changes.
- Add or update focused tests for behavior changes.
