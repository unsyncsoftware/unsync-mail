import Imap = require("imap");
import { type ParsedMail } from "mailparser";
import nodemailer = require("nodemailer");
import type SMTPTransport = require("nodemailer/lib/smtp-transport");
import { type DatabaseConnection } from "./db";
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
    openBox(mailboxName: string, readOnly: boolean, callback: (error: Error | null, mailbox?: unknown) => void): void;
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
export declare function syncInbox(options: SyncInboxOptions): Promise<SyncInboxResult>;
export declare function sendEmail(options: SendEmailOptions): Promise<SendEmailResult>;
export declare function extractUnsyncCipherBlock(text: string): string | undefined;
export declare function readableFromString(value: string): NodeJS.ReadableStream;
export {};
//# sourceMappingURL=sync.d.ts.map