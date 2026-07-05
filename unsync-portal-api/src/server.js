"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const tls = require("node:tls");
const { URL } = require("node:url");

const port = Number(process.env.PORT ?? 8787);
const dataDir = path.resolve(process.env.PORTAL_DATA_DIR ?? path.join(__dirname, "..", "data"));
const recordsPath = path.join(dataDir, "portal-records.json");
const attachmentRoot = path.join(dataDir, "attachments");
const allowedOrigin = process.env.PORTAL_ALLOWED_ORIGIN ?? "https://mail.unsync.uk";
const trustProxy = parseBoolean(process.env.TRUST_PROXY ?? "false");
const enableHsts = parseBoolean(process.env.PORTAL_ENABLE_HSTS ?? String(trustProxy));
const maxBodyBytes = Number(process.env.PORTAL_MAX_BODY_BYTES ?? 524288);
const maxJsonBodyBytes = Number(process.env.PORTAL_MAX_JSON_BODY_BYTES ?? maxBodyBytes);
const maxAttachmentChunkBytes = Number(process.env.PORTAL_MAX_ATTACHMENT_CHUNK_BYTES ?? 1024 * 1024 + 4096);
const maxReplyCiphertextBytes = Number(process.env.PORTAL_MAX_REPLY_CIPHERTEXT_BYTES ?? 256 * 1024);
const otpTtlMs = 10 * 60 * 1000;
const verifiedSessionTtlMs = 15 * 60 * 1000;
const maxOtpAttempts = 5;
const maxOtpSendsPerHour = 3;
const maxBadTokenFailures = 5;
const cleanupIntervalMs = Number(process.env.CLEANUP_INTERVAL_MS ?? 5 * 60 * 1000);
const consumedRetentionMs = Number(process.env.CONSUMED_PORTAL_RETENTION_MS ?? 10 * 60 * 1000);
const portalRateLimitWindowMs = Number(process.env.PORTAL_RATE_LIMIT_WINDOW_MS ?? 60 * 1000);
const portalRateLimitMax = Number(process.env.PORTAL_RATE_LIMIT_MAX ?? 60);
const otpCooldownMs = Number(process.env.OTP_COOLDOWN_MS ?? 60 * 1000);
const badTokenBlockMs = Number(process.env.BAD_TOKEN_BLOCK_MS ?? 15 * 60 * 1000);
const attachmentRateLimitMax = Number(process.env.ATTACHMENT_RATE_LIMIT_MAX ?? 120);
const uploadSessionTtlMs = Number(process.env.UPLOAD_SESSION_TTL_MS ?? 15 * 60 * 1000);
const stagedUploadRetentionMs = Number(process.env.STAGED_UPLOAD_RETENTION_MS ?? 15 * 60 * 1000);
const opsEventsMax = Number(process.env.OPS_EVENTS_MAX ?? 100);

/** @type {Map<string, PortalRecord>} */
let records = new Map();
/** @type {Map<string, OtpChallenge>} */
const otpChallenges = new Map();
/** @type {Map<string, VerifiedSession>} */
const verifiedSessions = new Map();
/** @type {Map<string, number[]>} */
const otpSendWindows = new Map();
/** @type {Map<string, RateLimitWindow>} */
const rateLimitWindows = new Map();
/** @type {Map<string, BadTokenWindow>} */
const badTokenWindows = new Map();
/** @type {Map<string, UploadSession>} */
const uploadSessions = new Map();
/** @type {Set<string>} */
const consumingPortals = new Set();
const recentSecurityEvents = [];
const metricsCounters = {
  portalCreatedCount: 0,
  expiredPortalCount: 0,
  consumedPortalCount: 0,
  otpRequestedCount: 0,
  otpSuccessCount: 0,
  otpFailCount: 0,
  rateLimitBlockCount: 0,
  invalidTokenCount: 0,
  uploadSessionCreatedCount: 0,
  uploadFailuresCount: 0,
  attachmentChunksUploadedCount: 0,
  attachmentChunksDownloadedCount: 0,
  cleanupDeletionCount: 0,
};

/**
 * @typedef {object} PortalRecord
 * @property {string} portalId
 * @property {string} accessTokenHash
 * @property {string} recipientEmail
 * @property {string[]} recipientEmails
 * @property {string} encryptedPayload
 * @property {string} createdAt
 * @property {string} expiresAt
 * @property {number} idleTimeoutSeconds
 * @property {boolean} oneTimeRead
 * @property {boolean} isConsumed
 * @property {string | null} consumedAt
 * @property {string | null} deleteAfter
 * @property {Array<{ attachmentId: string, chunkCount: number, encryptedSize: number, uploadComplete: boolean, receivedChunkCount: number, receivedEncryptedSize: number }>} attachments
 * @property {Array<{ replyId: string, createdAt: string, receivedAt: string, recipientEmailHash: string, notificationEmailHash: string, encryptedPayload: object }>} replies
 * @property {string | null} lastAccessAt
 * @property {string} updatedAt
 */

/**
 * @typedef {object} OtpChallenge
 * @property {string} portalId
 * @property {string} recipientEmail
 * @property {string} otpHash
 * @property {string} salt
 * @property {number} expiresAt
 * @property {number} attempts
 */

/**
 * @typedef {object} VerifiedSession
 * @property {string} portalId
 * @property {string} recipientEmail
 * @property {string} tokenHash
 * @property {number} expiresAt
 */

/**
 * @typedef {object} RateLimitWindow
 * @property {number} resetAt
 * @property {number} count
 */

/**
 * @typedef {object} BadTokenWindow
 * @property {number} resetAt
 * @property {number} count
 * @property {number} blockedUntil
 */

/**
 * @typedef {object} UploadSession
 * @property {string} portalId
 * @property {string} tokenHash
 * @property {Map<string, { attachmentId: string, chunkCount: number, encryptedSize: number, originalSize: number }>} attachments
 * @property {number} createdAt
 * @property {number} expiresAt
 */

async function main() {
  await loadRecords();
  startCleanupWorker();

  const server = http.createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      if (error instanceof HttpError) {
        sendJson(response, error.statusCode, { error: error.code });
        return;
      }

      // Do not log request bodies or encrypted payloads.
      console.error("portal api error:", error instanceof Error ? error.message : String(error));
      sendJson(response, 500, { error: "internal_error" });
    });
  });

  server.listen(port, () => {
    console.log(`Unsync Portal API listening on ${port}`);
  });
}

async function handleRequest(request, response) {
  applySecurityHeaders(request, response);

  if (!trustProxy && hasForwardedClientHeaders(request)) {
    logSecurityEvent("invalid_portal_access", {
      ipHash: hashLogValue(getSocketIp(request)),
      reason: "untrusted_forwarded_headers"
    });
    sendJson(response, 400, { error: "invalid_proxy_headers" });
    return;
  }

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (request.method === "GET" && url.pathname === "/ops/metrics") {
    await handleOpsMetrics(request, response);
    return;
  }

  if (request.method === "GET" && url.pathname === "/ops") {
    await handleOpsDashboard(request, response);
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  const readMatch = url.pathname.match(/^\/read\/([^/]+)$/);

  if (request.method === "GET" && readMatch) {
    sendReaderPage(response, decodeURIComponent(readMatch[1]));
    return;
  }

  if (request.method === "GET" && url.pathname === "/reader/reader.css") {
    sendText(response, 200, "text/css; charset=utf-8", readerCss);
    return;
  }

  if (request.method === "GET" && url.pathname === "/reader/reader.js") {
    sendText(response, 200, "application/javascript; charset=utf-8", readerJs);
    return;
  }

  if (request.method === "POST" && url.pathname === "/portal/create") {
    await handleCreate(request, response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/portal/upload-session") {
    await handleCreateUploadSession(request, response);
    return;
  }

  const uploadChunkMatch = url.pathname.match(/^\/portal\/([^/]+)\/attachment\/([^/]+)\/chunk\/(\d+)$/);

  if (request.method === "POST" && uploadChunkMatch) {
    await handleUploadAttachmentChunk(
      request,
      response,
      decodeURIComponent(uploadChunkMatch[1]),
      decodeURIComponent(uploadChunkMatch[2]),
      uploadChunkMatch[3],
    );
    return;
  }

  const requestOtpMatch = url.pathname.match(/^\/portal\/([^/]+)\/request-otp$/);

  if (request.method === "POST" && requestOtpMatch) {
    await handleRequestOtp(request, response, decodeURIComponent(requestOtpMatch[1]));
    return;
  }

  const verifyOtpMatch = url.pathname.match(/^\/portal\/([^/]+)\/verify-otp$/);

  if (request.method === "POST" && verifyOtpMatch) {
    await handleVerifyOtp(request, response, decodeURIComponent(verifyOtpMatch[1]));
    return;
  }

  // Secure Reader browser replies. Body text is encrypted in the browser before this endpoint receives it.
  if (request.method === "POST" && url.pathname === "/portal/reply") {
    await handlePortalReply(request, response);
    return;
  }

  const portalMatch = url.pathname.match(/^\/portal\/([^/]+)$/);

  if (request.method === "GET" && portalMatch) {
    await handleGetPortal(request, response, decodeURIComponent(portalMatch[1]), url);
    return;
  }

  if (request.method === "GET" && uploadChunkMatch) {
    await handleGetAttachmentChunk(
      request,
      response,
      decodeURIComponent(uploadChunkMatch[1]),
      decodeURIComponent(uploadChunkMatch[2]),
      uploadChunkMatch[3],
    );
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

async function handleOpsMetrics(request, response) {
  if (!isAuthorizedOpsRequest(request)) {
    sendJson(response, 404, { error: "not_found" });
    return;
  }

  sendJson(response, 200, await buildSafeMetricsSnapshot());
}

async function handleOpsDashboard(request, response) {
  if (!isAuthorizedOpsRequest(request)) {
    sendJson(response, 404, { error: "not_found" });
    return;
  }

  const snapshot = await buildSafeMetricsSnapshot();
  response.setHeader(
    "content-security-policy",
    "default-src 'none'; style-src 'nonce-unsync-ops-style'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  sendText(response, 200, "text/html; charset=utf-8", buildOpsDashboardHtml(snapshot));
}

async function handleCreate(request, response) {
  const body = await readJsonBody(request);
  const validationError = validateCreateBody(body);

  if (validationError) {
    sendJson(response, 400, { error: validationError });
    return;
  }

  if (records.has(body.portalId)) {
    sendJson(response, 409, { error: "portal_already_exists" });
    return;
  }

  const sessionValidationError = await validateStagedUploadSession(body.portalId, body.attachments ?? []);
  if (sessionValidationError) {
    sendJson(response, 400, { error: sessionValidationError });
    return;
  }

  const attachments = await normalizeAttachmentManifests(body.attachments, body.portalId);
  const record = {
    portalId: body.portalId,
    accessTokenHash: body.accessTokenHash,
    recipientEmail: normalizeEmail(body.recipientEmail),
    recipientEmails: normalizeRecipientEmails([body.recipientEmail, ...(body.recipientEmails ?? [])]),
    encryptedPayload: body.encryptedPayload,
    createdAt: body.createdAt,
    expiresAt: body.expiresAt,
    idleTimeoutSeconds: body.idleTimeoutSeconds,
    oneTimeRead: body.oneTimeRead,
    isConsumed: false,
    consumedAt: null,
    deleteAfter: null,
    attachments,
    replies: [],
    lastAccessAt: null,
    updatedAt: new Date().toISOString()
  };

  if (record.attachments.some((attachment) => !attachment.uploadComplete)) {
    logSecurityEvent("attachment_upload_denied", {
      portalIdHash: hashLogValue(record.portalId),
      reason: "attachment_upload_incomplete"
    });
    sendJson(response, 400, { error: "attachment_upload_incomplete" });
    return;
  }

  records.set(record.portalId, record);
  uploadSessions.delete(record.portalId);
  await persistRecords();
  logSecurityEvent("portal_created", {
    portalIdHash: hashLogValue(record.portalId),
    recipientCount: record.recipientEmails.length,
    oneTimeRead: record.oneTimeRead
  });
  sendJson(response, 201, { ok: true, portalId: record.portalId });
}

async function handleCreateUploadSession(request, response) {
  if (!consumeRequestRateLimit(request, response, "upload_session", "create", portalRateLimitMax, {
    reason: "upload_session_create"
  })) {
    return;
  }

  const body = await readJsonBody(request);
  const validationError = validateUploadSessionBody(body);

  if (validationError) {
    sendJson(response, 400, { error: validationError });
    return;
  }

  if (records.has(body.portalId)) {
    sendJson(response, 409, { error: "portal_already_exists" });
    return;
  }

  await deletePortalAttachmentChunks(body.portalId);
  const uploadSessionToken = randomToken(32);
  const attachments = new Map(body.attachments.map((attachment) => [
    attachment.attachmentId,
    {
      attachmentId: attachment.attachmentId,
      chunkCount: attachment.chunkCount,
      encryptedSize: attachment.encryptedSize,
      originalSize: attachment.originalSize,
    },
  ]));

  uploadSessions.set(body.portalId, {
    portalId: body.portalId,
    tokenHash: hashUploadSessionToken(uploadSessionToken),
    attachments,
    createdAt: Date.now(),
    expiresAt: Date.now() + uploadSessionTtlMs,
  });

  logSecurityEvent("upload_session_created", {
    portalIdHash: hashLogValue(body.portalId),
    attachmentCount: attachments.size,
    expiresInMs: uploadSessionTtlMs
  });
  sendJson(response, 201, { uploadSessionToken, expiresInMs: uploadSessionTtlMs });
}

async function handleUploadAttachmentChunk(request, response, portalId, attachmentId, chunkIndexValue) {
  if (!isStorageId(portalId) || !isStorageId(attachmentId)) {
    sendJson(response, 400, { error: "invalid_attachment_path" });
    return;
  }

  const chunkIndex = Number(chunkIndexValue);

  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 100000) {
    sendJson(response, 400, { error: "invalid_chunk_index" });
    return;
  }

  if (records.has(portalId)) {
    sendJson(response, 409, { error: "portal_already_created" });
    return;
  }

  const uploadSession = validateUploadSessionForChunk(request, portalId, attachmentId, chunkIndex);
  if (!uploadSession) {
    logSecurityEvent("attachment_upload_denied", {
      portalIdHash: hashLogValue(portalId),
      attachmentIdHash: hashLogValue(attachmentId),
      reason: "invalid_upload_session"
    });
    sendJson(response, 403, { error: "portal_access_denied" });
    return;
  }

  const encryptedChunk = await readBinaryBody(request, maxAttachmentChunkBytes);
  const attachmentManifest = uploadSession.attachments.get(attachmentId);
  const received = await inspectReceivedAttachmentChunks(portalId, attachmentId, attachmentManifest.chunkCount);
  const existingChunkSize = await getExistingAttachmentChunkSize(portalId, attachmentId, chunkIndex);

  if (received.encryptedSize - existingChunkSize + encryptedChunk.length > attachmentManifest.encryptedSize) {
    logSecurityEvent("attachment_upload_denied", {
      portalIdHash: hashLogValue(portalId),
      attachmentIdHash: hashLogValue(attachmentId),
      reason: "encrypted_size_exceeded"
    });
    sendJson(response, 413, { error: "payload_too_large" });
    return;
  }

  const attachmentDir = getAttachmentDirectory(portalId, attachmentId);
  const chunkPath = getAttachmentChunkPath(portalId, attachmentId, chunkIndex);

  await fs.mkdir(attachmentDir, { recursive: true });
  await fs.writeFile(chunkPath, encryptedChunk, { mode: 0o600 });
  metricsCounters.attachmentChunksUploadedCount += 1;
  sendJson(response, 201, { ok: true });
}

async function handleGetAttachmentChunk(request, response, portalId, attachmentId, chunkIndexValue) {
  if (!isStorageId(portalId) || !isStorageId(attachmentId)) {
    logInvalidPortalAccess(request, portalId, "invalid_attachment_path");
    sendJson(response, 404, { error: "not_found" });
    return;
  }

  const chunkIndex = Number(chunkIndexValue);

  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 100000) {
    logInvalidPortalAccess(request, portalId, "invalid_chunk_index");
    sendJson(response, 404, { error: "not_found" });
    return;
  }

  if (!consumeRequestRateLimit(request, response, "attachment_chunk", portalId, attachmentRateLimitMax, {
    extraEvent: "attachment_rate_limited",
    reason: "chunk_download"
  })) {
    return;
  }

  const record = await getActivePortalRecord(response, portalId, { request, genericAccessDenied: true });

  if (!record) {
    return;
  }

  const verifiedSession = getVerifiedSession(request, record);

  if (!verifiedSession) {
    logInvalidPortalAccess(request, portalId, "verified_session_required");
    sendJson(response, 403, { error: "portal_access_denied" });
    return;
  }

  const attachment = record.attachments.find((item) => item.attachmentId === attachmentId);

  if (!attachment || !attachment.uploadComplete || chunkIndex >= attachment.chunkCount) {
    sendJson(response, 404, { error: "not_found" });
    return;
  }

  try {
    const chunk = await fs.readFile(getAttachmentChunkPath(portalId, attachmentId, chunkIndex));
    metricsCounters.attachmentChunksDownloadedCount += 1;
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(chunk.length),
    });
    response.end(chunk);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      sendJson(response, 404, { error: "not_found" });
      return;
    }

    throw error;
  }
}

