// oftkit: deploy the three-contract MintBurn pattern, link two chains, check a deployment
// against the documented rules, relay pending packets, and send.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { parse as parseToml } from "smol-toml";
import { Operation, Asset } from "@stellar/stellar-sdk";
import {
  net, loadKey, saveKey, fund, uploadWasm, deployContract, deploySac, invoke, view, submitClassic,
  sc, bytes32, addressFromBytes32, links, horizonAccount, masterWeight, sleep,
} from "./stellar.mjs";
import { Keypair } from "@stellar/stellar-sdk";

const WASM = {
  endpoint: "target/wasm32v1-none/release/mock_lz_endpoint.wasm",
  manager: "target/wasm32v1-none/release/sac_manager.wasm",
  oft: "target/wasm32v1-none/release/oft.wasm",
};
export const MSG_TYPE_SEND = 1;
export const MINTER = "MINTER";
export const DELIVERY = { Auto: 0, Manual: 1, Fail: 2 };

export function readConfig(path) {
  return parseToml(readFileSync(path, "utf8"));
}

export function readDeploy(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2));
}

// ----- keys ------------------------------------------------------------------------------------

export async function keysNew(name, { fundIt = true, network = "testnet", log = console.log } = {}) {
  const n = net(network);
  const kp = Keypair.random();
  saveKey(name, kp);
  log(`key ${name}: ${kp.publicKey()} (secret in .keys/${name}.json)`);
  if (fundIt) {
    await fund(n, kp.publicKey());
    log(`  funded by friendbot`);
  }
  return kp;
}

export async function ensureKey(name, { network = "testnet", log = console.log } = {}) {
  try {
    return loadKey(name);
  } catch {
    return keysNew(name, { network, log });
  }
}

// ----- deploy ----------------------------------------------------------------------------------

/**
 * Deploys one chain: SAC, SAC Manager (then set_admin), mock endpoint, OFT, MINTER grant to the
 * OFT (and to the owner when `owner_can_mint`). Writes a deployment record with every id and hash.
 */
