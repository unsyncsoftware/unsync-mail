import { Readable } from "node:stream";
import Imap = require("imap");
import {
  type AddressObject,
  type EmailAddress,
  type ParsedMail,
  simpleParser,
} from "mailparser";
import nodemailer = require("nodemailer");
import type SMTPTransport = require("nodemailer/lib/smtp-transport");

import { encryptText } from "./crypto";
import {
  type DatabaseConnection,
  getContactPublicKey,
  getDatabase,
  type SaveEmailInput,
  saveEmail,
} from "./db";

const UNSYNC_PGP_BLOCK =
  /-----BEGIN PGP MESSAGE-----[\s\S]*?-----END PGP MESSAGE-----/;

export interface SyncInboxOptions {
  accountId: string;
  imap: Imap.Config;
  mailbox?: string;
  database?: DatabaseConnection;
  searchCriteria?: unknown[];
  imapFactory?: (config: Imap.Config) => ImapClientLike;
  parser?: MailParser;
}

export interface SyncInboxResult {
  fetched: number;
  saved: number;
  encrypted: number;
}

export interface EmailDraft {
  from: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text: string;
  attachments?: nodemailer.SendMailOptions["attachments"];
}

export interface SendEmailOptions {
  smtp: SMTPTransport.Options;
  draft: EmailDraft;
  useUnsyncShield: boolean;
  database?: DatabaseConnection;
  transport?: MailTransportLike;
}

export interface SendEmailResult {
  info: unknown;
  shielded: boolean;
}

type MailParser = (source: NodeJS.ReadableStream) => Promise<ParsedMail>;

export interface ImapClientLike extends NodeJS.EventEmitter {
  connect(): void;
  end(): void;
  openBox(
    mailboxName: string,
    readOnly: boolean,
    callback: (error: Error | null, mailbox?: unknown) => void,
  ): void;
  search(criteria: unknown[], callback: (error: Error | null, uids: number[]) => void): void;
  fetch(source: number[] | string, options: Imap.FetchOptions): ImapFetchLike;
}

export interface ImapFetchLike extends NodeJS.EventEmitter {
  on(event: "message", listener: (message: ImapMessageLike, seqno: number) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "end", listener: () => void): this;
}

export interface ImapMessageLike extends NodeJS.EventEmitter {
  on(event: "body", listener: (stream: NodeJS.ReadableStream) => void): this;
  once(event: "end", listener: () => void): this;
}

export interface MailTransportLike {
  sendMail(message: nodemailer.SendMailOptions): Promise<unknown>;
}

export async function syncInbox(
  options: SyncInboxOptions,
): Promise<SyncInboxResult> {
  const database = options.database ?? getDatabase();
  const mailbox = options.mailbox ?? "INBOX";
  const parser = options.parser ?? simpleParser;
  const imapClient = options.imapFactory
    ? options.imapFactory(options.imap)
    : new Imap(options.imap);

  await connectImap(imapClient);

  try {
    await openMailbox(imapClient, mailbox);

    const uids = await searchMailbox(
      imapClient,
      options.searchCriteria ?? ["UNSEEN"],
    );

    if (uids.length === 0) {
      return { fetched: 0, saved: 0, encrypted: 0 };
    }

    const parsedMessages = await fetchAndParseMessages(imapClient, uids, parser);
    let encrypted = 0;

    for (const parsedMessage of parsedMessages) {
      const savedEmail = saveParsedMessage(
        parsedMessage,
        options.accountId,
        mailbox.toLowerCase(),
        database,
      );

      if (savedEmail.isUnsyncEncrypted === 1) {
        encrypted += 1;
      }
    }

    return {
      fetched: uids.length,
      saved: parsedMessages.length,
      encrypted,
    };
  } finally {
    imapClient.end();
  }
}

export async function sendEmail(
  options: SendEmailOptions,
): Promise<SendEmailResult> {
  const transport =
    options.transport ?? nodemailer.createTransport(options.smtp);
  const message = options.useUnsyncShield
    ? await buildShieldedMessage(options.draft, options.database ?? getDatabase())
    : buildStandardMessage(options.draft);
  const info = await transport.sendMail(message);

  return {
    info,
    shielded: options.useUnsyncShield,
  };
}

