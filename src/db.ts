import Database = require("better-sqlite3");
import fs = require("node:fs");
import os = require("node:os");
import path = require("node:path");

export const DEFAULT_DATABASE_DIR =
  process.env.UNSYNC_MAIL_DATA_DIR ??
  (process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Unsync Mail")
    : path.join(os.homedir(), ".unsync-mail"));

export const DEFAULT_DATABASE_PATH = path.join(
  DEFAULT_DATABASE_DIR,
  "unsync-mail.sqlite",
);

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
}

export interface SavedEmail {
  id: number;
  isUnsyncEncrypted: 0 | 1;
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

let activeDatabase: DatabaseConnection | undefined;

export function openDatabase(databasePath = DEFAULT_DATABASE_PATH): DatabaseConnection {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  const database = new Database(databasePath);
  configureDatabase(database);
  initializeSchema(database);

  return database;
}

export function getDatabase(databasePath = DEFAULT_DATABASE_PATH): DatabaseConnection {
  if (!activeDatabase || activeDatabase.name !== databasePath) {
    activeDatabase?.close();
    activeDatabase = openDatabase(databasePath);
  }

  return activeDatabase;
}

export function closeDatabase(): void {
  activeDatabase?.close();
  activeDatabase = undefined;
}

export function initializeSchema(database: DatabaseConnection): void {
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
      headers_json TEXT NOT NULL DEFAULT '{}',
      flags_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (account_id, provider_message_id)
    );

    CREATE INDEX IF NOT EXISTS idx_contacts_email_address
      ON contacts (email_address);

    CREATE INDEX IF NOT EXISTS idx_emails_account_mailbox_received
      ON emails (account_id, mailbox, received_at DESC);

    CREATE INDEX IF NOT EXISTS idx_emails_thread_id
      ON emails (thread_id);

    CREATE INDEX IF NOT EXISTS idx_mail_accounts_email_address
      ON mail_accounts (email_address);

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

  addColumnIfMissing(
    database,
    "emails",
    "is_unsync_encrypted",
    "INTEGER NOT NULL DEFAULT 0 CHECK (is_unsync_encrypted IN (0, 1))",
  );
}