export async function deploy({ config, chain, out, network, log = console.log, wasmHashes }) {
  const cfg = readConfig(config);
  const c = cfg.chains?.[chain];
  if (!c) throw new Error(`chain ${chain} not in ${config}`);
  const n = net(network ?? cfg.network ?? "testnet");
  const L = links(n);
  const owner = await ensureKey(c.owner, { network: n.name, log });
  const issuer = await ensureKey(c.issuer, { network: n.name, log });
  const sharedDecimals = Number(c.shared_decimals ?? cfg.shared_decimals ?? 6);
  const record = {
    chain, name: c.name ?? chain, network: n.name, eid: Number(c.eid), asset_code: c.asset_code,
    shared_decimals: sharedDecimals, owner: owner.publicKey(), issuer: issuer.publicKey(),
    contracts: {}, wasm: {}, txs: [], created_at: new Date().toISOString(),
  };
  const step = async (label, fn) => {
    log(`[${chain}] ${label} ...`);
    const r = await fn();
    if (r?.hash) {
      record.txs.push({ step: label, hash: r.hash, link: L.tx(r.hash) });
      log(`[${chain}]   tx ${r.hash}`);
    }
    return r;
  };

  // 1. Wasm (uploaded once per run and shared between chains)
  const cachePath = join("deploy", `wasm-${n.name}.json`);
  wasmHashes ??= existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  for (const [k, p] of Object.entries(WASM)) {
    if (!wasmHashes[k]) {
      const r = await step(`upload ${k} wasm`, () => uploadWasm(n, owner, p));
      wasmHashes[k] = r.wasmHash;
      writeJson(cachePath, wasmHashes);
    } else {
      log(`[${chain}] ${k} wasm already uploaded (${wasmHashes[k].slice(0, 12)}…)`);
    }
    record.wasm[k] = wasmHashes[k];
  }

  // 2. Token: a classic asset wrapped as a SAC
  const sacR = await step(`deploy SAC for ${c.asset_code}:${issuer.publicKey().slice(0, 6)}…`, () => deploySac(n, owner, c.asset_code, issuer.publicKey()));
  record.contracts.token = sacR.contractId;

  // 3. SAC Manager, then hand it the SAC admin role
  const mgrR = await step("deploy sac-manager", () => deployContract(n, owner, wasmHashes.manager, [sc.addr(owner.publicKey()), sc.addr(record.contracts.token)]));
  record.contracts.sac_manager = mgrR.contractId;
  await step("set_admin(SAC) -> sac-manager", () => invoke(n, issuer, record.contracts.token, "set_admin", [sc.addr(record.contracts.sac_manager)]));

  // 4. Endpoint: the mock, or an existing endpoint address from the config
  if (c.endpoint) {
    record.contracts.endpoint = c.endpoint;
    record.endpoint_is_mock = false;
  } else {
    const epR = await step(`deploy mock endpoint (eid ${c.eid})`, () => deployContract(n, owner, wasmHashes.endpoint, [sc.u32(c.eid)]));
    record.contracts.endpoint = epR.contractId;
    record.endpoint_is_mock = true;
  }

  // 5. OFT
  const oftR = await step("deploy oft", () => deployContract(n, owner, wasmHashes.oft, [
    sc.addr(owner.publicKey()), sc.addr(record.contracts.token), sc.addr(record.contracts.sac_manager),
    sc.addr(record.contracts.endpoint), sc.addr(issuer.publicKey()), sc.u32(sharedDecimals),
  ]));
  record.contracts.oft = oftR.contractId;

  // 6. Permissions
  await step("grant MINTER -> oft", () => invoke(n, owner, record.contracts.sac_manager, "grant_role", [sc.sym(MINTER), sc.addr(record.contracts.oft)]));
  if (c.owner_can_mint) {
    await step("grant MINTER -> owner (seeding)", () => invoke(n, owner, record.contracts.sac_manager, "grant_role", [sc.sym(MINTER), sc.addr(owner.publicKey())]));
  }

  // 7. Issuer lock (irreversible; testnet throwaway)
  if (c.lock_issuer) {
    await step("lock issuer (master weight 0)", () => submitClassic(n, issuer, [Operation.setOptions({ masterWeight: 0 })]));
    record.issuer_locked = true;
  }

  record.links = {
    token: L.contract(record.contracts.token), sac_manager: L.contract(record.contracts.sac_manager),
    endpoint: L.contract(record.contracts.endpoint), oft: L.contract(record.contracts.oft),
    owner: L.account(owner.publicKey()), issuer: L.account(issuer.publicKey()),
  };
  if (out) writeJson(out, record);
  log(`[${chain}] done: oft ${record.contracts.oft}`);
  return record;
}

// ----- link ------------------------------------------------------------------------------------

