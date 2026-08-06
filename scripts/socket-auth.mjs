import { MODULE_ID } from "./constants.mjs";

/**
 * Authentication for module socket messages without relying on WebCrypto.
 *
 * Foundry's module socket does not expose the authenticated socket sender to
 * package listeners. To bind a request to a real User, the sender first writes
 * the canonical request into a flag on their own User document. That document
 * update is handled by Foundry's server and is subject to its User permissions:
 * another player cannot publish an intent on somebody else's User document.
 *
 * The primary GM accepts a socket request only when it exactly matches the
 * short-lived intent stored on the claimed sender's User document. Replies from
 * the GM are verified in the same way. This works on LAN installations served
 * over plain HTTP, where window.crypto.subtle is intentionally unavailable.
 */
const AUTH_FLAG = "socket-auth-intents";
const AUTH_VERSION = 2;
const MAX_MESSAGE_AGE_MS = 60_000;
const FUTURE_TOLERANCE_MS = 10_000;
const SEEN_RETENTION_MS = 5 * 60_000;
const INTENT_RETENTION_MS = 2 * 60_000;
const VERIFY_RETRIES = 5;
const VERIFY_RETRY_DELAY_MS = 40;

function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

function payloadForProof(payload) {
  const copy = {};
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (key === "auth" || value === undefined) continue;
    copy[key] = value;
  }
  return copy;
}

function sleep(ms) {
  return new Promise(resolve => globalThis.setTimeout(resolve, ms));
}

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

export class SocketAuth {
  static _ready = null;
  static _seen = new Map();
  static _writeQueue = Promise.resolve();
  static _cleanupTimers = new Map();

  static initialize() {
    this._ready ??= this._initialize();
    return this._ready;
  }

  static async _initialize() {
    if (!game.user) throw new Error("SOCKET_AUTH_UNAVAILABLE");
    await this._pruneOwnIntents();
    return true;
  }

  static async sign(payload) {
    await this.initialize();

    const requestId = String(payload?.requestId ?? "");
    if (!requestId) throw new Error("SOCKET_AUTH_REQUEST_ID_REQUIRED");

    const body = {
      ...payloadForProof(payload),
      senderId: game.user.id,
      issuedAt: Date.now(),
      authVersion: AUTH_VERSION
    };

    await this._publishOwnIntent(body);
    this._scheduleOwnCleanup(requestId);

    return {
      ...body,
      auth: {
        mode: "user-flag"
      }
    };
  }

  static async verify(payload, {
    expectedSenderId = null,
    consume = true,
    maxAgeMs = MAX_MESSAGE_AGE_MS
  } = {}) {
    if (!payload || typeof payload !== "object") return null;
    if (payload.authVersion !== AUTH_VERSION || payload.auth?.mode !== "user-flag") return null;

    const senderId = String(payload.senderId ?? "");
    const requestId = String(payload.requestId ?? "");
    const issuedAt = Number(payload.issuedAt);
    if (!senderId || !requestId || !Number.isFinite(issuedAt)) return null;
    if (expectedSenderId && senderId !== expectedSenderId) return null;

    const now = Date.now();
    if (issuedAt > now + FUTURE_TOLERANCE_MS || now - issuedAt > maxAgeMs) return null;

    const replayKey = `${senderId}:${payload.type ?? ""}:${requestId}`;
    this._pruneSeen(now);
    if (consume && this._seen.has(replayKey)) return null;

    const user = game.users.get(senderId);
    if (!user) return null;

    const expectedCanonical = canonicalize(payloadForProof(payload));
    let record = null;

    // The User document update and the module socket event travel through
    // separate broadcasts. Usually the flag arrives first because sign()
    // awaits setFlag(), but a brief retry removes ordering races between
    // clients without delaying normal requests.
    for (let attempt = 0; attempt < VERIFY_RETRIES; attempt += 1) {
      const intents = user.getFlag(MODULE_ID, AUTH_FLAG);
      record = isRecord(intents) ? intents[requestId] : null;
      if (record) break;
      if (attempt < VERIFY_RETRIES - 1) await sleep(VERIFY_RETRY_DELAY_MS);
    }

    if (!isRecord(record)) return null;
    if (Number(record.issuedAt) !== issuedAt) return null;
    if (record.canonical !== expectedCanonical) return null;

    if (consume) this._seen.set(replayKey, now);
    return user;
  }

  static async clearOwn(requestId) {
    const id = String(requestId ?? "");
    if (!id || !game.user) return;
    const timer = this._cleanupTimers.get(id);
    if (timer) globalThis.clearTimeout(timer);
    this._cleanupTimers.delete(id);
    await this._mutateOwnIntents(intents => {
      delete intents[id];
      return intents;
    });
  }

  static async _publishOwnIntent(body) {
    const requestId = String(body.requestId);
    const canonical = canonicalize(body);
    await this._mutateOwnIntents(intents => {
      const now = Date.now();
      for (const [id, record] of Object.entries(intents)) {
        const timestamp = Number(record?.issuedAt);
        if (!Number.isFinite(timestamp) || now - timestamp > INTENT_RETENTION_MS) delete intents[id];
      }
      intents[requestId] = {
        issuedAt: body.issuedAt,
        canonical
      };
      return intents;
    });
  }

  static _scheduleOwnCleanup(requestId) {
    const oldTimer = this._cleanupTimers.get(requestId);
    if (oldTimer) globalThis.clearTimeout(oldTimer);
    const timer = globalThis.setTimeout(() => {
      this._cleanupTimers.delete(requestId);
      void this.clearOwn(requestId).catch(error => {
        console.debug(`${MODULE_ID} | Не удалось удалить устаревшее подтверждение сокет-запроса`, error);
      });
    }, INTENT_RETENTION_MS);
    this._cleanupTimers.set(requestId, timer);
  }

  static async _pruneOwnIntents(now = Date.now()) {
    await this._mutateOwnIntents(intents => {
      for (const [id, record] of Object.entries(intents)) {
        const timestamp = Number(record?.issuedAt);
        if (!Number.isFinite(timestamp) || now - timestamp > INTENT_RETENTION_MS) delete intents[id];
      }
      return intents;
    });
  }

  static async _mutateOwnIntents(mutator) {
    const run = async () => {
      const current = game.user.getFlag(MODULE_ID, AUTH_FLAG);
      const hadCurrent = isRecord(current) && Object.keys(current).length > 0;
      const intents = isRecord(current) ? foundry.utils.deepClone(current) : {};
      const next = mutator(intents) ?? intents;
      if (Object.keys(next).length) await game.user.setFlag(MODULE_ID, AUTH_FLAG, next);
      else if (hadCurrent) await game.user.unsetFlag(MODULE_ID, AUTH_FLAG);
    };

    const queued = this._writeQueue.then(run, run);
    // Keep the queue alive even when one document update fails, while still
    // returning the original rejection to the caller.
    this._writeQueue = queued.catch(() => undefined);
    return queued;
  }

  static _pruneSeen(now = Date.now()) {
    for (const [key, timestamp] of this._seen) {
      if (now - timestamp > SEEN_RETENTION_MS) this._seen.delete(key);
    }
  }
}
