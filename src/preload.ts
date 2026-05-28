import { contextBridge, ipcRenderer } from "electron";

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

export type SendMailResponse =
  | {
      ok: true;
      shielded: boolean;
      deliveryMode: "standard" | "unsync_direct" | "secure_portal";
      portal?: SecurePortalSendInfo;
    }
  | { ok: false; error: ComposeSendError };

export interface SecurePortalSendInfo {
  portalId: string;
  portalUrl: string;
  recipientEmail: string;
  missingRecipientEmails: string[];
  expiresAt: string;
  idleTimeoutSeconds: number;
}

export interface ComposeSendError {
  code: "MISSING_RECIPIENT_PUBLIC_KEY" | "SECURE_PORTAL_UPLOAD_FAILED";
  recipientEmail?: string;
  message: string;
}

export interface MailAttachment {
  filename: string;
  path: string;
}

const api = {
  listEmails(options?: { accountId?: string; mailbox?: string; query?: string }) {
    return ipcRenderer.invoke("emails:list", options) as Promise<
      UnsyncEmailListItem[]
    >;
  },

  getFolderEmails(folderName: string, accountEmail?: string, query?: string) {
    return ipcRenderer.invoke(
      "mail:get-folder-emails",
      folderName,
      accountEmail,
      query,
    ) as Promise<UnsyncEmailListItem[]>;
  },

  getEmail(id: number) {
    return ipcRenderer.invoke(
      "emails:get",
      id,
    ) as Promise<UnsyncEmailReadModel>;
  },

  decryptEmail(input: { id: number; passphrase: string; userId?: string }) {
    return ipcRenderer.invoke("emails:decrypt", input) as Promise<string>;
  },

  generateUserKey(input: GenerateUserKeyRequest) {
    return ipcRenderer.invoke("crypto:generate-user-key", input);
  },

  generateSafetyNumber(
    firstPublicKeyArmored: string,
    secondPublicKeyArmored: string,
  ) {
    return ipcRenderer.invoke(
      "crypto:safety-number",
      firstPublicKeyArmored,
      secondPublicKeyArmored,
    ) as Promise<string>;
  },

  listAccounts() {
    return ipcRenderer.invoke("accounts:list") as Promise<MailAccountSettings[]>;
  },

  saveAccount(input: MailAccountSettings) {
    return ipcRenderer.invoke(
      "accounts:save",
      input,
    ) as Promise<MailAccountSettings[]>;
  },

  deleteAccount(emailAddress: string) {
    return ipcRenderer.invoke("accounts:delete", emailAddress) as Promise<void>;
  },

  syncNow(accountEmail?: string) {
    return ipcRenderer.invoke("mail:sync-now", accountEmail) as Promise<SyncStatusEvent>;
  },

  sendMail(input: ComposeMailRequest) {
    return ipcRenderer.invoke("mail:send", input) as Promise<SendMailResponse>;
  },

  selectAttachments() {
    return ipcRenderer.invoke("mail:select-attachments") as Promise<MailAttachment[]>;
  },

  setReaderContent(html: string) {
    return ipcRenderer.invoke("mail:set-reader-content", html) as Promise<boolean>;
  },

  moveEmailToFolder(emailId: number, folderKey: string) {
    return ipcRenderer.invoke("mail:move-email", emailId, folderKey) as Promise<boolean>;
  },

  deleteEmailToTrash(emailId: number) {
    return ipcRenderer.invoke("mail:delete-email-to-trash", emailId) as Promise<boolean>;
  },

  reportEmailSpam(emailId: number) {
    return ipcRenderer.invoke("mail:report-email-spam", emailId) as Promise<boolean>;
  },

  archiveEmail(emailId: number) {
    return ipcRenderer.invoke("mail:archive-email", emailId) as Promise<boolean>;
  },

  markEmailRead(emailId: number, isRead: boolean) {
    return ipcRenderer.invoke("mail:mark-email-read", emailId, isRead) as Promise<boolean>;
  },

  onMailboxUpdated(callback: () => void) {
    const listener = () => callback();
    ipcRenderer.on("mailbox:updated", listener);
    return () => ipcRenderer.removeListener("mailbox:updated", listener);
  },

  onSyncStatus(callback: (event: SyncStatusEvent) => void) {
    const listener = (
      _event: Electron.IpcRendererEvent,
      status: SyncStatusEvent,
    ) => {
      callback(status);
    };
    ipcRenderer.on("mail:sync-status", listener);
    return () => ipcRenderer.removeListener("mail:sync-status", listener);
  },
};

contextBridge.exposeInMainWorld("unsync", api);

export type UnsyncPreloadApi = typeof api;