/** Registers remotes on both endpoints, sets peers and enforced options on both OFTs. */
export async function link({ a, b, options, deliveryMode = DELIVERY.Manual, log = console.log }) {
  const A = typeof a === "string" ? readDeploy(a) : a;
  const B = typeof b === "string" ? readDeploy(b) : b;
  const n = net(A.network);
  const L = links(n);
  const ownerA = loadKey(keyNameFor(A, "owner"));
  const ownerB = loadKey(keyNameFor(B, "owner"));
  const opts = Buffer.from((options ?? "0003010011010000000000000000000000000000c350").replace(/^0x/, ""), "hex");
  const txs = [];
  const step = async (label, fn) => { log(`${label} ...`); const r = await fn(); txs.push({ step: label, hash: r.hash, link: L.tx(r.hash) }); log(`  tx ${r.hash}`); return r; };

  if (A.endpoint_is_mock) {
    await step(`endpoint ${A.chain}: set_remote(${B.eid})`, () => invoke(n, ownerA, A.contracts.endpoint, "set_remote", [sc.u32(B.eid), sc.addr(B.contracts.endpoint)]));
    await step(`endpoint ${A.chain}: delivery mode ${deliveryMode}`, () => invoke(n, ownerA, A.contracts.endpoint, "set_delivery_mode", [sc.u32(deliveryMode)]));
  }
  if (B.endpoint_is_mock) {
    await step(`endpoint ${B.chain}: set_remote(${A.eid})`, () => invoke(n, ownerB, B.contracts.endpoint, "set_remote", [sc.u32(A.eid), sc.addr(A.contracts.endpoint)]));
    await step(`endpoint ${B.chain}: delivery mode ${deliveryMode}`, () => invoke(n, ownerB, B.contracts.endpoint, "set_delivery_mode", [sc.u32(deliveryMode)]));
  }
  await step(`oft ${A.chain}: set_peer(${B.eid}, ${B.contracts.oft.slice(0, 8)}…)`, () => invoke(n, ownerA, A.contracts.oft, "set_peer", [sc.u32(B.eid), sc.bytesN(bytes32(B.contracts.oft).key)]));
  await step(`oft ${B.chain}: set_peer(${A.eid}, ${A.contracts.oft.slice(0, 8)}…)`, () => invoke(n, ownerB, B.contracts.oft, "set_peer", [sc.u32(A.eid), sc.bytesN(bytes32(A.contracts.oft).key)]));
  await step(`oft ${A.chain}: set_enforced_options(${B.eid}, SEND)`, () => invoke(n, ownerA, A.contracts.oft, "set_enforced_options", [sc.u32(B.eid), sc.u32(MSG_TYPE_SEND), sc.bytes(opts)]));
  await step(`oft ${B.chain}: set_enforced_options(${A.eid}, SEND)`, () => invoke(n, ownerB, B.contracts.oft, "set_enforced_options", [sc.u32(A.eid), sc.u32(MSG_TYPE_SEND), sc.bytes(opts)]));
  return { txs, options: opts.toString("hex") };
}

function keyNameFor(record, role) {
  // deployment records store public keys; key files are looked up by chain config name.
  // Convention: .keys/<role><chain>.json or .keys/owner.json for a shared owner.
  const shared = join(process.cwd(), ".keys", `${role}.json`);
  const perChain = join(process.cwd(), ".keys", `${role}${record.chain}.json`);
  if (existsSync(perChain)) {
    const k = JSON.parse(readFileSync(perChain, "utf8"));
    if (k.publicKey === record[role]) return `${role}${record.chain}`;
  }
  if (existsSync(shared)) {
    const k = JSON.parse(readFileSync(shared, "utf8"));
    if (k.publicKey === record[role]) return role;
  }
  throw new Error(`no key file in .keys matches ${role} ${record[role]} of chain ${record.chain}`);
}

// ----- check -----------------------------------------------------------------------------------

/**
 * Reads a deployed OFT and reports pass/fail per documented rule. Never submits a transaction.
 * remotes: [{ eid }] expected peers. sharedDecimals: expected value (optional).
 */