async function handleRequestOtp(request, response, portalId) {
  if (!consumeRequestRateLimit(request, response, "request_otp", portalId, portalRateLimitMax, {
    extraEvent: "otp_rate_limited",
    reason: "ip_rate_limit"
  })) {
    return;
  }

  const body = await readJsonBody(request);
  const recipientEmail = normalizeEmail(body.recipientEmail);
  const record = await getActivePortalRecord(response, portalId, { request, genericAccessDenied: true });

  if (!record) {
    return;
  }

  if (!recipientEmail || !isValidEmail(recipientEmail)) {
    sendJson(response, 400, { error: "invalid_recipient_email" });
    return;
  }

  if (!portalIncludesRecipient(record, recipientEmail)) {
    logInvalidPortalAccess(request, portalId, "recipient_not_allowed", { recipientEmailHash: hashLogValue(recipientEmail) });
    sendJson(response, 403, { error: "portal_access_denied" });
    return;
  }

  if (isBadTokenBlocked(request, record.portalId)) {
    logRateLimitBlocked(request, "bad_token", record.portalId, "bad_token_block");
    sendJson(response, 429, { error: "rate_limited" });
    return;
  }

  if (!isToken(body.accessTokenHash, 32, 256) || !constantTimeEqual(body.accessTokenHash, record.accessTokenHash)) {
    const blocked = recordBadTokenFailure(request, record.portalId);
    logSecurityEvent("invalid_token_hash", {
      portalIdHash: hashLogValue(record.portalId),
      ipHash: hashLogValue(getClientIp(request)),
      recipientEmailHash: hashLogValue(recipientEmail),
      blocked
    });
    sendJson(response, blocked ? 429 : 403, { error: blocked ? "rate_limited" : "portal_access_denied" });
    return;
  }

  clearBadTokenFailures(request, record.portalId);

  const otpAllowance = consumeOtpSendAllowance(record.portalId, recipientEmail);

  if (!otpAllowance.ok) {
    logSecurityEvent("otp_rate_limited", {
      portalIdHash: hashLogValue(record.portalId),
      ipHash: hashLogValue(getClientIp(request)),
      recipientEmailHash: hashLogValue(recipientEmail),
      reason: otpAllowance.reason
    });
    sendJson(response, 429, { error: "otp_rate_limited" });
    return;
  }

  const otp = generateOtp();
  const salt = randomToken(16);
  otpChallenges.set(challengeKey(record.portalId, recipientEmail), {
    portalId: record.portalId,
    recipientEmail,
    otpHash: hashOtp(otp, salt),
    salt,
    expiresAt: Date.now() + otpTtlMs,
    attempts: 0
  });

  // TODO: Add abuse monitoring and expired OTP cleanup worker.
  await sendOtpEmail(recipientEmail, otp);
  logSecurityEvent("otp_requested", {
    portalIdHash: hashLogValue(record.portalId),
    recipientEmailHash: hashLogValue(recipientEmail)
  });
  sendJson(response, 202, { ok: true });
}

async function handleVerifyOtp(request, response, portalId) {
  if (!consumeRequestRateLimit(request, response, "verify_otp", portalId, portalRateLimitMax, {
    extraEvent: "otp_rate_limited",
    reason: "ip_rate_limit"
  })) {
    return;
  }

  const body = await readJsonBody(request);
  const recipientEmail = normalizeEmail(body.recipientEmail);
  const otp = typeof body.otp === "string" ? body.otp.trim() : "";
  const record = await getActivePortalRecord(response, portalId, { request, genericAccessDenied: true });

  if (!record) {
    return;
  }

  if (!recipientEmail || !portalIncludesRecipient(record, recipientEmail)) {
    logInvalidPortalAccess(request, portalId, "recipient_not_allowed", { recipientEmailHash: hashLogValue(recipientEmail) });
    sendJson(response, 403, { error: "portal_access_denied" });
    return;
  }

  if (!/^\d{6}$/.test(otp)) {
    logOtpFailure(record.portalId, recipientEmail, "invalid_format");
    sendJson(response, 400, { error: "invalid_otp" });
    return;
  }

  const key = challengeKey(record.portalId, recipientEmail);
  const challenge = otpChallenges.get(key);

  if (!challenge || challenge.expiresAt <= Date.now()) {
    otpChallenges.delete(key);
    logOtpFailure(record.portalId, recipientEmail, "expired_or_missing");
    sendJson(response, 403, { error: "otp_expired" });
    return;
  }

  if (challenge.attempts >= maxOtpAttempts) {
    otpChallenges.delete(key);
    logOtpFailure(record.portalId, recipientEmail, "attempts_exceeded");
    sendJson(response, 429, { error: "otp_attempts_exceeded" });
    return;
  }

  challenge.attempts += 1;
  const candidateHash = hashOtp(otp, challenge.salt);

  if (!constantTimeEqual(candidateHash, challenge.otpHash)) {
    logOtpFailure(record.portalId, recipientEmail, "invalid_code");
    sendJson(response, 403, { error: "invalid_otp" });
    return;
  }

  otpChallenges.delete(key);
  logSecurityEvent("otp_verified", {
    portalIdHash: hashLogValue(record.portalId),
    recipientEmailHash: hashLogValue(recipientEmail)
  });
  const verifiedSessionToken = randomToken(32);
  verifiedSessions.set(sessionKey(record.portalId, recipientEmail), {
    portalId: record.portalId,
    recipientEmail,
    tokenHash: hashSessionToken(verifiedSessionToken),
    expiresAt: Date.now() + verifiedSessionTtlMs
  });

  // TODO: Expired verified-session cleanup worker and session destruction hooks.
  logSecurityEvent("verified_session_created", {
    portalIdHash: hashLogValue(record.portalId),
    recipientEmailHash: hashLogValue(recipientEmail)
  });
  sendJson(response, 200, { verifiedSessionToken });
}

async function handleGetPortal(request, response, portalId, url) {
  if (!consumeRequestRateLimit(request, response, "get_portal", portalId, portalRateLimitMax, {
    reason: "payload_fetch"
  })) {
    return;
  }

  const record = await getActivePortalRecord(response, portalId, { request, genericAccessDenied: true });

  if (!record) {
    return;
  }

  const verifiedSession = getVerifiedSession(request, record);

  if (!verifiedSession) {
    logInvalidPortalAccess(request, portalId, "verified_session_required");
    sendJson(response, 403, { error: "portal_access_denied" });
    return;
  }

  if (record.oneTimeRead) {
    consumingPortals.add(record.portalId);
  }

  record.lastAccessAt = new Date().toISOString();
  record.updatedAt = record.lastAccessAt;
  try {
    await persistRecords();
  } catch (error) {
    consumingPortals.delete(record.portalId);
    throw error;
  }

  const responsePayload = {
    portalId: record.portalId,
    encryptedPayload: record.encryptedPayload,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    idleTimeoutSeconds: record.idleTimeoutSeconds,
    oneTimeRead: record.oneTimeRead,
    isConsumed: record.isConsumed,
    lastAccessAt: record.lastAccessAt
  };

  if (record.oneTimeRead) {
    sendJson(response, 200, responsePayload, () => {
      void consumePortalAfterSuccessfulRetrieval(record.portalId);
    });
    return;
  }

  sendJson(response, 200, responsePayload);
}

