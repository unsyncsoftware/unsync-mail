import Database = require("better-sqlite3");
export declare const DEFAULT_DATABASE_DIR: string;
export declare const DEFAULT_DATABASE_PATH: string;
export type DatabaseConnection = Database.Database;
export interface EmailSearchOptions {
    accountId?: string;
    mailbox?: string;
    limit?: number;
    offset?: number;
}
export interface EmailSearchResult {
    id: number;
    accountId: string;
    mailbox: string;
    subject: string;
    fromAddress: string;
    fromName: string | null;
    receivedAt: string;
    decryptedPreview: string;
    isUnsyncEncrypted: 0 | 1;
    rank: number;
}
export interface EmailListItem {
    id: number;
    mailbox: string;
    subject: string;
    fromAddress: string;
    fromName: string | null;
    receivedAt: string;
    decryptedPreview: string;
    isUnsyncEncrypted: 0 | 1;
}
export interface EmailReadModel extends EmailListItem {
    accountId: string;
    toAddresses: string;
    ccAddresses: string;
    bodyCiphertext: string;
    localSearchText: string;
}
export interface SaveUserKeyInput {
    userId: string;
    keyFingerprint: string;
    publicKeyArmored: string;
    privateKeyArmoredEncrypted: string;
    passphraseHint?: string;
}
export interface StoredUserKey {
    id: number;
    userId: string;
    keyFingerprint: string;
    publicKeyArmored: string;
    privateKeyArmoredEncrypted: string;
    passphraseHint: string | null;
    isActive: 0 | 1;
    createdAt: string;
    revokedAt: string | null;
}
export interface SaveEmailInput {
    accountId: string;
    mailbox?: string;
    providerMessageId: string;
    threadId?: string;
    subject?: string;
    fromAddress?: string;
    fromName?: string;
    toAddresses?: string[];
    ccAddresses?: string[];
    bccAddresses?: string[];
    sentAt?: string;
    receivedAt: string;
    bodyCiphertext: string;
    decryptedPreview?: string;
    localSearchText?: string;
    headersJson?: string;
    flagsJson?: string;
    isUnsyncEncrypted?: boolean;
    deliveryMode?: "standard" | "unsync_direct" | "secure_portal";
    securePortalId?: string;
    securePortalUrl?: string;
}
export interface SavedEmail {
    id: number;
    isUnsyncEncrypted: 0 | 1;
}
export interface SaveSecurePortalPayloadInput {
    portalId: string;
    accessToken: string;
    senderAccountId: string;
    recipientEmail: string;
    encryptedPayload: string;
    portalUrl: string;
    createdAt: string;
    expiresAt: string;
    idleTimeoutSeconds: number;
    isConsumed?: boolean;
    oneTimeRead?: boolean;
    lastAccessAt?: string | null;
}
export interface SaveContactPublicKeyInput {
    emailAddress: string;
    displayName?: string;
    publicKeyArmored: string;
    keyFingerprint?: string;
    trustState?: "unknown" | "trusted" | "blocked";
}
export interface SaveMailAccountInput {
    emailAddress: string;
    imapHost: string;
    imapPort: number;
    smtpHost: string;
    smtpPort: number;
    appPassword: string;
}
export interface StoredMailAccount {
    id: number;
    emailAddress: string;
    imapHost: string;
    imapPort: number;
    smtpHost: string;
    smtpPort: number;
    appPassword: string;
    createdAt: string;
    updatedAt: string;
}
export declare function openDatabase(databasePath?: string): DatabaseConnection;
export declare function getDatabase(databasePath?: string): DatabaseConnection;
export declare function closeDatabase(): void;
export declare function initializeSchema(database: DatabaseConnection): void;
export declare function searchEmails(query: string, options?: EmailSearchOptions, database?: DatabaseConnection): EmailSearchResult[];
export declare function listEmails(options?: EmailSearchOptions, database?: DatabaseConnection): EmailListItem[];
export declare function getEmailById(id: number, database?: DatabaseConnection): EmailReadModel | undefined;
export declare function moveEmailToMailbox(id: number, mailbox: string, database?: DatabaseConnection): boolean;
export declare function updateEmailReadState(id: number, isRead: boolean, database?: DatabaseConnection): boolean;
export declare function saveUserKey(input: SaveUserKeyInput, database?: DatabaseConnection): StoredUserKey;
export declare function getActiveUserKey(userId: string, database?: DatabaseConnection): StoredUserKey | undefined;
export declare function saveEmail(input: SaveEmailInput, database?: DatabaseConnection): SavedEmail;
export declare function saveSecurePortalPayload(input: SaveSecurePortalPayloadInput, database?: DatabaseConnection): void;
export declare function getContactPublicKey(emailAddress: string, database?: DatabaseConnection): string | undefined;
export declare function saveContactPublicKey(input: SaveContactPublicKeyInput, database?: DatabaseConnection): void;
export declare function saveMailAccount(input: SaveMailAccountInput, database?: DatabaseConnection): StoredMailAccount;
export declare function getMailAccountByEmail(emailAddress: string, database?: DatabaseConnection): StoredMailAccount | undefined;
export declare function listMailAccounts(database?: DatabaseConnection): StoredMailAccount[];
export declare function deleteMailAccount(emailAddress: string, database?: DatabaseConnection): void;
export declare function getMailAccount(database?: DatabaseConnection): StoredMailAccount | undefined;
//# sourceMappingURL=db.d.ts.map