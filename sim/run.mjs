// 20-wallet simulation on testnet: fund, trust, seed, send A->B, relay, show the no-trustline
// retry path, send B->A (to self, to a neighbour, to a contract address), the dust and slippage
// rejections, relay again, then prove conservation from Horizon balances. Writes sim/report.json
// (public keys only), sim/report.md and copies the data the dashboard reads into web/public/data.
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";
import { readDeploy, send, relay, mint, trust, net, loadKey, view, sc, fund, links, sleep } from "../lib/oftkit.mjs";
import { horizonAccount, assetBalance } from "../lib/stellar.mjs";

const N_WALLETS = 20;
const SEED_AMOUNT = "100";
const A = readDeploy("deploy/A.json");
const B = readDeploy("deploy/B.json");
const n = net(A.network);
const L = links(n);
const owner = loadKey("owner");
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${s}`);

const report = {
  started_at: new Date().toISOString(), network: n.name,
  chains: { A: pick(A), B: pick(B) }, wallets: [], phases: [], txs: [], errors_expected: [], conservation: null,
};
function pick(d) { return { chain: d.chain, name: d.name, eid: d.eid, asset_code: d.asset_code, issuer: d.issuer, contracts: d.contracts, links: d.links }; }
function tx(phase, entry) { const e = { phase, ...entry }; report.txs.push(e); return e; }

async function pMap(items, fn, concurrency = 4) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

async function withRetry(fn, tries = 4, label = "") {
  let last;
  for (let k = 0; k < tries; k++) {
    try { return await fn(); } catch (e) { last = e; log(`  retry ${k + 1}/${tries} ${label}: ${String(e.message).slice(0, 120)}`); await sleep(3000 * (k + 1)); }
  }
  throw last;
}

// ----- 1. wallets --------------------------------------------------------------------------------
const keysPath = ".keys/wallets.json";
let wallets;
if (existsSync(keysPath)) {
  wallets = JSON.parse(readFileSync(keysPath, "utf8")).map((w) => Keypair.fromSecret(w.secret));
  log(`reusing ${wallets.length} wallets from ${keysPath}`);
} else {
  wallets = Array.from({ length: N_WALLETS }, () => Keypair.random());
  mkdirSync(".keys", { recursive: true });
  writeFileSync(keysPath, JSON.stringify(wallets.map((w) => ({ publicKey: w.publicKey(), secret: w.secret() })), null, 2));
  log(`created ${N_WALLETS} wallets`);
}
report.wallets = wallets.map((w, i) => ({ index: i + 1, label: `W${String(i + 1).padStart(2, "0")}`, publicKey: w.publicKey(), link: L.account(w.publicKey()) }));

log("phase 1: funding via friendbot");
for (const w of wallets) {
  const acct = await horizonAccount(n, w.publicKey());
  if (acct) continue;
  await withRetry(() => fund(n, w.publicKey()), 5, "friendbot");
  await sleep(400);
}
report.phases.push({ phase: "fund", note: `${N_WALLETS} wallets funded by friendbot` });

// ----- 2. trustlines (wallet 20 deliberately skips the chain-B asset) ---------------------------
log("phase 2: trustlines (W20 skips OFTB on purpose)");
await pMap(wallets, async (w, i) => {
  const acct = await horizonAccount(n, w.publicKey());
  const hasA = assetBalance(acct, A.asset_code, A.issuer) != null;
  const hasB = assetBalance(acct, B.asset_code, B.issuer) != null;
  if (!hasA) { const r = await withRetry(() => trust(n, w, A.asset_code, A.issuer), 3, "trust A"); tx("trust", { wallet: i + 1, action: `changeTrust ${A.asset_code}`, hash: r.hash, link: L.tx(r.hash) }); }
  if (i !== N_WALLETS - 1 && !hasB) { const r = await withRetry(() => trust(n, w, B.asset_code, B.issuer), 3, "trust B"); tx("trust", { wallet: i + 1, action: `changeTrust ${B.asset_code}`, hash: r.hash, link: L.tx(r.hash) }); }
}, 4);
report.phases.push({ phase: "trust", note: `trustlines for ${A.asset_code} on all 20; ${B.asset_code} on 19 (W20 left without one to show the retry path)` });

// ----- 3. seed chain A balances through the SAC Manager ------------------------------------------
log(`phase 3: owner mints ${SEED_AMOUNT} ${A.asset_code} to each wallet through sac_manager`);
for (const [i, w] of wallets.entries()) {
  const acct = await horizonAccount(n, w.publicKey());
  if (Number(assetBalance(acct, A.asset_code, A.issuer) ?? 0) >= Number(SEED_AMOUNT)) continue;
  const r = await withRetry(() => mint({ deploy: A, minter: owner, to: w.publicKey(), amount: SEED_AMOUNT }), 3, "mint");
  tx("seed", { wallet: i + 1, action: `mint ${SEED_AMOUNT} ${A.asset_code}`, hash: r.hash, link: L.tx(r.hash) });
  log(`  minted to W${String(i + 1).padStart(2, "0")}  ${r.hash.slice(0, 12)}…`);
}
report.phases.push({ phase: "seed", note: `${SEED_AMOUNT} ${A.asset_code} minted to each wallet by the owner (MINTER) through sac_manager` });

const snap = async (label) => {
  const rows = await pMap(wallets, async (w) => {
    const acct = await horizonAccount(n, w.publicKey());
    return { a: assetBalance(acct, A.asset_code, A.issuer), b: assetBalance(acct, B.asset_code, B.issuer) };
  }, 6);
  const sumA = rows.reduce((s, r) => s + Number(r.a ?? 0), 0);
  const sumB = rows.reduce((s, r) => s + Number(r.b ?? 0), 0);
  // value in flight: burned on the source chain, not yet delivered (pending on either endpoint)
  let inFlight = 0n;
  for (const d of [A, B]) {
    const pending = await view(n, owner.publicKey(), d.contracts.endpoint, "pending");
    for (const guid of pending) {
      const p = await view(n, owner.publicKey(), d.contracts.endpoint, "packet", [sc.bytesN(guid)]);
      inFlight += Buffer.from(p.message).readBigUInt64BE(33) * 10n;
    }
  }
  const inFlightNum = Number(inFlight) / 1e7;
  const snapshot = { label, rows, sumA: sumA.toFixed(7), sumB: sumB.toFixed(7), inFlight: inFlightNum.toFixed(7), total: (sumA + sumB + inFlightNum).toFixed(7) };
  report.phases.push({ phase: `balances:${label}`, ...snapshot });
  log(`  balances ${label}: A ${snapshot.sumA}  B ${snapshot.sumB}  in flight ${snapshot.inFlight}  total ${snapshot.total}`);
  return snapshot;
};
const before = await snap("after-seed");

// ----- 4. round 1: every wallet sends A -> B to itself -------------------------------------------
log("phase 4: round 1, A -> B, each wallet to itself (amounts carry a 7th-decimal stroop that must be dropped)");
const round1 = await pMap(wallets, async (w, i) => {
  const amount = (5 + i * 0.5 + 0.0000003).toFixed(7);
  const r = await withRetry(() => send({ deploy: A, from: w, to: w.publicKey(), dstEid: B.eid, amount, log: () => {} }), 3, `send W${i + 1}`);
  tx("round1", { wallet: i + 1, action: `send ${amount} ${A.asset_code} -> eid ${B.eid} (self)`, amount, amount_sent_ld: r.amount_sent_ld, guid: r.guid, hash: r.hash, link: L.tx(r.hash) });
  log(`  W${String(i + 1).padStart(2, "0")} sent ${amount} -> burned ${(Number(r.amount_sent_ld) / 1e7).toFixed(7)}  guid ${r.guid.slice(0, 12)}…`);
  return r;
}, 1);
report.phases.push({ phase: "round1-send", note: "20 sends A->B; each amount ends in 3 stroops of dust that stays with the sender" });

log("phase 5: relay A endpoint (expect 19 delivered, W20 fails: no trustline on chain B)");
const relay1 = await relay({ deploy: A, relayer: "owner", log });
for (const o of relay1.outcomes) tx("relay1", { action: o.delivered ? "deliver" : "deliver FAILED (retriable)", guid: o.guid, hash: o.hash, link: o.link, delivered: o.delivered });
const failed1 = relay1.outcomes.filter((o) => !o.delivered);
report.phases.push({ phase: "relay1", delivered: relay1.outcomes.length - failed1.length, failed: failed1.length, note: "a failed receive leaves the packet pending on the endpoint" });

log("phase 6: W20 creates its OFTB trustline, then the pending packet is retried");
{
  const w = wallets[N_WALLETS - 1];
  const r = await withRetry(() => trust(n, w, B.asset_code, B.issuer), 3, "trust B (W20)");
  tx("retry", { wallet: N_WALLETS, action: `changeTrust ${B.asset_code} (late)`, hash: r.hash, link: L.tx(r.hash) });
  const relayRetry = await relay({ deploy: A, relayer: "owner", log });
  for (const o of relayRetry.outcomes) tx("retry", { action: o.delivered ? "deliver (retry)" : "deliver FAILED", guid: o.guid, hash: o.hash, link: o.link, delivered: o.delivered });
  report.phases.push({ phase: "retry", delivered: relayRetry.outcomes.filter((o) => o.delivered).length, note: "the same packet, delivered once the trustline exists; nothing was re-sent" });
}
await snap("after-round1");

// ----- 5. round 2: B -> A, mixed destinations, plus the two expected rejections ---------------
log("phase 7: round 2, B -> A: W01-W10 to self, W11-W15 to the next wallet, W16 to a contract address; W17 dust and W18 slippage are rejected");
const vault = A.contracts.endpoint; // any contract (C...) address receives without a trustline
await pMap(wallets.slice(0, 16), async (w, i) => {
  let to = w.publicKey(), note = "self";
  if (i >= 10 && i < 15) { to = wallets[i + 1].publicKey(); note = `W${String(i + 2).padStart(2, "0")}`; }
  if (i === 15) { to = vault; note = "contract address (C…)"; }
  const amount = (2 + i * 0.25).toFixed(7);
  const r = await withRetry(() => send({ deploy: B, from: w, to, dstEid: A.eid, amount, log: () => {} }), 3, `send back W${i + 1}`);
  tx("round2", { wallet: i + 1, action: `send ${amount} ${B.asset_code} -> eid ${A.eid} (${note})`, to, amount, amount_sent_ld: r.amount_sent_ld, guid: r.guid, hash: r.hash, link: L.tx(r.hash) });
  log(`  W${String(i + 1).padStart(2, "0")} sent ${amount} back -> ${note}`);
}, 1);

for (const [idx, c] of [[16, { amount: "0.0000005", min: undefined, expect: 5, why: "dust below the conversion rate: nothing would arrive, so the send is refused before any burn" }],
                        [17, { amount: "1.0000005", min: "1.0000005", expect: 3, why: "min amount set above the post-dust amount: slippage guard" }]]) {
  const w = wallets[idx];
  try {
    await send({ deploy: B, from: w, to: w.publicKey(), dstEid: A.eid, amount: c.amount, minAmount: c.min, log: () => {} });
    report.errors_expected.push({ wallet: idx + 1, amount: c.amount, expected_error: c.expect, got: "SUCCESS (unexpected)", why: c.why });
    log(`  W${idx + 1} UNEXPECTED success for ${c.amount}`);
  } catch (e) {
    report.errors_expected.push({ wallet: idx + 1, amount: c.amount, min: c.min, expected_error: c.expect, got: e.contractError ?? e.message, ok: e.contractError === c.expect, why: c.why });
    log(`  W${idx + 1} rejected as expected: contract error #${e.contractError} (${c.expect === 5 ? "ZeroAmount" : "SlippageExceeded"})`);
  }
}
report.phases.push({ phase: "round2-send", note: "16 sends B->A with mixed recipients; W17 (dust) and W18 (slippage) rejected by the contract before any burn" });