async function handlePortalReply(request, response) {
  const body = await readJsonBody(request);
  const validationError = validatePortalReplyBody(body);

  if (validationError) {
    sendJson(response, 400, { error: validationError });
    return;
  }

  if (!consumeRequestRateLimit(request, response, "reply", body.portalId, portalRateLimitMax, {
    reason: "reply_submit"
  })) {
    return;
  }

  const record = await getReplyablePortalRecord(response, body.portalId, { request });

  if (!record) {
    return;
  }

  const verifiedSession = getVerifiedSession(request, record);

  if (!verifiedSession) {
    logInvalidPortalAccess(request, body.portalId, "verified_session_required");
    sendJson(response, 403, { error: "portal_access_denied" });
    return;
  }

  const notificationEmail = normalizeEmail(body.notificationEmail);
  const receivedAt = new Date().toISOString();
  const reply = {
    replyId: randomToken(18),
    createdAt: body.encryptedPayload.createdAt,
    receivedAt,
    recipientEmailHash: hashLogValue(verifiedSession.recipientEmail),
    notificationEmailHash: hashLogValue(notificationEmail),
    encryptedPayload: body.encryptedPayload,
  };

  record.replies = Array.isArray(record.replies) ? record.replies : [];
  record.replies.push(reply);
  record.updatedAt = receivedAt;
  await persistRecords();

  const replyEmail = buildSecureReplyEmail(buildSecureReplyPackage(record.portalId, reply));
  const notificationSent = await sendReplyNotificationEmail(notificationEmail, replyEmail)
    .catch(() => {
      logSecurityEvent("reply_notification_failed", {
        portalIdHash: hashLogValue(record.portalId),
        recipientEmailHash: hashLogValue(verifiedSession.recipientEmail),
        reason: "smtp_send_failed"
      });
      return false;
    });

  logSecurityEvent("portal_reply_stored", {
    portalIdHash: hashLogValue(record.portalId),
    recipientEmailHash: hashLogValue(verifiedSession.recipientEmail),
    notificationSent,
    replyCount: record.replies.length
  });

  sendJson(response, 201, { ok: true, replyId: reply.replyId, notificationSent });
}

function getAccessTokenHash(request) {
  return getHeaderValue(request.headers["x-unsync-access-token-hash"]);
}

async function getActivePortalRecord(response, portalId, options = {}) {
  const record = records.get(portalId);

  if (!record) {
    if (options.request) {
      logInvalidPortalAccess(options.request, portalId, "missing_portal");
    }
    sendGenericPortalError(response, options);
    return undefined;
  }

  if (isExpired(record)) {
    records.delete(portalId);
    expirePortalAuthState(portalId);
    await persistRecords();
    if (options.request) {
      logInvalidPortalAccess(options.request, portalId, "expired_portal");
    }
    sendGenericPortalError(response, options);
    return undefined;
  }

  if (record.isConsumed || consumingPortals.has(portalId)) {
    sendJson(response, 410, { error: "PORTAL_CONSUMED" });
    return undefined;
  }

  return record;
}

async function getReplyablePortalRecord(response, portalId, options = {}) {
  const record = records.get(portalId);

  if (!record) {
    if (options.request) {
      logInvalidPortalAccess(options.request, portalId, "missing_portal");
    }
    sendJson(response, 403, { error: "portal_access_denied" });
    return undefined;
  }

  if (isExpired(record)) {
    records.delete(portalId);
    expirePortalAuthState(portalId);
    await persistRecords();
    if (options.request) {
      logInvalidPortalAccess(options.request, portalId, "expired_portal");
    }
    sendJson(response, 403, { error: "portal_access_denied" });
    return undefined;
  }

  return record;
}

function sendGenericPortalError(response, options = {}) {
  if (options.genericAccessDenied) {
    sendJson(response, 403, { error: "portal_access_denied" });
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

function getVerifiedSession(request, record) {
  const recipientEmail = normalizeEmail(getHeaderValue(request.headers["x-unsync-recipient-email"]));
  const sessionToken = getHeaderValue(request.headers["x-unsync-verified-session"]);

  if (!recipientEmail || !sessionToken || !portalIncludesRecipient(record, recipientEmail)) {
    return undefined;
  }

  const key = sessionKey(record.portalId, recipientEmail);
  const session = verifiedSessions.get(key);

  if (!session || session.expiresAt <= Date.now()) {
    verifiedSessions.delete(key);
    return undefined;
  }

  if (!constantTimeEqual(hashSessionToken(sessionToken), session.tokenHash)) {
    return undefined;
  }

  return session;
}

function expirePortalAuthState(portalId) {
  for (const [key, challenge] of otpChallenges.entries()) {
    if (challenge.portalId === portalId) {
      otpChallenges.delete(key);
    }
  }

  for (const [key, session] of verifiedSessions.entries()) {
    if (session.portalId === portalId) {
      verifiedSessions.delete(key);
    }
  }
}

async function consumePortalAfterSuccessfulRetrieval(portalId) {
  const record = records.get(portalId);

  if (!record || record.isConsumed) {
    consumingPortals.delete(portalId);
    return;
  }

  const consumedAt = new Date();
  record.isConsumed = true;
  record.consumedAt = consumedAt.toISOString();
  record.deleteAfter = new Date(consumedAt.getTime() + consumedRetentionMs).toISOString();
  record.updatedAt = record.consumedAt;
  expirePortalAuthState(portalId);

  try {
    await persistRecords();
    logSecurityEvent("portal_consumed", {
      portalIdHash: hashLogValue(portalId),
      deleteAfter: record.deleteAfter
    });
  } finally {
    consumingPortals.delete(portalId);
  }
}

function applySecurityHeaders(request, response) {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("cache-control", "no-store, max-age=0");
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");

  if (enableHsts && isHttpsRequest(request)) {
    response.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
  }

  const origin = request.headers.origin;
  if (allowedOrigin && origin === allowedOrigin) {
    response.setHeader("access-control-allow-origin", allowedOrigin);
    response.setHeader("vary", "origin");
    response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    response.setHeader("access-control-allow-headers", "content-type,x-unsync-access-token-hash,x-unsync-recipient-email,x-unsync-verified-session,x-unsync-upload-session");
  }
}

function getHeaderValue(value) {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }

  return value ?? "";
}

function parseBoolean(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? ""));
}

async function readJsonBody(request) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;

    if (totalBytes > maxJsonBodyBytes) {
      throw new HttpError(413, "payload_too_large");
    }

    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

function isAuthorizedOpsRequest(request) {
  const expectedToken = process.env.OPS_ADMIN_TOKEN;
  const candidateToken = getHeaderValue(request.headers["x-unsync-admin-token"]);

  return Boolean(
    expectedToken &&
    candidateToken &&
    constantTimeEqual(candidateToken, expectedToken)
  );
}

async function buildSafeMetricsSnapshot() {
  const storageUsage = await getStorageUsage();
  const portalCounts = getPortalCounts();

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    counters: {
      portalCreatedCount: metricsCounters.portalCreatedCount,
      expiredPortalCount: metricsCounters.expiredPortalCount,
      consumedPortalCount: metricsCounters.consumedPortalCount,
      otpRequestedCount: metricsCounters.otpRequestedCount,
      otpSuccessCount: metricsCounters.otpSuccessCount,
      otpFailCount: metricsCounters.otpFailCount,
      rateLimitBlockCount: metricsCounters.rateLimitBlockCount,
      invalidTokenCount: metricsCounters.invalidTokenCount,
      uploadSessionCreatedCount: metricsCounters.uploadSessionCreatedCount,
      uploadFailuresCount: metricsCounters.uploadFailuresCount,
      attachmentChunksUploadedCount: metricsCounters.attachmentChunksUploadedCount,
      attachmentChunksDownloadedCount: metricsCounters.attachmentChunksDownloadedCount,
      cleanupDeletionCount: metricsCounters.cleanupDeletionCount,
    },
    gauges: {
      activePortalCount: portalCounts.active,
      expiredPortalCount: portalCounts.expired,
      consumedPortalCount: portalCounts.consumed,
      activeVerifiedSessionCount: getActiveVerifiedSessionCount(),
      activeUploadSessionCount: getActiveUploadSessionCount(),
      storageUsageBytes: storageUsage.totalBytes,
      encryptedPayloadStoreBytes: storageUsage.encryptedPayloadStoreBytes,
      encryptedAttachmentStorageBytes: storageUsage.encryptedAttachmentStorageBytes,
    },
    recentEvents: recentSecurityEvents.slice().reverse(),
  };
}

function getPortalCounts() {
  let active = 0;
  let expired = 0;
  let consumed = 0;

  for (const record of records.values()) {
    if (record.isConsumed) {
      consumed += 1;
    } else if (isExpired(record)) {
      expired += 1;
    } else {
      active += 1;
    }
  }

  return { active, expired, consumed };
}

function getActiveVerifiedSessionCount() {
  const now = Date.now();
  let count = 0;

  for (const session of verifiedSessions.values()) {
    if (session.expiresAt > now) {
      count += 1;
    }
  }

  return count;
}

function getActiveUploadSessionCount() {
  const now = Date.now();
  let count = 0;

  for (const uploadSession of uploadSessions.values()) {
    if (uploadSession.expiresAt > now) {
      count += 1;
    }
  }

  return count;
}

async function getStorageUsage() {
  const encryptedPayloadStoreBytes = await getFileSize(recordsPath);
  const encryptedAttachmentStorageBytes = await getDirectorySize(attachmentRoot);

  return {
    encryptedPayloadStoreBytes,
    encryptedAttachmentStorageBytes,
    totalBytes: encryptedPayloadStoreBytes + encryptedAttachmentStorageBytes,
  };
}

async function getFileSize(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() ? stat.size : 0;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return 0;
    }

    throw error;
  }
}

async function getDirectorySize(directoryPath) {
  let entries;

  try {
    entries = await fs.readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return 0;
    }

    throw error;
  }

  let totalBytes = 0;

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      totalBytes += await getDirectorySize(entryPath);
    } else if (entry.isFile()) {
      totalBytes += await getFileSize(entryPath);
    }
  }

  return totalBytes;
}

async function readBinaryBody(request, maxBytes) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;

    if (totalBytes > maxBytes) {
      throw new HttpError(413, "payload_too_large");
    }

    chunks.push(chunk);
  }

  if (totalBytes === 0) {
    throw new HttpError(400, "empty_payload");
  }

  return Buffer.concat(chunks);
}

function validateCreateBody(body) {
  if (!isPlainObject(body)) return "invalid_body";
  if (!isToken(body.portalId, 16, 256)) return "invalid_portal_id";
  if (!isToken(body.accessTokenHash, 32, 256)) return "invalid_access_token_hash";
  if (!isValidEmail(normalizeEmail(body.recipientEmail))) return "invalid_recipient_email";
  if (body.recipientEmails !== undefined && !Array.isArray(body.recipientEmails)) return "invalid_recipient_emails";
  if (typeof body.encryptedPayload !== "string" || body.encryptedPayload.length === 0) {
    return "invalid_encrypted_payload";
  }
  if (!isIsoDate(body.createdAt)) return "invalid_created_at";
  if (!isIsoDate(body.expiresAt)) return "invalid_expires_at";
  if (Date.parse(body.expiresAt) <= Date.now()) return "expired_payload";
  if (!Number.isInteger(body.idleTimeoutSeconds) || body.idleTimeoutSeconds < 1 || body.idleTimeoutSeconds > 86400) {
    return "invalid_idle_timeout";
  }
  if (typeof body.oneTimeRead !== "boolean") return "invalid_one_time_read";
  if (body.attachments !== undefined && !isValidAttachmentManifestList(body.attachments)) {
    return "invalid_attachments";
  }
  return undefined;
}

