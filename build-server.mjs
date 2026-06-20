import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["server/src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/server/index.mjs",
  sourcemap: true,
  external: ["pino", "pino-pretty", "pino-http", "thread-stream"],
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
});

console.log("Server bundle complete.");
