import {
  app,
  BrowserWindow,
  dialog,
  type BrowserWindowConstructorOptions,
  ipcMain,
  Menu,
  protocol,
  safeStorage,
} from "electron";
import path = require("node:path");

import { decryptText, generateSafetyNumber, generateUserKey } from "./crypto";
import {
  type DatabaseConnection,
  deleteMailAccount,
  getDatabase,
  getEmailById,
  getMailAccount,
  getMailAccountByEmail,
  listEmails,
  listMailAccounts,
  saveMailAccount,
  searchEmails,
  type StoredMailAccount,
} from "./db";
import { sendEmail, syncInbox, type EmailDraft, type SyncInboxResult } from "./sync";

const DEFAULT_UI_USER_ID = "local-user";
const SAFE_STORAGE_PREFIX = "safe:v1:";

interface SyncStatusEvent {
  state: "syncing" | "synced" | "error";
  message: string;
  fetched?: number;
  saved?: number;
  encrypted?: number;
}

interface RendererAttachment {
  filename: string;
  path: string;
}

let mainWindow: BrowserWindow | undefined;
let database: DatabaseConnection | undefined;
let currentEmailHtml = "";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "email-reader",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: false,
      corsEnabled: false,
    },
  },
]);

function createMainWindow(): void {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: "#080808",
    ...getPlatformWindowChrome(),
    title: "Unsync Mail",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "public", "index.html"));

  mainWindow.webContents.openDevTools({ mode: "detach" });
}

function getPlatformWindowChrome(): Pick<
  BrowserWindowConstructorOptions,
  "frame" | "titleBarStyle" | "titleBarOverlay"
> {
  if (process.platform === "linux") {
    return {
      frame: true,
      titleBarStyle: "default",
    };
  }

  if (process.platform === "darwin") {
    return {
      frame: false,
      titleBarStyle: "hiddenInset",
    };
  }

  return {
    frame: false,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#0f141c",
      symbolColor: "#ffffff",
      height: 48,
    },
  };
}