log("phase 8: relay B endpoint");
const relay2 = await relay({ deploy: B, relayer: "owner", log });
for (const o of relay2.outcomes) tx("relay2", { action: o.delivered ? "deliver" : "deliver FAILED", guid: o.guid, hash: o.hash, link: o.link, delivered: o.delivered });
report.phases.push({ phase: "relay2", delivered: relay2.outcomes.filter((o) => o.delivered).length, failed: relay2.outcomes.filter((o) => !o.delivered).length });

// ----- 6. conservation ---------------------------------------------------------------------------
const after = await snap("final");
const vaultBal = Number(await view(n, owner.publicKey(), A.contracts.token, "balance", [sc.addr(vault)])) / 1e7;
const totalAfter = Number(after.total) + vaultBal;
report.conservation = {
  minted: before.total, wallets_after: after.total, contract_recipient: vault, contract_recipient_balance: vaultBal.toFixed(7),
  total_after: totalAfter.toFixed(7), conserved: Math.abs(Number(before.total) - totalAfter) < 1e-6,
  note: "burns on one chain equal mints on the other; dust never leaves the sender, so the sum over both chains is unchanged",
};
log(`conservation: minted ${before.total}, after ${totalAfter.toFixed(7)} (incl. ${vaultBal.toFixed(7)} at the contract recipient) -> ${report.conservation.conserved ? "OK" : "MISMATCH"}`);