function validateUploadSessionBody(body) {
  if (!isPlainObject(body)) return "invalid_body";
  if (!isToken(body.portalId, 16, 256)) return "invalid_portal_id";
  if (!Array.isArray(body.attachments) || body.attachments.length === 0) return "invalid_attachments";
  if (body.attachments.length > 100) return "invalid_attachments";

  const seenAttachmentIds = new Set();

  for (const attachment of body.attachments) {
    if (!isPlainObject(attachment)) return "invalid_attachments";
    if (!isStorageId(attachment.attachmentId)) return "invalid_attachments";
    if (seenAttachmentIds.has(attachment.attachmentId)) return "duplicate_attachment_id";
    seenAttachmentIds.add(attachment.attachmentId);
    if (!Number.isInteger(attachment.chunkCount) || attachment.chunkCount <= 0 || attachment.chunkCount > 100000) {
      return "invalid_attachments";
    }
    if (!Number.isSafeInteger(attachment.encryptedSize) || attachment.encryptedSize < attachment.chunkCount * 28) {
      return "invalid_attachments";
    }
    if (attachment.encryptedSize > attachment.chunkCount * maxAttachmentChunkBytes) {
      return "invalid_attachments";
    }
    if (!Number.isSafeInteger(attachment.originalSize) || attachment.originalSize < 0) {
      return "invalid_attachments";
    }
  }

  return undefined;
}

function validatePortalReplyBody(body) {
  if (!isPlainObject(body)) return "invalid_body";
  if (!isToken(body.portalId, 16, 256)) return "invalid_portal_id";
  if (!isValidEmail(normalizeEmail(body.notificationEmail))) return "invalid_notification_email";
  if (!isValidEncryptedReplyPayload(body.encryptedPayload)) return "invalid_encrypted_reply";
  return undefined;
}

function isValidEncryptedReplyPayload(payload) {
  if (!isPlainObject(payload)) return false;
  if (payload.version !== 1) return false;
  if (payload.type !== "portal-reply") return false;
  if (payload.cipher !== "aes-256-gcm") return false;
  if (!isIsoDate(payload.createdAt)) return false;
  if (Date.parse(payload.createdAt) > Date.now() + 5 * 60 * 1000) return false;
  if (!isPlainObject(payload.encryptedBody)) return false;

  const { iv, ciphertext, authTag } = payload.encryptedBody;
  return (
    isBase64UrlBytes(iv, 12, 12) &&
    isBase64UrlBytes(authTag, 16, 16) &&
    isBase64UrlBytes(ciphertext, 1, maxReplyCiphertextBytes)
  );
}

function isBase64UrlBytes(value, minBytes, maxBytes) {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return false;
  }

  const byteLength = Buffer.from(
    value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4),
    "base64",
  ).length;

  return byteLength >= minBytes && byteLength <= maxBytes;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isToken(value, minLength, maxLength) {
  return typeof value === "string" && value.length >= minLength && value.length <= maxLength && /^[A-Za-z0-9_-]+$/.test(value);
}

function isStorageId(value) {
  return typeof value === "string" && value.length >= 8 && value.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value);
}

function isValidAttachmentManifestList(value) {
  return Array.isArray(value) && value.every((attachment) =>
    isPlainObject(attachment) &&
    isStorageId(attachment.attachmentId) &&
    Number.isInteger(attachment.chunkCount) &&
    attachment.chunkCount > 0 &&
    attachment.chunkCount <= 100000 &&
    Number.isSafeInteger(attachment.encryptedSize) &&
    attachment.encryptedSize >= attachment.chunkCount * 28 &&
    attachment.encryptedSize <= attachment.chunkCount * maxAttachmentChunkBytes &&
    typeof attachment.uploadComplete === "boolean"
  );
}

async function normalizeAttachmentManifests(value, portalId) {
  if (!Array.isArray(value)) {
    return [];
  }

  const manifests = [];

  for (const attachment of value) {
    const received = await inspectReceivedAttachmentChunks(portalId, attachment.attachmentId, attachment.chunkCount);
    const uploadComplete =
      attachment.uploadComplete &&
      received.contiguous &&
      !received.unexpectedEntries &&
      attachment.chunkCount === received.chunkCount &&
      attachment.encryptedSize === received.encryptedSize;

    manifests.push({
      attachmentId: attachment.attachmentId,
      chunkCount: attachment.chunkCount,
      encryptedSize: attachment.encryptedSize,
      uploadComplete,
      receivedChunkCount: received.chunkCount,
      receivedEncryptedSize: received.encryptedSize,
    });
  }

  return manifests;
}

async function validateStagedUploadSession(portalId, attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    if (await hasAnyAttachmentStaging(portalId)) {
      return "unexpected_attachment_staging";
    }

    return undefined;
  }

  const uploadSession = uploadSessions.get(portalId);

  if (!uploadSession || uploadSession.expiresAt <= Date.now()) {
    return "upload_session_required";
  }

  if (uploadSession.attachments.size !== attachments.length) {
    return "upload_session_mismatch";
  }

  const declaredAttachmentIds = new Set();

  for (const attachment of attachments) {
    const expected = uploadSession.attachments.get(attachment.attachmentId);

    if (!expected) {
      return "upload_session_mismatch";
    }

    declaredAttachmentIds.add(attachment.attachmentId);

    if (
      expected.chunkCount !== attachment.chunkCount ||
      expected.encryptedSize !== attachment.encryptedSize
    ) {
      return "upload_session_mismatch";
    }
  }

  if (await hasUnexpectedAttachmentStaging(portalId, declaredAttachmentIds)) {
    return "unexpected_attachment_staging";
  }

  return undefined;
}

async function hasAnyAttachmentStaging(portalId) {
  let entries;

  try {
    entries = await fs.readdir(resolveStoragePath(attachmentRoot, portalId));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }

  return entries.length > 0;
}

async function inspectReceivedAttachmentChunks(portalId, attachmentId, expectedChunkCount) {
  try {
    const entries = await fs.readdir(getAttachmentDirectory(portalId, attachmentId));
    const chunkIndexes = [];
    let encryptedSize = 0;
    let unexpectedEntries = false;

    for (const entry of entries) {
      const match = entry.match(/^(\d+)\.chunk$/);

      if (!match) {
        unexpectedEntries = true;
        continue;
      }

      const chunkIndex = Number(match[1]);
      chunkIndexes.push(chunkIndex);
      const stat = await fs.stat(getAttachmentChunkPath(portalId, attachmentId, chunkIndex));
      encryptedSize += stat.size;
    }

    chunkIndexes.sort((left, right) => left - right);
    const contiguous =
      chunkIndexes.length === expectedChunkCount &&
      chunkIndexes.every((chunkIndex, expectedIndex) => chunkIndex === expectedIndex);

    return {
      chunkCount: chunkIndexes.filter((chunkIndex) => Number.isInteger(chunkIndex)).length,
      encryptedSize,
      contiguous,
      unexpectedEntries,
    };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { chunkCount: 0, encryptedSize: 0, contiguous: false, unexpectedEntries: false };
    }

    throw error;
  }
}

async function getExistingAttachmentChunkSize(portalId, attachmentId, chunkIndex) {
  try {
    const stat = await fs.stat(getAttachmentChunkPath(portalId, attachmentId, chunkIndex));
    return stat.size;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return 0;
    }

    throw error;
  }
}

async function hasUnexpectedAttachmentStaging(portalId, expectedAttachmentIds) {
  let entries;

  try {
    entries = await fs.readdir(resolveStoragePath(attachmentRoot, portalId), { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !isStorageId(entry.name) || !expectedAttachmentIds.has(entry.name)) {
      return true;
    }
  }

  return false;
}

function getAttachmentDirectory(portalId, attachmentId) {
  return resolveStoragePath(attachmentRoot, portalId, attachmentId);
}

function getAttachmentChunkPath(portalId, attachmentId, chunkIndex) {
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 100000) {
    throw new Error("Invalid attachment chunk index.");
  }

  return resolveStoragePath(attachmentRoot, portalId, attachmentId, `${chunkIndex}.chunk`);
}

function resolveStoragePath(root, ...segments) {
  for (const segment of segments) {
    if (typeof segment !== "string" || !/^[A-Za-z0-9_.-]+$/.test(segment)) {
      throw new Error("Invalid storage path segment.");
    }
  }

  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, ...segments);

  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Storage path escaped root.");
  }

  return resolvedPath;
}