function registerIpcHandlers(): void {
  ipcMain.handle(
    "emails:list",
    (_event, options?: { accountId?: string; mailbox?: string; query?: string }) => {
      const db = getAppDatabase();
      const mailbox = options?.mailbox ?? "inbox";

      if (options?.query?.trim()) {
        return searchEmails(options.query, {
          ...(options.accountId !== undefined && { accountId: options.accountId }),
          mailbox,
          limit: 80,
        }, db);
      }

      return listEmails({
        ...(options?.accountId !== undefined && { accountId: options.accountId }),
        mailbox,
        limit: 80,
      }, db);
    },
  );

  ipcMain.handle("emails:get", (_event, id: number) => {
    assertPositiveInteger(id, "email id");

    const email = getEmailById(id, getAppDatabase());

    if (!email) {
      throw new Error(`Email ${id} was not found.`);
    }

    return {
      id: email.id,
      accountId: email.accountId,
      mailbox: email.mailbox,
      subject: email.subject,
      fromAddress: email.fromAddress,
      fromName: email.fromName,
      toAddresses: email.toAddresses,
      ccAddresses: email.ccAddresses,
      receivedAt: email.receivedAt,
      decryptedPreview: email.decryptedPreview,
      localSearchText: email.isUnsyncEncrypted ? "" : email.localSearchText,
      bodyContent: email.isUnsyncEncrypted ? "" : email.bodyCiphertext || email.localSearchText,
      bodyContentType:
        email.isUnsyncEncrypted !== 1 && email.bodyCiphertext ? "html" : "text",
      isUnsyncEncrypted: email.isUnsyncEncrypted,
    };
  });

  ipcMain.handle(
    "emails:decrypt",
    async (
      _event,
      input: { id: number; passphrase: string; userId?: string },
    ) => {
      assertPositiveInteger(input.id, "email id");

      if (!input.passphrase?.trim()) {
        throw new Error("Passphrase is required.");
      }

      const db = getAppDatabase();
      const email = getEmailById(input.id, db);

      if (!email) {
        throw new Error(`Email ${input.id} was not found.`);
      }

      if (email.isUnsyncEncrypted !== 1) {
        return email.localSearchText;
      }

      return decryptText(email.bodyCiphertext, {
        userId: input.userId?.trim() || DEFAULT_UI_USER_ID,
        passphrase: input.passphrase,
        database: db,
      });
    },
  );

  ipcMain.handle("crypto:generate-user-key", (_event, input) =>
    generateUserKey({ ...input, database: getAppDatabase() }),
  );

  ipcMain.handle(
    "crypto:safety-number",
    (_event, firstPublicKeyArmored: string, secondPublicKeyArmored: string) =>
      generateSafetyNumber(firstPublicKeyArmored, secondPublicKeyArmored),
  );

  ipcMain.handle("accounts:list", () => {
    return listMailAccounts(getAppDatabase()).map(toRendererAccount);
  });

  ipcMain.handle("accounts:delete", (_event, emailAddress: string) => {
    if (!emailAddress?.trim()) {
      throw new Error("emailAddress is required.");
    }
    deleteMailAccount(emailAddress.trim().toLowerCase(), getAppDatabase());
  });

  ipcMain.handle("accounts:save", async (_event, input) => {
    assertAccountInput(input);

    const db = getAppDatabase();
    const existingAccount = getMailAccountByEmail(input.emailAddress.trim().toLowerCase(), db);
    const appPassword = input.appPassword?.trim()
      ? encryptAccountPassword(input.appPassword)
      : existingAccount?.appPassword;

    if (!appPassword) {
      throw new Error("App password is required for the first account save.");
    }

    const account = saveMailAccount(
      {
        ...input,
        appPassword,
      },
      db,
    );

    const syncResult = await syncInboxForAccount(account, ["ALL"]);
    publishSyncStatus({
      state: "synced",
      message: `Inbox synced. Saved ${syncResult.saved} message(s).`,
      fetched: syncResult.fetched,
      saved: syncResult.saved,
      encrypted: syncResult.encrypted,
    });
    publishMailboxUpdated();

    return listMailAccounts(db).map(toRendererAccount);
  });

  ipcMain.handle("mail:sync-now", async (_event, accountEmail?: string) => {
    const db = getAppDatabase();
    const accountsToSync = accountEmail
      ? [getMailAccountByEmail(accountEmail, db)].filter(Boolean) as StoredMailAccount[]
      : listMailAccounts(db);

    if (accountsToSync.length === 0) {
      throw new Error("No mail account is configured.");
    }

    let totalFetched = 0;
    let totalSaved = 0;
    let totalEncrypted = 0;

    for (const account of accountsToSync) {
      const result = await syncInboxForAccount(account, getRecentInboxCriteria());
      totalFetched += result.fetched;
      totalSaved += result.saved;
      totalEncrypted += result.encrypted;
    }

    const status: SyncStatusEvent = {
      state: "synced",
      message: `Inbox synced. Saved ${totalSaved} new/updated message(s).`,
      fetched: totalFetched,
      saved: totalSaved,
      encrypted: totalEncrypted,
    };

    publishSyncStatus(status);
    publishMailboxUpdated();

    return status;
  });

  ipcMain.handle("mail:set-reader-content", async (_event, html: string) => {
    currentEmailHtml = html || "";
    return true;
  });

  ipcMain.handle("mail:get-folder-emails", (_event, folderName: string, accountEmail?: string) => {
    if (typeof folderName !== "string" || !folderName.trim()) {
      throw new Error("Folder name is required.");
    }

    if (accountEmail !== undefined && typeof accountEmail !== "string") {
      throw new Error("Account filter must be text.");
    }

    return getFolderEmails(folderName, accountEmail?.trim() || undefined, getAppDatabase());
  });

  ipcMain.handle("mail:select-attachments", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Attach files",
      properties: ["openFile", "multiSelections"],
    });

    if (result.canceled) {
      return [];
    }

    return result.filePaths.map((filePath) => ({
      filename: path.basename(filePath),
      path: filePath,
    }));
  });

  ipcMain.handle("mail:send", async (_event, input) => {
    assertComposeInput(input);

    const db = getAppDatabase();
    const account = input.fromAccountEmail
      ? getMailAccountByEmail(input.fromAccountEmail, db)
      : getMailAccount(db);

    if (!account) {
      throw new Error("No mail account is configured.");
    }

    const draft: EmailDraft = {
      from: account.emailAddress,
      to: input.to,
      subject: input.subject,
      text: input.body,
    };

    if (input.cc.trim()) {
      draft.cc = input.cc.trim();
    }

    if (input.bcc.trim()) {
      draft.bcc = input.bcc.trim();
    }

    const attachments = normalizeAttachments(input.attachments);

    if (attachments.length > 0) {
      draft.attachments = attachments;
    }

    const result = await sendEmail({
      smtp: {
        host: account.smtpHost,
        port: account.smtpPort,
        secure: account.smtpPort === 465,
        auth: {
          user: account.emailAddress,
          pass: decryptAccountPassword(account.appPassword),
        },
      },
      draft,
      useUnsyncShield: input.useUnsyncShield,
      database: getAppDatabase(),
    });

    return {
      shielded: result.shielded,
    };
  });
}