export async function check({ oft, remotes = [], sharedDecimals, network = "testnet", viewer, log = console.log }) {
  const n = net(network);
  const results = [];
  const add = (rule, ok, detail, info) => results.push({ rule, status: ok === null ? "info" : ok ? "pass" : "fail", detail, ...(info ? { info } : {}) });

  const viewerKey = viewer ?? (await anyFundedViewer(n));
  const V = (id, m, args = []) => view(n, viewerKey, id, m, args);

  const token = await V(oft, "token");
  const manager = await V(oft, "sac_manager");
  const endpoint = await V(oft, "endpoint");
  const issuer = await V(oft, "issuer");
  const shared = Number(await V(oft, "shared_decimals"));
  const local = Number(await V(oft, "local_decimals"));
  const owner = await V(oft, "owner");

  // Rule 1: a non-empty peer for every configured remote
  for (const r of remotes) {
    const peer = await V(oft, "peer", [sc.u32(r.eid)]);
    const empty = peer == null || (Buffer.isBuffer(peer) && peer.every((b) => b === 0));
    add(`peer[${r.eid}] set`, !empty, empty ? "peer is None (the stellar-cli 25.1.0 Option<BytesN<32>> footgun looks exactly like this)" : `peer = ${addressFromBytes32(peer, true)}`);
  }
  if (remotes.length === 0) add("peer[*] set", null, "no remote eids given; pass --remotes to check peers");

  // Rule 2: enforced options for SEND on every remote
  for (const r of remotes) {
    const o = await V(oft, "enforced_options", [sc.u32(r.eid), sc.u32(MSG_TYPE_SEND)]);
    const present = o && o.length > 0;
    add(`enforced_options[${r.eid}, SEND] present`, present, present ? `0x${Buffer.from(o).toString("hex")}` : "none set; sends to this remote carry no executor options");
  }

  // Rule 3: issuer master weight is zero
  const issuerAcct = await horizonAccount(n, issuer);
  const mw = masterWeight(issuerAcct);
  add("issuer master weight = 0", mw === 0, mw === null ? `issuer ${issuer} not found on Horizon` : `issuer ${issuer} master weight ${mw}${mw === 0 ? "" : " (the RBAC model can be bypassed by the issuer key)"}`);

  // Rule 4: SAC admin is the SAC Manager
  const admin = await V(token, "admin");
  add("SAC admin = sac_manager", admin === manager, admin === manager ? `admin ${admin}` : `SAC admin is ${admin}, expected ${manager}`);

  // Rule 5: MINTER granted to the OFT
  const hasRole = await V(manager, "has_role", [sc.sym(MINTER), sc.addr(oft)]);
  add("MINTER role granted to oft", Boolean(hasRole), hasRole ? "sac_manager.has_role(MINTER, oft) = true" : "the OFT cannot mint on receive");

  // Rule 6: shared decimals as configured and not above local
  const decOk = shared <= local && (sharedDecimals == null || Number(sharedDecimals) === shared);
  add("shared decimals", decOk, `shared ${shared}, local ${local}${sharedDecimals != null ? `, expected ${sharedDecimals}` : ""} (conversion rate 10^${local - shared}; this value cannot be changed after deployment)`);

  // Informational
  const paused = await V(manager, "is_paused");
  add("sac_manager paused", null, paused ? "PAUSED: receives will fail until unpaused" : "not paused");
  let endpointInfo = `endpoint ${endpoint}`;
  try {
    const eid = await V(endpoint, "eid");
    const mode = await V(endpoint, "delivery_mode");
    const pending = await V(endpoint, "pending");
    endpointInfo += ` (mock, eid ${eid}, delivery mode ${["Auto", "Manual", "Fail"][Number(mode)] ?? mode}, ${pending.length} pending)`;
    for (const r of remotes) {
      const rem = await V(endpoint, "remote", [sc.u32(r.eid)]);
      add(`endpoint remote[${r.eid}] registered`, rem != null, rem ? `-> ${rem}` : "no endpoint registered for this eid; nothing can be delivered there");
    }
  } catch { endpointInfo += " (not a mock endpoint; skipping routing checks)"; }
  add("endpoint", null, endpointInfo);

  const summary = { oft, owner, token, sac_manager: manager, endpoint, issuer, shared_decimals: shared, local_decimals: local, network };
  const failed = results.filter((r) => r.status === "fail").length;
  return { ok: failed === 0, failed, results, summary };
}

async function anyFundedViewer(n) {
  // Any funded account works for simulation; use the first key file present, else create one.
  for (const name of ["owner", "viewer"]) {
    try { return loadKey(name).publicKey(); } catch {}
  }
  const kp = await keysNew("viewer", { network: n.name, log: () => {} });
  return kp.publicKey();
}

export function formatCheck(report) {
  const w = Math.max(...report.results.map((r) => r.rule.length));
  const lines = [];
  lines.push(`oftkit check  ${report.summary.oft}  (${report.summary.network})`);
  lines.push(`  token ${report.summary.token}`);
  lines.push(`  sac_manager ${report.summary.sac_manager}`);
  lines.push(`  endpoint ${report.summary.endpoint}`);
  lines.push("");
  for (const r of report.results) {
    const tag = r.status === "pass" ? "PASS" : r.status === "fail" ? "FAIL" : "INFO";
    lines.push(`  ${tag}  ${r.rule.padEnd(w)}  ${r.detail}`);
  }
  lines.push("");
  lines.push(report.ok ? "  result: PASS (no failing rules)" : `  result: FAIL (${report.failed} failing rule${report.failed > 1 ? "s" : ""})`);
  return lines.join("\n");
}

