import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "dist");
mkdirSync(outDir, { recursive: true });

const result = await build({
  entryPoints: [join(root, "src", "app.tsx")],
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  jsx: "automatic",
  outdir: outDir,
  entryNames: "app-bundle",
  write: false,
  define: {
    "process.env.NODE_ENV": '"production"',
  },
});

let js = "";
let css = "";
for (const file of result.outputFiles) {
  if (file.path.endsWith(".js")) js += file.text;
  else if (file.path.endsWith(".css")) css += file.text;
}

const escapeScript = (code) => code.replace(/<\/script>/gi, "<\\/script>");
const escapeStyle = (code) => code.replace(/<\/style>/gi, "<\\/style>");

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Hill Climb</title>
  <style>${escapeStyle(css)}</style>
</head>
<body>
  <div id="root"></div>
  <script>${escapeScript(js)}</script>
</body>
</html>
`;

const outPath = join(outDir, "app.html");
writeFileSync(outPath, html, "utf8");
console.log(`Built ${outPath} (${(Buffer.byteLength(html, "utf8") / 1024).toFixed(1)} KiB)`);