function isIsoDate(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeRecipientEmails(value) {
  return Array.from(
    new Set(
      (Array.isArray(value) ? value : [])
        .map((item) => normalizeEmail(item))
        .filter((item) => isValidEmail(item)),
    ),
  );
}

function isValidEmail(value) {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function portalIncludesRecipient(record, recipientEmail) {
  return record.recipientEmails.includes(normalizeEmail(recipientEmail));
}

function challengeKey(portalId, recipientEmail) {
  return `${portalId}:${normalizeEmail(recipientEmail)}`;
}

function sessionKey(portalId, recipientEmail) {
  return `${portalId}:${normalizeEmail(recipientEmail)}`;
}

function generateOtp() {
  if (/^\d{6}$/.test(process.env.UNSYNC_OTP_FIXED_CODE ?? "")) {
    return process.env.UNSYNC_OTP_FIXED_CODE;
  }

  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function randomToken(byteLength) {
  return crypto.randomBytes(byteLength).toString("base64url");
}

function hashOtp(otp, salt) {
  return crypto.createHash("sha256").update(`${salt}:${otp}`, "utf8").digest("base64url");
}

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest("base64url");
}

function hashUploadSessionToken(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest("base64url");
}

function hashLogValue(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("base64url").slice(0, 16);
}

function logSecurityEvent(event, fields = {}) {
  updateMetricsForSecurityEvent(event, fields);
  const safeEvent = {
    ts: new Date().toISOString(),
    event,
    ...sanitizeSecurityEventFields(fields)
  };

  recentSecurityEvents.push(safeEvent);

  while (recentSecurityEvents.length > getOpsEventsMax()) {
    recentSecurityEvents.shift();
  }

  console.log(JSON.stringify(safeEvent));
}

function getOpsEventsMax() {
  return Number.isInteger(opsEventsMax) && opsEventsMax > 0 && opsEventsMax <= 1000
    ? opsEventsMax
    : 100;
}

function sanitizeSecurityEventFields(fields) {
  const safeFields = {};

  for (const [key, value] of Object.entries(fields)) {
    if (!isSafeEventFieldName(key)) {
      continue;
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      safeFields[key] = value;
    }
  }

  return safeFields;
}

function isSafeEventFieldName(key) {
  return [
    "portalIdHash",
    "attachmentIdHash",
    "recipientEmailHash",
    "ipHash",
    "scope",
    "reason",
    "attachmentCount",
    "recipientCount",
    "replyCount",
    "expiresInMs",
    "oneTimeRead",
    "blocked",
    "notificationSent",
    "deleteAfter",
  ].includes(key);
}

function updateMetricsForSecurityEvent(event, fields) {
  switch (event) {
    case "portal_created":
      metricsCounters.portalCreatedCount += 1;
      break;
    case "portal_consumed":
      metricsCounters.consumedPortalCount += 1;
      break;
    case "otp_requested":
      metricsCounters.otpRequestedCount += 1;
      break;
    case "otp_verified":
      metricsCounters.otpSuccessCount += 1;
      break;
    case "otp_failed":
      metricsCounters.otpFailCount += 1;
      break;
    case "rate_limit_blocked":
      metricsCounters.rateLimitBlockCount += 1;
      break;
    case "invalid_token_hash":
      metricsCounters.invalidTokenCount += 1;
      break;
    case "upload_session_created":
      metricsCounters.uploadSessionCreatedCount += 1;
      break;
    case "attachment_upload_denied":
      metricsCounters.uploadFailuresCount += 1;
      break;
    case "cleanup_deletion":
      metricsCounters.cleanupDeletionCount += 1;
      if (fields.reason === "expired") {
        metricsCounters.expiredPortalCount += 1;
      }
      break;
    default:
      break;
  }
}

function logOtpFailure(portalId, recipientEmail, reason) {
  logSecurityEvent("otp_failed", {
    portalIdHash: hashLogValue(portalId),
    recipientEmailHash: hashLogValue(recipientEmail),
    reason,
  });
}

function logInvalidPortalAccess(request, portalId, reason, fields = {}) {
  logSecurityEvent("invalid_portal_access", {
    portalIdHash: hashLogValue(portalId),
    ipHash: hashLogValue(getClientIp(request)),
    reason,
    ...fields
  });
}

function logRateLimitBlocked(request, scope, portalId, reason) {
  logSecurityEvent("rate_limit_blocked", {
    scope,
    portalIdHash: hashLogValue(portalId),
    ipHash: hashLogValue(getClientIp(request)),
    reason
  });
}

function consumeRequestRateLimit(request, response, scope, portalId, maxRequests, options = {}) {
  const key = `${scope}:${portalId}:${getClientIp(request)}`;
  const allowed = consumeRateLimit(rateLimitWindows, key, maxRequests, portalRateLimitWindowMs);

  if (allowed) {
    return true;
  }

  logRateLimitBlocked(request, scope, portalId, options.reason ?? "request_rate_limit");

  if (options.extraEvent) {
    logSecurityEvent(options.extraEvent, {
      portalIdHash: hashLogValue(portalId),
      ipHash: hashLogValue(getClientIp(request)),
      reason: options.reason ?? "request_rate_limit"
    });
  }

  sendJson(response, 429, { error: "rate_limited" });
  return false;
}

function consumeRateLimit(store, key, maxRequests, windowMs) {
  const now = Date.now();
  const existing = store.get(key);

  if (!existing || existing.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (existing.count >= maxRequests) {
    return false;
  }

  existing.count += 1;
  return true;
}

function getClientIp(request) {
  if (!trustProxy) {
    return getSocketIp(request);
  }

  const cfConnectingIp = getHeaderValue(request.headers["cf-connecting-ip"]).trim();
  if (isPlausibleClientIp(cfConnectingIp)) {
    return cfConnectingIp;
  }

  const realIp = getHeaderValue(request.headers["x-real-ip"]).trim();
  if (isPlausibleClientIp(realIp)) {
    return realIp;
  }

  const forwardedFor = getHeaderValue(request.headers["x-forwarded-for"]);
  const firstForwarded = forwardedFor.split(",")[0]?.trim();
  if (isPlausibleClientIp(firstForwarded)) {
    return firstForwarded;
  }

  return getSocketIp(request);
}

function getSocketIp(request) {
  return request.socket.remoteAddress || "unknown";
}

function hasForwardedClientHeaders(request) {
  return Boolean(
    request.headers["forwarded"] ||
    request.headers["x-forwarded-for"] ||
    request.headers["x-forwarded-host"] ||
    request.headers["x-forwarded-proto"] ||
    request.headers["x-real-ip"] ||
    request.headers["cf-connecting-ip"] ||
    request.headers["cf-visitor"]
  );
}

function isPlausibleClientIp(value) {
  return typeof value === "string" && net.isIP(value) !== 0;
}

function isHttpsRequest(request) {
  if (request.socket.encrypted) {
    return true;
  }

  if (!trustProxy) {
    return false;
  }

  if (getHeaderValue(request.headers["x-forwarded-proto"]).split(",")[0]?.trim() === "https") {
    return true;
  }

  try {
    const cfVisitor = JSON.parse(getHeaderValue(request.headers["cf-visitor"]) || "{}");
    return cfVisitor.scheme === "https";
  } catch {
    return false;
  }
}

function badTokenKey(request, portalId) {
  return `${portalId}:${getClientIp(request)}`;
}

function isBadTokenBlocked(request, portalId) {
  const entry = badTokenWindows.get(badTokenKey(request, portalId));
  return Boolean(entry && entry.blockedUntil > Date.now());
}

function recordBadTokenFailure(request, portalId) {
  const key = badTokenKey(request, portalId);
  const now = Date.now();
  const existing = badTokenWindows.get(key);
  const entry = existing && existing.resetAt > now
    ? existing
    : { count: 0, resetAt: now + portalRateLimitWindowMs, blockedUntil: 0 };

  entry.count += 1;

  if (entry.count >= maxBadTokenFailures) {
    entry.blockedUntil = now + badTokenBlockMs;
  }

  badTokenWindows.set(key, entry);
  return entry.blockedUntil > now;
}

function clearBadTokenFailures(request, portalId) {
  badTokenWindows.delete(badTokenKey(request, portalId));
}

function validateUploadSessionForChunk(request, portalId, attachmentId, chunkIndex) {
  const uploadSession = uploadSessions.get(portalId);
  const uploadSessionToken = getHeaderValue(request.headers["x-unsync-upload-session"]);

  if (!uploadSession || uploadSession.expiresAt <= Date.now()) {
    return undefined;
  }

  if (!uploadSessionToken || !constantTimeEqual(hashUploadSessionToken(uploadSessionToken), uploadSession.tokenHash)) {
    return undefined;
  }

  if (uploadSession.portalId !== portalId) {
    return undefined;
  }

  const attachment = uploadSession.attachments.get(attachmentId);

  if (!attachment || chunkIndex < 0 || chunkIndex >= attachment.chunkCount) {
    return undefined;
  }

  return uploadSession;
}

function consumeOtpSendAllowance(portalId, recipientEmail) {
  const key = challengeKey(portalId, recipientEmail);
  const cutoff = Date.now() - 60 * 60 * 1000;
  const recent = (otpSendWindows.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
  const lastSentAt = recent[recent.length - 1] ?? 0;

  if (lastSentAt && Date.now() - lastSentAt < otpCooldownMs) {
    otpSendWindows.set(key, recent);
    return { ok: false, reason: "cooldown" };
  }

  if (recent.length >= maxOtpSendsPerHour) {
    otpSendWindows.set(key, recent);
    return { ok: false, reason: "hourly_limit" };
  }

  recent.push(Date.now());
  otpSendWindows.set(key, recent);
  return { ok: true };
}

function isExpired(record) {
  return Date.parse(record.expiresAt) <= Date.now();
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  const maxLength = Math.max(leftBuffer.length, rightBuffer.length);
  const paddedLeft = Buffer.alloc(maxLength);
  const paddedRight = Buffer.alloc(maxLength);

  leftBuffer.copy(paddedLeft);
  rightBuffer.copy(paddedRight);

  return crypto.timingSafeEqual(paddedLeft, paddedRight) && leftBuffer.length === rightBuffer.length;
}

async function sendOtpEmail(recipientEmail, otp) {
  if (process.env.UNSYNC_OTP_FIXED_CODE && !process.env.SMTP_HOST) {
    return;
  }

  const host = process.env.SMTP_HOST;
  const portValue = Number(process.env.SMTP_PORT ?? 465);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM ?? user;

  if (!host || !from) {
    throw new HttpError(503, "otp_email_not_configured");
  }

  const subject = "Unsync Secure Message Verification Code";
  const body = [
    "Your Unsync verification code is:",
    "",
    otp,
    "",
    "This code expires in 10 minutes.",
  ].join("\r\n");
  const message = [
    `From: ${from}`,
    `To: ${recipientEmail}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
  ].join("\r\n");

  await sendSmtpMail({ host, port: portValue, user, pass, from, to: recipientEmail, message });
}

function buildSecureReplyPackage(portalId, reply) {
  return {
    version: 1,
    type: "secure-portal-reply",
    portalId,
    replyId: reply.replyId,
    receivedAt: reply.receivedAt,
    encryptedPayload: reply.encryptedPayload,
  };
}

function buildSecureReplyEmail(replyPackage) {
  const encodedPackage = Buffer
    .from(JSON.stringify(replyPackage), "utf8")
    .toString("base64url");
  const armoredPackage = [
    "-----BEGIN UNSYNC SECURE PORTAL REPLY-----",
    encodedPackage,
    "-----END UNSYNC SECURE PORTAL REPLY-----",
  ].join("\r\n");

  return {
    subject: "Unsync Secure Portal Reply Received",
    body: [
      "You have received an encrypted Secure Portal reply.",
      "",
      "Open this email in Hermes to decrypt automatically.",
      "",
      armoredPackage,
    ].join("\r\n"),
  };
}

async function sendReplyNotificationEmail(recipientEmail, replyEmail) {
  const host = process.env.SMTP_HOST;
  const portValue = Number(process.env.SMTP_PORT ?? 465);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM ?? user;

  if (!host || !from) {
    return false;
  }

  const subject = replyEmail.subject;
  const body = replyEmail.body;
  const message = [
    `From: ${from}`,
    `To: ${recipientEmail}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
  ].join("\r\n");

  await sendSmtpMail({ host, port: portValue, user, pass, from, to: recipientEmail, message });
  return true;
}

async function sendSmtpMail(options) {
  const secure = process.env.SMTP_SECURE !== "false";

  if (!secure && !parseBoolean(process.env.SMTP_ALLOW_INSECURE_TRANSPORT ?? "false")) {
    throw new HttpError(503, "smtp_insecure_transport_disabled");
  }

  const socket = secure
    ? tls.connect({ host: options.host, port: options.port, servername: options.host })
    : net.connect({ host: options.host, port: options.port });

  try {
    await expectSmtp(socket, 220);
    await smtpCommand(socket, `EHLO ${process.env.SMTP_EHLO_HOST ?? "mail.unsync.uk"}`, 250);

    if (options.user && options.pass) {
      await smtpCommand(socket, "AUTH LOGIN", 334);
      await smtpCommand(socket, Buffer.from(options.user).toString("base64"), 334);
      await smtpCommand(socket, Buffer.from(options.pass).toString("base64"), 235);
    }

    await smtpCommand(socket, `MAIL FROM:<${options.from}>`, 250);
    await smtpCommand(socket, `RCPT TO:<${options.to}>`, 250);
    await smtpCommand(socket, "DATA", 354);
    await smtpCommand(socket, `${options.message.replace(/\r?\n\./g, "\r\n..")}\r\n.`, 250);
    await smtpCommand(socket, "QUIT", 221);
  } finally {
    socket.end();
  }
}

function smtpCommand(socket, command, expectedCode) {
  socket.write(`${command}\r\n`);
  return expectSmtp(socket, expectedCode);
}

function expectSmtp(socket, expectedCode) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const lastLine = lines[lines.length - 1] ?? "";

      if (!/^\d{3} /.test(lastLine)) {
        return;
      }

      socket.off("data", onData);
      socket.off("error", onError);
      const code = Number(lastLine.slice(0, 3));

      if (code === expectedCode) {
        resolve(buffer);
      } else {
        reject(new Error(`SMTP command failed with ${code}.`));
      }
    };
    const onError = (error) => {
      socket.off("data", onData);
      reject(error);
    };

    socket.on("data", onData);
    socket.once("error", onError);
  });
}

async function loadRecords() {
  await fs.mkdir(dataDir, { recursive: true });

  try {
    const raw = await fs.readFile(recordsPath, "utf8");
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed.records)) {
      records = new Map(parsed.records.map((record) => [
        record.portalId,
        {
          ...record,
          replies: Array.isArray(record.replies) ? record.replies : [],
        },
      ]));
    }
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      throw error;
    }
  }
}

function startCleanupWorker() {
  const timer = setInterval(() => {
    void runCleanup().catch((error) => {
      console.error("portal cleanup error:", error instanceof Error ? error.message : String(error));
    });
  }, cleanupIntervalMs);

  timer.unref?.();
  void runCleanup();
}

async function runCleanup() {
  const now = Date.now();
  let recordsChanged = false;

  for (const [portalId, record] of records.entries()) {
    const expired = isExpired(record);
    const consumedReadyForDeletion =
      record.oneTimeRead &&
      record.isConsumed &&
      record.deleteAfter &&
      Date.parse(record.deleteAfter) <= now;

    if (expired || consumedReadyForDeletion) {
      records.delete(portalId);
      expirePortalAuthState(portalId);
      await deletePortalAttachmentChunks(portalId);
      recordsChanged = true;
      logSecurityEvent("cleanup_deletion", {
        portalIdHash: hashLogValue(portalId),
        reason: expired ? "expired" : "consumed_retention_elapsed"
      });
    }
  }

  for (const [key, challenge] of otpChallenges.entries()) {
    if (challenge.expiresAt <= now) {
      otpChallenges.delete(key);
    }
  }

  for (const [key, session] of verifiedSessions.entries()) {
    if (session.expiresAt <= now) {
      verifiedSessions.delete(key);
    }
  }

  for (const [key, timestamps] of otpSendWindows.entries()) {
    const recent = timestamps.filter((timestamp) => timestamp > now - 60 * 60 * 1000);

    if (recent.length === 0) {
      otpSendWindows.delete(key);
    } else {
      otpSendWindows.set(key, recent);
    }
  }

  for (const [key, window] of rateLimitWindows.entries()) {
    if (window.resetAt <= now) {
      rateLimitWindows.delete(key);
    }
  }

  for (const [key, window] of badTokenWindows.entries()) {
    if (window.resetAt <= now && window.blockedUntil <= now) {
      badTokenWindows.delete(key);
    }
  }

  for (const [portalId, uploadSession] of uploadSessions.entries()) {
    if (uploadSession.expiresAt <= now) {
      uploadSessions.delete(portalId);
      await deletePortalAttachmentChunks(portalId);
      logSecurityEvent("upload_session_expired", {
        portalIdHash: hashLogValue(portalId),
      });
      logSecurityEvent("staged_upload_deleted", {
        portalIdHash: hashLogValue(portalId),
        reason: "upload_session_expired"
      });
    }
  }

  if (recordsChanged) {
    await persistRecords();
  }

  await deleteOrphanedAttachmentDirectories();
}

