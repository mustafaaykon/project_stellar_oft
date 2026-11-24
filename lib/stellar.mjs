// Thin helpers over @stellar/stellar-sdk for testnet work: keys, funding, Wasm upload, contract
// deployment, invocation with the source account's auth, read-only views, and Horizon reads.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  rpc, Horizon, Keypair, TransactionBuilder, Operation, Asset, Address, Contract,
  nativeToScVal, scValToNative, xdr, StrKey, BASE_FEE,
} from "@stellar/stellar-sdk";

export const NETWORKS = {
  testnet: {
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    passphrase: "Test SDF Network ; September 2015",
    friendbot: "https://friendbot.stellar.org",
    explorer: "https://stellar.expert/explorer/testnet",
  },
};

export function net(name = "testnet") {
  const n = NETWORKS[name];
  if (!n) throw new Error(`unknown network ${name}; this kit is testnet-only`);
  return { name, ...n, server: new rpc.Server(n.rpcUrl), horizon: new Horizon.Server(n.horizonUrl) };
}

// ----- keys ------------------------------------------------------------------------------------

export const KEYS_DIR = join(process.cwd(), ".keys");

export function loadKey(name) {
  const p = join(KEYS_DIR, `${name}.json`);
  if (!existsSync(p)) throw new Error(`no key named ${name}; run: oftkit keys new ${name}`);
  return Keypair.fromSecret(JSON.parse(readFileSync(p, "utf8")).secret);
}

export function saveKey(name, kp) {
  mkdirSync(KEYS_DIR, { recursive: true });
  writeFileSync(join(KEYS_DIR, `${name}.json`), JSON.stringify({ publicKey: kp.publicKey(), secret: kp.secret() }, null, 2));
}

export async function fund(n, publicKey) {
  const r = await fetch(`${n.friendbot}?addr=${encodeURIComponent(publicKey)}`);
  if (!r.ok && r.status !== 400) throw new Error(`friendbot ${r.status}: ${await r.text()}`);
  return r.ok;
}

// ----- transactions ----------------------------------------------------------------------------

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollTx(server, hash, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = await server.getTransaction(hash);
    if (t.status === "SUCCESS") return t;
    if (t.status === "FAILED") {
      const err = new Error(`transaction ${hash} failed`);
      err.tx = t;
      throw err;
    }
    await sleep(1500);
  }
  throw new Error(`transaction ${hash} not found after ${timeoutMs} ms`);
}

/** Builds, simulates, signs with `signer`, submits and waits. Returns { hash, returnValue, native }. */
export async function submit(n, signer, operations, { memo } = {}) {
  const account = await n.server.getAccount(signer.publicKey());
  const b = new TransactionBuilder(account, { fee: (Number(BASE_FEE) * 100).toString(), networkPassphrase: n.passphrase });
  for (const op of operations) b.addOperation(op);
  const tx = b.setTimeout(120).build();
  let prepared;
  try {
    prepared = await n.server.prepareTransaction(tx);
  } catch (e) {
    throw decorateSimError(e);
  }
  prepared.sign(signer);
  const sent = await n.server.sendTransaction(prepared);
  if (sent.status === "ERROR" || sent.status === "DUPLICATE" || sent.status === "TRY_AGAIN_LATER") {
    const err = new Error(`send ${sent.status}: ${sent.errorResult ? JSON.stringify(sent.errorResult) : ""}`);
    err.sent = sent;
    throw err;
  }
  const done = await pollTx(n.server, sent.hash);
  const returnValue = done.returnValue;
  return { hash: sent.hash, returnValue, native: returnValue ? safeNative(returnValue) : undefined };
}

function safeNative(v) {
  try { return scValToNative(v); } catch { return undefined; }
}

