"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assert = require("node:assert/strict");
const node_events_1 = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto_1 = require("./crypto");
const db_1 = require("./db");
const sync_1 = require("./sync");
const normalRawMessage = [
    "From: Sender <sender@example.test>",
    "To: Local <local@example.test>",
    "Subject: Normal message",
    "Message-ID: <normal-1@example.test>",
    "Date: Fri, 22 May 2026 00:00:00 +0000",
    "",
    "This is a normal searchable body.",
].join("\r\n");
const encryptedRawMessage = [
    "From: Sender <sender@example.test>",
    "To: Local <local@example.test>",
    "Subject: Shielded message",
    "Message-ID: <shielded-1@example.test>",
    "Date: Fri, 22 May 2026 00:01:00 +0000",
    "",
    "This message is protected.",
    "",
    "-----BEGIN PGP MESSAGE-----",
    "",
    "mock-cipher-block",
    "-----END PGP MESSAGE-----",
].join("\r\n");
async function main() {
    const databasePath = path.join(os.tmpdir(), "unsync-mail-sync-smoke.sqlite");
    removeDatabaseFiles(databasePath);
    const database = (0, db_1.openDatabase)(databasePath);
    try {
        const syncResult = await (0, sync_1.syncInbox)({
            accountId: "local-account",
            imap: {
                user: "local@example.test",
                password: "unused",
                host: "imap.example.test",
                port: 993,
                tls: true,
            },
            database,
            imapFactory: () => new MockImapClient([
                normalRawMessage,
                encryptedRawMessage,
            ]),
        });
        assert.deepEqual(syncResult, {
            fetched: 2,
            saved: 2,
            encrypted: 1,
        });
        assert.equal((0, db_1.searchEmails)("searchable body", {}, database).length, 1);
        const encryptedRow = database
            .prepare(`
          SELECT
            is_unsync_encrypted AS isUnsyncEncrypted,
            body_ciphertext AS bodyCiphertext
          FROM emails
          WHERE provider_message_id = @providerMessageId
        `)
            .get({ providerMessageId: "<shielded-1@example.test>" });
        assert.equal(encryptedRow?.isUnsyncEncrypted, 1);
        assert.match(encryptedRow?.bodyCiphertext ?? "", /BEGIN PGP MESSAGE/);
        const recipientKey = await (0, crypto_1.generateUserKey)({
            userId: "recipient",
            name: "Recipient",
            email: "recipient@example.test",
            passphrase: "recipient-passphrase",
            database,
        });
        (0, db_1.saveContactPublicKey)({
            emailAddress: "recipient@example.test",
            displayName: "Recipient",
            publicKeyArmored: recipientKey.publicKeyArmored,
            keyFingerprint: recipientKey.keyFingerprint,
            trustState: "trusted",
        }, database);
        const shieldedTransport = new MockTransport();
        const shieldedResult = await (0, sync_1.sendEmail)({
            smtp: { host: "smtp.example.test", port: 587, secure: false },
            draft: {
                from: "local@example.test",
                to: "Recipient <recipient@example.test>",
                subject: "Shielded outbound",
                text: "Encrypt this body locally before SMTP.",
            },
            useUnsyncShield: true,
            database,
            transport: shieldedTransport,
        });
        assert.equal(shieldedResult.shielded, true);
        assert.match(shieldedTransport.sent[0]?.text?.toString() ?? "", /BEGIN PGP MESSAGE/);
        assert.match(shieldedTransport.sent[0]?.text?.toString() ?? "", /protected by Unsync Shield/);
        const standardTransport = new MockTransport();
        await (0, sync_1.sendEmail)({
            smtp: { host: "smtp.example.test", port: 587, secure: false },
            draft: {
                from: "local@example.test",
                to: "plain@example.test",
                subject: "Standard outbound",
                text: "Send this as standard SMTP.",
            },
            useUnsyncShield: false,
            database,
            transport: standardTransport,
        });
        assert.equal(standardTransport.sent[0]?.text, "Send this as standard SMTP.");
        console.log("sync smoke test passed");
    }
    finally {
        database.close();
        removeDatabaseFiles(databasePath);
    }
}
class MockImapClient extends node_events_1.EventEmitter {
    rawMessages;
    constructor(rawMessages) {
        super();
        this.rawMessages = rawMessages;
    }
    connect() {
        setImmediate(() => this.emit("ready"));
    }
    end() {
        this.emit("end");
    }
    openBox(_mailboxName, _readOnly, callback) {
        callback(null, {});
    }
    search(_criteria, callback) {
        callback(null, this.rawMessages.map((_, index) => index + 1));
    }
    fetch(_source, _options) {
        return new MockImapFetch(this.rawMessages);
    }
}
class MockImapFetch extends node_events_1.EventEmitter {
    rawMessages;
    constructor(rawMessages) {
        super();
        this.rawMessages = rawMessages;
        setImmediate(() => {
            this.rawMessages.forEach((rawMessage, index) => {
                const message = new MockImapMessage(rawMessage);
                this.emit("message", message, index + 1);
                message.emitBody();
            });
            this.emit("end");
        });
    }
}
class MockImapMessage extends node_events_1.EventEmitter {
    rawMessage;
    constructor(rawMessage) {
        super();
        this.rawMessage = rawMessage;
    }
    emitBody() {
        this.emit("body", (0, sync_1.readableFromString)(this.rawMessage));
        this.emit("end");
    }
}
class MockTransport {
    sent = [];
    async sendMail(message) {
        this.sent.push(message);
        return { accepted: [message.to], messageId: "mock-message-id" };
    }
}
function removeDatabaseFiles(databasePath) {
    for (const suffix of ["", "-wal", "-shm"]) {
        fs.rmSync(databasePath + suffix, { force: true });
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
//# sourceMappingURL=sync.smoke.js.map