const totals = { A: { sent: await view(n, owner.publicKey(), A.contracts.oft, "total_sent"), received: await view(n, owner.publicKey(), A.contracts.oft, "total_received") },
                 B: { sent: await view(n, owner.publicKey(), B.contracts.oft, "total_sent"), received: await view(n, owner.publicKey(), B.contracts.oft, "total_received") } };
report.oft_totals = Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, { sent: (Number(v.sent) / 1e7).toFixed(7), received: (Number(v.received) / 1e7).toFixed(7) }]));
report.finished_at = new Date().toISOString();
report.duration_s = Math.round((Date.now() - t0) / 1000);
report.tx_count = report.txs.length;

mkdirSync("sim", { recursive: true });
writeFileSync("sim/report.json", JSON.stringify(report, null, 2));
mkdirSync("web/public/data", { recursive: true });
copyFileSync("sim/report.json", "web/public/data/report.json");
for (const c of ["A", "B", "BROKEN"]) if (existsSync(`deploy/${c}.json`)) copyFileSync(`deploy/${c}.json`, `web/public/data/${c}.json`);

const md = [
  `# Simulation report (${report.network}, ${report.started_at})`, "",
  `${N_WALLETS} wallets, ${report.tx_count} transactions, ${report.duration_s} s.`, "",
  `| Phase | Result |`, `| --- | --- |`,
  ...report.phases.map((p) => `| ${p.phase} | ${p.note ?? ""}${p.delivered != null ? ` delivered ${p.delivered}` : ""}${p.failed != null ? `, failed ${p.failed}` : ""}${p.total ? ` A ${p.sumA} / B ${p.sumB} / total ${p.total}` : ""} |`),
  "", `Expected rejections: ${report.errors_expected.map((e) => `W${e.wallet} ${e.amount} -> error #${e.got}${e.ok ? " (as expected)" : " (UNEXPECTED)"}`).join("; ")}`, "",
  `Conservation: minted ${report.conservation.minted}, after ${report.conservation.total_after} -> ${report.conservation.conserved ? "conserved" : "MISMATCH"}.`, "",
  `OFT totals: A sent ${report.oft_totals.A.sent} / received ${report.oft_totals.A.received}; B sent ${report.oft_totals.B.sent} / received ${report.oft_totals.B.received}.`,
].join("\n");
writeFileSync("sim/report.md", md);
log(`wrote sim/report.json and sim/report.md (${report.tx_count} transactions)`);
