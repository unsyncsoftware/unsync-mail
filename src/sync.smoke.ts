import assert = require("node:assert/strict");
import { EventEmitter } from "node:events";
import fs = require("node:fs");
import os = require("node:os");
import path = require("node:path");
import type Imap = require("imap");
import type { SendMailOptions } from "nodemailer";

import { generateUserKey } from "./crypto";
import { openDatabase, saveContactPublicKey, searchEmails } from "./db";
import {
  type ImapClientLike,
  type ImapFetchLike,
  type ImapMessageLike,
  type MailTransportLike,
  readableFromString,
  sendEmail,
  syncInbox,
} from "./sync";

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

async function main(): Promise<void> {
  const databasePath = path.join(os.tmpdir(), "unsync-mail-sync-smoke.sqlite");

  removeDatabaseFiles(databasePath);

  const database = openDatabase(databasePath);

  try {
    const syncResult = await syncInbox({
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
    assert.equal(searchEmails("searchable body", {}, database).length, 1);

    const encryptedRow = database
      .prepare<
        { providerMessageId: string },
        { isUnsyncEncrypted: 0 | 1; bodyCiphertext: string }
      >(
        `
          SELECT
            is_unsync_encrypted AS isUnsyncEncrypted,
            body_ciphertext AS bodyCiphertext
          FROM emails
          WHERE provider_message_id = @providerMessageId
        `,
      )
      .get({ providerMessageId: "<shielded-1@example.test>" });

    assert.equal(encryptedRow?.isUnsyncEncrypted, 1);
    assert.match(encryptedRow?.bodyCiphertext ?? "", /BEGIN PGP MESSAGE/);

    const recipientKey = await generateUserKey({
      userId: "recipient",
      name: "Recipient",
      email: "recipient@example.test",
      passphrase: "recipient-passphrase",
      database,
    });
    saveContactPublicKey(
      {
        emailAddress: "recipient@example.test",
        displayName: "Recipient",
        publicKeyArmored: recipientKey.publicKeyArmored,
        keyFingerprint: recipientKey.keyFingerprint,
        trustState: "trusted",
      },
      database,
    );

    const shieldedTransport = new MockTransport();
    const shieldedResult = await sendEmail({
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
    assert.match(
      shieldedTransport.sent[0]?.text?.toString() ?? "",
      /protected by Unsync Shield/,
    );

    const standardTransport = new MockTransport();
    await sendEmail({
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
  } finally {
    database.close();
    removeDatabaseFiles(databasePath);
  }
}

class MockImapClient extends EventEmitter implements ImapClientLike {
  constructor(private readonly rawMessages: string[]) {
    super();
  }

  connect(): void {
    setImmediate(() => this.emit("ready"));
  }

  end(): void {
    this.emit("end");
  }

  openBox(
    _mailboxName: string,
    _readOnly: boolean,
    callback: (error: Error | null, mailbox?: unknown) => void,
  ): void {
    callback(null, {});
  }

  search(
    _criteria: unknown[],
    callback: (error: Error | null, uids: number[]) => void,
  ): void {
    callback(null, this.rawMessages.map((_, index) => index + 1));
  }

  fetch(
    _source: number[] | string,
    _options: Imap.FetchOptions,
  ): ImapFetchLike {
    return new MockImapFetch(this.rawMessages);
  }
}

class MockImapFetch extends EventEmitter implements ImapFetchLike {
  constructor(private readonly rawMessages: string[]) {
    super();

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

class MockImapMessage extends EventEmitter implements ImapMessageLike {
  constructor(private readonly rawMessage: string) {
    super();
  }

  emitBody(): void {
    this.emit("body", readableFromString(this.rawMessage));
    this.emit("end");
  }
}

class MockTransport implements MailTransportLike {
  readonly sent: SendMailOptions[] = [];

  async sendMail(message: SendMailOptions): Promise<unknown> {
    this.sent.push(message);
    return { accepted: [message.to], messageId: "mock-message-id" };
  }
}

function removeDatabaseFiles(databasePath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(databasePath + suffix, { force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