/** Turns a simulation failure into an error carrying the contract error code, when there is one. */
function decorateSimError(e) {
  const msg = String(e?.message ?? e);
  const m = msg.match(/Error\(Contract, #(\d+)\)/);
  const err = new Error(msg);
  if (m) err.contractError = Number(m[1]);
  err.simulation = true;
  return err;
}

/** Classic (non-Soroban) submit: no simulation step. */
export async function submitClassic(n, signer, operations) {
  const account = await n.server.getAccount(signer.publicKey());
  const b = new TransactionBuilder(account, { fee: (Number(BASE_FEE) * 10).toString(), networkPassphrase: n.passphrase });
  for (const op of operations) b.addOperation(op);
  const tx = b.setTimeout(120).build();
  tx.sign(signer);
  const sent = await n.server.sendTransaction(tx);
  if (sent.status !== "PENDING") throw new Error(`send ${sent.status}: ${JSON.stringify(sent.errorResult ?? "")}`);
  await pollTx(n.server, sent.hash);
  return { hash: sent.hash };
}

export async function uploadWasm(n, signer, wasmPath) {
  const wasm = readFileSync(wasmPath);
  const r = await submit(n, signer, [Operation.uploadContractWasm({ wasm })]);
  return { hash: r.hash, wasmHash: Buffer.from(r.returnValue.bytes()).toString("hex") };
}

export async function deployContract(n, signer, wasmHashHex, constructorArgs = []) {
  const r = await submit(n, signer, [
    Operation.createCustomContract({
      address: new Address(signer.publicKey()),
      wasmHash: Buffer.from(wasmHashHex, "hex"),
      salt: Keypair.random().rawPublicKey(),
      constructorArgs,
    }),
  ]);
  return { hash: r.hash, contractId: Address.fromScVal(r.returnValue).toString() };
}

export async function deploySac(n, signer, code, issuerPublicKey) {
  const r = await submit(n, signer, [Operation.createStellarAssetContract({ asset: new Asset(code, issuerPublicKey) })]);
  return { hash: r.hash, contractId: Address.fromScVal(r.returnValue).toString() };
}

export async function invoke(n, signer, contractId, method, args = []) {
  const r = await submit(n, signer, [new Contract(contractId).call(method, ...args)]);
  return r;
}

/** Read-only call through simulation. `viewer` is any funded public key. */
export async function view(n, viewerPublicKey, contractId, method, args = []) {
  const account = await n.server.getAccount(viewerPublicKey);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: n.passphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(60)
    .build();
  const sim = await n.server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) {
    const err = new Error(`view ${method} failed: ${sim.error ?? "simulation error"}`);
    const m = String(sim.error ?? "").match(/Error\(Contract, #(\d+)\)/);
    if (m) err.contractError = Number(m[1]);
    throw err;
  }
  return scValToNative(sim.result.retval);
}

// ----- ScVal helpers ---------------------------------------------------------------------------

export const sc = {
  addr: (s) => new Address(s).toScVal(),
  u32: (v) => nativeToScVal(Number(v), { type: "u32" }),
  u64: (v) => nativeToScVal(BigInt(v), { type: "u64" }),
  i128: (v) => nativeToScVal(BigInt(v), { type: "i128" }),
  bool: (v) => xdr.ScVal.scvBool(Boolean(v)),
  sym: (s) => nativeToScVal(s, { type: "symbol" }),
  bytes: (b) => nativeToScVal(Buffer.from(b), { type: "bytes" }),
  bytesN: (b) => xdr.ScVal.scvBytes(Buffer.from(b)),
  none: () => xdr.ScVal.scvVoid(),
  some: (v) => v,
};

/** The 32-byte payload of a G or C address, and whether it is a contract. */
export function bytes32(addressStr) {
  if (StrKey.isValidContract(addressStr)) return { key: StrKey.decodeContract(addressStr), isContract: true };
  if (StrKey.isValidEd25519PublicKey(addressStr)) return { key: StrKey.decodeEd25519PublicKey(addressStr), isContract: false };
  throw new Error(`not a Stellar address: ${addressStr}`);
}

export function addressFromBytes32(buf, isContract) {
  return isContract ? StrKey.encodeContract(Buffer.from(buf)) : StrKey.encodeEd25519PublicKey(Buffer.from(buf));
}

export const toStroops = (amount) => BigInt(Math.round(Number(amount) * 1e7));
export const fromStroops = (s) => (Number(BigInt(s)) / 1e7).toFixed(7);

export const links = (n) => ({
  tx: (h) => `${n.explorer}/tx/${h}`,
  contract: (c) => `${n.explorer}/contract/${c}`,
  account: (a) => `${n.explorer}/account/${a}`,
});

// ----- Horizon reads ---------------------------------------------------------------------------

export async function horizonAccount(n, publicKey) {
  try {
    return await n.horizon.loadAccount(publicKey);
  } catch (e) {
    if (e?.response?.status === 404) return null;
    throw e;
  }
}

export function masterWeight(account) {
  if (!account) return null;
  const master = account.signers.find((s) => s.key === account.account_id);
  return master ? master.weight : 0;
}

export function assetBalance(account, code, issuer) {
  if (!account) return null;
  const b = account.balances.find((x) => x.asset_code === code && x.asset_issuer === issuer);
  return b ? b.balance : null; // null = no trustline
}
