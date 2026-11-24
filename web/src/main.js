// OFT Testkit dashboard: static data from the deployment records and the simulation report,
// live data (balances, check rules, pending packets) read from testnet RPC and Horizon.
import { Buffer } from "buffer";
globalThis.Buffer = Buffer;
import { rpc, Horizon, TransactionBuilder, Contract, nativeToScVal, scValToNative, Address, StrKey, xdr, BASE_FEE } from "@stellar/stellar-sdk";

const RPC = "https://soroban-testnet.stellar.org";
const HORIZON = "https://horizon-testnet.stellar.org";
const PASS = "Test SDF Network ; September 2015";
const EXPLORER = "https://stellar.expert/explorer/testnet";
const server = new rpc.Server(RPC);
const horizon = new Horizon.Server(HORIZON);
const $ = (s) => document.querySelector(s);
const short = (s, n = 8) => `${s.slice(0, n)}…${s.slice(-4)}`;
const link = (href, text) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
const txLink = (h) => link(`${EXPLORER}/tx/${h}`, short(h, 10));

const data = {};
async function loadStatic() {
  for (const f of ["A", "B", "BROKEN", "report"]) {
    try { data[f] = await (await fetch(`./data/${f}.json`, { cache: "no-store" })).json(); } catch { data[f] = null; }
  }
}

// ----- read-only contract views via simulation ----------------------------------------------
let viewer;
async function viewerAccount() {
  if (!viewer) viewer = await server.getAccount(data.A.owner);
  return viewer;
}
async function view(contractId, method, args = []) {
  const acct = await viewerAccount();
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: PASS }).addOperation(new Contract(contractId).call(method, ...args)).setTimeout(60).build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) throw new Error(sim.error ?? "simulation failed");
  return scValToNative(sim.result.retval);
}
const u32 = (v) => nativeToScVal(Number(v), { type: "u32" });
const sym = (s) => nativeToScVal(s, { type: "symbol" });
const addr = (a) => new Address(a).toScVal();

// ----- chain cards ----------------------------------------------------------------------------
function chainCard(d, pending) {
  const c = d.contracts;
  return `<h2>${d.name} <span class="pill">${d.asset_code}</span></h2>
  <div class="kv">
    <span class="k">OFT</span><span>${link(`${EXPLORER}/contract/${c.oft}`, c.oft)}</span>
    <span class="k">Token (SAC)</span><span>${link(`${EXPLORER}/contract/${c.token}`, c.token)}</span>
    <span class="k">SAC Manager</span><span>${link(`${EXPLORER}/contract/${c.sac_manager}`, c.sac_manager)}</span>
    <span class="k">Mock endpoint</span><span>${link(`${EXPLORER}/contract/${c.endpoint}`, c.endpoint)}</span>
    <span class="k">Issuer</span><span>${link(`${EXPLORER}/account/${d.issuer}`, d.issuer)} ${d.issuer_locked ? '<span class="pill">locked</span>' : ""}</span>
    <span class="k">Owner</span><span>${link(`${EXPLORER}/account/${d.owner}`, d.owner)}</span>
    <span class="k">Shared decimals</span><span>${d.shared_decimals} (local 7, rate 10)</span>
    <span class="k">Pending packets</span><span id="pending-${d.chain}">${pending ?? "…"}</span>
    <span class="k">Deployed</span><span>${new Date(d.created_at).toLocaleString()} · ${d.txs.length} transactions</span>
  </div>`;
}