// ----- relay -----------------------------------------------------------------------------------

/** Delivers every pending packet on a mock endpoint once. Returns per-guid outcomes. */
export async function relay({ deploy: dep, relayer, log = console.log }) {
  const D = typeof dep === "string" ? readDeploy(dep) : dep;
  const n = net(D.network);
  const L = links(n);
  const kp = relayer ? loadKey(relayer) : loadKey(keyNameFor(D, "owner"));
  const pending = await view(n, kp.publicKey(), D.contracts.endpoint, "pending");
  const out = [];
  for (const guid of pending) {
    const hex = Buffer.from(guid).toString("hex");
    try {
      const r = await invoke(n, kp, D.contracts.endpoint, "deliver", [sc.bytesN(guid)]);
      const delivered = r.native === true;
      out.push({ guid: hex, delivered, hash: r.hash, link: L.tx(r.hash) });
      log(`  ${delivered ? "delivered" : "FAILED   "} ${hex.slice(0, 16)}…  tx ${r.hash}`);
    } catch (e) {
      out.push({ guid: hex, delivered: false, error: String(e.message) });
      log(`  error     ${hex.slice(0, 16)}…  ${e.message}`);
    }
  }
  return { pending: pending.length, outcomes: out };
}

// ----- send ------------------------------------------------------------------------------------

/** Sends `amount` (decimal string) from key `from` through the OFT on `deploy` to `to` on `dstEid`. */
export async function send({ deploy: dep, from, to, dstEid, amount, minAmount, log = console.log }) {
  const D = typeof dep === "string" ? readDeploy(dep) : dep;
  const n = net(D.network);
  const L = links(n);
  const kp = typeof from === "string" ? loadKey(from) : from;
  const t = bytes32(to);
  const amountLd = BigInt(Math.round(Number(amount) * 1e7));
  const minLd = minAmount != null ? BigInt(Math.round(Number(minAmount) * 1e7)) : 0n;
  const args = [sc.addr(kp.publicKey()), sc.u32(dstEid), sc.bytesN(t.key), sc.bool(t.isContract), sc.i128(amountLd), sc.i128(minLd)];
  // A send simulated against a stale outbound nonce traps on apply (its packet key was not in the
  // footprint). Re-simulate and resubmit up to three times; contract errors are not retried.
  let r, lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { r = await invoke(n, kp, D.contracts.oft, "send", args); break; }
    catch (e) { lastErr = e; if (e.contractError != null) throw e; await sleep(2500); }
  }
  if (!r) throw lastErr;
  const receipt = r.native;
  const guid = receipt?.guid ? Buffer.from(receipt.guid).toString("hex") : null;
  log(`sent ${amount} -> eid ${dstEid} ${to.slice(0, 8)}…  guid ${guid?.slice(0, 16)}…  tx ${r.hash}`);
  return { hash: r.hash, link: L.tx(r.hash), guid, amount_sent_ld: receipt?.amount_sent_ld?.toString(), amount_received_ld: receipt?.amount_received_ld?.toString() };
}

export async function trust(n, kp, code, issuer) {
  return submitClassic(n, kp, [Operation.changeTrust({ asset: new Asset(code, issuer) })]);
}

export async function mint({ deploy: dep, minter, to, amount }) {
  const D = typeof dep === "string" ? readDeploy(dep) : dep;
  const n = net(D.network);
  const kp = typeof minter === "string" ? loadKey(minter) : minter;
  const amountLd = BigInt(Math.round(Number(amount) * 1e7));
  return invoke(n, kp, D.contracts.sac_manager, "mint", [sc.addr(kp.publicKey()), sc.addr(to), sc.i128(amountLd)]);
}

export { net, loadKey, view, sc, bytes32, addressFromBytes32, links, sleep, fund };
