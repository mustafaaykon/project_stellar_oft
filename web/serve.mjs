// Serves the built dashboard (web/dist) on http://localhost:4173 with no dependencies.
// Build first: npm run web:build
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "dist");
const PORT = Number(process.env.PORT ?? 4173);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

if (!existsSync(join(DIST, "index.html"))) {
  console.error("web/dist is missing. Run: npm run web:build");
  process.exit(1);
}

createServer((req, res) => {
  let p = join(DIST, decodeURIComponent(req.url.split("?")[0]));
  if (!existsSync(p) || statSync(p).isDirectory()) p = join(DIST, "index.html");
  res.writeHead(200, { "content-type": MIME[extname(p)] ?? "application/octet-stream", "cache-control": "no-store" });
  res.end(readFileSync(p));
}).listen(PORT, () => console.log(`OFT Testkit dashboard: http://localhost:${PORT}  (Ctrl+C to stop)`));