// ----- check rules (mirrors lib/oftkit.mjs check) ---------------------------------------------
async function runCheck(d, remoteEid, sharedExpected = 6) {
  const oft = d.contracts.oft;
  const rows = [];
  const add = (rule, ok, detail) => rows.push({ rule, status: ok === null ? "info" : ok ? "pass" : "fail", detail });
  const [token, manager, endpoint, issuer, shared, local] = await Promise.all([
    view(oft, "token"), view(oft, "sac_manager"), view(oft, "endpoint"), view(oft, "issuer"), view(oft, "shared_decimals"), view(oft, "local_decimals"),
  ]);
  const peer = await view(oft, "peer", [u32(remoteEid)]);
  const empty = peer == null || (peer.length && [...peer].every((b) => b === 0));
  add(`peer[${remoteEid}] set`, !empty, empty ? "peer is None" : `peer = ${StrKey.encodeContract(Buffer.from(peer))}`);
  const opts = await view(oft, "enforced_options", [u32(remoteEid), u32(1)]);
  add(`enforced_options[${remoteEid}, SEND]`, opts && opts.length > 0, opts && opts.length ? `0x${Buffer.from(opts).toString("hex")}` : "none set");
  let mw = null;
  try { const acct = await horizon.loadAccount(issuer); const m = acct.signers.find((s) => s.key === issuer); mw = m ? m.weight : 0; } catch {}
  add("issuer master weight = 0", mw === 0, mw === null ? "issuer not found" : `master weight ${mw}${mw === 0 ? "" : " (issuer can bypass the RBAC model)"}`);
  const admin = await view(token, "admin");
  add("SAC admin = sac_manager", admin === manager, admin === manager ? short(admin, 10) : `admin is ${short(admin, 10)}`);
  const hasRole = await view(manager, "has_role", [sym("MINTER"), addr(oft)]);
  add("MINTER granted to oft", Boolean(hasRole), hasRole ? "has_role = true" : "the OFT cannot mint on receive");
  add("shared decimals", Number(shared) <= Number(local) && Number(shared) === sharedExpected, `shared ${shared}, local ${local}, expected ${sharedExpected}`);
  try {
    const rem = await view(endpoint, "remote", [u32(remoteEid)]);
    add(`endpoint remote[${remoteEid}]`, rem != null, rem ? `-> ${short(rem, 10)}` : "no endpoint registered for this eid");
    const mode = await view(endpoint, "delivery_mode");
    const pending = await view(endpoint, "pending");
    add("endpoint", null, `mock, delivery ${["Auto", "Manual", "Fail"][Number(mode)]}, ${pending.length} pending`);
  } catch { add("endpoint", null, "not a mock endpoint"); }
  const failed = rows.filter((r) => r.status === "fail").length;
  return { rows, ok: failed === 0, failed };
}
function renderCheck(el, r) {
  el.innerHTML = r.rows.map((x) => `<div class="row"><span class="tag ${x.status}">${x.status.toUpperCase()}</span><div><div class="rule">${x.rule}</div><div class="detail">${x.detail}</div></div></div>`).join("")
    + `<div class="result ${r.ok ? "pass" : "fail"}">${r.ok ? "PASS — no failing rules" : `FAIL — ${r.failed} failing rule${r.failed > 1 ? "s" : ""}`}</div>`;
}

// ----- wallets ----------------------------------------------------------------------------------
async function balances(pub) {
  try {
    const a = await horizon.loadAccount(pub);
    const bal = (code, issuer) => { const b = a.balances.find((x) => x.asset_code === code && x.asset_issuer === issuer); return b ? b.balance : null; };
    return { a: bal(data.A.asset_code, data.A.issuer), b: bal(data.B.asset_code, data.B.issuer) };
  } catch { return { a: null, b: null }; }
}
async function renderWallets() {
  const r = data.report;
  const tbody = $("#wallets tbody");
  if (!r) { tbody.innerHTML = `<tr><td colspan="6" class="muted">no simulation report yet</td></tr>`; return; }
  const rows = await Promise.all(r.wallets.map(async (w) => ({ w, b: await balances(w.publicKey) })));
  const byWallet = (phase, i) => r.txs.filter((t) => t.phase === phase && t.wallet === i);
  tbody.innerHTML = rows.map(({ w, b }) => {
    const r1 = byWallet("round1", w.index)[0];
    const r2 = byWallet("round2", w.index)[0];
    const rej = r.errors_expected.find((e) => e.wallet === w.index);
    return `<tr><td>${w.index}</td><td>${link(w.link, short(w.publicKey, 6))}</td>
      <td class="num">${b.a ?? '<span class="none">no trustline</span>'}</td>
      <td class="num${b.b == null ? " none" : ""}">${b.b ?? "no trustline"}</td>
      <td>${r1 ? `${r1.amount} → B ${txLink(r1.hash)}` : ""}</td>
      <td>${r2 ? `${r2.amount} → A ${txLink(r2.hash)}` : rej ? `<span class="tag fail">rejected #${rej.got}</span> ${rej.amount}` : ""}</td></tr>`;
  }).join("");
}

