"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_DATABASE_PATH = exports.DEFAULT_DATABASE_DIR = void 0;
exports.openDatabase = openDatabase;
exports.getDatabase = getDatabase;
exports.closeDatabase = closeDatabase;
exports.initializeSchema = initializeSchema;
exports.searchEmails = searchEmails;
exports.listEmails = listEmails;
exports.getEmailById = getEmailById;
exports.moveEmailToMailbox = moveEmailToMailbox;
exports.updateEmailReadState = updateEmailReadState;
exports.saveUserKey = saveUserKey;
exports.getActiveUserKey = getActiveUserKey;
exports.saveEmail = saveEmail;
exports.saveSecurePortalPayload = saveSecurePortalPayload;
exports.getContactPublicKey = getContactPublicKey;
exports.saveContactPublicKey = saveContactPublicKey;
exports.saveMailAccount = saveMailAccount;
exports.getMailAccountByEmail = getMailAccountByEmail;
exports.listMailAccounts = listMailAccounts;
exports.deleteMailAccount = deleteMailAccount;
exports.getMailAccount = getMailAccount;
const Database = require("better-sqlite3");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
exports.DEFAULT_DATABASE_DIR = process.env.UNSYNC_MAIL_DATA_DIR ??
    (process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, "Unsync Mail")
        : path.join(os.homedir(), ".unsync-mail"));
