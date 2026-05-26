export interface UnsyncEmailListItem {
    id: number;
    mailbox: string;
    subject: string;
    fromAddress: string;
    fromName: string | null;
    receivedAt: string;
    decryptedPreview: string;
    isUnsyncEncrypted: 0 | 1;
}
export interface UnsyncEmailReadModel extends UnsyncEmailListItem {
    toAddresses: string;
    ccAddresses: string;
    localSearchText: string;
    bodyContent: string;
    bodyContentType: "html" | "text";
}
export interface GenerateUserKeyRequest {
    userId: string;
    name: string;
    email: string;
    passphrase: string;
    passphraseHint?: string;
}
export interface MailAccountSettings {
    emailAddress: string;
    imapHost: string;
    imapPort: number;
    smtpHost: string;
    smtpPort: number;
    /**
     * New saves should provide this value.
     * Existing accounts are returned with an empty appPassword so the stored
     * secret is not exposed back into the renderer process.
     */
    appPassword: string;
}
export interface SyncStatusEvent {
    state: "syncing" | "synced" | "error";
    message: string;
    fetched?: number;
    saved?: number;
    encrypted?: number;
}
export interface ComposeMailRequest {
    fromAccountEmail?: string;
    to: string;
    cc: string;
    bcc: string;
    subject: string;
    body: string;
    attachments?: MailAttachment[];
    useUnsyncShield: boolean;
}
export interface MailAttachment {
    filename: string;
    path: string;
}
declare const api: {
    listEmails(options?: {
        accountId?: string;
        mailbox?: string;
        query?: string;
    }): Promise<UnsyncEmailListItem[]>;
    getFolderEmails(folderName: string, accountEmail?: string): Promise<UnsyncEmailListItem[]>;
    getEmail(id: number): Promise<UnsyncEmailReadModel>;
    decryptEmail(input: {
        id: number;
        passphrase: string;
        userId?: string;
    }): Promise<string>;
    generateUserKey(input: GenerateUserKeyRequest): Promise<any>;
    generateSafetyNumber(firstPublicKeyArmored: string, secondPublicKeyArmored: string): Promise<string>;
    listAccounts(): Promise<MailAccountSettings[]>;
    saveAccount(input: MailAccountSettings): Promise<MailAccountSettings[]>;
    deleteAccount(emailAddress: string): Promise<void>;
    syncNow(accountEmail?: string): Promise<SyncStatusEvent>;
    sendMail(input: ComposeMailRequest): Promise<{
        shielded: boolean;
    }>;
    selectAttachments(): Promise<MailAttachment[]>;
    setReaderContent(html: string): Promise<boolean>;
    onMailboxUpdated(callback: () => void): () => Electron.IpcRenderer;
    onSyncStatus(callback: (event: SyncStatusEvent) => void): () => Electron.IpcRenderer;
};
export type UnsyncPreloadApi = typeof api;
export {};
//# sourceMappingURL=preload.d.ts.map