// ----- phases and tx log ------------------------------------------------------------------------
function renderSim() {
  const r = data.report;
  if (!r) { $("#conservation").style.display = "none"; $("#phases").innerHTML = '<span class="muted">no simulation report yet</span>'; return; }
  $("#sim-meta").textContent = `${r.wallets.length} wallets · ${r.tx_count} transactions · ${r.duration_s}s · ${new Date(r.started_at).toLocaleString()}`;
  $("#phases").innerHTML = r.phases.map((p) => `<div class="phase"><div class="name">${p.phase}</div><div>${p.note ?? ""}${p.delivered != null ? ` delivered <b>${p.delivered}</b>` : ""}${p.failed != null ? `, failed <b>${p.failed}</b>` : ""}${p.total ? `<br>A ${p.sumA} · B ${p.sumB} · total <b>${p.total}</b>` : ""}</div></div>`).join("");
  const c = r.conservation;
  $("#conservation").className = `conservation${c.conserved ? "" : " bad"}`;
  $("#conservation").innerHTML = `<b>Conservation ${c.conserved ? "holds" : "BROKEN"}:</b> minted ${c.minted} · after ${c.total_after} (incl. ${c.contract_recipient_balance} at the contract recipient) · OFT A sent ${r.oft_totals.A.sent}, received ${r.oft_totals.A.received} · OFT B sent ${r.oft_totals.B.sent}, received ${r.oft_totals.B.received}<br><span class="muted">${c.note}</span>
    <br><span class="muted">Expected rejections: ${r.errors_expected.map((e) => `W${e.wallet} ${e.amount} → contract error #${e.got} (${e.ok ? "as expected" : "unexpected"})`).join("; ")}</span>`;
  const phases = [...new Set(r.txs.map((t) => t.phase))];
  let active = "all";
  const draw = () => {
    const rows = r.txs.filter((t) => active === "all" || t.phase === active);
    $("#tx-count").textContent = `${rows.length} shown`;
    $("#txs tbody").innerHTML = rows.map((t) => `<tr><td><span class="pill">${t.phase}</span></td><td>${t.wallet ? `W${String(t.wallet).padStart(2, "0")}` : ""}</td><td>${t.action}${t.delivered === false ? ' <span class="tag fail">pending</span>' : ""}</td><td>${t.hash ? txLink(t.hash) : t.error ?? ""}</td></tr>`).join("");
    $("#filters").innerHTML = ["all", ...phases].map((p) => `<button data-p="${p}" class="${p === active ? "on" : ""}">${p}</button>`).join("");
    $("#filters").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { active = b.dataset.p; draw(); }));
  };
  draw();
}

// ----- live refresh -----------------------------------------------------------------------------
async function refresh() {
  const btn = $("#refresh"); btn.disabled = true;
  try {
    const [pa, pb] = await Promise.all([view(data.A.contracts.endpoint, "pending"), view(data.B.contracts.endpoint, "pending")]);
    $("#chain-A").innerHTML = chainCard(data.A, pa.length);
    $("#chain-B").innerHTML = chainCard(data.B, pb.length);
    const [ca, cb] = await Promise.all([runCheck(data.A, data.B.eid), data.BROKEN ? runCheck(data.BROKEN, data.B.eid) : null]);
    renderCheck($("#check-A"), ca);
    if (cb) renderCheck($("#check-BROKEN"), cb);
    await renderWallets();
    $("#clock").textContent = `live as of ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    $("#clock").textContent = `refresh failed: ${e.message}`;
  } finally { btn.disabled = false; }
}

(async () => {
  await loadStatic();
  $("#chain-A").innerHTML = chainCard(data.A);
  $("#chain-B").innerHTML = chainCard(data.B);
  renderSim();
  $("#refresh").addEventListener("click", refresh);
  refresh();
})();
