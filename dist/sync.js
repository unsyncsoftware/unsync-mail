"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SendEmailError = exports.SECURE_PORTAL_UPLOAD_FAILED = exports.MISSING_RECIPIENT_PUBLIC_KEY = void 0;
exports.isSendEmailError = isSendEmailError;
exports.syncInbox = syncInbox;
exports.sendEmail = sendEmail;
exports.extractUnsyncCipherBlock = extractUnsyncCipherBlock;
exports.createSecurePortalPayload = createSecurePortalPayload;
exports.buildSecurePortalEmail = buildSecurePortalEmail;
exports.readableFromString = readableFromString;
const node_stream_1 = require("node:stream");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Imap = require("imap");
const mailparser_1 = require("mailparser");
const nodemailer = require("nodemailer");
const addressparser = require("nodemailer/lib/addressparser");
const crypto_1 = require("./crypto");
const db_1 = require("./db");
const UNSYNC_PGP_BLOCK = /-----BEGIN PGP MESSAGE-----[\s\S]*?-----END PGP MESSAGE-----/;
exports.MISSING_RECIPIENT_PUBLIC_KEY = "MISSING_RECIPIENT_PUBLIC_KEY";
exports.SECURE_PORTAL_UPLOAD_FAILED = "SECURE_PORTAL_UPLOAD_FAILED";
const SECURE_PORTAL_READER_BASE_URL = process.env.UNSYNC_PORTAL_READER_BASE_URL ?? "https://mail.unsync.uk";
const SECURE_PORTAL_API_BASE_URL = process.env.UNSYNC_PORTAL_API_URL ?? "https://api.mail.unsync.uk";
const SECURE_PORTAL_DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000;
const SECURE_PORTAL_IDLE_TIMEOUT_SECONDS = 5 * 60;
const SECURE_PORTAL_ATTACHMENT_CHUNK_SIZE_BYTES = 1024 * 1024;
class SendEmailError extends Error {
    code;
    recipientEmail;
    constructor(code, message, recipientEmail) {
        super(message);
        this.name = "SendEmailError";
        this.code = code;
        this.recipientEmail = recipientEmail;
    }
}
exports.SendEmailError = SendEmailError;
function isSendEmailError(error) {
    return error instanceof SendEmailError;
}
async function syncInbox(options) {
    const database = options.database ?? (0, db_1.getDatabase)();
    const mailbox = options.mailbox ?? "INBOX";
    const parser = options.parser ?? mailparser_1.simpleParser;
    const imapClient = options.imapFactory
        ? options.imapFactory(options.imap)
        : new Imap(options.imap);
    await connectImap(imapClient);
    try {
        await openMailbox(imapClient, mailbox);
        const uids = await searchMailbox(imapClient, options.searchCriteria ?? ["UNSEEN"]);
        if (uids.length === 0) {
            return { fetched: 0, saved: 0, encrypted: 0 };
        }
        const parsedMessages = await fetchAndParseMessages(imapClient, uids, parser);
        let encrypted = 0;
        let saved = 0;
        for (const parsedMessage of parsedMessages) {
            const savedEmail = saveParsedMessage(parsedMessage, options.accountId, mailbox.toLowerCase(), database);
            if (savedEmail.wasInserted) {
                saved += 1;
            }
            if (savedEmail.isUnsyncEncrypted === 1) {
                encrypted += 1;
            }
        }
        return {
            fetched: uids.length,
            saved,
            encrypted,
        };
    }
    finally {
        imapClient.end();
    }
}
async function sendEmail(options) {
    const database = options.database ?? (0, db_1.getDatabase)();
    const transport = options.transport ?? nodemailer.createTransport(options.smtp);
    const prepared = options.useUnsyncShield
        ? await prepareShieldedOrPortalMessage(options.draft, database)
        : prepareStandardMessage(options.draft);
    if (prepared.portalRecord) {
        (0, db_1.saveSecurePortalPayload)(prepared.portalRecord, database);
    }
    if (prepared.portalUploadRequest) {
        let uploadSessionToken;
        if (prepared.portalAttachmentUploads && prepared.portalAttachmentUploads.length > 0) {
            uploadSessionToken = await createSecurePortalUploadSession(prepared.portalUploadRequest.portalId, prepared.portalAttachmentUploads, options.portalApiBaseUrl ?? SECURE_PORTAL_API_BASE_URL);
            await uploadSecurePortalAttachmentChunks(prepared.portalUploadRequest.portalId, prepared.portalAttachmentUploads, options.portalApiBaseUrl ?? SECURE_PORTAL_API_BASE_URL, uploadSessionToken);
        }
        await uploadSecurePortalPayload(prepared.portalUploadRequest, options.portalApiBaseUrl ?? SECURE_PORTAL_API_BASE_URL, options.portalUploader ?? uploadSecurePortalPayloadToApi);
    }
    const info = await transport.sendMail(prepared.message);
    saveSentEmailCopy(options.draft, prepared, info, database);
    // TODO: Future expiry cleanup should remove expired local portal records.
    const result = {
        info,
        shielded: options.useUnsyncShield,
        deliveryMode: prepared.deliveryMode,
    };
    if (prepared.portal) {
        result.portal = prepared.portal;
    }
    return result;
}
function extractUnsyncCipherBlock(text) {
    return text.match(UNSYNC_PGP_BLOCK)?.[0];
}
async function createSecurePortalPayload(draft, recipients, options = {}) {
    const portalId = randomToken(18);
    const accessToken = randomToken(32);
    const createdAtDate = new Date();
    const expiresAtDate = new Date(createdAtDate.getTime() + SECURE_PORTAL_DEFAULT_EXPIRY_MS);
    const createdAt = createdAtDate.toISOString();
    const expiresAt = expiresAtDate.toISOString();
    const messageKey = crypto.randomBytes(32);
    const oneTimeRead = options.allowMultipleReads === false;
    const attachmentUploads = await buildSecurePortalAttachmentUploads(draft.attachments);
    const attachmentMetadata = attachmentUploads.map((attachment) => ({
        attachmentId: attachment.attachmentId,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        originalSize: attachment.originalSize,
        encryptedSize: attachment.encryptedSize,
        chunkCount: attachment.chunkCount,
        chunkSize: attachment.chunkSize,
        encryptedKey: encryptBufferWithKey(attachment.key, messageKey),
        uploadComplete: true,
    }));
    const encryptedBody = encryptJsonWithKey({ text: draft.text }, messageKey);
    const encryptedMetadata = encryptJsonWithKey({
        subject: draft.subject,
        from: draft.from,
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        recipients,
        attachments: attachmentMetadata,
        createdAt,
        expiresAt,
        idleTimeoutSeconds: SECURE_PORTAL_IDLE_TIMEOUT_SECONDS,
        oneTimeRead,
        // TODO: Future secure web reader should enforce session expiry server-side.
    }, messageKey);
    const wrappedMessageKey = encryptBufferWithKey(messageKey, deriveAccessTokenKey(accessToken));
    // TODO: Future attachment encryption should stream encrypted attachment
    // blobs into the portal payload instead of storing metadata placeholders.
    const encryptedPayload = JSON.stringify({
        version: 1,
        cipher: "aes-256-gcm",
        wrappedMessageKey,
        encryptedBody,
        encryptedMetadata,
    });
    return {
        version: 1,
        portalId,
        accessToken,
        recipients,
        portalUrl: buildSecurePortalUrl(portalId, accessToken),
        createdAt,
        expiresAt,
        idleTimeoutSeconds: SECURE_PORTAL_IDLE_TIMEOUT_SECONDS,
        oneTimeRead,
        encryptedPayload,
        attachmentUploads,
    };
}
function buildSecurePortalEmail(payload) {
    const text = [
        "This message was sent securely using Unsync Mail.",
        "",
        "Open securely:",
        payload.portalUrl,
        "",
        "This secure session expires automatically.",
    ].join("\n");
    // TODO: Future secure web reader should replace this placeholder link with
    // a real hosted portal URL after upload/session APIs exist.
    return {
        subject: "",
        text,
        html: [
            "<p>This message was sent securely using Unsync Mail.</p>",
            "<p>Open securely:<br>",
            `<a href="${escapeHtml(payload.portalUrl)}">${escapeHtml(payload.portalUrl)}</a></p>`,
            "<p>This secure session expires automatically.</p>",
        ].join(""),
    };
}
function connectImap(imapClient) {
    return new Promise((resolve, reject) => {
        imapClient.once("ready", resolve);
        imapClient.once("error", reject);
        imapClient.connect();
    });
}
function openMailbox(imapClient, mailbox) {
    return new Promise((resolve, reject) => {
        imapClient.openBox(mailbox, true, (error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}
function searchMailbox(imapClient, criteria) {
    return new Promise((resolve, reject) => {
        imapClient.search(criteria, (error, uids) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(uids);
        });
    });
}
function fetchAndParseMessages(imapClient, uids, parser) {
    return new Promise((resolve, reject) => {
        const parsedMessages = [];
        const pendingParses = [];
        const fetchStream = imapClient.fetch(uids, {
            bodies: "",
            markSeen: false,
        });
        fetchStream.on("message", (message) => {
            message.on("body", (stream) => {
                pendingParses.push(parser(stream).then((parsedMail) => {
                    parsedMessages.push(parsedMail);
                }));
            });
        });
        fetchStream.once("error", reject);
        fetchStream.once("end", () => {
            Promise.all(pendingParses)
                .then(() => resolve(parsedMessages))
                .catch(reject);
        });
    });
}
function saveParsedMessage(parsedMessage, accountId, mailbox, database) {
    const plainBody = parsedMessage.text ?? htmlToSearchableText(parsedMessage.html);
    const rawHtmlBody = typeof parsedMessage.html === "string" ? parsedMessage.html : "";
    const cipherBlock = extractUnsyncCipherBlock(plainBody);
    const from = firstAddress(parsedMessage.from);
    const toAddresses = flattenAddresses(parsedMessage.to).flatMap((address) => address.address ? [address.address] : []);
    const ccAddresses = flattenAddresses(parsedMessage.cc).flatMap((address) => address.address ? [address.address] : []);
    const bccAddresses = flattenAddresses(parsedMessage.bcc).flatMap((address) => address.address ? [address.address] : []);
    const receivedAt = (parsedMessage.date ?? new Date()).toISOString();
    const providerMessageId = parsedMessage.messageId ?? buildFallbackMessageId(parsedMessage, plainBody);
    const wasInserted = !emailExists(accountId, providerMessageId, database);
    const saveInput = {
        accountId,
        mailbox,
        providerMessageId,
        toAddresses,
        ccAddresses,
        bccAddresses,
        receivedAt,
        bodyCiphertext: cipherBlock ?? rawHtmlBody,
        decryptedPreview: cipherBlock ? "" : plainBody.slice(0, 240),
        localSearchText: cipherBlock ? "" : plainBody,
        isUnsyncEncrypted: Boolean(cipherBlock),
        headersJson: JSON.stringify(parsedMessage.headerLines.map((header) => header.line)),
        flagsJson: "{}",
    };
    if (parsedMessage.inReplyTo) {
        saveInput.threadId = parsedMessage.inReplyTo;
    }
    if (parsedMessage.subject) {
        saveInput.subject = parsedMessage.subject;
    }
    if (from?.address) {
        saveInput.fromAddress = from.address;
    }
    if (from?.name) {
        saveInput.fromName = from.name;
    }
    if (parsedMessage.date) {
        saveInput.sentAt = parsedMessage.date.toISOString();
    }
    return {
        ...(0, db_1.saveEmail)(saveInput, database),
        wasInserted,
    };
}
function emailExists(accountId, providerMessageId, database) {
    const row = database
        .prepare(`
      SELECT id
      FROM emails
      WHERE account_id = @accountId
        AND provider_message_id = @providerMessageId
      LIMIT 1
    `)
        .get({ accountId, providerMessageId });
    return Boolean(row);
}
function prepareStandardMessage(draft) {
    return {
        message: buildStandardMessage(draft),
        deliveryMode: "standard",
        sentSaveInput: buildSentEmailSaveInput(draft, "standard"),
    };
}
async function prepareShieldedOrPortalMessage(draft, database) {
    const recipientEmails = getDraftRecipientEmails(draft);
    const recipientPublicKeys = [];
    const missingRecipientEmails = [];
    for (const recipientEmail of recipientEmails) {
        const recipientPublicKey = (0, db_1.getContactPublicKey)(recipientEmail, database);
        if (!recipientPublicKey) {
            missingRecipientEmails.push(recipientEmail);
            continue;
        }
        recipientPublicKeys.push(recipientPublicKey);
    }
    if (missingRecipientEmails.length > 0) {
        return await prepareSecurePortalMessage(draft, recipientEmails, missingRecipientEmails);
    }
    return {
        message: await buildShieldedMessage(draft, recipientPublicKeys),
        deliveryMode: "unsync_direct",
        sentSaveInput: buildSentEmailSaveInput(draft, "unsync_direct"),
    };
}
async function prepareSecurePortalMessage(draft, recipientEmails, missingRecipientEmails) {
    const recipients = recipientEmails.map((emailAddress) => ({
        emailAddress,
        hasTrustedPublicKey: !missingRecipientEmails.includes(emailAddress),
    }));
    const payload = await createSecurePortalPayload(draft, recipients, {
        allowMultipleReads: draft.allowMultipleReads ?? true,
    });
    const portalEmail = buildSecurePortalEmail(payload);
    const message = {
        ...buildStandardMessage(draft),
        text: portalEmail.text,
        html: portalEmail.html,
        attachments: undefined,
    };
    const portal = {
        portalId: payload.portalId,
        portalUrl: payload.portalUrl,
        recipientEmail: missingRecipientEmails[0] ?? recipientEmails[0] ?? "",
        missingRecipientEmails,
        expiresAt: payload.expiresAt,
        idleTimeoutSeconds: payload.idleTimeoutSeconds,
    };
    return {
        message,
        deliveryMode: "secure_portal",
        portal,
        portalRecord: {
            portalId: payload.portalId,
            accessToken: payload.accessToken,
            senderAccountId: draft.from,
            recipientEmail: recipientEmails.join(", "),
            encryptedPayload: payload.encryptedPayload,
            portalUrl: payload.portalUrl,
            createdAt: payload.createdAt,
            expiresAt: payload.expiresAt,
            idleTimeoutSeconds: payload.idleTimeoutSeconds,
            isConsumed: false,
            oneTimeRead: payload.oneTimeRead,
            lastAccessAt: null,
        },
        portalUploadRequest: {
            portalId: payload.portalId,
            accessTokenHash: hashAccessToken(payload.accessToken),
            recipientEmail: portal.recipientEmail,
            recipientEmails,
            encryptedPayload: payload.encryptedPayload,
            createdAt: payload.createdAt,
            expiresAt: payload.expiresAt,
            idleTimeoutSeconds: payload.idleTimeoutSeconds,
            oneTimeRead: payload.oneTimeRead,
            attachments: payload.attachmentUploads.map((attachment) => ({
                attachmentId: attachment.attachmentId,
                chunkCount: attachment.chunkCount,
                encryptedSize: attachment.encryptedSize,
                originalSize: attachment.originalSize,
                uploadComplete: true,
            })),
        },
        portalAttachmentUploads: payload.attachmentUploads,
        sentSaveInput: buildSentEmailSaveInput(draft, "secure_portal", payload),
    };
}
async function buildShieldedMessage(draft, recipientPublicKeys) {
    const armoredCiphertext = await (0, crypto_1.encryptText)(draft.text, recipientPublicKeys);
    const shieldedText = [
        "This message is protected by Unsync Shield.",
        "",
        "If you use Unsync Mail, the app will decrypt the block below locally.",
        "",
        armoredCiphertext,
    ].join("\n");
    return {
        ...buildStandardMessage(draft),
        text: shieldedText,
        html: [
            "<p>This message is protected by Unsync Shield.</p>",
            "<p>If you use Unsync Mail, the app will decrypt the block below locally.</p>",
            `<pre>${escapeHtml(armoredCiphertext)}</pre>`,
        ].join(""),
    };
}
function buildStandardMessage(draft) {
    return {
        from: draft.from,
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject,
        text: draft.text,
        attachments: draft.attachments,
    };
}
function buildSentEmailSaveInput(draft, deliveryMode, portalPayload) {
    const now = new Date().toISOString();
    const portalMetadata = portalPayload
        ? {
            portalId: portalPayload.portalId,
            portalUrl: portalPayload.portalUrl,
            expiresAt: portalPayload.expiresAt,
            idleTimeoutSeconds: portalPayload.idleTimeoutSeconds,
            oneTimeRead: portalPayload.oneTimeRead,
        }
        : undefined;
    const saveInput = {
        accountId: draft.from,
        mailbox: "sent",
        providerMessageId: `unsync-sent-${randomToken(20)}`,
        subject: draft.subject,
        fromAddress: draft.from,
        toAddresses: parseDraftRecipients(draft.to),
        ccAddresses: parseDraftRecipients(draft.cc),
        bccAddresses: parseDraftRecipients(draft.bcc),
        sentAt: now,
        receivedAt: now,
        bodyCiphertext: draft.text,
        decryptedPreview: draft.text.slice(0, 240),
        localSearchText: draft.text,
        isUnsyncEncrypted: deliveryMode !== "standard",
        deliveryMode,
        headersJson: JSON.stringify({
            deliveryMode,
            securePortal: portalMetadata,
        }),
        flagsJson: JSON.stringify({ isRead: true, isSentLocalCopy: true }),
    };
    if (portalPayload) {
        saveInput.securePortalId = portalPayload.portalId;
        saveInput.securePortalUrl = portalPayload.portalUrl;
    }
    return saveInput;
}
function saveSentEmailCopy(draft, prepared, info, database) {
    if (!prepared.sentSaveInput) {
        return;
    }
    (0, db_1.saveEmail)({
        ...prepared.sentSaveInput,
        providerMessageId: getSentProviderMessageId(info) ?? prepared.sentSaveInput.providerMessageId,
    }, database);
}
async function uploadSecurePortalPayload(request, apiBaseUrl, uploader) {
    try {
        await uploader(request, apiBaseUrl);
    }
    catch (error) {
        throw new SendEmailError(exports.SECURE_PORTAL_UPLOAD_FAILED, `Secure portal upload failed. Message was not sent. ${formatErrorMessage(error)}`.trim());
    }
}
async function uploadSecurePortalAttachmentChunks(portalId, attachments, apiBaseUrl, uploadSessionToken) {
    try {
        for (const attachment of attachments) {
            await uploadSecurePortalAttachment(portalId, attachment, apiBaseUrl, uploadSessionToken);
        }
    }
    catch (error) {
        throw new SendEmailError(exports.SECURE_PORTAL_UPLOAD_FAILED, `Secure portal attachment upload failed. Message was not sent. ${formatErrorMessage(error)}`.trim());
    }
}
async function uploadSecurePortalAttachment(portalId, attachment, apiBaseUrl, uploadSessionToken) {
    const file = await fs.promises.open(attachment.filePath, "r");
    try {
        const buffer = Buffer.allocUnsafe(attachment.chunkSize);
        for (let chunkIndex = 0; chunkIndex < attachment.chunkCount; chunkIndex += 1) {
            const { bytesRead } = await file.read(buffer, 0, attachment.chunkSize, chunkIndex * attachment.chunkSize);
            const plaintextChunk = buffer.subarray(0, bytesRead);
            const encryptedChunk = encryptAttachmentChunk(plaintextChunk, attachment.key, buildAttachmentChunkAad(portalId, attachment.attachmentId, chunkIndex));
            const endpoint = new URL(`/portal/${encodeURIComponent(portalId)}/attachment/${encodeURIComponent(attachment.attachmentId)}/chunk/${chunkIndex}`, normalizeApiBaseUrl(apiBaseUrl));
            const response = await fetch(endpoint, {
                method: "POST",
                headers: {
                    "content-type": "application/octet-stream",
                    "x-unsync-upload-session": uploadSessionToken,
                },
                body: encryptedChunk,
            });
            if (!response.ok) {
                throw new Error(`Portal API returned HTTP ${response.status} for attachment chunk upload.`);
            }
        }
    }
    finally {
        await file.close();
    }
}
async function createSecurePortalUploadSession(portalId, attachments, apiBaseUrl) {
    const request = {
        portalId,
        attachments: attachments.map((attachment) => ({
            attachmentId: attachment.attachmentId,
            chunkCount: attachment.chunkCount,
            encryptedSize: attachment.encryptedSize,
            originalSize: attachment.originalSize,
        })),
    };
    const endpoint = new URL("/portal/upload-session", normalizeApiBaseUrl(apiBaseUrl));
    try {
        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "content-type": "application/json",
            },
            body: JSON.stringify(request),
        });
        if (!response.ok) {
            throw new Error(`Portal API returned HTTP ${response.status} for upload session.`);
        }
        const result = await response.json();
        const uploadSessionToken = result.uploadSessionToken;
        if (typeof uploadSessionToken !== "string" || uploadSessionToken.length === 0) {
            throw new Error("Portal API did not return an upload session token.");
        }
        return uploadSessionToken;
    }
    catch (error) {
        throw new SendEmailError(exports.SECURE_PORTAL_UPLOAD_FAILED, `Secure portal attachment upload session failed. Message was not sent. ${formatErrorMessage(error)}`.trim());
    }
}
function encryptAttachmentChunk(plaintextChunk, key, aad) {
    const encrypted = encryptBufferWithKey(plaintextChunk, key, aad);
    return Buffer.concat([
        Buffer.from(encrypted.iv, "base64url"),
        Buffer.from(encrypted.authTag, "base64url"),
        Buffer.from(encrypted.ciphertext, "base64url"),
    ]);
}
async function uploadSecurePortalPayloadToApi(request, apiBaseUrl) {
    const endpoint = new URL("/portal/create", normalizeApiBaseUrl(apiBaseUrl));
    const response = await fetch(endpoint, {
        method: "POST",
        headers: {
            "content-type": "application/json",
        },
        body: JSON.stringify(request),
    });
    if (!response.ok) {
        throw new Error(`Portal API returned HTTP ${response.status}.`);
    }
}
function normalizeApiBaseUrl(value) {
    return value.endsWith("/") ? value : `${value}/`;
}
function hashAccessToken(accessToken) {
    return crypto
        .createHash("sha256")
        .update(accessToken, "utf8")
        .digest("base64url");
}
function formatErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function getSentProviderMessageId(info) {
    if (!info || typeof info !== "object" || !("messageId" in info)) {
        return undefined;
    }
    const messageId = info.messageId;
    return typeof messageId === "string" && messageId.trim()
        ? messageId.trim()
        : undefined;
}
function randomToken(byteLength) {
    return crypto
        .randomBytes(byteLength)
        .toString("base64url");
}
function buildSecurePortalUrl(portalId, accessToken) {
    const base = `${SECURE_PORTAL_READER_BASE_URL.replace(/\/+$/, "")}/read/${encodeURIComponent(portalId)}`;
    return accessToken ? `${base}#${accessToken}` : base;
}
function deriveAccessTokenKey(accessToken) {
    return crypto.createHash("sha256").update(accessToken).digest();
}
function encryptJsonWithKey(value, key) {
    return encryptBufferWithKey(Buffer.from(JSON.stringify(value), "utf8"), key);
}
function encryptBufferWithKey(value, key, aad) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    if (aad) {
        cipher.setAAD(aad);
    }
    const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
        iv: iv.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        authTag: authTag.toString("base64url"),
    };
}
function buildAttachmentChunkAad(portalId, attachmentId, chunkIndex) {
    return Buffer.from(`unsync-portal-attachment-chunk:v1:${portalId}:${attachmentId}:${chunkIndex}`, "utf8");
}
async function buildSecurePortalAttachmentUploads(attachments) {
    if (!attachments) {
        return [];
    }
    const attachmentList = Array.isArray(attachments) ? attachments : [attachments];
    const uploads = [];
    for (const attachment of attachmentList) {
        const filePath = getAttachmentFilePath(attachment);
        if (!filePath) {
            continue;
        }
        const stats = await fs.promises.stat(filePath);
        if (!stats.isFile()) {
            continue;
        }
        const chunkCount = Math.max(1, Math.ceil(stats.size / SECURE_PORTAL_ATTACHMENT_CHUNK_SIZE_BYTES));
        uploads.push({
            attachmentId: randomToken(18),
            filePath,
            fileName: getAttachmentFileName(attachment, filePath),
            mimeType: getAttachmentMimeType(attachment),
            originalSize: stats.size,
            encryptedSize: stats.size + chunkCount * (12 + 16),
            chunkSize: SECURE_PORTAL_ATTACHMENT_CHUNK_SIZE_BYTES,
            chunkCount,
            key: crypto.randomBytes(32),
        });
    }
    return uploads;
}
function getAttachmentFilePath(attachment) {
    if (!attachment || typeof attachment !== "object" || !("path" in attachment)) {
        return undefined;
    }
    const filePath = attachment.path;
    return typeof filePath === "string" ? filePath : undefined;
}
function getAttachmentFileName(attachment, filePath) {
    if (attachment && typeof attachment === "object" && "filename" in attachment) {
        const filename = attachment.filename;
        if (typeof filename === "string" && filename.trim()) {
            return filename.trim();
        }
    }
    return path.basename(filePath);
}
function getAttachmentMimeType(attachment) {
    if (attachment && typeof attachment === "object" && "contentType" in attachment) {
        const contentType = attachment.contentType;
        if (typeof contentType === "string" && contentType.trim()) {
            return contentType.trim();
        }
    }
    return "application/octet-stream";
}
function flattenAddresses(value) {
    if (!value) {
        return [];
    }
    return (Array.isArray(value) ? value : [value]).flatMap((address) => address.value);
}
function firstAddress(value) {
    return flattenAddresses(value)[0];
}
function htmlToSearchableText(html) {
    if (!html) {
        return "";
    }
    return html
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<head[\s\S]*?<\/head>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<\/div>/gi, "\n")
        .replace(/<\/tr>/gi, "\n")
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/\s+\n/g, "\n")
        .replace(/\n\s+/g, "\n")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