function toRendererAccount(account: StoredMailAccount) {
  return {
    emailAddress: account.emailAddress,
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    smtpHost: account.smtpHost,
    smtpPort: account.smtpPort,
    // Never send the stored secret back to the renderer process.
    appPassword: "",
  };
}

async function syncInboxForAccount(
  account: StoredMailAccount,
  searchCriteria: unknown[],
): Promise<SyncInboxResult> {
  publishSyncStatus({
    state: "syncing",
    message: "Syncing inbox...",
  });

  try {
    return await syncInbox({
      accountId: account.emailAddress,
      imap: {
        user: account.emailAddress,
        password: decryptAccountPassword(account.appPassword),
        host: account.imapHost,
        port: account.imapPort,
        tls: true,
        tlsOptions: {
          rejectUnauthorized: false,
        },
      },
      mailbox: "INBOX",
      database: getAppDatabase(),
      searchCriteria,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Inbox sync failed.";
    publishSyncStatus({
      state: "error",
      message,
    });
    throw error;
  }
}

function encryptAccountPassword(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    // Fallback keeps development builds working on platforms where the OS
    // keychain is unavailable. Production builds should surface this as a
    // warning and require safeStorage support.
    return value;
  }

  return `${SAFE_STORAGE_PREFIX}${safeStorage.encryptString(value).toString("base64")}`;
}

function decryptAccountPassword(value: string): string {
  if (!value.startsWith(SAFE_STORAGE_PREFIX)) {
    // Backward compatibility for existing plaintext rows.
    return value;
  }

  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Stored mail password cannot be decrypted on this device.");
  }

  const encryptedValue = value.slice(SAFE_STORAGE_PREFIX.length);
  return safeStorage.decryptString(Buffer.from(encryptedValue, "base64"));
}

function publishMailboxUpdated(): void {
  mainWindow?.webContents.send("mailbox:updated");
}

function publishSyncStatus(status: SyncStatusEvent): void {
  mainWindow?.webContents.send("mail:sync-status", status);
}

function getRecentInboxCriteria(): unknown[] {
  return ["ALL", ["SINCE", formatImapSearchDate(daysAgo(3))]];
}

function daysAgo(days: number): Date {
  const date = new Date();

  date.setUTCDate(date.getUTCDate() - days);

  return date;
}

function formatImapSearchDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
    date.getUTCMonth()
  ];

  return `${day}-${month}-${date.getUTCFullYear()}`;
}