async function deletePortalAttachmentChunks(portalId) {
  if (!isStorageId(portalId)) {
    return;
  }

  await fs.rm(resolveStoragePath(attachmentRoot, portalId), { recursive: true, force: true });
}

async function deleteOrphanedAttachmentDirectories() {
  let entries;

  try {
    entries = await fs.readdir(attachmentRoot, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      isStorageId(entry.name) &&
      !records.has(entry.name) &&
      !hasActiveUploadSession(entry.name) &&
      await isStagedUploadPastRetention(entry.name)
    ) {
      await deletePortalAttachmentChunks(entry.name);
      logSecurityEvent("cleanup_deletion", {
        portalIdHash: hashLogValue(entry.name),
        reason: "orphaned_attachment_chunks"
      });
      logSecurityEvent("staged_upload_deleted", {
        portalIdHash: hashLogValue(entry.name),
        reason: "orphaned_staging_retention_elapsed"
      });
    }
  }
}

function hasActiveUploadSession(portalId) {
  const uploadSession = uploadSessions.get(portalId);
  return Boolean(uploadSession && uploadSession.expiresAt > Date.now());
}

async function isStagedUploadPastRetention(portalId) {
  try {
    const stat = await fs.stat(resolveStoragePath(attachmentRoot, portalId));
    return stat.mtimeMs <= Date.now() - stagedUploadRetentionMs;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function persistRecords() {
  await fs.mkdir(dataDir, { recursive: true });
  const payload = JSON.stringify({ records: Array.from(records.values()) }, null, 2);
  const tempPath = `${recordsPath}.tmp`;
  await fs.writeFile(tempPath, payload, { mode: 0o600 });
  await fs.rename(tempPath, recordsPath);
}

function sendJson(response, statusCode, payload, callback) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload), callback);
}

function sendText(response, statusCode, contentType, body) {
  response.writeHead(statusCode, { "content-type": contentType });
  response.end(body);
}