export function extractUnsyncCipherBlock(text: string): string | undefined {
  return text.match(UNSYNC_PGP_BLOCK)?.[0];
}

function connectImap(imapClient: ImapClientLike): Promise<void> {
  return new Promise((resolve, reject) => {
    imapClient.once("ready", resolve);
    imapClient.once("error", reject);
    imapClient.connect();
  });
}

function openMailbox(
  imapClient: ImapClientLike,
  mailbox: string,
): Promise<void> {
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

function searchMailbox(
  imapClient: ImapClientLike,
  criteria: unknown[],
): Promise<number[]> {
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

function fetchAndParseMessages(
  imapClient: ImapClientLike,
  uids: number[],
  parser: MailParser,
): Promise<ParsedMail[]> {
  return new Promise((resolve, reject) => {
    const parsedMessages: ParsedMail[] = [];
    const pendingParses: Array<Promise<void>> = [];
    const fetchStream = imapClient.fetch(uids, {
      bodies: "",
      markSeen: false,
    });

    fetchStream.on("message", (message) => {
      message.on("body", (stream) => {
        pendingParses.push(
          parser(stream).then((parsedMail) => {
            parsedMessages.push(parsedMail);
          }),
        );
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

function saveParsedMessage(
  parsedMessage: ParsedMail,
  accountId: string,
  mailbox: string,
  database: DatabaseConnection,
): { isUnsyncEncrypted: 0 | 1 } {
  const plainBody = parsedMessage.text ?? htmlToSearchableText(parsedMessage.html);
  const rawHtmlBody = typeof parsedMessage.html === "string" ? parsedMessage.html : "";
  const cipherBlock = extractUnsyncCipherBlock(plainBody);
  const from = firstAddress(parsedMessage.from);
  const toAddresses = flattenAddresses(parsedMessage.to).flatMap((address) =>
    address.address ? [address.address] : [],
  );
  const ccAddresses = flattenAddresses(parsedMessage.cc).flatMap((address) =>
    address.address ? [address.address] : [],
  );
  const bccAddresses = flattenAddresses(parsedMessage.bcc).flatMap((address) =>
    address.address ? [address.address] : [],
  );
  const receivedAt = (parsedMessage.date ?? new Date()).toISOString();
  const providerMessageId =
    parsedMessage.messageId ?? buildFallbackMessageId(parsedMessage, plainBody);

  const saveInput: SaveEmailInput = {
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
    headersJson: JSON.stringify(
      parsedMessage.headerLines.map((header) => header.line),
    ),
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

  return saveEmail(saveInput, database);
}

async function buildShieldedMessage(
  draft: EmailDraft,
  database: DatabaseConnection,
): Promise<nodemailer.SendMailOptions> {
  const recipientEmail = getPrimaryRecipientEmail(draft.to);
  const recipientPublicKey = getContactPublicKey(recipientEmail, database);

  if (!recipientPublicKey) {
    throw new Error(`No trusted public key found for recipient ${recipientEmail}.`);
  }

  const armoredCiphertext = await encryptText(draft.text, recipientPublicKey);
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

function buildStandardMessage(draft: EmailDraft): nodemailer.SendMailOptions {
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

function flattenAddresses(
  value: AddressObject | AddressObject[] | undefined,
): EmailAddress[] {
  if (!value) {
    return [];
  }

  return (Array.isArray(value) ? value : [value]).flatMap((address) => address.value);
}

function firstAddress(value: AddressObject | undefined): EmailAddress | undefined {
  return flattenAddresses(value)[0];
}

function htmlToSearchableText(html: string | false | undefined): string {
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

function buildFallbackMessageId(parsedMessage: ParsedMail, body: string): string {
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

function getPrimaryRecipientEmail(to: string | string[]): string {
  const firstRecipient = Array.isArray(to) ? to[0] : to.split(",")[0];

  if (!firstRecipient) {
    throw new Error("Draft must include at least one recipient.");
  }

  const angleMatch = firstRecipient.match(/<([^>]+)>/);
  return (angleMatch?.[1] ?? firstRecipient).trim().toLowerCase();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function readableFromString(value: string): NodeJS.ReadableStream {
  return Readable.from([value]);
}
