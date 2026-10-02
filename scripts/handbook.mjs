/** Project knowledge uses short DB commits, leased publication and lock-free reads. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as S from "./store.mjs";
import { sanitize } from "./policy-core.mjs";
import { hash } from "./git.mjs";
import { strings } from "./contracts.mjs";
export const HANDBOOK_LIMIT = 16000;
export const LEASE_MS = 60000;
const marker = "\n[Handbook truncated at 16000 characters.]";
const publishing = new Map();
const directory = () => path.join(S.stateRoot(), "handbooks");
const empty = () => ({ version: 0, text: "", hash: hash(""), size: 0, truncated: false });
const row = key => S.extension("handbook", key) || empty();
/** Recorded batch children share their parent project's handbook, including nested batches. */
export function projectCwd(cwd) {
  let current = S.workspace(cwd);
  const seen = new Set();
  const batches = S.extensions("batch");
  while (!seen.has(S.key(current))) {
    seen.add(S.key(current));
    const batch = batches.find(b => b.children?.some(c => S.key(path.resolve(c.cwd)) === S.key(current)));
    if (!batch) return current;
    current = S.workspace(batch.cwd);
  }
  throw new Error("Cyclic batch handbook project mapping.");
}
export const handbookKey = cwd => hash(S.key(projectCwd(cwd)));
export const handbookPath = cwd => path.join(directory(), handbookKey(cwd) + ".md");
export const metadata = value => ({ hash: value.hash, version: value.version });
export function trimHandbook(text) {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  const truncated = normalized.length > HANDBOOK_LIMIT;
  let prefix = normalized.slice(0, HANDBOOK_LIMIT - marker.length);
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  const result = truncated ? prefix + marker : normalized;
  return { text: result, size: result.length, hash: hash(result), truncated };
}
/** Expired or dead owners can be replaced; every write fences a replaced publisher. */
export function withHandbook(cwd, fn) {
  const key = handbookKey(cwd), owner = S.extension("handbook-publisher", key);
  if (owner && owner.expiresAt > Date.now() && S.alive(owner.pid) &&
      (owner.pid !== process.pid || publishing.get(key) === owner.token))
    throw new Error("Handbook publication is busy; retry this operation.");
  const token = randomUUID();
  S.transaction(() => {
    const fresh = S.extension("handbook-publisher", key);
    if ((fresh?.token ?? null) !== (owner?.token ?? null))
      throw new Error("Handbook publication is busy; retry this operation.");
    S.setExtension("handbook-publisher", key, { token, pid: process.pid, expiresAt: Date.now() + LEASE_MS });
  }, "handbook:claim");
  publishing.set(key, token);
  try {
    fs.mkdirSync(directory(), { recursive: true, mode: 0o700 });
    return fn(key);
  } finally {
    if (publishing.get(key) === token) publishing.delete(key);
    S.transaction(() => {
      if (S.extension("handbook-publisher", key)?.token === token)
        S.db().prepare("DELETE FROM extensions WHERE kind='handbook-publisher' AND key=?").run(key);
    }, "handbook:release");
  }
}
export function assertPublisher(key) {
  const owner = S.extension("handbook-publisher", key);
  if (!owner || owner.token !== publishing.get(key) || owner.expiresAt <= Date.now())
    throw new Error("Handbook publisher lease expired or changed; retry publication.");
}
const targetFor = key => path.join(directory(), key + ".md");
function matchesFile(key, current) {
  try { return fs.readFileSync(targetFor(key), "utf8") === current.text; }
  catch (error) { if (error.code === "ENOENT") return !current.version; throw error; }
}
/** Reads never acquire the publisher mutex or write: the durable DB row is authoritative. */
export function readHandbook(cwd) {
  return row(handbookKey(cwd));
}
export function publicationPending(cwd) {
  const key = handbookKey(cwd);
  return !matchesFile(key, row(key));
}
function sweepTemps(key) {
  for (const name of fs.readdirSync(directory())) {
    if (!name.startsWith(key + ".md.") || !name.endsWith(".tmp")) continue;
    const file = path.join(directory(), name);
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > LEASE_MS) fs.unlinkSync(file);
    } catch (error) { if (!["ENOENT", "EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error; }
  }
}
/** Retry transient Windows sharing failures outside the transaction, with bounded backoff. */
export function publishHandbook(key) {
  assertPublisher(key);
  sweepTemps(key);
  const current = row(key);
  if (!current.version || matchesFile(key, current)) return current;
  const temp = targetFor(key) + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temp, current.text, { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      assertPublisher(key);
      if (row(key).version !== current.version) throw new Error("Handbook changed before publication; retry.");
      try { fs.renameSync(temp, targetFor(key)); break; }
      catch (error) {
        if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt === 4) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * 3 ** attempt);
      }
    }
  } finally {
    try { fs.unlinkSync(temp); } catch (error) {
      if (!["ENOENT", "EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
    }
  }
  return current;
}
export function recoverPublication(cwd) {
  return withHandbook(cwd, key => publishHandbook(key));
}
/** Committed acceptance is still acceptance when disk publication must be retried later. */
export function finishPublication(cwd, held = false) {
  try {
    if (publicationPending(cwd)) {
      if (held) publishHandbook(handbookKey(cwd));
      else recoverPublication(cwd);
    }
    return "published";
  } catch { return "pending"; }
}
export function replaceHandbook(cwd, input, profile) {
  if (typeof input.text !== "string" || input.text.length > 1000000)
    throw new Error("Handbook text must be a string of at most 1000000 characters.");
  const content = trimHandbook(sanitize(input.text, profile));
  return withHandbook(cwd, key => {
    const previous = row(key);
    if (input.expectedHandbookVersion === undefined && input.expectedHandbookHash === undefined)
      throw new Error("Handbook replacement requires expectedHandbookVersion or expectedHandbookHash.");
    if ((input.expectedHandbookVersion !== undefined && input.expectedHandbookVersion !== previous.version) ||
        (input.expectedHandbookHash !== undefined && input.expectedHandbookHash !== previous.hash))
      throw new Error(`Handbook changed; read version ${previous.version} before replacing.`);
    const next = { ...content, version: previous.version + 1 };
    S.transaction(() => { assertPublisher(key); S.setExtension("handbook", key, next); }, "handbook:replace");
    return publishHandbook(key);
  });
}
/** Selection is explicit lead authorization, never inferred from an acceptance. */
export function selectNotes(state, selection) {
  const notes = strings(state.result?.handbookNotes || [], "handbookNotes");
  if (selection === undefined) return [];
  if (selection === "all") throw Error("handbookNotes all is removed; select explicit note indexes.");
  if (!Array.isArray(selection) || selection.length > 200 || new Set(selection).size !== selection.length ||
      selection.some(i => !Number.isInteger(i) || i < 0 || i >= notes.length))
    throw new Error('handbookNotes must be unique valid note indexes.');
  return selection.map(i => notes[i]);
}
/** Prepare outside the acceptance transaction, under the publisher lease. */
export function prepareAcceptedNotes(cwd, state, selected = []) {
  const key = handbookKey(cwd), previous = row(key);
  const receiptKey = `${key}:${state.jobId}:${state.verifiedFingerprint}`;
  if (S.extension("handbook-accepted", receiptKey)) return null;
  const notes = [...new Set(sanitize(strings(selected, "handbookNotes"), state.profile)
    .map(note => note.replace(/\r\n?/g, "\n").trim()).filter(Boolean))];
  if (!notes.length) return null;
  const additions = notes.filter(note => !("\n\n" + previous.text + "\n\n").includes("\n\n" + note + "\n\n"));
  const content = trimHandbook([previous.text, ...additions].filter(Boolean).join("\n\n"));
  return { key, receiptKey, previousVersion: previous.version,
    next: { ...content, truncated: previous.truncated || content.truncated, version: previous.version + 1 } };
}
export function mergeAcceptedNotes(prepared) {
  if (!prepared || S.extension("handbook-accepted", prepared.receiptKey)) return;
  if (row(prepared.key).version !== prepared.previousVersion)
    throw new Error("Handbook changed while acceptance was prepared; retry acceptance.");
  assertPublisher(prepared.key);
  S.setExtension("handbook", prepared.key, prepared.next);
  S.setExtension("handbook-accepted", prepared.receiptKey, { version: prepared.next.version });
}
