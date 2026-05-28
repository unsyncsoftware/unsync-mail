"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const path = require("node:path");
const crypto_1 = require("./crypto");
const db_1 = require("./db");
const sync_1 = require("./sync");
const DEFAULT_UI_USER_ID = "local-user";
const SAFE_STORAGE_PREFIX = "safe:v1:";
const AUTO_SYNC_INTERVAL_MS = 3 * 60 * 1000;
let mainWindow;
let database;
let currentEmailHtml = "";
let autoSyncTimer;
let syncInProgress = false;
electron_1.protocol.registerSchemesAsPrivileged([
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
function createMainWindow() {
    electron_1.Menu.setApplicationMenu(null);
    mainWindow = new electron_1.BrowserWindow({
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
    mainWindow.webContents.once("did-finish-load", () => {
        startAutoSyncLoop();
    });
    mainWindow.once("closed", () => {
        stopAutoSyncLoop();
        mainWindow = undefined;
    });
}
function getPlatformWindowChrome() {
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
function registerIpcHandlers() {
    electron_1.ipcMain.handle("emails:list", (_event, options) => {
        const db = getAppDatabase();
        const mailbox = options?.mailbox ?? "inbox";
        if (options?.query?.trim()) {
            return (0, db_1.searchEmails)(options.query, {
                ...(options.accountId !== undefined && { accountId: options.accountId }),
                mailbox,
                limit: 80,
            }, db);
        }
        return (0, db_1.listEmails)({
            ...(options?.accountId !== undefined && { accountId: options.accountId }),
            mailbox,
            limit: 80,
        }, db);
    });
    electron_1.ipcMain.handle("emails:get", (_event, id) => {
        assertPositiveInteger(id, "email id");
        const email = (0, db_1.getEmailById)(id, getAppDatabase());
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
            bodyContentType: email.isUnsyncEncrypted !== 1 && email.bodyCiphertext ? "html" : "text",
            isUnsyncEncrypted: email.isUnsyncEncrypted,
        };
    });
    electron_1.ipcMain.handle("emails:decrypt", async (_event, input) => {
        assertPositiveInteger(input.id, "email id");
        if (!input.passphrase?.trim()) {
            throw new Error("Passphrase is required.");
        }
        const db = getAppDatabase();
        const email = (0, db_1.getEmailById)(input.id, db);
        if (!email) {
            throw new Error(`Email ${input.id} was not found.`);
        }
        if (email.isUnsyncEncrypted !== 1) {
            return email.localSearchText;
        }
        return (0, crypto_1.decryptText)(email.bodyCiphertext, {
            userId: input.userId?.trim() || DEFAULT_UI_USER_ID,
            passphrase: input.passphrase,
            database: db,
        });
    });
    electron_1.ipcMain.handle("crypto:generate-user-key", (_event, input) => (0, crypto_1.generateUserKey)({ ...input, database: getAppDatabase() }));
    electron_1.ipcMain.handle("crypto:safety-number", (_event, firstPublicKeyArmored, secondPublicKeyArmored) => (0, crypto_1.generateSafetyNumber)(firstPublicKeyArmored, secondPublicKeyArmored));
    electron_1.ipcMain.handle("accounts:list", () => {
        return (0, db_1.listMailAccounts)(getAppDatabase()).map(toRendererAccount);
    });
    electron_1.ipcMain.handle("accounts:delete", (_event, emailAddress) => {
        if (!emailAddress?.trim()) {
            throw new Error("emailAddress is required.");
        }
        (0, db_1.deleteMailAccount)(emailAddress.trim().toLowerCase(), getAppDatabase());
    });
    electron_1.ipcMain.handle("accounts:save", async (_event, input) => {
        assertAccountInput(input);
        const db = getAppDatabase();
        const existingAccount = (0, db_1.getMailAccountByEmail)(input.emailAddress.trim().toLowerCase(), db);
        const appPassword = input.appPassword?.trim()
            ? encryptAccountPassword(input.appPassword)
            : existingAccount?.appPassword;
        if (!appPassword) {
            throw new Error("App password is required for the first account save.");
        }
        const account = (0, db_1.saveMailAccount)({
            ...input,
            appPassword,
        }, db);
        await syncInboxForAccounts([account], "manual", ["ALL"]);
        return (0, db_1.listMailAccounts)(db).map(toRendererAccount);
    });
    electron_1.ipcMain.handle("mail:sync-now", async (_event, accountEmail) => {
        const db = getAppDatabase();
        const accountsToSync = accountEmail
            ? [(0, db_1.getMailAccountByEmail)(accountEmail, db)].filter(Boolean)
            : (0, db_1.listMailAccounts)(db);
        if (accountsToSync.length === 0) {
            throw new Error("No mail account is configured.");
        }
        return syncInboxForAccounts(accountsToSync, "manual", getRecentInboxCriteria());
    });
    electron_1.ipcMain.handle("mail:set-reader-content", async (_event, html) => {
        currentEmailHtml = html || "";
        return true;
    });
    electron_1.ipcMain.handle("mail:get-folder-emails", (_event, folderName, accountEmail, query) => {
        if (typeof folderName !== "string" || !folderName.trim()) {
            throw new Error("Folder name is required.");
        }
        if (accountEmail !== undefined && typeof accountEmail !== "string") {
            throw new Error("Account filter must be text.");
        }
        if (query !== undefined && typeof query !== "string") {
            throw new Error("Search query must be text.");
        }
        return getFolderEmails(folderName, accountEmail?.trim() || undefined, query?.trim() || undefined, getAppDatabase());
    });
    electron_1.ipcMain.handle("mail:move-email", (_event, emailId, folderKey) => {
        assertPositiveInteger(emailId, "email id");
        if (typeof folderKey !== "string" || !folderKey.trim()) {
            throw new Error("Folder key is required.");
        }
        const mailbox = getActionMailbox(folderKey);
        const moved = (0, db_1.moveEmailToMailbox)(emailId, mailbox, getAppDatabase());
        if (!moved) {
            throw new Error(`Email ${emailId} was not found.`);
        }
        publishMailboxUpdated();
        return true;
    });
    electron_1.ipcMain.handle("mail:delete-email-to-trash", (_event, emailId) => {
        assertPositiveInteger(emailId, "email id");
        const moved = (0, db_1.moveEmailToMailbox)(emailId, getActionMailbox("trash"), getAppDatabase());
        if (!moved) {
            throw new Error(`Email ${emailId} was not found.`);
        }
        publishMailboxUpdated();
        return true;
    });
    electron_1.ipcMain.handle("mail:report-email-spam", (_event, emailId) => {
        assertPositiveInteger(emailId, "email id");
        const moved = (0, db_1.moveEmailToMailbox)(emailId, getActionMailbox("spam"), getAppDatabase());
        if (!moved) {
            throw new Error(`Email ${emailId} was not found.`);
        }
        publishMailboxUpdated();
        return true;
    });
    electron_1.ipcMain.handle("mail:archive-email", (_event, emailId) => {
        assertPositiveInteger(emailId, "email id");
        const moved = (0, db_1.moveEmailToMailbox)(emailId, getActionMailbox("archive"), getAppDatabase());
        if (!moved) {
            throw new Error(`Email ${emailId} was not found.`);
        }
        publishMailboxUpdated();
        return true;
    });
    electron_1.ipcMain.handle("mail:mark-email-read", (_event, emailId, isRead) => {
        assertPositiveInteger(emailId, "email id");
        if (typeof isRead !== "boolean") {
            throw new Error("Read state must be a boolean.");
        }
        const updated = (0, db_1.updateEmailReadState)(emailId, isRead, getAppDatabase());
        if (!updated) {
            throw new Error(`Email ${emailId} was not found.`);
        }
        publishMailboxUpdated();
        return true;
    });
    electron_1.ipcMain.handle("mail:select-attachments", async () => {
        const result = await electron_1.dialog.showOpenDialog(mainWindow, {
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
    electron_1.ipcMain.handle("mail:send", async (_event, input) => {
        assertComposeInput(input);
        const db = getAppDatabase();
        const account = input.fromAccountEmail
            ? (0, db_1.getMailAccountByEmail)(input.fromAccountEmail, db)
            : (0, db_1.getMailAccount)(db);
        if (!account) {
            throw new Error("No mail account is configured.");
        }
        const draft = {
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
        try {
            const sendOptions = {
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
            };
            if (process.env.UNSYNC_PORTAL_API_URL) {
                Object.assign(sendOptions, {
                    portalApiBaseUrl: process.env.UNSYNC_PORTAL_API_URL,
                });
            }
            const result = await (0, sync_1.sendEmail)(sendOptions);
            return {
                ok: true,
                shielded: result.shielded,
                deliveryMode: result.deliveryMode,
                portal: result.portal,
            };
        }
        catch (error) {
            if ((0, sync_1.isSendEmailError)(error)) {
                const responseError = {
                    code: error.code,
                    message: error.message,
                };
                if (error.recipientEmail) {
                    responseError.recipientEmail = error.recipientEmail;
                }
                return {
                    ok: false,
                    error: responseError,
                };
            }
            throw error;
        }
    });
}
function toRendererAccount(account) {
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
async function syncInboxForAccount(account, searchCriteria) {
    publishSyncStatus({
        state: "syncing",
        message: "Syncing inbox...",
    });
    try {
        return await (0, sync_1.syncInbox)({
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
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Inbox sync failed.";
        publishSyncStatus({
            state: "error",
            message,
        });
        throw error;
    }
}
async function syncInboxForAccounts(accounts, source, searchCriteria) {
    if (syncInProgress) {
        const status = {
            state: "syncing",
            message: "Sync already in progress. Mailbox will update when it finishes.",
        };
        if (source === "manual") {
            publishSyncStatus(status);
        }
        return status;
    }
    syncInProgress = true;
    try {
        let totalFetched = 0;
        let totalSaved = 0;
        let totalEncrypted = 0;
        let syncedAccounts = 0;
        const failures = [];
        for (const account of accounts) {
            try {
                const result = await syncInboxForAccount(account, searchCriteria);
                totalFetched += result.fetched;
                totalSaved += result.saved;
                totalEncrypted += result.encrypted;
                syncedAccounts += 1;
            }
            catch (error) {
                failures.push(`${account.emailAddress}: ${formatErrorMessage(error)}`);
            }
        }
        if (syncedAccounts > 0) {
            publishMailboxUpdated();
        }
        const status = failures.length === 0
            ? {
                state: "synced",
                message: source === "auto"
                    ? `Synced ${totalSaved} new message${totalSaved === 1 ? "" : "s"}.`
                    : `Inbox synced. Saved ${totalSaved} new message${totalSaved === 1 ? "" : "s"}.`,
                fetched: totalFetched,
                saved: totalSaved,
                encrypted: totalEncrypted,
            }
            : {
                state: "error",
                message: syncedAccounts > 0
                    ? `Synced ${totalSaved} new message${totalSaved === 1 ? "" : "s"}; ${failures.length} account${failures.length === 1 ? "" : "s"} failed.`
                    : `Sync failed. Will retry on the next interval. ${failures[0] ?? ""}`.trim(),
                fetched: totalFetched,
                saved: totalSaved,
                encrypted: totalEncrypted,
            };
        publishSyncStatus(status);
        return status;
    }
    finally {
        syncInProgress = false;
    }
}
function startAutoSyncLoop() {
    if (autoSyncTimer) {
        return;
    }
    autoSyncTimer = setInterval(() => {
        void runAutoSyncTick();
    }, AUTO_SYNC_INTERVAL_MS);
    void runAutoSyncTick();
}
function stopAutoSyncLoop() {
    if (!autoSyncTimer) {
        return;
    }
    clearInterval(autoSyncTimer);
    autoSyncTimer = undefined;
}
async function runAutoSyncTick() {
    if (syncInProgress) {
        return;
    }
    try {
        const accounts = (0, db_1.listMailAccounts)(getAppDatabase());
        if (accounts.length === 0) {
            return;
        }
        await syncInboxForAccounts(accounts, "auto", getRecentInboxCriteria());
    }
    catch (error) {
        publishSyncStatus({
            state: "error",
            message: `Auto-sync could not run. Will retry soon. ${formatErrorMessage(error)}`,
        });
    }
}
function formatErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function encryptAccountPassword(value) {
    if (!electron_1.safeStorage.isEncryptionAvailable()) {
        // Fallback keeps development builds working on platforms where the OS
        // keychain is unavailable. Production builds should surface this as a
        // warning and require safeStorage support.
        return value;
    }
    return `${SAFE_STORAGE_PREFIX}${electron_1.safeStorage.encryptString(value).toString("base64")}`;
}
function decryptAccountPassword(value) {
    if (!value.startsWith(SAFE_STORAGE_PREFIX)) {
        // Backward compatibility for existing plaintext rows.
        return value;
    }
    if (!electron_1.safeStorage.isEncryptionAvailable()) {
        throw new Error("Stored mail password cannot be decrypted on this device.");
    }
    const encryptedValue = value.slice(SAFE_STORAGE_PREFIX.length);
    return electron_1.safeStorage.decryptString(Buffer.from(encryptedValue, "base64"));
}
function publishMailboxUpdated() {
    mainWindow?.webContents.send("mailbox:updated");
}
function publishSyncStatus(status) {
    mainWindow?.webContents.send("mail:sync-status", status);
}
function getRecentInboxCriteria() {
    return ["ALL", ["SINCE", formatImapSearchDate(daysAgo(3))]];
}
function daysAgo(days) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - days);
    return date;
}
function formatImapSearchDate(date) {
    const day = String(date.getUTCDate()).padStart(2, "0");
    const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getUTCMonth()];
    return `${day}-${month}-${date.getUTCFullYear()}`;
}
function getAppDatabase() {
    database ??= (0, db_1.getDatabase)();
    return database;
}
function assertPositiveInteger(value, label) {
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`${label} must be a positive integer.`);
    }
}
function assertAccountInput(value) {
    if (!value || typeof value !== "object") {
        throw new Error("Account settings are required.");
    }
    const input = value;
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
        if (typeof input[field] !== "number" ||
            !Number.isInteger(input[field]) ||
            input[field] < 1 ||
            input[field] > 65535) {
            throw new Error(`${field} must be a valid TCP port.`);
        }
    }
}
function assertComposeInput(value) {
    if (!value || typeof value !== "object") {
        throw new Error("Draft is required.");
    }
    const input = value;
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
function normalizeAttachments(value) {
    if (!value) {
        return [];
    }
    return value.map((attachment) => {
        if (!attachment ||
            typeof attachment.filename !== "string" ||
            typeof attachment.path !== "string" ||
            !attachment.path.trim()) {
            throw new Error("Each attachment must include a file path.");
        }
        return {
            filename: attachment.filename.trim() || path.basename(attachment.path),
            path: attachment.path,
        };
    });
}
function toMailboxKey(folderName) {
    const normalized = folderName.trim().toLowerCase();
    const mailboxMap = {
        inbox: "inbox",
        sent: "sent",
        "sent items": "sent",
        outbox: "outbox",
        drafts: "drafts",
        archive: "archive",
        spam: "spam",
        junk: "spam",
        "junk email": "spam",
        trash: "trash",
        deleted: "trash",
        "deleted items": "trash",
    };
    return mailboxMap[normalized] ?? normalized;
}
const folderAliases = {
    inbox: ["Inbox", "INBOX"],
    sent: ["Sent", "Sent Items", "Sent Mail", "[Gmail]/Sent Mail", "[Google Mail]/Sent Mail"],
    outbox: ["Outbox"],
    drafts: ["Drafts", "[Gmail]/Drafts", "[Google Mail]/Drafts"],
    archive: ["Archive", "All Mail", "[Gmail]/All Mail", "[Google Mail]/All Mail"],
    spam: ["Spam", "Junk", "Junk Email", "[Gmail]/Spam", "[Google Mail]/Spam"],
    trash: ["Trash", "Deleted Items", "Deleted Messages", "[Gmail]/Trash", "[Google Mail]/Trash"],
};
function getMailboxAliases(folderName) {
    const mailboxKey = toMailboxKey(folderName);
    const aliases = folderAliases[mailboxKey] ?? [mailboxKey];
    return Array.from(new Set([mailboxKey, ...aliases].map((alias) => alias.trim().toLowerCase())));
}
function getActionMailbox(folderKey) {
    const mailboxKey = toMailboxKey(folderKey);
    const actionMailboxes = {
        trash: "trash",
        spam: "spam",
        archive: "archive",
    };
    const mailbox = actionMailboxes[mailboxKey];
    if (!mailbox) {
        throw new Error(`Unsupported mailbox action: ${folderKey}`);
    }
    return mailbox;
}
function getFolderEmails(folderName, accountEmail, query, db) {
    const aliases = getMailboxAliases(folderName);
    const account = accountEmail ?? null;
    const placeholders = aliases.map(() => "?").join(", ");
    const baseParams = [...aliases, account];
    const ftsQuery = query ? toFtsPrefixQuery(query) : "";
    if (query && !ftsQuery) {
        return [];
    }
    if (ftsQuery) {
        return db
            .prepare(`
        SELECT
          emails.id,
          emails.mailbox,
          emails.subject,
          emails.from_address AS fromAddress,
          emails.from_name AS fromName,
          emails.received_at AS receivedAt,
          emails.decrypted_preview AS decryptedPreview,
          emails.is_unsync_encrypted AS isUnsyncEncrypted
        FROM email_fts
        JOIN emails ON emails.id = email_fts.rowid
        WHERE email_fts MATCH ?
          AND lower(emails.mailbox) IN (${placeholders})
          AND (? IS NULL OR emails.account_id = ?)
        ORDER BY bm25(email_fts), COALESCE(emails.sent_at, emails.received_at) DESC, emails.id DESC
        LIMIT 50
      `)
            .all([ftsQuery, ...baseParams, account]);
    }
    return db
        .prepare(`
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
      WHERE lower(mailbox) IN (${placeholders})
        AND (? IS NULL OR account_id = ?)
      ORDER BY COALESCE(sent_at, received_at) DESC, id DESC
      LIMIT 50
    `)
        .all([...baseParams, account]);
}
function toFtsPrefixQuery(query) {
    return query
        .trim()
        .split(/\s+/)
        .map((token) => token.replace(/"/g, '""').trim())
        .filter((token) => token.length > 0)
        .map((token) => `"${token}"*`)
        .join(" ");
}
electron_1.app.whenReady().then(() => {
    electron_1.protocol.handle("email-reader", async (request) => {
        const url = new URL(request.url);
        if (url.hostname !== "view") {
            return new Response("Not found", { status: 404 });
        }
        return new Response(currentEmailHtml || "<!doctype html><html><body></body></html>", {
            headers: {
                "Content-Type": "text/html; charset=utf-8",
                "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src http: https: data: cid: blob:; font-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'; script-src 'none';",
            },
        });
    });
    registerIpcHandlers();
    createMainWindow();
    electron_1.app.on("activate", () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0) {
            createMainWindow();
        }
    });
});
electron_1.app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        electron_1.app.quit();
    }
});
electron_1.app.on("before-quit", () => {
    stopAutoSyncLoop();
    database?.close();
    database = undefined;
});
//# sourceMappingURL=main.js.map