function getAppDatabase(): DatabaseConnection {
  database ??= getDatabase();
  return database;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

function assertAccountInput(value: unknown): asserts value is {
  emailAddress: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  appPassword: string;
} {
  if (!value || typeof value !== "object") {
    throw new Error("Account settings are required.");
  }

  const input = value as Record<string, unknown>;
  const requiredStringFields = ["emailAddress", "imapHost", "smtpHost"];

  for (const field of requiredStringFields) {
    if (typeof input[field] !== "string" || input[field].trim().length === 0) {
      throw new Error(`${field} is required.`);
    }
  }

  if (typeof input.appPassword !== "string") {
    throw new Error("appPassword is required.");
  }

  for (const field of ["imapPort", "smtpPort"]) {
    if (
      typeof input[field] !== "number" ||
      !Number.isInteger(input[field]) ||
      input[field] < 1 ||
      input[field] > 65535
    ) {
      throw new Error(`${field} must be a valid TCP port.`);
    }
  }
}

function assertComposeInput(value: unknown): asserts value is {
  fromAccountEmail?: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  attachments?: RendererAttachment[];
  useUnsyncShield: boolean;
} {
  if (!value || typeof value !== "object") {
    throw new Error("Draft is required.");
  }

  const input = value as Record<string, unknown>;

  for (const field of ["to", "cc", "bcc", "subject", "body"]) {
    if (typeof input[field] !== "string") {
      throw new Error(`${field} must be text.`);
    }
  }

  if (typeof input.to !== "string" || !input.to.trim()) {
    throw new Error("Recipient is required.");
  }

  if (typeof input.subject !== "string" || !input.subject.trim()) {
    throw new Error("Subject is required.");
  }

  if (typeof input.body !== "string" || !input.body.trim()) {
    throw new Error("Message body is required.");
  }

  if (typeof input.useUnsyncShield !== "boolean") {
    throw new Error("useUnsyncShield must be a boolean.");
  }

  if (input.attachments !== undefined && !Array.isArray(input.attachments)) {
    throw new Error("attachments must be an array.");
  }
}

function normalizeAttachments(value: RendererAttachment[] | undefined): RendererAttachment[] {
  if (!value) {
    return [];
  }

  return value.map((attachment) => {
    if (
      !attachment ||
      typeof attachment.filename !== "string" ||
      typeof attachment.path !== "string" ||
      !attachment.path.trim()
    ) {
      throw new Error("Each attachment must include a file path.");
    }

    return {
      filename: attachment.filename.trim() || path.basename(attachment.path),
      path: attachment.path,
    };
  });
}

function toMailboxKey(folderName: string): string {
  const normalized = folderName.trim().toLowerCase();
  const mailboxMap: Record<string, string> = {
    inbox: "inbox",
    "junk email": "junk",
    drafts: "drafts",
    "sent items": "sent",
    "deleted items": "deleted",
    archive: "archive",
    "conversation history": "conversation history",
    notes: "notes",
    outbox: "outbox",
    "go to groups": "groups",
  };

  return mailboxMap[normalized] ?? normalized;
}

function getFolderEmails(
  folderName: string,
  accountEmail: string | undefined,
  db: DatabaseConnection,
) {
  const mailbox = toMailboxKey(folderName);
  const account = accountEmail ?? null;

  if (mailbox === "outbox") {
    return db
      .prepare<{ account: string | null }, FolderEmailRow>(`
        SELECT
          id,
          mailbox,
          subject,
          from_address AS fromAddress,
          from_name AS fromName,
          received_at AS receivedAt,
          decrypted_preview AS decryptedPreview,
          is_unsync_encrypted AS isUnsyncEncrypted
        FROM emails
        WHERE mailbox IN ('outbox', 'drafts')
          AND (@account IS NULL OR account_id = @account)
        ORDER BY COALESCE(sent_at, received_at) DESC, id DESC
        LIMIT 50
      `)
      .all({ account });
  }

  return db
    .prepare<{ mailbox: string; account: string | null }, FolderEmailRow>(`
      SELECT
        id,
        mailbox,
        subject,
        from_address AS fromAddress,
        from_name AS fromName,
        received_at AS receivedAt,
        decrypted_preview AS decryptedPreview,
        is_unsync_encrypted AS isUnsyncEncrypted
      FROM emails
      WHERE mailbox = @mailbox
        AND (@account IS NULL OR account_id = @account)
      ORDER BY COALESCE(sent_at, received_at) DESC, id DESC
      LIMIT 50
    `)
    .all({ mailbox, account });
}

interface FolderEmailRow {
  id: number;
  mailbox: string;
  subject: string;
  fromAddress: string;
  fromName: string | null;
  receivedAt: string;
  decryptedPreview: string;
  isUnsyncEncrypted: 0 | 1;
}

app.whenReady().then(() => {
  protocol.handle("email-reader", async (request) => {
    const url = new URL(request.url);

    if (url.hostname !== "view") {
      return new Response("Not found", { status: 404 });
    }

    return new Response(currentEmailHtml || "<!doctype html><html><body></body></html>", {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; img-src http: https: data: cid: blob:; font-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'; script-src 'none';",
      },
    });
  });

  registerIpcHandlers();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  database?.close();
  database = undefined;
});
