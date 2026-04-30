# Repository Instructions

Default to using Bun instead of Node.js for this repository.

## Commands

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`.
- Use `bun test` instead of Jest or Vitest.
- Use `bun build <file.html|file.ts|file.css>` instead of webpack or esbuild.
- Use `bun install` instead of `npm install`, `yarn install`, or `pnpm install`.
- Use `bun run <script>` instead of `npm run <script>`, `yarn run <script>`, or `pnpm run <script>`.
- Use `bunx <package> <command>` instead of `npx <package> <command>`.
- Bun automatically loads `.env`; do not add `dotenv`.

## Bun APIs

- Use `Bun.serve()` for HTTP, WebSockets, HTTPS, and routes. Do not add Express.
- Use `bun:sqlite` for SQLite. Do not add `better-sqlite3`.
- Use `Bun.redis` for Redis. Do not add `ioredis`.
- Use `Bun.sql` for Postgres. Do not add `pg` or `postgres.js`.
- Use the built-in `WebSocket`. Do not add `ws`.
- Prefer `Bun.file` over `node:fs` `readFile` / `writeFile` for simple file reads and writes.
- Prefer ``Bun.$`...` `` over `execa` for shelling out inside Bun code.

## Testing

Use `bun test` for tests.

```ts
import { expect, test } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

For Bun-native frontend experiments, use HTML imports with `Bun.serve()` and avoid Vite. HTML imports can load `.tsx`, `.jsx`, `.js`, and CSS files directly through Bun's bundler.

The `web/` app has its own [AGENTS.md](./web/AGENTS.md). When working under `web/`, follow that file's Next.js-specific instructions over this generic Bun frontend guidance.
