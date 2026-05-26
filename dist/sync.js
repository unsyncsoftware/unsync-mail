"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncInbox = syncInbox;
exports.sendEmail = sendEmail;
exports.extractUnsyncCipherBlock = extractUnsyncCipherBlock;
exports.readableFromString = readableFromString;
const node_stream_1 = require("node:stream");
const Imap = require("imap");
const mailparser_1 = require("mailparser");
const nodemailer = require("nodemailer");
const crypto_1 = require("./crypto");
const db_1 = require("./db");
const UNSYNC_PGP_BLOCK = /-----BEGIN PGP MESSAGE-----[\s\S]*?-----END PGP MESSAGE-----/;
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
        for (const parsedMessage of parsedMessages) {
            const savedEmail = saveParsedMessage(parsedMessage, options.accountId, mailbox.toLowerCase(), database);
            if (savedEmail.isUnsyncEncrypted === 1) {
                encrypted += 1;
            }
        }
        return {
            fetched: uids.length,
            saved: parsedMessages.length,
            encrypted,
        };
    }
    finally {
        imapClient.end();
    }
}
async function sendEmail(options) {
    const transport = options.transport ?? nodemailer.createTransport(options.smtp);
    const message = options.useUnsyncShield
        ? await buildShieldedMessage(options.draft, options.database ?? (0, db_1.getDatabase)())
        : buildStandardMessage(options.draft);
    const info = await transport.sendMail(message);
    return {
        info,
        shielded: options.useUnsyncShield,
    };
}
function extractUnsyncCipherBlock(text) {
    return text.match(UNSYNC_PGP_BLOCK)?.[0];
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
    return (0, db_1.saveEmail)(saveInput, database);
}
async function buildShieldedMessage(draft, database) {
    const recipientEmail = getPrimaryRecipientEmail(draft.to);
    const recipientPublicKey = (0, db_1.getContactPublicKey)(recipientEmail, database);
    if (!recipientPublicKey) {
        throw new Error(`No trusted public key found for recipient ${recipientEmail}.`);
    }
    const armoredCiphertext = await (0, crypto_1.encryptText)(draft.text, recipientPublicKey);
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
function getPrimaryRecipientEmail(to) {
    const firstRecipient = Array.isArray(to) ? to[0] : to.split(",")[0];
    if (!firstRecipient) {
        throw new Error("Draft must include at least one recipient.");
    }
    const angleMatch = firstRecipient.match(/<([^>]+)>/);
    return (angleMatch?.[1] ?? firstRecipient).trim().toLowerCase();
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