exports.DEFAULT_DATABASE_PATH = path.join(exports.DEFAULT_DATABASE_DIR, "unsync-mail.sqlite");
let activeDatabase;
function openDatabase(databasePath = exports.DEFAULT_DATABASE_PATH) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new Database(databasePath);
    configureDatabase(database);
    initializeSchema(database);
    return database;
}
function getDatabase(databasePath = exports.DEFAULT_DATABASE_PATH) {
    if (!activeDatabase || activeDatabase.name !== databasePath) {
        activeDatabase?.close();
        activeDatabase = openDatabase(databasePath);
    }
    return activeDatabase;
}
function closeDatabase() {
    activeDatabase?.close();
    activeDatabase = undefined;
}
function initializeSchema(database) {
    database.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY,
      email_address TEXT NOT NULL UNIQUE,
      display_name TEXT,
      public_key_armored TEXT,
      key_fingerprint TEXT,
      trust_state TEXT NOT NULL DEFAULT 'unknown'
        CHECK (trust_state IN ('unknown', 'trusted', 'blocked')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS user_keys (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL,
      key_fingerprint TEXT NOT NULL UNIQUE,
      public_key_armored TEXT NOT NULL,
      private_key_armored_encrypted TEXT NOT NULL,
      passphrase_hint TEXT,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS mail_accounts (
      id INTEGER PRIMARY KEY,
      email_address TEXT NOT NULL UNIQUE,
      imap_host TEXT NOT NULL,
      imap_port INTEGER NOT NULL,
      smtp_host TEXT NOT NULL,
      smtp_port INTEGER NOT NULL,
      app_password TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS emails (
      id INTEGER PRIMARY KEY,
      account_id TEXT NOT NULL,
      mailbox TEXT NOT NULL DEFAULT 'inbox',
      provider_message_id TEXT NOT NULL,
      thread_id TEXT,
      subject TEXT NOT NULL DEFAULT '',
      from_address TEXT NOT NULL DEFAULT '',
      from_name TEXT,
      to_addresses TEXT NOT NULL DEFAULT '[]',
      cc_addresses TEXT NOT NULL DEFAULT '[]',
      bcc_addresses TEXT NOT NULL DEFAULT '[]',
      sent_at TEXT,
      received_at TEXT NOT NULL,
      body_ciphertext TEXT NOT NULL,
      decrypted_preview TEXT NOT NULL DEFAULT '',
      local_search_text TEXT NOT NULL DEFAULT '',
      is_unsync_encrypted INTEGER NOT NULL DEFAULT 0
        CHECK (is_unsync_encrypted IN (0, 1)),
      delivery_mode TEXT NOT NULL DEFAULT 'standard'
        CHECK (delivery_mode IN ('standard', 'unsync_direct', 'secure_portal')),
      secure_portal_id TEXT,
      secure_portal_url TEXT,
      headers_json TEXT NOT NULL DEFAULT '{}',
      flags_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (account_id, provider_message_id)
    );

    CREATE TABLE IF NOT EXISTS secure_portal_payloads (
      portal_id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      sender_account_id TEXT NOT NULL,
      recipient_email TEXT NOT NULL,
      encrypted_payload TEXT NOT NULL,
      portal_url TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      idle_timeout_seconds INTEGER NOT NULL,
      is_consumed INTEGER NOT NULL DEFAULT 0 CHECK (is_consumed IN (0, 1)),
      one_time_read INTEGER NOT NULL DEFAULT 1 CHECK (one_time_read IN (0, 1)),
      last_access_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_contacts_email_address
      ON contacts (email_address);

    CREATE INDEX IF NOT EXISTS idx_emails_account_mailbox_received
      ON emails (account_id, mailbox, received_at DESC);

    CREATE INDEX IF NOT EXISTS idx_emails_thread_id
      ON emails (thread_id);

    CREATE INDEX IF NOT EXISTS idx_mail_accounts_email_address
      ON mail_accounts (email_address);

    CREATE INDEX IF NOT EXISTS idx_secure_portal_payloads_expires
      ON secure_portal_payloads (expires_at);

    CREATE INDEX IF NOT EXISTS idx_secure_portal_payloads_recipient
      ON secure_portal_payloads (recipient_email);

    CREATE VIRTUAL TABLE IF NOT EXISTS email_fts USING fts5(
      subject,
      from_address,
      to_addresses,
      cc_addresses,
      decrypted_preview,
      local_search_text,
      content='emails',
      content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER IF NOT EXISTS emails_ai AFTER INSERT ON emails BEGIN
      INSERT INTO email_fts(
        rowid,
        subject,
        from_address,
        to_addresses,
        cc_addresses,
        decrypted_preview,
        local_search_text
      )
      VALUES (
        new.id,
        new.subject,
        new.from_address,
        new.to_addresses,
        new.cc_addresses,
        new.decrypted_preview,
        new.local_search_text
      );
    END;

    CREATE TRIGGER IF NOT EXISTS emails_ad AFTER DELETE ON emails BEGIN
      INSERT INTO email_fts(
        email_fts,
        rowid,
        subject,
        from_address,
        to_addresses,
        cc_addresses,
        decrypted_preview,
        local_search_text
      )
      VALUES (
        'delete',
        old.id,
        old.subject,
        old.from_address,
        old.to_addresses,
        old.cc_addresses,
        old.decrypted_preview,
        old.local_search_text
      );
    END;

    CREATE TRIGGER IF NOT EXISTS emails_au AFTER UPDATE ON emails BEGIN
      INSERT INTO email_fts(
        email_fts,
        rowid,
        subject,
        from_address,
        to_addresses,
        cc_addresses,
        decrypted_preview,
        local_search_text
      )
      VALUES (
        'delete',
        old.id,
        old.subject,
        old.from_address,
        old.to_addresses,
        old.cc_addresses,
        old.decrypted_preview,
        old.local_search_text
      );

      INSERT INTO email_fts(
        rowid,
        subject,
        from_address,
        to_addresses,
        cc_addresses,
        decrypted_preview,
        local_search_text
      )
      VALUES (
        new.id,
        new.subject,
        new.from_address,
        new.to_addresses,
        new.cc_addresses,
        new.decrypted_preview,
        new.local_search_text
      );
    END;
  `);
    addColumnIfMissing(database, "emails", "is_unsync_encrypted", "INTEGER NOT NULL DEFAULT 0 CHECK (is_unsync_encrypted IN (0, 1))");
    addColumnIfMissing(database, "emails", "delivery_mode", "TEXT NOT NULL DEFAULT 'standard' CHECK (delivery_mode IN ('standard', 'unsync_direct', 'secure_portal'))");
    addColumnIfMissing(database, "emails", "secure_portal_id", "TEXT");
    addColumnIfMissing(database, "emails", "secure_portal_url", "TEXT");
}
function searchEmails(query, options = {}, database = getDatabase()) {
    const ftsQuery = toFtsPrefixQuery(query);
    if (!ftsQuery) {
        return [];
    }
    const limit = clampResultWindow(options.limit ?? 25);
    const offset = Math.max(0, options.offset ?? 0);
    const accountFilter = options.accountId ? "AND emails.account_id = @accountId" : "";
    const mailboxFilter = options.mailbox ? "AND emails.mailbox = @mailbox" : "";
    const statement = database.prepare(`
    SELECT
      emails.id,
      emails.account_id AS accountId,
      emails.mailbox,
      emails.subject,
      emails.from_address AS fromAddress,
      emails.from_name AS fromName,
      emails.received_at AS receivedAt,
      emails.decrypted_preview AS decryptedPreview,
      emails.is_unsync_encrypted AS isUnsyncEncrypted,
      bm25(email_fts) AS rank
    FROM email_fts
    JOIN emails ON emails.id = email_fts.rowid
    WHERE email_fts MATCH @query
      ${accountFilter}
      ${mailboxFilter}
    ORDER BY rank, emails.received_at DESC
    LIMIT @limit OFFSET @offset
  `);
    const params = {
        query: ftsQuery,
        limit,
        offset,
    };
    if (options.accountId) {
        params.accountId = options.accountId;
    }
    if (options.mailbox) {
        params.mailbox = options.mailbox;
    }
    return statement.all(params);
}
function listEmails(options = {}, database = getDatabase()) {
    if (options.offset && options.offset < 0) {
        throw new Error("offset cannot be negative.");
    }
    if (options.mailbox && options.mailbox.trim().length === 0) {
        throw new Error("mailbox cannot be empty.");
    }
    const limit = clampResultWindow(options.limit ?? 50);
    const offset = Math.max(0, options.offset ?? 0);
    const accountFilter = options.accountId ? "AND account_id = @accountId" : "";
    const mailboxFilter = options.mailbox ? "AND mailbox = @mailbox" : "";
    const statement = database.prepare(`
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
    WHERE 1=1
      ${accountFilter}
      ${mailboxFilter}
    ORDER BY received_at DESC, id DESC
    LIMIT @limit OFFSET @offset
  `);
    const params = {
        limit,
        offset,
    };
    if (options.accountId) {
        params.accountId = options.accountId;
    }
    if (options.mailbox) {
        params.mailbox = options.mailbox;
    }
    return statement.all(params);
}
function getEmailById(id, database = getDatabase()) {
    return database
        .prepare(`
      SELECT
        id,
        account_id AS accountId,
        mailbox,
        subject,
        from_address AS fromAddress,
        from_name AS fromName,
        to_addresses AS toAddresses,
        cc_addresses AS ccAddresses,
        received_at AS receivedAt,
        body_ciphertext AS bodyCiphertext,
        decrypted_preview AS decryptedPreview,
        local_search_text AS localSearchText,
        is_unsync_encrypted AS isUnsyncEncrypted
      FROM emails
      WHERE id = @id
      LIMIT 1
    `)
        .get({ id });
}
function moveEmailToMailbox(id, mailbox, database = getDatabase()) {
    const result = database
        .prepare(`
      UPDATE emails
      SET mailbox = @mailbox,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = @id
    `)
        .run({ id, mailbox });
    return result.changes > 0;
}
function updateEmailReadState(id, isRead, database = getDatabase()) {
    const row = database
        .prepare(`
      SELECT flags_json AS flagsJson
      FROM emails
      WHERE id = @id
      LIMIT 1
    `)
        .get({ id });
    if (!row) {
        return false;
    }
    const flags = parseEmailFlags(row.flagsJson);
    flags.isRead = isRead;
    const result = database
        .prepare(`
      UPDATE emails
      SET flags_json = @flagsJson,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = @id
    `)
        .run({
        id,
        flagsJson: JSON.stringify(flags),
    });
    return result.changes > 0;
}
function saveUserKey(input, database = getDatabase()) {
    return database.transaction(() => {
        database
            .prepare("UPDATE user_keys SET is_active = 0 WHERE user_id = @userId")
            .run({ userId: input.userId });
        const result = database
            .prepare(`
        INSERT INTO user_keys (
          user_id,
          key_fingerprint,
          public_key_armored,
          private_key_armored_encrypted,
          passphrase_hint,
          is_active
        )
        VALUES (
          @userId,
          @keyFingerprint,
          @publicKeyArmored,
          @privateKeyArmoredEncrypted,
          @passphraseHint,
          1
        )
      `)
            .run({
            userId: input.userId,
            keyFingerprint: input.keyFingerprint,
            publicKeyArmored: input.publicKeyArmored,
            privateKeyArmoredEncrypted: input.privateKeyArmoredEncrypted,
            passphraseHint: input.passphraseHint ?? null,
        });
        return getUserKeyById(Number(result.lastInsertRowid), database);
    })();
}
function getActiveUserKey(userId, database = getDatabase()) {
    return database
        .prepare(`
      SELECT
        id,
        user_id AS userId,
        key_fingerprint AS keyFingerprint,
        public_key_armored AS publicKeyArmored,
        private_key_armored_encrypted AS privateKeyArmoredEncrypted,
        passphrase_hint AS passphraseHint,
        is_active AS isActive,
        created_at AS createdAt,
        revoked_at AS revokedAt
      FROM user_keys
      WHERE user_id = @userId
        AND is_active = 1
        AND revoked_at IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `)
        .get({ userId });
}
function saveEmail(input, database = getDatabase()) {
    const params = {
        accountId: input.accountId,
        mailbox: input.mailbox ?? "inbox",
        providerMessageId: input.providerMessageId,
        threadId: input.threadId ?? null,
        subject: input.subject ?? "",
        fromAddress: input.fromAddress ?? "",
        fromName: input.fromName ?? null,
        toAddresses: JSON.stringify(input.toAddresses ?? []),
        ccAddresses: JSON.stringify(input.ccAddresses ?? []),
        bccAddresses: JSON.stringify(input.bccAddresses ?? []),
        sentAt: input.sentAt ?? null,
        receivedAt: input.receivedAt,
        body_ciphertext: input.bodyCiphertext, // Fixed parameter name mismatch
        decryptedPreview: input.decryptedPreview ?? "",
        localSearchText: input.localSearchText ?? "",
        isUnsyncEncrypted: input.isUnsyncEncrypted ? 1 : 0,
        deliveryMode: input.deliveryMode ?? (input.isUnsyncEncrypted ? "unsync_direct" : "standard"),
        securePortalId: input.securePortalId ?? null,
        securePortalUrl: input.securePortalUrl ?? null,
        headersJson: input.headersJson ?? "{}",
        flagsJson: input.flagsJson ?? "{}",
    };
    database
        .prepare(`
      INSERT INTO emails (
        account_id,
        mailbox,
        provider_message_id,
        thread_id,
        subject,
        from_address,
        from_name,
        to_addresses,
        cc_addresses,
        bcc_addresses,
        sent_at,
        received_at,
        body_ciphertext,
        decrypted_preview,
        local_search_text,
        is_unsync_encrypted,
        delivery_mode,
        secure_portal_id,
        secure_portal_url,
        headers_json,
        flags_json
      )
      VALUES (
        @accountId,
        @mailbox,
        @providerMessageId,
        @threadId,
        @subject,
        @fromAddress,
        @fromName,
        @toAddresses,
        @ccAddresses,
        @bccAddresses,
        @sentAt,
        @receivedAt,
        @body_ciphertext,
        @decryptedPreview,
        @localSearchText,
        @isUnsyncEncrypted,
        @deliveryMode,
        @securePortalId,
        @securePortalUrl,
        @headersJson,
        @flagsJson
      )
      ON CONFLICT (account_id, provider_message_id) DO UPDATE SET
        mailbox = excluded.mailbox,
        thread_id = excluded.thread_id,
        subject = excluded.subject,
        from_address = excluded.from_address,
        from_name = excluded.from_name,
        to_addresses = excluded.to_addresses,
        cc_addresses = excluded.cc_addresses,
        bcc_addresses = excluded.bcc_addresses,
        sent_at = excluded.sent_at,
        received_at = excluded.received_at,
        body_ciphertext = excluded.body_ciphertext,
        decrypted_preview = excluded.decrypted_preview,
        local_search_text = excluded.local_search_text,
        is_unsync_encrypted = excluded.is_unsync_encrypted,
        delivery_mode = excluded.delivery_mode,
        secure_portal_id = excluded.secure_portal_id,
        secure_portal_url = excluded.secure_portal_url,
        headers_json = excluded.headers_json,
        flags_json = excluded.flags_json,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `)
        .run(params);
    const savedEmail = database
        .prepare(`
      SELECT
        id,
        is_unsync_encrypted AS isUnsyncEncrypted
      FROM emails
      WHERE account_id = @accountId
        AND provider_message_id = @providerMessageId
    `)
        .get({
        accountId: input.accountId,
        providerMessageId: input.providerMessageId,
    });
    if (!savedEmail) {
        throw new Error("Email was not found after save.");
    }
    return savedEmail;
}
function saveSecurePortalPayload(input, database = getDatabase()) {
    const params = {
        portalId: input.portalId,
        accessToken: input.accessToken,
        senderAccountId: input.senderAccountId,
        recipientEmail: input.recipientEmail,
        encryptedPayload: input.encryptedPayload,
        portalUrl: input.portalUrl,
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
        idleTimeoutSeconds: input.idleTimeoutSeconds,
        isConsumed: input.isConsumed ? 1 : 0,
        oneTimeRead: input.oneTimeRead ?? true ? 1 : 0,
        lastAccessAt: input.lastAccessAt ?? null,
    };
    database
        .prepare(`
      INSERT INTO secure_portal_payloads (
        portal_id,
        access_token,
        sender_account_id,
        recipient_email,
        encrypted_payload,
        portal_url,
        created_at,
        expires_at,
        idle_timeout_seconds,
        is_consumed,
        one_time_read,
        last_access_at
      )
      VALUES (
        @portalId,
        @accessToken,
        @senderAccountId,
        @recipientEmail,
        @encryptedPayload,
        @portalUrl,
        @createdAt,
        @expiresAt,
        @idleTimeoutSeconds,
        @isConsumed,
        @oneTimeRead,
        @lastAccessAt
      )
      ON CONFLICT (portal_id) DO UPDATE SET
        access_token = excluded.access_token,
        sender_account_id = excluded.sender_account_id,
        recipient_email = excluded.recipient_email,
        encrypted_payload = excluded.encrypted_payload,
        portal_url = excluded.portal_url,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at,
        idle_timeout_seconds = excluded.idle_timeout_seconds,
        is_consumed = excluded.is_consumed,
        one_time_read = excluded.one_time_read,
        last_access_at = excluded.last_access_at,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `)
        .run(params);
}
function getContactPublicKey(emailAddress, database = getDatabase()) {
    return database
        .prepare(`
      SELECT public_key_armored AS publicKeyArmored
        FROM contacts
       WHERE lower(email_address) = lower(@emailAddress)
         AND public_key_armored IS NOT NULL
         AND trust_state = 'trusted'
       LIMIT 1
    `)
        .get({ emailAddress })?.publicKeyArmored;
}
function saveContactPublicKey(input, database = getDatabase()) {
    const params = {
        emailAddress: input.emailAddress,
        displayName: input.displayName ?? null,
        publicKeyArmored: input.publicKeyArmored,
        keyFingerprint: input.keyFingerprint ?? null,
        trustState: input.trustState ?? "unknown",
    };
    database
        .prepare(`
      INSERT INTO contacts (
        email_address,
        display_name,
        public_key_armored,
        key_fingerprint,
        trust_state
      )
      VALUES (
        @emailAddress,
        @displayName,
        @publicKeyArmored,
        @keyFingerprint,
        @trustState
      )
      ON CONFLICT (email_address) DO UPDATE SET
        display_name = coalesce(excluded.display_name, contacts.display_name),
        public_key_armored = excluded.public_key_armored,
        key_fingerprint = excluded.key_fingerprint,
        trust_state = excluded.trust_state,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `)
        .run(params);
}
function saveMailAccount(input, database = getDatabase()) {
    validatePort(input.imapPort, "imapPort");
    validatePort(input.smtpPort, "smtpPort");
    const params = {
        emailAddress: input.emailAddress.trim().toLowerCase(),
        imapHost: input.imapHost.trim(),
        imapPort: input.imapPort,
        smtpHost: input.smtpHost.trim(),
        smtpPort: input.smtpPort,
        appPassword: input.appPassword,
    };
    if (!params.emailAddress || !params.imapHost || !params.smtpHost || !params.appPassword) {
        throw new Error("Mail account settings cannot contain empty fields.");
    }
    database
        .prepare(`
      INSERT INTO mail_accounts (
        email_address,
        imap_host,
        imap_port,
        smtp_host,
        smtp_port,
        app_password
      )
      VALUES (
        @emailAddress,
        @imapHost,
        @imapPort,
        @smtpHost,
        @smtpPort,
        @appPassword
      )
      ON CONFLICT (email_address) DO UPDATE SET
        imap_host = excluded.imap_host,
        imap_port = excluded.imap_port,
        smtp_host = excluded.smtp_host,
        smtp_port = excluded.smtp_port,
        app_password = excluded.app_password,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `)
        .run(params);
    const account = getMailAccountByEmail(params.emailAddress, database);
    if (!account) {
        throw new Error("Mail account was not found after save.");
    }
    return account;
}
function getMailAccountByEmail(emailAddress, database = getDatabase()) {
    return database
        .prepare(`
      SELECT
        id,
        email_address AS emailAddress,
        imap_host AS imapHost,
        imap_port AS imapPort,
        smtp_host AS smtpHost,
        smtp_port AS smtpPort,
        app_password AS appPassword,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM mail_accounts
      WHERE email_address = @emailAddress
      LIMIT 1
    `)
        .get({ emailAddress });
}
function listMailAccounts(database = getDatabase()) {
    return database
        .prepare(`
      SELECT
        id,
        email_address AS emailAddress,
        imap_host AS imapHost,
        imap_port AS imapPort,
        smtp_host AS smtpHost,
        smtp_port AS smtpPort,
        app_password AS appPassword,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM mail_accounts
      ORDER BY created_at ASC
    `)
        .all();
}
function deleteMailAccount(emailAddress, database = getDatabase()) {
    database.transaction(() => {
        // Emails are scoped to account_id which equals emailAddress
        database
            .prepare("DELETE FROM emails WHERE account_id = @emailAddress")
            .run({ emailAddress });
        database
            .prepare("DELETE FROM mail_accounts WHERE email_address = @emailAddress")
            .run({ emailAddress });
    })();
}
function getMailAccount(database = getDatabase()) {
    return database
        .prepare(`
      SELECT
        id,
        email_address AS emailAddress,
        imap_host AS imapHost,
        imap_port AS imapPort,
        smtp_host AS smtpHost,
        smtp_port AS smtpPort,
        app_password AS appPassword,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM mail_accounts
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `)
        .get();
}
function configureDatabase(database) {
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
}
function toFtsPrefixQuery(query) {
    return query
        .trim()
        .split(/\s+/)
        .map((token) => token.replace(/"/g, '""').trim()) // Fixed string escaping typo here
        .filter((token) => token.length > 0)
        .map((token) => `"${token}"*`)
        .join(" ");
}
function clampResultWindow(value) {
    if (!Number.isFinite(value)) {
        return 25;
    }
    return Math.min(Math.max(Math.floor(value), 1), 100);
}
function parseEmailFlags(value) {
    try {
        const parsed = JSON.parse(value || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed;
        }
    }
    catch {
        // Corrupt flags should not block mailbox actions.
    }
    return {};
}
function validatePort(port, label) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`${label} must be a valid TCP port.`);
    }
}
function addColumnIfMissing(database, tableName, columnName, definition) {
    const existingColumns = database
        .prepare(`PRAGMA table_info(${tableName})`)
        .all();
    if (!existingColumns.some((column) => column.name === columnName)) {
        database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
}
function getUserKeyById(id, database) {
    const userKey = database
        .prepare(`
      SELECT
        id,
        user_id AS userId,
        key_fingerprint AS keyFingerprint,
        public_key_armored AS publicKeyArmored,
        private_key_armored_encrypted AS privateKeyArmoredEncrypted,
        passphrase_hint AS passphraseHint,
        is_active AS isActive,
        created_at AS createdAt,
        revoked_at AS revokedAt
      FROM user_keys
      WHERE id = @id
    `)
        .get({ id });
    if (!userKey) {
        throw new Error(`User key ${id} was not found after insert.`);
    }
    return userKey;
}
//# sourceMappingURL=db.js.map