function sendReaderPage(response, portalId) {
  const safePortalId = escapeHtml(portalId);

  response.setHeader(
    "content-security-policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  sendText(
    response,
    200,
    "text/html; charset=utf-8",
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <title>Unsync Secure Message</title>
    <link rel="stylesheet" href="/reader/reader.css">
  </head>
  <body>
    <main class="shell">
      <section class="card" aria-labelledby="reader-title">
        <div class="brand">Unsync Mail</div>
        <h1 id="reader-title">Secure message</h1>
        <p id="state-message" class="state">Enter the access token from the sender to decrypt this message locally.</p>

        <form id="token-form" class="token-form" autocomplete="off">
          <input type="hidden" id="portal-id" value="${safePortalId}">
          <div id="recipient-field">
            <label for="recipient-email">Recipient email</label>
            <input id="recipient-email" name="recipient-email" type="email" autocomplete="email" spellcheck="false" required>
          </div>
          <div id="token-field">
            <label for="access-token">Access token</label>
            <input id="access-token" name="access-token" type="password" autocomplete="off" spellcheck="false" required>
          </div>
          <div id="otp-fields" hidden>
            <label for="otp-code">Verification code</label>
            <input id="otp-code" name="otp-code" type="text" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code" spellcheck="false">
          </div>
          <button id="decrypt-button" type="submit">Send verification code</button>
        </form>

        <article id="message-content" class="message" hidden>
          <div id="message-toolbar" class="message-toolbar" hidden>
            <p id="session-status" class="session-status"></p>
            <div class="message-actions">
              <button id="reply-button" type="button">Reply</button>
              <button id="forward-button" type="button">Forward</button>
            </div>
          </div>
          <h2 id="message-subject"></h2>
          <pre id="message-body"></pre>
          <section id="attachment-section" class="attachments" hidden>
            <h3>Attachments</h3>
            <div id="attachment-list"></div>
          </section>
        </article>
      </section>
      <section id="reply-modal" class="reply-modal" role="dialog" aria-modal="true" aria-labelledby="reply-title" hidden>
        <form id="reply-form" class="reply-panel" autocomplete="off">
          <div class="reply-header">
            <h2 id="reply-title">Secure reply</h2>
            <button id="reply-close-button" class="reply-close" type="button" aria-label="Close reply composer">x</button>
          </div>
          <label for="reply-to">To</label>
          <input id="reply-to" name="reply-to" type="email" readonly>
          <label for="reply-subject">Subject</label>
          <input id="reply-subject" name="reply-subject" type="text" readonly>
          <label for="reply-body">Message</label>
          <textarea id="reply-body" name="reply-body" rows="8" required></textarea>
          <p id="reply-status" class="reply-status" role="status"></p>
          <div class="reply-actions">
            <button id="reply-cancel-button" type="button">Cancel</button>
            <button id="reply-send-button" type="submit">Send encrypted reply</button>
          </div>
        </form>
      </section>
    </main>
    <script src="/reader/reader.js"></script>
  </body>
</html>`,
  );
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildOpsDashboardHtml(snapshot) {
  const cards = [
    ["Active portals", snapshot.gauges.activePortalCount],
    ["Consumed portals", snapshot.gauges.consumedPortalCount],
    ["OTP requested", snapshot.counters.otpRequestedCount],
    ["OTP success", snapshot.counters.otpSuccessCount],
    ["OTP fail", snapshot.counters.otpFailCount],
    ["Rate-limit blocks", snapshot.counters.rateLimitBlockCount],
    ["Invalid tokens", snapshot.counters.invalidTokenCount],
    ["Upload sessions", snapshot.gauges.activeUploadSessionCount],
    ["Chunks uploaded", snapshot.counters.attachmentChunksUploadedCount],
    ["Chunks downloaded", snapshot.counters.attachmentChunksDownloadedCount],
    ["Storage", formatDashboardBytes(snapshot.gauges.storageUsageBytes)],
    ["Verified sessions", snapshot.gauges.activeVerifiedSessionCount],
  ];
  const cardHtml = cards.map(([label, value]) =>
    `<section class="card"><div>${escapeHtml(label)}</div><strong>${escapeHtml(String(value))}</strong></section>`
  ).join("");
  const eventRows = snapshot.recentEvents.map((event) =>
    `<tr><td>${escapeHtml(event.ts)}</td><td>${escapeHtml(event.event)}</td><td>${escapeHtml(JSON.stringify(event))}</td></tr>`
  ).join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <title>Unsync Portal Ops</title>
    <style nonce="unsync-ops-style">
      body { margin: 0; background: #070b10; color: #e6edf3; font-family: ui-sans-serif, system-ui, sans-serif; }
      main { max-width: 1180px; margin: 0 auto; padding: 32px 20px; }
      h1 { font-size: 24px; font-weight: 650; margin: 0 0 6px; }
      p { color: #9ca8b3; margin: 0 0 24px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }
      .card { border: 1px solid #243140; padding: 14px; background: #0d131b; }
      .card div { color: #9ca8b3; font-size: 12px; }
      .card strong { display: block; font-size: 24px; margin-top: 8px; }
      table { width: 100%; border-collapse: collapse; margin-top: 24px; font-size: 12px; }
      th, td { border-bottom: 1px solid #243140; padding: 8px; text-align: left; vertical-align: top; }
      td:last-child { color: #9ca8b3; word-break: break-word; }
    </style>
  </head>
  <body>
    <main>
      <h1>Unsync Secure Portal Ops</h1>
      <p>Generated ${escapeHtml(snapshot.generatedAt)}. Metrics are aggregate-only and sanitized.</p>
      <div class="grid">${cardHtml}</div>
      <table>
        <thead><tr><th>Time</th><th>Event</th><th>Safe fields</th></tr></thead>
        <tbody>${eventRows}</tbody>
      </table>
    </main>
  </body>
</html>`;
}

function formatDashboardBytes(value) {
  const units = ["B", "KB", "MB", "GB"];
  let size = Number(value) || 0;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

const readerCss = `
:root {
  color-scheme: dark;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #0b0d10;
  color: #f7f7f2;
}

* {
  box-sizing: border-box;
}

html,
body {
  min-height: 100%;
  margin: 0;
}

body {
  background: #0b0d10;
}

.shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
}

.card {
  width: min(640px, 100%);
  border: 1px solid #2d343d;
  background: #11161c;
  padding: 28px;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.36);
}

.brand {
  color: #8ee6c8;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
}

h1,
h2,
p {
  margin: 0;
}

h1 {
  margin-top: 10px;
  font-size: 28px;
  line-height: 1.15;
}

.state {
  margin-top: 12px;
  color: #b7c0c9;
  line-height: 1.5;
}

.state.is-error {
  color: #ff9b9b;
}

.state.is-success {
  color: #8ee6c8;
}

.token-form {
  display: grid;
  gap: 10px;
  margin-top: 24px;
}

.token-form.is-complete {
  display: none;
}

label {
  color: #dce4ea;
  font-size: 13px;
  font-weight: 650;
}

input,
textarea,
button {
  border-radius: 0;
  font: inherit;
}

input,
textarea {
  width: 100%;
  border: 1px solid #35404b;
  background: #07090c;
  color: #ffffff;
  padding: 12px;
  outline: none;
}

textarea {
  min-height: 160px;
  resize: vertical;
}

input:focus,
textarea:focus {
  border-color: #8ee6c8;
}

button {
  border: 1px solid #8ee6c8;
  background: #8ee6c8;
  color: #07100d;
  padding: 12px 14px;
  font-weight: 750;
  cursor: pointer;
}

button:disabled {
  cursor: wait;
  opacity: 0.7;
}

.message-toolbar {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 12px;
  align-items: center;
  margin-bottom: 18px;
}

.session-status {
  color: #8ee6c8;
  font-size: 13px;
  line-height: 1.45;
}

.message-actions {
  display: flex;
  gap: 8px;
}

.message-actions button {
  background: #161e27;
  color: #e6edf3;
  border-color: #3a4653;
  padding: 9px 12px;
}

.message-actions button:hover {
  border-color: #8ee6c8;
}

.message {
  margin-top: 26px;
  border-top: 1px solid #2d343d;
  padding-top: 22px;
}

.message h2 {
  font-size: 20px;
  line-height: 1.25;
}

.message pre {
  margin: 16px 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  line-height: 1.55;
  color: #eef3f7;
}

.attachments {
  margin-top: 22px;
  border-top: 1px solid #2d343d;
  padding-top: 18px;
}

.attachments h3 {
  margin: 0 0 12px;
  font-size: 15px;
}

.attachment-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 12px;
  align-items: center;
  border: 1px solid #2d343d;
  padding: 12px;
  margin-top: 8px;
}

.attachment-name {
  overflow-wrap: anywhere;
}

.attachment-meta {
  color: #9ca8b3;
  font-size: 12px;
  margin-top: 2px;
}

.reply-modal {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(4, 7, 10, 0.78);
}

.reply-modal[hidden] {
  display: none;
}

.reply-panel {
  width: min(560px, 100%);
  display: grid;
  gap: 10px;
  border: 1px solid #2d343d;
  background: #11161c;
  padding: 20px;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.42);
}

.reply-header,
.reply-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.reply-header h2 {
  font-size: 20px;
}

.reply-close {
  width: 38px;
  height: 38px;
  padding: 0;
  background: #161e27;
  color: #e6edf3;
  border-color: #3a4653;
}

.reply-status {
  min-height: 20px;
  color: #b7c0c9;
  font-size: 13px;
  line-height: 1.45;
}

.reply-status.is-error {
  color: #ff9b9b;
}

.reply-status.is-success {
  color: #8ee6c8;
}

.reply-actions button:first-child {
  background: #161e27;
  color: #e6edf3;
  border-color: #3a4653;
}

@media (max-width: 540px) {
  .message-toolbar {
    grid-template-columns: 1fr;
  }

  .message-actions {
    width: 100%;
  }

  .message-actions button {
    flex: 1;
  }

  .reply-actions {
    display: grid;
  }
}
`;

const readerJs = `
(() => {
  "use strict";

  const form = document.getElementById("token-form");
  const portalIdInput = document.getElementById("portal-id");
  const recipientField = document.getElementById("recipient-field");
  const recipientEmailInput = document.getElementById("recipient-email");
  const tokenField = document.getElementById("token-field");
  const tokenInput = document.getElementById("access-token");
  const otpFields = document.getElementById("otp-fields");
  const otpInput = document.getElementById("otp-code");
  const decryptButton = document.getElementById("decrypt-button");
  const stateMessage = document.getElementById("state-message");
  const messageContent = document.getElementById("message-content");
  const messageToolbar = document.getElementById("message-toolbar");
  const sessionStatus = document.getElementById("session-status");
  const replyButton = document.getElementById("reply-button");
  const forwardButton = document.getElementById("forward-button");
  const messageSubject = document.getElementById("message-subject");
  const messageBody = document.getElementById("message-body");
  const attachmentSection = document.getElementById("attachment-section");
  const attachmentList = document.getElementById("attachment-list");
  const replyModal = document.getElementById("reply-modal");
  const replyForm = document.getElementById("reply-form");
  const replyToInput = document.getElementById("reply-to");
  const replySubjectInput = document.getElementById("reply-subject");
  const replyBodyInput = document.getElementById("reply-body");
  const replyStatus = document.getElementById("reply-status");
  const replyCloseButton = document.getElementById("reply-close-button");
  const replyCancelButton = document.getElementById("reply-cancel-button");
  const replySendButton = document.getElementById("reply-send-button");
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let plaintextSubject = "";
  let plaintextBody = "";
  let decryptedMetadata = null;
  let replyTargetEmail = "";
  let replyPreparedSubject = "";
  let replyEncryptionKey = null;
  let attachmentDescriptors = [];
  let attachmentObjectUrls = [];
  let accessToken = "";
  let recipientEmail = "";
  let verifiedSessionToken = "";
  let idleTimer = 0;
  let idleController = null;
  let replyCloseTimer = 0;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void continueVerificationFlow();
  });

  replyButton.addEventListener("click", () => {
    openReplyComposer();
  });
  forwardButton.addEventListener("click", () => {
    setState("Forwarding is not available in Secure Reader.", "error");
  });
  replyForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void sendSecureReply();
  });
  replyCloseButton.addEventListener("click", closeReplyComposer);
  replyCancelButton.addEventListener("click", closeReplyComposer);

  window.addEventListener("beforeunload", clearPlaintext);
  window.addEventListener("pagehide", clearPlaintext);
  prefillTokenFromHash();

  function prefillTokenFromHash() {
    if (!window.location.hash || window.location.hash.length <= 1) {
      return;
    }

    const hashToken = decodeURIComponent(window.location.hash.slice(1));

    if (hashToken) {
      tokenInput.value = hashToken;
      accessToken = hashToken;
    }

    history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  async function continueVerificationFlow() {
    if (!verifiedSessionToken && otpFields.hidden) {
      await requestOtp();
      return;
    }

    if (!verifiedSessionToken) {
      await verifyOtp();
    }

    if (verifiedSessionToken) {
      await decryptMessage();
    }
  }

  async function requestOtp() {
    clearPlaintext();
    setState("Requesting verification code...", "");
    decryptButton.disabled = true;

    try {
      accessToken = tokenInput.value.trim();
      recipientEmail = recipientEmailInput.value.trim().toLowerCase();

      if (!accessToken) {
        throw new Error("Enter the access token.");
      }

      if (!recipientEmail) {
        throw new Error("Enter your recipient email.");
      }

      const accessTokenHash = await sha256Base64Url(accessToken);
      const response = await fetch("/portal/" + encodeURIComponent(portalIdInput.value) + "/request-otp", {
        method: "POST",
        cache: "no-store",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          recipientEmail,
          accessTokenHash
        })
      });

    if (!response.ok) {
        if (response.status === 410) {
          throw new Error("This secure message has already been opened and is no longer available.");
        }

        throw new Error(await friendlyAuthError(response));
      }

      otpFields.hidden = false;
      otpInput.required = true;
      tokenInput.disabled = true;
      recipientEmailInput.disabled = true;
      decryptButton.textContent = "Verify and decrypt";
      setState("Verification code sent. Enter the code to continue.", "success");
      otpInput.focus();
    } catch (error) {
      accessToken = "";
      recipientEmail = "";
      setState(error instanceof Error ? error.message : "Unable to request verification code.", "error");
    } finally {
      decryptButton.disabled = false;
    }
  }

  async function verifyOtp() {
    setState("Verifying code...", "");
    decryptButton.disabled = true;

    try {
      const otp = otpInput.value.trim();

      if (!/^\\d{6}$/.test(otp)) {
        throw new Error("Enter the 6-digit verification code.");
      }

      const response = await fetch("/portal/" + encodeURIComponent(portalIdInput.value) + "/verify-otp", {
        method: "POST",
        cache: "no-store",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          recipientEmail,
          otp
        })
      });

      if (!response.ok) {
        throw new Error(await friendlyAuthError(response));
      }

      const result = await response.json();
      verifiedSessionToken = String(result.verifiedSessionToken || "");

      if (!verifiedSessionToken) {
        throw new Error("Verification session was not created.");
      }

      otpInput.value = "";
      setState("Verified. Decrypting locally...", "success");
    } finally {
      decryptButton.disabled = false;
    }
  }

  async function decryptMessage() {
    clearPlaintext(false);
    setState("Fetching encrypted message...", "");
    decryptButton.disabled = true;

    try {
      const response = await fetch("/portal/" + encodeURIComponent(portalIdInput.value), {
        method: "GET",
        cache: "no-store",
        headers: {
          "x-unsync-recipient-email": recipientEmail,
          "x-unsync-verified-session": verifiedSessionToken
        }
      });

      if (!response.ok) {
        if (response.status === 410) {
          verifiedSessionToken = "";
          throw new Error("This secure message has already been opened and is no longer available.");
        }

        if (response.status === 403) {
          verifiedSessionToken = "";
          throw new Error("Verification session expired. Reload and verify again.");
        }

        throw new Error("Secure message was not found or has expired.");
      }

      const portalRecord = await response.json();
      const encryptedPayload = JSON.parse(portalRecord.encryptedPayload);

      if (encryptedPayload.version !== 1 || encryptedPayload.cipher !== "aes-256-gcm") {
        throw new Error("Unsupported secure message format.");
      }

      const tokenKey = await importAesKey(await sha256Bytes(accessToken));
      const messageKeyBytes = await decryptPart(encryptedPayload.wrappedMessageKey, tokenKey);
      const messageKey = await importAesKey(messageKeyBytes, ["decrypt", "encrypt"]);
      const metadataBytes = await decryptPart(encryptedPayload.encryptedMetadata, messageKey);
      const bodyBytes = await decryptPart(encryptedPayload.encryptedBody, messageKey);
      const metadata = JSON.parse(decoder.decode(metadataBytes));
      const body = JSON.parse(decoder.decode(bodyBytes));
      const attachments = await buildAttachmentDescriptors(metadata.attachments || [], messageKey);

      decryptedMetadata = metadata;
      replyEncryptionKey = messageKey;
      attachmentDescriptors = attachments;
      plaintextSubject = String(metadata.subject || "(no subject)");
      plaintextBody = String(body.text || "");
      messageSubject.textContent = plaintextSubject;
      messageBody.textContent = plaintextBody;
      messageContent.hidden = false;
      renderAttachmentList();
      tokenInput.value = "";
      accessToken = "";
      const timeoutSeconds = Number(metadata.idleTimeoutSeconds || portalRecord.idleTimeoutSeconds || 300);
      prepareMessageActions(metadata, plaintextSubject, plaintextBody);
      showDecryptedSession(timeoutSeconds);
      setState("Decrypted locally in this browser.", "success");
      startIdleTimeout(timeoutSeconds);
    } catch (error) {
      clearPlaintext();
      setState(error instanceof Error ? error.message : "Unable to decrypt secure message.", "error");
    } finally {
      decryptButton.disabled = false;
    }
  }

  async function sha256Bytes(value) {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  }

  async function sha256Base64Url(value) {
    return toBase64Url(await sha256Bytes(value));
  }

  async function importAesKey(rawKey, usages = ["decrypt"]) {
    return crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, usages);
  }

  async function decryptPart(part, key) {
    const iv = fromBase64Url(part.iv);
    const ciphertext = fromBase64Url(part.ciphertext);
    const authTag = fromBase64Url(part.authTag);
    const combined = new Uint8Array(ciphertext.length + authTag.length);
    combined.set(ciphertext);
    combined.set(authTag, ciphertext.length);

    return new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, tagLength: 128 },
      key,
      combined
    ));
  }

  async function buildAttachmentDescriptors(attachments, messageKey) {
    const descriptors = [];

    for (const attachment of attachments) {
      if (!attachment.uploadComplete) {
        continue;
      }

      const attachmentId = String(attachment.attachmentId || "");
      const chunkCount = Number(attachment.chunkCount || 0);

      if (!attachmentId || !Number.isInteger(chunkCount) || chunkCount <= 0) {
        continue;
      }

      const safeMetadata = await decryptAttachmentMetadata(attachment, messageKey);
      const attachmentKey = await resolveAttachmentKey(attachment, messageKey);
      descriptors.push({
        attachmentId,
        fileName: safeMetadata.fileName,
        mimeType: safeMetadata.mimeType,
        originalSize: safeMetadata.originalSize,
        chunkCount,
        key: attachmentKey
      });
    }

    return descriptors;
  }

  async function decryptAttachmentMetadata(attachment, messageKey) {
    let metadata = {};

    if (attachment.encryptedMetadata) {
      const metadataBytes = await decryptPart(attachment.encryptedMetadata, messageKey);
      metadata = JSON.parse(decoder.decode(metadataBytes));
    }

    return {
      fileName: safeAttachmentFileName(metadata.fileName || attachment.fileName || "attachment"),
      mimeType: safeAttachmentMimeType(metadata.mimeType || attachment.mimeType || "application/octet-stream"),
      originalSize: safeAttachmentSize(metadata.originalSize ?? attachment.originalSize)
    };
  }

  async function resolveAttachmentKey(attachment, messageKey) {
    if (!attachment.encryptedKey) {
      return messageKey;
    }

    const rawKey = await decryptPart(attachment.encryptedKey, messageKey);
    return importAesKey(rawKey);
  }

  function safeAttachmentFileName(value) {
    const text = String(value || "attachment").trim();
    const cleaned = Array.from(text, (char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127 || code === 47 || code === 92 ? "_" : char;
    }).join("");
    return cleaned || "attachment";
  }

  function safeAttachmentMimeType(value) {
    const text = String(value || "application/octet-stream").trim();
    return /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(text)
      ? text
      : "application/octet-stream";
  }

  function safeAttachmentSize(value) {
    const size = Number(value || 0);
    return Number.isSafeInteger(size) && size >= 0 ? size : 0;
  }

  function renderAttachmentList() {
    attachmentList.replaceChildren();
    attachmentSection.hidden = attachmentDescriptors.length === 0;

    for (const attachment of attachmentDescriptors) {
      const row = document.createElement("div");
      row.className = "attachment-row";

      const details = document.createElement("div");
      const name = document.createElement("div");
      name.className = "attachment-name";
      name.textContent = attachment.fileName;
      const meta = document.createElement("div");
      meta.className = "attachment-meta";
      meta.textContent = attachment.mimeType + " - " + formatBytes(attachment.originalSize);
      details.append(name, meta);

      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Download";
      button.addEventListener("click", () => {
        void downloadAttachment(attachment, button);
      });

      row.append(details, button);
      attachmentList.append(row);
    }
  }

  function prepareMessageActions(metadata, subject, body) {
    const sender = getOriginalSender(metadata);
    const replySubject = prefixSubject("Re:", subject);

    replyTargetEmail = sender;
    replyPreparedSubject = replySubject;
    replyButton.disabled = !sender;
    forwardButton.disabled = true;
  }

  function showDecryptedSession(timeoutSeconds) {
    form.classList.add("is-complete");
    recipientField.hidden = true;
    tokenField.hidden = true;
    otpFields.hidden = true;
    decryptButton.hidden = true;
    tokenInput.required = false;
    recipientEmailInput.required = false;
    otpInput.required = false;
    messageToolbar.hidden = false;
    sessionStatus.textContent = "Session active. Idle timeout: " + formatDuration(timeoutSeconds) + ".";
  }

  function restoreVerificationUi() {
    form.classList.remove("is-complete");
    recipientField.hidden = false;
    tokenField.hidden = false;
    decryptButton.hidden = false;
    messageToolbar.hidden = true;
    sessionStatus.textContent = "";
  }

  function getOriginalSender(metadata) {
    const candidates = [metadata.from, metadata.sender, metadata.replyTo, metadata.fromAddress];

    for (const candidate of candidates) {
      const email = extractEmail(candidate);

      if (email) {
        return email;
      }
    }

    return "";
  }

  function extractEmail(value) {
    if (typeof value !== "string") {
      return "";
    }

    const match = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/i);
    return match ? match[0] : "";
  }

  function prefixSubject(prefix, subject) {
    const normalizedSubject = String(subject || "").trim() || "(no subject)";
    return normalizedSubject.toLowerCase().startsWith(prefix.toLowerCase())
      ? normalizedSubject
      : prefix + " " + normalizedSubject;
  }

  function openReplyComposer() {
    if (!replyTargetEmail || !replyEncryptionKey || !verifiedSessionToken) {
      setState("Reply is unavailable for this secure message.", "error");
      return;
    }

    window.clearTimeout(replyCloseTimer);
    replyCloseTimer = 0;
    replyToInput.value = replyTargetEmail;
    replySubjectInput.value = replyPreparedSubject;
    replyBodyInput.value = "";
    setReplyStatus("", "");
    replyModal.hidden = false;
    replyBodyInput.focus();
  }

  function closeReplyComposer() {
    window.clearTimeout(replyCloseTimer);
    replyCloseTimer = 0;
    replyModal.hidden = true;
    replyBodyInput.value = "";
    setReplyStatus("", "");
    replySendButton.disabled = false;
  }

  async function sendSecureReply() {
    const replyText = replyBodyInput.value.trim();

    if (!replyText) {
      setReplyStatus("Write a reply before sending.", "error");
      return;
    }

    replySendButton.disabled = true;
    setReplyStatus("Encrypting reply in this browser...", "");

    try {
      const encryptedPayload = await encryptReplyPayload({
        to: replyTargetEmail,
        subject: replyPreparedSubject,
        text: replyText
      });
      setReplyStatus("Uploading encrypted reply...", "");

      const response = await fetch("/portal/reply", {
        method: "POST",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          "x-unsync-recipient-email": recipientEmail,
          "x-unsync-verified-session": verifiedSessionToken
        },
        body: JSON.stringify({
          portalId: portalIdInput.value,
          notificationEmail: replyTargetEmail,
          encryptedPayload
        })
      });

      if (!response.ok) {
        throw new Error(await friendlyReplyError(response));
      }

      const result = await response.json();
      replyBodyInput.value = "";
      setReplyStatus(
        result.notificationSent
          ? "Encrypted reply sent. The sender was notified."
          : "Encrypted reply stored. Sender notification is not configured.",
        "success"
      );
      setState("Encrypted reply submitted.", "success");
      window.clearTimeout(replyCloseTimer);
      replyCloseTimer = window.setTimeout(closeReplyComposer, 1000);
    } catch (error) {
      setReplyStatus(error instanceof Error ? error.message : "Unable to send encrypted reply.", "error");
    } finally {
      replySendButton.disabled = false;
    }
  }

  async function encryptReplyPayload(reply) {
    if (!replyEncryptionKey) {
      throw new Error("Reply encryption key is unavailable. Reload and verify again.");
    }

    const createdAt = new Date().toISOString();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = encoder.encode(JSON.stringify({
      to: reply.to,
      subject: reply.subject,
      text: reply.text,
      sentAt: createdAt,
      originalPortalId: portalIdInput.value
    }));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        tagLength: 128,
        additionalData: encoder.encode("unsync-portal-reply:v1:" + portalIdInput.value + ":" + createdAt)
      },
      replyEncryptionKey,
      plaintext
    ));
    const authTag = encrypted.slice(encrypted.length - 16);
    const ciphertext = encrypted.slice(0, encrypted.length - 16);

    return {
      version: 1,
      type: "portal-reply",
      cipher: "aes-256-gcm",
      createdAt,
      encryptedBody: {
        iv: toBase64Url(iv),
        ciphertext: toBase64Url(ciphertext),
        authTag: toBase64Url(authTag)
      }
    };
  }

  function setReplyStatus(message, kind) {
    replyStatus.textContent = message;
    replyStatus.classList.toggle("is-error", kind === "error");
    replyStatus.classList.toggle("is-success", kind === "success");
  }

  async function downloadAttachment(attachment, button) {
    button.disabled = true;
    const buttonText = button.textContent;
    button.textContent = "Downloading...";

    try {
      const plaintextChunks = [];

      for (let index = 0; index < attachment.chunkCount; index += 1) {
        const response = await fetch(
          "/portal/" + encodeURIComponent(portalIdInput.value) +
            "/attachment/" + encodeURIComponent(attachment.attachmentId) +
            "/chunk/" + index,
          {
            method: "GET",
            cache: "no-store",
            headers: {
              "x-unsync-recipient-email": recipientEmail,
              "x-unsync-verified-session": verifiedSessionToken
            }
          }
        );

        if (!response.ok) {
          if (response.status === 410) {
            throw new Error("This secure message has already been opened and is no longer available.");
          }

          if (response.status === 403) {
            verifiedSessionToken = "";
            throw new Error("Verification session expired. Reload and verify again.");
          }

          if (response.status === 404) {
            throw new Error("Attachment chunk is missing.");
          }

          throw new Error("Attachment download was interrupted.");
        }

        const encryptedChunk = new Uint8Array(await response.arrayBuffer());
        plaintextChunks.push(
          await decryptAttachmentChunk(encryptedChunk, attachment.key, attachment.attachmentId, index)
        );
      }

      const blob = new Blob(plaintextChunks, { type: attachment.mimeType });
      const objectUrl = URL.createObjectURL(blob);
      attachmentObjectUrls.push(objectUrl);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = attachment.fileName;
      link.rel = "noopener";
      link.click();
      setState("Attachment decrypted locally for download.", "success");
    } catch (error) {
      setState(friendlyAttachmentDownloadError(error), "error");
    } finally {
      button.disabled = false;
      button.textContent = buttonText;
    }
  }

  async function decryptAttachmentChunk(encryptedChunk, key, attachmentId, chunkIndex) {
    if (encryptedChunk.length < 28) {
      throw new Error("Attachment chunk is invalid.");
    }

    const iv = encryptedChunk.slice(0, 12);
    const authTag = encryptedChunk.slice(12, 28);
    const ciphertext = encryptedChunk.slice(28);
    const combined = new Uint8Array(ciphertext.length + authTag.length);
    combined.set(ciphertext);
    combined.set(authTag, ciphertext.length);

    try {
      return new Uint8Array(await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv,
          tagLength: 128,
          additionalData: encoder.encode("unsync-portal-attachment-chunk:v1:" + portalIdInput.value + ":" + attachmentId + ":" + chunkIndex)
        },
        key,
        combined
      ));
    } catch (_) {
      throw new Error("Attachment authentication failed.");
    }
  }

  function friendlyAttachmentDownloadError(error) {
    if (error instanceof TypeError) {
      return "Attachment download was interrupted.";
    }

    if (error instanceof Error && error.message) {
      return error.message;
    }

    return "Unable to decrypt attachment.";
  }

  function startIdleTimeout(seconds) {
    const timeoutSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 300;
    const reset = () => {
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(expireSession, timeoutSeconds * 1000);
    };

    if (idleController) {
      idleController.abort();
    }

    idleController = new AbortController();
    for (const eventName of ["mousemove", "keydown", "pointerdown", "scroll", "touchstart"]) {
      window.addEventListener(eventName, reset, { signal: idleController.signal, passive: true });
    }
    reset();
  }

  function expireSession() {
    clearPlaintext();
    tokenInput.value = "";
    otpInput.value = "";
    setState("Session expired. Reload and verify again.", "error");
  }

  function clearPlaintext(clearSession = true) {
    for (const objectUrl of attachmentObjectUrls) {
      URL.revokeObjectURL(objectUrl);
    }

    attachmentObjectUrls = [];
    attachmentDescriptors = [];
    plaintextSubject = "";
    plaintextBody = "";
    decryptedMetadata = null;
    replyTargetEmail = "";
    replyPreparedSubject = "";
    replyEncryptionKey = null;
    replyModal.hidden = true;
    replyToInput.value = "";
    replySubjectInput.value = "";
    replyBodyInput.value = "";
    window.clearTimeout(replyCloseTimer);
    replyCloseTimer = 0;
    setReplyStatus("", "");
    messageSubject.textContent = "";
    messageBody.textContent = "";
    attachmentList.replaceChildren();
    attachmentSection.hidden = true;
    messageContent.hidden = true;
    messageToolbar.hidden = true;
    sessionStatus.textContent = "";
    replyButton.disabled = true;
    forwardButton.disabled = true;

    if (idleController) {
      idleController.abort();
      idleController = null;
    }

    window.clearTimeout(idleTimer);
    idleTimer = 0;

    if (clearSession) {
      accessToken = "";
      verifiedSessionToken = "";
      restoreVerificationUi();
      tokenInput.disabled = false;
      recipientEmailInput.disabled = false;
      tokenInput.required = true;
      recipientEmailInput.required = true;
    }
  }

  function setState(message, kind) {
    stateMessage.textContent = message;
    stateMessage.classList.toggle("is-error", kind === "error");
    stateMessage.classList.toggle("is-success", kind === "success");
  }

  function fromBase64Url(value) {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  }

  function toBase64Url(bytes) {
    let binary = "";

    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }

    return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
  }

  function formatBytes(value) {
    if (!Number.isFinite(value) || value <= 0) {
      return "0 B";
    }

    const units = ["B", "KB", "MB", "GB"];
    let size = value;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }

    return size.toFixed(unitIndex === 0 ? 0 : 1) + " " + units[unitIndex];
  }

  function formatDuration(seconds) {
    const totalSeconds = Math.max(1, Math.floor(Number(seconds) || 300));
    const minutes = Math.floor(totalSeconds / 60);
    const remainingSeconds = totalSeconds % 60;

    if (minutes > 0 && remainingSeconds > 0) {
      return minutes + "m " + remainingSeconds + "s";
    }

    if (minutes > 0) {
      return minutes + "m";
    }

    return remainingSeconds + "s";
  }

  async function friendlyAuthError(response) {
    let code = "";

    try {
      code = (await response.json()).error || "";
    } catch {
      code = "";
    }

    if (response.status === 429) {
      return "Too many verification attempts. Try again later.";
    }

    if (code === "otp_email_not_configured") {
      return "Verification email is not configured yet.";
    }

    if (code === "invalid_otp") {
      return "Verification code is incorrect.";
    }

    if (code === "otp_expired") {
      return "Verification code expired. Reload and request a new code.";
    }

    if (response.status === 403) {
      return "Verification failed. Check your email and access token.";
    }

    return "Unable to continue verification.";
  }

  async function friendlyReplyError(response) {
    let code = "";

    try {
      code = (await response.json()).error || "";
    } catch {
      code = "";
    }

    if (response.status === 429) {
      return "Too many reply attempts. Try again later.";
    }

    if (response.status === 403) {
      return "Your secure session expired. Reload and verify again.";
    }

    if (code === "invalid_encrypted_reply") {
      return "The encrypted reply package was not accepted.";
    }

    if (code === "invalid_notification_email") {
      return "The sender address is not valid for notification.";
    }

    return "Unable to submit encrypted reply.";
  }
})();
`;

class HttpError extends Error {
  constructor(statusCode, code) {
    super(code);
    this.statusCode = statusCode;
    this.code = code;
  }
}

process.on("uncaughtException", (error) => {
  console.error("uncaught exception:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

process.on("unhandledRejection", (error) => {
  console.error("unhandled rejection:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

void main();