function buildFallbackMessageId(parsedMessage, body) {
    const stableParts = [
        parsedMessage.subject ?? "",
        parsedMessage.from?.text ?? "",
        parsedMessage.date?.toISOString() ?? "",
        body,
    ].join("\n");
    const hash = require("node:crypto")
        .createHash("sha256")
        .update(stableParts)
        .digest("hex");
    return `unsync-local-${hash}`;
}
function getDraftRecipientEmails(draft) {
    const recipients = uniqueEmailAddresses([
        ...parseDraftRecipients(draft.to),
        ...parseDraftRecipients(draft.cc),
        ...parseDraftRecipients(draft.bcc),
    ]);
    if (recipients.length === 0) {
        throw new Error("Draft must include at least one recipient.");
    }
    return recipients;
}
function parseDraftRecipients(value) {
    if (!value) {
        return [];
    }
    const addressFields = Array.isArray(value) ? value : [value];
    return addressFields.flatMap((addressField) => addressparser(addressField, { flatten: true })
        .map((address) => address.address.trim().toLowerCase())
        .filter(Boolean));
}
function uniqueEmailAddresses(addresses) {
    return Array.from(new Set(addresses.map((address) => address.toLowerCase())));
}
function escapeHtml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
function readableFromString(value) {
    return node_stream_1.Readable.from([value]);
}
//# sourceMappingURL=sync.js.map