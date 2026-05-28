import Imap = require("imap");
import { type ParsedMail } from "mailparser";
import nodemailer = require("nodemailer");
import type SMTPTransport = require("nodemailer/lib/smtp-transport");
import { type DatabaseConnection } from "./db";
export declare const MISSING_RECIPIENT_PUBLIC_KEY = "MISSING_RECIPIENT_PUBLIC_KEY";
export declare const SECURE_PORTAL_UPLOAD_FAILED = "SECURE_PORTAL_UPLOAD_FAILED";
export type SendEmailErrorCode = typeof MISSING_RECIPIENT_PUBLIC_KEY | typeof SECURE_PORTAL_UPLOAD_FAILED;
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
    allowMultipleReads?: boolean;
}
export interface SendEmailOptions {
    smtp: SMTPTransport.Options;
    draft: EmailDraft;
    useUnsyncShield: boolean;
    database?: DatabaseConnection;
    transport?: MailTransportLike;
    portalApiBaseUrl?: string;
    portalUploader?: PortalUploader;
}
export interface SendEmailResult {
    info: unknown;
    shielded: boolean;
    deliveryMode: "standard" | "unsync_direct" | "secure_portal";
    portal?: SecurePortalSendInfo;
}
export interface SecurePortalRecipient {
    emailAddress: string;
    hasTrustedPublicKey: boolean;
}
export interface SecurePortalPayload {
    version: 1;
    portalId: string;
    accessToken: string;
    recipients: SecurePortalRecipient[];
    portalUrl: string;
    createdAt: string;
    expiresAt: string;
    idleTimeoutSeconds: number;
    oneTimeRead: boolean;
    encryptedPayload: string;
    attachmentUploads: SecurePortalAttachmentUpload[];
}
export interface SecurePortalPayloadOptions {
    allowMultipleReads?: boolean;
}
export interface SecurePortalAttachmentUpload {
    attachmentId: string;
    filePath: string;
    fileName: string;
    mimeType: string;
    originalSize: number;
    encryptedSize: number;
    chunkSize: number;
    chunkCount: number;
    key: Buffer;
}
export interface SecurePortalSendInfo {
    portalId: string;
    portalUrl: string;
    recipientEmail: string;
    missingRecipientEmails: string[];
    expiresAt: string;
    idleTimeoutSeconds: number;
}
export declare class SendEmailError extends Error {
    readonly code: SendEmailErrorCode;
    readonly recipientEmail: string | undefined;
    constructor(code: SendEmailErrorCode, message: string, recipientEmail?: string);
}
export declare function isSendEmailError(error: unknown): error is SendEmailError;
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
export type PortalUploader = (request: SecurePortalUploadRequest, apiBaseUrl: string) => Promise<void>;
export interface SecurePortalUploadRequest {
    portalId: string;
    accessTokenHash: string;
    recipientEmail: string;
    recipientEmails: string[];
    encryptedPayload: string;
    createdAt: string;
    expiresAt: string;
    idleTimeoutSeconds: number;
    oneTimeRead: boolean;
    attachments: SecurePortalAttachmentManifest[];
}
export interface SecurePortalAttachmentManifest {
    attachmentId: string;
    chunkCount: number;
    encryptedSize: number;
    originalSize: number;
    uploadComplete: boolean;
}
export declare function syncInbox(options: SyncInboxOptions): Promise<SyncInboxResult>;
export declare function sendEmail(options: SendEmailOptions): Promise<SendEmailResult>;
export declare function extractUnsyncCipherBlock(text: string): string | undefined;
export declare function createSecurePortalPayload(draft: EmailDraft, recipients: SecurePortalRecipient[], options?: SecurePortalPayloadOptions): Promise<SecurePortalPayload>;
export declare function buildSecurePortalEmail(payload: SecurePortalPayload): nodemailer.SendMailOptions;
export declare function readableFromString(value: string): NodeJS.ReadableStream;
export {};
//# sourceMappingURL=sync.d.ts.map