export function searchEmails(
  query: string,
  options: EmailSearchOptions = {},
  database: DatabaseConnection = getDatabase(),
): EmailSearchResult[] {
  const ftsQuery = toFtsPrefixQuery(query);

  if (!ftsQuery) {
    return [];
  }

  const limit = clampResultWindow(options.limit ?? 25);
  const offset = Math.max(0, options.offset ?? 0);
  const accountFilter = options.accountId ? "AND emails.account_id = @accountId" : "";
  const mailboxFilter = options.mailbox ? "AND emails.mailbox = @mailbox" : "";

  const statement = database.prepare<SearchEmailParams, EmailSearchResult>(`
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

  const params: SearchEmailParams = {
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

export function listEmails(
  options: EmailSearchOptions = {},
  database: DatabaseConnection = getDatabase(),
): EmailListItem[] {
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
  const statement = database.prepare<ListEmailsParams, EmailListItem>(`
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
  const params: ListEmailsParams = {
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

export function getEmailById(
  id: number,
  database: DatabaseConnection = getDatabase(),
): EmailReadModel | undefined {
  return database
    .prepare<{ id: number }, EmailReadModel>(`
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

export function saveUserKey(
  input: SaveUserKeyInput,
  database: DatabaseConnection = getDatabase(),
): StoredUserKey {
  return database.transaction(() => {
    database
      .prepare<{ userId: string }, void>(
        "UPDATE user_keys SET is_active = 0 WHERE user_id = @userId",
      )
      .run({ userId: input.userId });

    const result = database
      .prepare<SaveUserKeyParams, void>(`
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

export function getActiveUserKey(
  userId: string,
  database: DatabaseConnection = getDatabase(),
): StoredUserKey | undefined {
  return database
    .prepare<{ userId: string }, StoredUserKey>(`
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

export function saveEmail(
  input: SaveEmailInput,
  database: DatabaseConnection = getDatabase(),
): SavedEmail {
  const params: SaveEmailParams = {
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
    headersJson: input.headersJson ?? "{}",
    flagsJson: input.flagsJson ?? "{}",
  };

  database
    .prepare<SaveEmailParams, void>(`
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
        headers_json = excluded.headers_json,
        flags_json = excluded.flags_json,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `)
    .run(params);

  const savedEmail = database
    .prepare<
      { accountId: string; providerMessageId: string },
      SavedEmail
    >(`
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

export function getContactPublicKey(
  emailAddress: string,
  database: DatabaseConnection = getDatabase(),
): string | undefined {
  return database
    .prepare<{ emailAddress: string }, { publicKeyArmored: string }>(`
      SELECT public_key_armored AS publicKeyArmored
        FROM contacts
       WHERE lower(email_address) = lower(@emailAddress)
         AND public_key_armored IS NOT NULL
         AND trust_state != 'blocked'
       LIMIT 1
    `)
    .get({ emailAddress })?.publicKeyArmored;
}

export function saveContactPublicKey(
  input: SaveContactPublicKeyInput,
  database: DatabaseConnection = getDatabase(),
): void {
  const params: SaveContactPublicKeyParams = {
    emailAddress: input.emailAddress,
    displayName: input.displayName ?? null,
    publicKeyArmored: input.publicKeyArmored,
    keyFingerprint: input.keyFingerprint ?? null,
    trustState: input.trustState ?? "unknown",
  };

  database
    .prepare<SaveContactPublicKeyParams, void>(`
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

export function saveMailAccount(
  input: SaveMailAccountInput,
  database: DatabaseConnection = getDatabase(),
): StoredMailAccount {
  validatePort(input.imapPort, "imapPort");
  validatePort(input.smtpPort, "smtpPort");

  const params: SaveMailAccountParams = {
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
    .prepare<SaveMailAccountParams>(`
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

export function getMailAccountByEmail(
  emailAddress: string,
  database: DatabaseConnection = getDatabase(),
): StoredMailAccount | undefined {
  return database
    .prepare<{ emailAddress: string }, StoredMailAccount>(`
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

export function listMailAccounts(
  database: DatabaseConnection = getDatabase(),
): StoredMailAccount[] {
  return database
    .prepare<[], StoredMailAccount>(`
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

export function deleteMailAccount(
  emailAddress: string,
  database: DatabaseConnection = getDatabase(),
): void {
  database.transaction(() => {
    // Emails are scoped to account_id which equals emailAddress
    database
      .prepare<{ emailAddress: string }>(
        "DELETE FROM emails WHERE account_id = @emailAddress",
      )
      .run({ emailAddress });
    database
      .prepare<{ emailAddress: string }>(
        "DELETE FROM mail_accounts WHERE email_address = @emailAddress",
      )
      .run({ emailAddress });
  })();
}

export function getMailAccount(
  database: DatabaseConnection = getDatabase(),
): StoredMailAccount | undefined {
  return database
    .prepare<[], StoredMailAccount>(`
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

function configureDatabase(database: DatabaseConnection): void {
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
}

function toFtsPrefixQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/"/g, '""').trim()) // Fixed string escaping typo here
    .filter((token) => token.length > 0)
    .map((token) => `"${token}"*`)
    .join(" ");
}

function clampResultWindow(value: number): number {
  if (!Number.isFinite(value)) {
    return 25;
  }

  return Math.min(Math.max(Math.floor(value), 1), 100);
}

interface SearchEmailParams {
  query: string;
  accountId?: string;
  mailbox?: string;
  limit: number;
  offset: number;
}

interface ListEmailsParams {
  accountId?: string;
  mailbox?: string;
  limit: number;
  offset: number;
}

interface SaveUserKeyParams {
  userId: string;
  keyFingerprint: string;
  publicKeyArmored: string;
  privateKeyArmoredEncrypted: string;
  passphraseHint: string | null;
}

interface SaveEmailParams {
  accountId: string;
  mailbox: string;
  providerMessageId: string;
  threadId: string | null;
  subject: string;
  fromAddress: string;
  fromName: string | null;
  toAddresses: string;
  ccAddresses: string;
  bccAddresses: string;
  sentAt: string | null;
  receivedAt: string;
  body_ciphertext: string; // Matched snake_case parameters to bypass runtime mismatches 
  decryptedPreview: string;
  localSearchText: string;
  isUnsyncEncrypted: 0 | 1;
  headersJson: string;
  flagsJson: string;
}

interface SaveContactPublicKeyParams {
  emailAddress: string;
  displayName: string | null;
  publicKeyArmored: string;
  keyFingerprint: string | null;
  trustState: "unknown" | "trusted" | "blocked";
}

interface SaveMailAccountParams {
  emailAddress: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  appPassword: string;
}

function validatePort(port: number, label: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be a valid TCP port.`);
  }
}

function addColumnIfMissing(
  database: DatabaseConnection,
  tableName: string,
  columnName: string,
  definition: string,
): void {
  const existingColumns = database
    .prepare<[], { name: string }>(`PRAGMA table_info(${tableName})`)
    .all();

  if (!existingColumns.some((column) => column.name === columnName)) {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function getUserKeyById(
  id: number,
  database: DatabaseConnection,
): StoredUserKey {
  const userKey = database
    .prepare<{ id: number }, StoredUserKey>(`
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
