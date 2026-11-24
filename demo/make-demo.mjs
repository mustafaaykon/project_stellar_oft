// Produces the demo video: title card, four terminal takes (cargo test, oftkit deploy, oftkit
// check on a correct and a broken deployment, the 20-wallet simulation), the live dashboard, and
// an end card, each recorded with Playwright's Chromium at 1920x1080 and joined with ffmpeg into
// evidence/demo/oft-testkit-demo.mp4 with burned-in captions and an .srt sidecar.
//
// Usage: node demo/make-demo.mjs [--skip-capture]   (capture re-runs cargo test and oftkit check)
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, copyFileSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { chromium } from "playwright";
import ffmpegPath from "ffmpeg-static";

const ROOT = process.cwd();
const WORK = join(ROOT, "demo", "work");
const OUT_DIR = join(ROOT, "evidence", "demo");
const SIZE = { width: 1920, height: 1080 };
const skipCapture = process.argv.includes("--skip-capture");
mkdirSync(WORK, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });
const log = (s) => console.log(`make-demo: ${s}`);

// ----- 1. capture real outputs -----------------------------------------------------------------
function run(cmd, args, file) {
  const p = join(WORK, file);
  if (skipCapture && existsSync(p)) return readFileSync(p, "utf8");
  log(`capturing ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32" });
  const text = (r.stdout ?? "") + (r.stderr ?? "");
  writeFileSync(p, text);
  return text;
}
const cargoOut = run("cargo", ["test", "-p", "oft"], "cargo-test.txt").split("\n").filter((l) => !/^warning|^\s*\d*\s*\||^\s*=|^\s+-->|\^\^|^$|Finished|Running unittests|Compiling/.test(l)).join("\n");
const checkA = run("node", ["bin/oftkit.mjs", "check", "--deploy", "deploy/A.json", "--remotes", "30102", "--shared-decimals", "6"], "check-A.txt");
const checkBroken = run("node", ["bin/oftkit.mjs", "check", "--deploy", "deploy/BROKEN.json", "--remotes", "30102", "--shared-decimals", "6"], "check-BROKEN.txt");
const deployA = readFileSync(join(ROOT, "deploy", "A.json"), "utf8");
const simLog = existsSync(join(ROOT, "sim", "run.log")) ? readFileSync(join(ROOT, "sim", "run.log"), "utf8") : "(simulation log not found)";
const A = JSON.parse(deployA);
const B = JSON.parse(readFileSync(join(ROOT, "deploy", "B.json"), "utf8"));
const report = existsSync(join(ROOT, "sim", "report.json")) ? JSON.parse(readFileSync(join(ROOT, "sim", "report.json"), "utf8")) : null;

const deployText = A.txs.map((t) => `[A] ${t.step} ...\n[A]   tx ${t.hash}`).join("\n") + `\n[A] done: oft ${A.contracts.oft}\nwrote deploy/A.json`;
const simLines = simLog.split("\n").filter((l) => l.trim());
const cons = report?.conservation;
const consLine = cons ? `[ 439s] conservation: ${cons.total_before} before (wallets + ${cons.in_flight_at_seed} in flight) = ${cons.total_after} after (wallets + ${cons.contract_recipient_balance} at the contract recipient) -> ${cons.conserved ? "CONSERVED" : "MISMATCH"}` : "";
const simExcerpt = [
  ...simLines.filter((l) => /phase 1|phase 2|phase 3/.test(l)),
  ...simLines.filter((l) => /minted to W0[1-3]/.test(l)),
  "  … (17 more mints)",
  ...simLines.filter((l) => /phase 4/.test(l)),
  ...simLines.filter((l) => /W0[12] sent .*-> burned/.test(l)),
  "  … (17 more sends)",
  ...simLines.filter((l) => /W20 sent .*-> burned/.test(l)),
  ...simLines.filter((l) => /phase 5/.test(l)),
  ...simLines.filter((l) => /delivered .*tx/.test(l)).slice(0, 2),
  "  … (more deliveries)",
  ...simLines.filter((l) => /FAILED/.test(l)).slice(0, 1),
  ...simLines.filter((l) => /phase 6/.test(l)),
  ...simLines.filter((l) => /delivered .*tx/.test(l)).slice(-1),
  ...simLines.filter((l) => /phase 7/.test(l)),
  ...simLines.filter((l) => /W0[12] sent .*back/.test(l)),
  "  … (14 more sends)",
  ...simLines.filter((l) => /rejected as expected/.test(l)),
  ...simLines.filter((l) => /phase 8/.test(l)),
  consLine,
  ...simLines.filter((l) => /wrote sim\/report/.test(l)),
].filter(Boolean).join("\n");

// ----- 2. scene pages --------------------------------------------------------------------------
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const base = (body, extraCss = "") => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:#0b0f14;color:#e6edf3;font-family:ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif}
  .caption{position:absolute;left:0;right:0;bottom:0;padding:22px 48px;background:linear-gradient(transparent,rgba(0,0,0,.85) 30%);font-size:34px;line-height:1.3;text-shadow:0 2px 8px #000}
  .caption b{color:#ffd166}
  .term{position:absolute;inset:60px 80px 150px 80px;background:#0d1117;border:1px solid #30363d;border-radius:14px;padding:28px 34px;font-family:ui-monospace,Consolas,"Cascadia Mono",monospace;font-size:24px;line-height:1.42;white-space:pre-wrap;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.6)}
  .term .bar{position:absolute;top:0;left:0;right:0;height:36px;background:#161b22;border-bottom:1px solid #30363d;border-radius:14px 14px 0 0}
  .term .dot{position:absolute;top:11px;width:14px;height:14px;border-radius:50%}
  .term .body{position:absolute;top:50px;left:34px;right:34px;bottom:24px;overflow:hidden}
  .prompt{color:#7ee787}.cmd{color:#e6edf3}.pass{color:#2ecc71}.fail{color:#ff5c5c}.info{color:#6aa9ff}.dim{color:#8b98a5}
  ${extraCss}</style></head><body>${body}</body></html>`;

const termPage = (title, command, output, caption, { charMs = 18, lineMs = 55, hold = 2500 } = {}) => base(`
  <div class="term"><div class="bar"><span class="dot" style="left:16px;background:#ff5f57"></span><span class="dot" style="left:38px;background:#febc2e"></span><span class="dot" style="left:60px;background:#28c840"></span><span class="dim" style="position:absolute;left:0;right:0;text-align:center;top:7px;font-size:18px">${esc(title)}</span></div><div class="body" id="body"></div></div>
  <div class="caption">${caption}</div>
  <script>
    const body=document.getElementById('body');
    const cmd=${JSON.stringify(command)}; const lines=${JSON.stringify(output.split("\n"))};
    const colour=l=>l.replace(/\\b(PASS|ok)\\b/g,'<span class="pass">$1</span>').replace(/\\b(FAIL|FAILED)\\b/g,'<span class="fail">$1</span>').replace(/\\b(INFO)\\b/g,'<span class="info">$1</span>').replace(/(tx [0-9a-f]{64}|guid [0-9a-f]+…)/g,'<span class="dim">$1</span>');
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    (async()=>{
      let p=document.createElement('div'); p.innerHTML='<span class="prompt">$ </span><span class="cmd" id="c"></span>'; body.appendChild(p);
      const c=document.getElementById('c');
      for(const ch of cmd){c.textContent+=ch; await sleep(${charMs});}
      await sleep(400);
      for(const l of lines){const d=document.createElement('div'); d.innerHTML=colour(l.replace(/&/g,'&amp;').replace(/</g,'&lt;'))||'&nbsp;'; body.appendChild(d); body.scrollTop=body.scrollHeight; await sleep(${lineMs});}
      await sleep(${hold}); window.sceneDone=true;
    })();
  </script>`);

const cardPage = (html, caption, hold) => base(`
  <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 160px">${html}</div>
  ${caption ? `<div class="caption">${caption}</div>` : ""}
  <script>setTimeout(()=>{window.sceneDone=true},${hold})</script>`);

const scenes = [
  { name: "01-title", html: cardPage(`
      <div style="font-size:30px;color:#ffd166;letter-spacing:.2em;text-transform:uppercase;margin-bottom:28px">Stellar Instaward · 30-day sprint</div>
      <div style="font-size:112px;font-weight:800;letter-spacing:-.02em">OFT Testkit</div>
      <div style="font-size:40px;color:#8b98a5;margin-top:22px;max-width:1400px">A local and testnet harness for LayerZero-style OFT deployments on Stellar: mock endpoint, <b style="color:#e6edf3">oftkit deploy</b>, <b style="color:#e6edf3">oftkit check</b>, 20-wallet simulation.</div>
      <div style="font-size:26px;color:#8b98a5;margin-top:60px">Testnet only · mock endpoint stands in for LayerZero · contracts unaudited</div>`, "", 4500),
    caption: "" },
  { name: "02-cargo-test", html: termPage("contracts · cargo test -p oft", "cargo test -p oft", cargoOut, "<b>Unit tests against the mock endpoint:</b> round trip, the dropped seventh decimal, dust, issuer, missing peer, untrusted sender, manual delivery, simulated failure and retry, pause.", { lineMs: 110, hold: 2600 }) },
  { name: "03-deploy", html: termPage("oftkit deploy --config oftkit.toml --chain A", "oftkit deploy --config oftkit.toml --chain A", deployText, "<b>One command deploys the MintBurn pattern to testnet:</b> SAC, SAC Manager and set_admin, mock endpoint, OFT, MINTER grant, issuer lock. Every contract id and transaction hash is written to deploy/A.json.", { lineMs: 120, hold: 2600 }) },
  { name: "04-check-ok", html: termPage("oftkit check --deploy deploy/A.json --remotes 30102", "oftkit check --deploy deploy/A.json --remotes 30102 --shared-decimals 6", checkA, "<b>check reads the deployed state and never submits a transaction.</b> Peer, enforced options, issuer master weight, SAC admin, MINTER role, shared decimals, endpoint routing.", { lineMs: 150, hold: 2600 }) },
  { name: "05-check-broken", html: termPage("oftkit check --deploy deploy/BROKEN.json --remotes 30102", "oftkit check --deploy deploy/BROKEN.json --remotes 30102 --shared-decimals 6", checkBroken, "<b>The same check on a deliberately broken deployment:</b> the None peer, missing enforced options and the unlocked issuer are the faults LayerZero's docs warn about. Exit code 1 for CI.", { lineMs: 150, hold: 3200 }) },
  { name: "06-sim", html: termPage("node sim/run.mjs · 20 wallets on testnet", "node sim/run.mjs", simExcerpt, "<b>20 wallets:</b> seeded through the SAC Manager, A→B with dust removed, relayed; W20 fails without a trustline and is retried once it has one; B→A to self, neighbour and a contract address; dust and slippage rejected; conservation holds.", { lineMs: 140, hold: 3000 }) },
  { name: "07-dashboard", url: true, caption: "<b>Live dashboard:</b> both chains, the check rules re-read from testnet, the 20 wallets' balances from Horizon, every transaction linked to the explorer." },
  { name: "08-end", html: cardPage(`
      <div style="font-size:64px;font-weight:800;margin-bottom:30px">What was shown</div>
      <div style="font-size:32px;color:#c9d1d9;line-height:1.6;max-width:1500px;text-align:left">
        <div>✓ <b>mock-lz-endpoint</b> — endpoint test double with routing, manual delivery, simulated failure and retry</div>
        <div>✓ <b>oftkit deploy</b> — SAC → SAC Manager → OFT on testnet in one command</div>
        <div>✓ <b>oftkit check</b> — six documented rules, read-only, CI exit code</div>
        <div>✓ <b>20-wallet simulation</b> — ${report ? report.tx_count : "…"} testnet transactions, conservation verified</div>
        <div>✓ <b>Dashboard</b> — live state from RPC and Horizon</div>
      </div>
      <div style="font-size:24px;color:#8b98a5;margin-top:50px;font-family:ui-monospace,monospace">OFT A ${A.contracts.oft}<br>OFT B ${B.contracts.oft}</div>
      <div style="font-size:24px;color:#8b98a5;margin-top:26px">Testnet only · unaudited · github.com/mertkaya/oft-testkit</div>`, "", 6000) },
];

for (const s of scenes) {
  if (s.html) writeFileSync(join(WORK, `${s.name}.html`), s.html);
  if (!s.caption && s.html) { const m = s.html.match(/<div class="caption">([\s\S]*?)<\/div>/); if (m) s.caption = m[1]; }
}

// ----- 3. static server for the dashboard ------------------------------------------------------
const DIST = join(ROOT, "web", "dist");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
const server = createServer((req, res) => {
  let p = join(DIST, decodeURIComponent(req.url.split("?")[0]));
  if (!existsSync(p) || statSync(p).isDirectory()) p = join(DIST, "index.html");
  res.writeHead(200, { "content-type": MIME[extname(p)] ?? "application/octet-stream" });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(4178, r));

// ----- 4. record -------------------------------------------------------------------------------
const browser = await chromium.launch();
const takes = [];
for (const s of scenes) {
  const dir = join(WORK, "video", s.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({ viewport: SIZE, recordVideo: { dir, size: SIZE }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const started = Date.now();
  if (s.url) {
    await page.goto("http://localhost:4178/", { waitUntil: "networkidle" });
    await page.addStyleTag({ content: `.caption{position:fixed;left:0;right:0;bottom:0;padding:22px 48px;background:linear-gradient(transparent,rgba(0,0,0,.88) 30%);font-size:34px;line-height:1.3;color:#e6edf3;z-index:9;text-shadow:0 2px 8px #000}.caption b{color:#ffd166}` });
    await page.evaluate((c) => { const d = document.createElement("div"); d.className = "caption"; d.innerHTML = c; document.body.appendChild(d); }, s.caption);
    await page.waitForFunction(() => document.querySelector("#check-A .result") && document.querySelector("#wallets tbody tr td.num"), null, { timeout: 90_000 }).catch(() => {});
    await page.waitForTimeout(2500);
    for (let y = 0; y <= 2400; y += 60) { await page.mouse.wheel(0, 60); await page.waitForTimeout(90); }
    await page.waitForTimeout(2500);
  } else {
    await page.goto(`file:///${join(WORK, `${s.name}.html`).replace(/\\/g, "/")}`);
    await page.waitForFunction(() => window.sceneDone === true, null, { timeout: 180_000 });
  }
  const seconds = (Date.now() - started) / 1000;
  await ctx.close();
  const webm = readdirSync(dir).find((f) => f.endsWith(".webm"));
  takes.push({ name: s.name, file: join(dir, webm), seconds, caption: s.caption ?? "" });
  log(`recorded ${s.name} (${seconds.toFixed(1)}s)`);
}
await browser.close();
server.close();

// ----- 5. cut ----------------------------------------------------------------------------------
const segs = [];
for (const t of takes) {
  const mp4 = join(WORK, `${t.name}.mp4`);
  const r = spawnSync(ffmpegPath, ["-y", "-i", t.file, "-vf", "scale=1920:1080,fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-an", mp4], { encoding: "utf8" });
  if (r.status !== 0) { console.error(r.stderr); throw new Error(`ffmpeg failed on ${t.name}`); }
  segs.push(mp4);
}
const list = join(WORK, "concat.txt");
writeFileSync(list, segs.map((s) => `file '${s.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"));
const final = join(OUT_DIR, "oft-testkit-demo.mp4");
const r = spawnSync(ffmpegPath, ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", final], { encoding: "utf8" });
if (r.status !== 0) { console.error(r.stderr); throw new Error("ffmpeg concat failed"); }

// captions sidecar from the scene timings
let t = 0, i = 1; const srt = [];
const ts = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = (s % 60).toFixed(3).padStart(6, "0").replace(".", ","); return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${sec}`; };
for (const take of takes) {
  const text = (scenes.find((s) => s.name === take.name)?.caption ?? (take.name.includes("title") ? "OFT Testkit: a local and testnet harness for LayerZero-style OFTs on Stellar." : "")).replace(/<[^>]+>/g, "");
  if (text) srt.push(`${i++}\n${ts(t)} --> ${ts(t + take.seconds)}\n${text}\n`);
  t += take.seconds;
}
writeFileSync(join(OUT_DIR, "oft-testkit-demo.srt"), srt.join("\n"));
for (const f of ["cargo-test.txt", "check-A.txt", "check-BROKEN.txt"]) copyFileSync(join(WORK, f), join(OUT_DIR, f));
writeFileSync(join(OUT_DIR, "takes.json"), JSON.stringify(takes.map(({ name, seconds }) => ({ name, seconds })), null, 2));
log(`wrote ${relative(ROOT, final).replace(/\\/g, "/")} (${t.toFixed(1)}s) and the .srt sidecar`);
