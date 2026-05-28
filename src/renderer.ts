const rendererProcess =
  typeof process === "undefined" ? undefined : process;
const osPlatform =
  rendererProcess?.platform === "darwin" || navigator.userAgent.includes("Mac")
    ? "mac"
    : rendererProcess?.platform === "win32" || navigator.userAgent.includes("Win")
      ? "win"
      : "linux";
document.documentElement.classList.add(`os-${osPlatform}`);

type MailAccountSettings = {
  emailAddress: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  appPassword: string;
};

type UnsyncEmailListItem = {
  id: number;
  mailbox: string;
  subject: string;
  fromAddress: string;
  fromName: string | null;
  receivedAt: string;
  decryptedPreview: string;
  isUnsyncEncrypted: 0 | 1;
};

type UnsyncEmailReadModel = UnsyncEmailListItem & {
  accountId: string;
  toAddresses: string;
  ccAddresses: string;
  localSearchText: string;
  bodyContent: string;
  bodyContentType: "html" | "text";
};

type SyncStatusEvent = {
  state: "syncing" | "synced" | "error";
  message: string;
  fetched?: number;
  saved?: number;
  encrypted?: number;
};

type ComposeMailRequest = {
  fromAccountEmail?: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  attachments?: MailAttachment[];
  useUnsyncShield: boolean;
};

type SendMailResponse =
  | {
      ok: true;
      shielded: boolean;
      deliveryMode: "standard" | "unsync_direct" | "secure_portal";
      portal?: SecurePortalSendInfo;
    }
  | { ok: false; error: ComposeSendError };

type SecurePortalSendInfo = {
  portalId: string;
  portalUrl: string;
  recipientEmail: string;
  missingRecipientEmails: string[];
  expiresAt: string;
  idleTimeoutSeconds: number;
};

type ComposeSendError = {
  code: "MISSING_RECIPIENT_PUBLIC_KEY" | "SECURE_PORTAL_UPLOAD_FAILED";
  recipientEmail?: string;
  message: string;
};

type MailAttachment = {
  filename: string;
  path: string;
};

type FolderKey = "inbox" | "sent" | "outbox" | "drafts" | "archive" | "spam" | "trash";

type MyDayTask = {
  id: number;
  text: string;
  completed: boolean;
};

type UnsyncPreloadApi = {
  listEmails(options?: { accountId?: string; mailbox?: string; query?: string }): Promise<UnsyncEmailListItem[]>;
  getFolderEmails(folderName: string, accountEmail?: string, query?: string): Promise<UnsyncEmailListItem[]>;
  getEmail(id: number): Promise<UnsyncEmailReadModel>;
  decryptEmail(input: { id: number; passphrase: string; userId?: string }): Promise<string>;
  generateUserKey(input: unknown): Promise<unknown>;
  generateSafetyNumber(firstPublicKeyArmored: string, secondPublicKeyArmored: string): Promise<string>;
  listAccounts(): Promise<MailAccountSettings[]>;
  saveAccount(input: MailAccountSettings): Promise<MailAccountSettings[]>;
  deleteAccount(emailAddress: string): Promise<void>;
  syncNow(accountEmail?: string): Promise<SyncStatusEvent>;
  sendMail(input: ComposeMailRequest): Promise<SendMailResponse>;
  selectAttachments(): Promise<MailAttachment[]>;
  setReaderContent(html: string): Promise<boolean>;
  moveEmailToFolder(emailId: number, folderKey: "trash" | "spam" | "archive"): Promise<boolean>;
  deleteEmailToTrash(emailId: number): Promise<boolean>;
  reportEmailSpam(emailId: number): Promise<boolean>;
  archiveEmail(emailId: number): Promise<boolean>;
  markEmailRead(emailId: number, isRead: boolean): Promise<boolean>;
  onMailboxUpdated(callback: () => void): () => unknown;
  onSyncStatus(callback: (event: SyncStatusEvent) => void): () => unknown;
};

type UnsyncWindow = Window & {
  unsync?: UnsyncPreloadApi;
};

const appWindow = window as UnsyncWindow;

const folderButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>("[data-mailbox]"),
);
const sidebarFolderButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".sidebar-folders [data-folder]"),
);
const messageList = getElement<HTMLDivElement>("message-list");
const emptyState = getElement<HTMLDivElement>("empty-state");
const feedTitle = getElement<HTMLHeadingElement>("feed-title");
const readerPane = getElement<HTMLElement>("reader-pane");
const readerSubject = getElement<HTMLHeadingElement>("reader-subject");
const readerSenderAvatar = getElement<HTMLDivElement>("reader-sender-avatar");
const metaExactFrom = getElement<HTMLSpanElement>("meta-exact-from");
const metaExactTo = getElement<HTMLSpanElement>("meta-exact-to");
const metaExactDate = getElement<HTMLSpanElement>("meta-exact-date");
const readerIframe = getElement<HTMLIFrameElement>("reader-iframe");
const iframeThemeToggle = getElement<HTMLInputElement>("iframe-theme-toggle");
const masterSelect = getElement<HTMLInputElement>("master-select-all");
const headerJumpButton = getElement<HTMLButtonElement>("btn-hdr-jump");
const headerFilterButton = getElement<HTMLButtonElement>("btn-hdr-filter");
const headerSortButton = getElement<HTMLButtonElement>("btn-hdr-sort");
const replyButton = getElement<HTMLButtonElement>("btn-reply");
const replyAllButton = getElement<HTMLButtonElement>("btn-reply-all");
const forwardButton = getElement<HTMLButtonElement>("btn-forward");
const deleteButton = getElement<HTMLButtonElement>("btn-delete");
const spamButton = getElement<HTMLButtonElement>("btn-spam");
const moreMenuButton = getElement<HTMLButtonElement>("btn-more-menu");
const shieldBadge = getElement<HTMLDivElement>("shield-badge");
const accountSelector = getElement<HTMLSelectElement>("account-selector");
const searchInput = getElement<HTMLInputElement>("global-search");
const passphraseDialog = getElement<HTMLDialogElement>("passphrase-dialog");
const passphraseForm = getElement<HTMLFormElement>("passphrase-form");
const passphraseInput = getElement<HTMLInputElement>("passphrase-input");
const passphraseError = getElement<HTMLParagraphElement>("passphrase-error");
const cancelDecrypt = getElement<HTMLButtonElement>("cancel-decrypt");
const statusText = getElement<HTMLDivElement>("status-text");
const settingsButton = getElement<HTMLButtonElement>("sidebar-gear");
const notificationsButton = getElement<HTMLButtonElement>("btn-notifications");
const settingsModal = getElement<HTMLDialogElement>("settings-modal");
const settingsForm = getElement<HTMLFormElement>("settings-form");
const closeSettings = getElement<HTMLButtonElement>("close-settings");
const gmailDefaults = getElement<HTMLButtonElement>("gmail-defaults");
const settingsError = getElement<HTMLParagraphElement>("settings-error");
const accountEmail = getElement<HTMLInputElement>("account-email");
const accountPassword = getElement<HTMLInputElement>("account-password");
const imapHost = getElement<HTMLInputElement>("imap-host");
const imapPort = getElement<HTMLInputElement>("imap-port");
const smtpHost = getElement<HTMLInputElement>("smtp-host");
const smtpPort = getElement<HTMLInputElement>("smtp-port");
const composeButton = getElement<HTMLButtonElement>("compose-button");
const refreshButton = getElement<HTMLButtonElement>("refresh-button");
const composeModal = getElement<HTMLDialogElement>("compose-modal");
const composeForm = getElement<HTMLFormElement>("compose-form");
const closeCompose = getElement<HTMLButtonElement>("close-compose");
const cancelCompose = getElement<HTMLButtonElement>("cancel-compose");
const sendCompose = getElement<HTMLButtonElement>("send-compose");
const composeTo = getElement<HTMLInputElement>("compose-to");
const composeCc = getElement<HTMLInputElement>("compose-cc");
const composeBcc = getElement<HTMLInputElement>("compose-bcc");
const composeSubject = getElement<HTMLInputElement>("compose-subject");
const composeBody = getElement<HTMLTextAreaElement>("compose-body");
const composeShield = getElement<HTMLInputElement>("compose-shield");
const attachFileButton = getElement<HTMLButtonElement>("attach-file-button");
const attachmentList = getElement<HTMLUListElement>("attachment-list");
const composeError = getElement<HTMLParagraphElement>("compose-error");
const toast = getElement<HTMLDivElement>("toast");
const customContextMenu = getElement<HTMLDivElement>("custom-context-menu");
const ctxMarkRead = getElement<HTMLDivElement>("ctx-mark-read");
const ctxMarkUnread = getElement<HTMLDivElement>("ctx-mark-unread");
const ctxDelete = getElement<HTMLDivElement>("ctx-delete");
const ctxArchive = getElement<HTMLDivElement>("ctx-archive");
const ctxSpam = getElement<HTMLDivElement>("ctx-spam");
const readerMoreMenu = getElement<HTMLDivElement>("reader-more-menu");
const readerMoreMarkUnread = getElement<HTMLDivElement>("reader-more-mark-unread");
const readerMoreMarkRead = getElement<HTMLDivElement>("reader-more-mark-read");
const readerMoreArchive = getElement<HTMLDivElement>("reader-more-archive");
const readerMoreTrash = getElement<HTMLDivElement>("reader-more-trash");
const calendarMonthYear = getElement<HTMLSpanElement>("calendar-month-year");
const calendarDaysGrid = getElement<HTMLDivElement>("calendar-days-grid");
const todoNewItem = getElement<HTMLInputElement>("todo-new-item");
const todoAddButton = getElement<HTMLButtonElement>("todo-add-btn");
const todoListItems = getElement<HTMLUListElement>("todo-list-items");

let activeMailbox: FolderKey = "inbox";
let activeFolder = getFolderLabel(activeMailbox);
let activeAccount: string | undefined;
let activeAccountEmail: string | undefined;
let accounts: MailAccountSettings[] = [];
let activeEmailId: number | undefined;
let activeEmail: UnsyncEmailReadModel | undefined;
let activeReaderBody = "";
let pendingEncryptedEmail: UnsyncEmailReadModel | undefined;
let editingAccountEmail: string | undefined; // which account the settings modal is editing
let composeAttachments: MailAttachment[] = [];
let composeFromAccountEmail: string | undefined;
let contextMenuEmailId: number | undefined;
let nextMyDayTaskId = 1;
const myDayTasks: MyDayTask[] = [];

if (!appWindow.unsync) {
  throw new Error("Unsync preload bridge failed. Check BrowserWindow webPreferences.preload.");
}

const unsyncApi = appWindow.unsync;

unsyncApi.onMailboxUpdated(() => {
  void loadMessages();
});

unsyncApi.onSyncStatus((status) => {
  setStatus(status.message);
});

void loadAccounts();
renderSidebarCalendar();
renderMyDayTasks();

folderButtons.forEach((button) => {
  button.addEventListener("click", () => {
    activeMailbox = parseFolderKey(button.dataset.mailbox);
    activeFolder = getFolderLabel(activeMailbox);
    updateFeedTitle();
    folderButtons.forEach((item) => item.classList.remove("is-active"));
    button.classList.add("is-active");
    updateSidebarFolderActiveState();
    void loadMessages();
  });
});

sidebarFolderButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const folderKey = parseFolderKey(button.dataset.folder);
    void selectSidebarFolder(folderKey);
  });
});

accountSelector.addEventListener("change", () => {
  setActiveAccount(accountSelector.value || undefined);
  renderAccountSidebar();
  void loadMessages();
});

searchInput.addEventListener("input", () => {
  window.clearTimeout(Number(searchInput.dataset.timer));
  const timer = window.setTimeout(() => void loadMessages(), 180);
  searchInput.dataset.timer = String(timer);
});

masterSelect.addEventListener("change", () => {
  syncMessageCheckboxesToMaster();
});

headerJumpButton.addEventListener("click", () => handlePanel2HeaderAction("jump"));
headerFilterButton.addEventListener("click", () => handlePanel2HeaderAction("filter"));
headerSortButton.addEventListener("click", () => handlePanel2HeaderAction("sort"));

messageList.addEventListener("click", handleMessageControlInteraction, true);

replyButton.addEventListener("click", () => void handleReaderAction("reply"));
replyAllButton.addEventListener("click", () => void handleReaderAction("reply all"));
forwardButton.addEventListener("click", () => void handleReaderAction("forward"));
deleteButton.addEventListener("click", () => void handleReaderAction("delete"));
spamButton.addEventListener("click", () => void handleReaderAction("report spam"));
moreMenuButton.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleReaderMoreMenu();
});

iframeThemeToggle.addEventListener("change", () => {
  applyReaderIframeTheme(iframeThemeToggle.checked);
});

readerIframe.addEventListener("load", () => {
  injectReaderIframeScrollbarStyles();
  applyReaderIframeTheme(iframeThemeToggle.checked);
});

ctxMarkRead.addEventListener("click", () => void handleContextMenuAction("mark as read"));
ctxMarkUnread.addEventListener("click", () => void handleContextMenuAction("mark as unread"));
ctxDelete.addEventListener("click", () => void handleContextMenuAction("delete"));
ctxArchive.addEventListener("click", () => void handleContextMenuAction("archive"));
ctxSpam.addEventListener("click", () => void handleContextMenuAction("report spam"));
readerMoreMarkUnread.addEventListener("click", () => void handleReaderMoreAction("mark as unread"));
readerMoreMarkRead.addEventListener("click", () => void handleReaderMoreAction("mark as read"));
readerMoreArchive.addEventListener("click", () => void handleReaderMoreAction("archive"));
readerMoreTrash.addEventListener("click", () => void handleReaderMoreAction("move to trash"));

window.addEventListener("mousedown", (event) => {
  const target = event.target;

  if (
    target instanceof Node &&
    (customContextMenu.contains(target) || readerMoreMenu.contains(target) || moreMenuButton.contains(target))
  ) {
    return;
  }

  hideCustomContextMenu();
  hideReaderMoreMenu();
});

passphraseForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void decryptPendingEmail();
});

cancelDecrypt.addEventListener("click", () => {
  passphraseDialog.close();
  pendingEncryptedEmail = undefined;
});

settingsButton.addEventListener("click", () => {
  openSettingsForAccount(activeAccountEmail);
});

notificationsButton.addEventListener("click", () => {
  setStatus("No new notifications.");
});

document.getElementById("add-account-button")?.addEventListener("click", () => {
  openSettingsForAccount(undefined);
});

closeSettings.addEventListener("click", () => {
  settingsModal.close();
});

gmailDefaults.addEventListener("click", () => {
  imapHost.value = "imap.gmail.com";
  imapPort.value = "993";
  smtpHost.value = "smtp.gmail.com";
  smtpPort.value = "465";
  accountPassword.focus();
});

settingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveAccountSettings();
});

document.getElementById("delete-account-button")?.addEventListener("click", () => {
  void deleteActiveEditingAccount();
});

composeButton.addEventListener("click", () => {
  composeForm.reset();
  composeShield.checked = true;
  composeFromAccountEmail = undefined;
  composeAttachments = [];
  composeError.textContent = "";
  renderAttachmentList();
  composeModal.showModal();
  composeTo.focus();
});

refreshButton.addEventListener("click", () => {
  void refreshInbox();
});

closeCompose.addEventListener("click", () => {
  closeComposeModal();
});

cancelCompose.addEventListener("click", () => {
  closeComposeModal();
});

attachFileButton.addEventListener("click", () => {
  void attachFilesToDraft();
});

composeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendComposeDraft();
});

todoAddButton.addEventListener("click", () => {
  addTodoItem();
});

todoNewItem.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addTodoItem();
  }
});

todoListItems.addEventListener("click", (event) => {
  const checkbox = event.target;

  if (!(checkbox instanceof HTMLInputElement) || checkbox.type !== "checkbox") {
    return;
  }

  const taskId = Number(checkbox.dataset.taskId);
  const task = myDayTasks.find((item) => item.id === taskId);

  if (!task) {
    return;
  }

  task.completed = checkbox.checked;
  renderMyDayTasks();
});

async function loadMessages(): Promise<void> {
  setStatus("Loading local cache...");
  updateFeedTitle();

  try {
    const query = searchInput.value.trim();
    const messages = await unsyncApi.getFolderEmails(
      activeMailbox,
      activeAccount,
      query || undefined,
    );

    renderMessageList(messages);
    updateEmptyState(messages.length);
    setStatus(`${messages.length} cached message${messages.length === 1 ? "" : "s"}`);
  } catch (error) {
    setStatus(formatError(error));
  }
}

async function selectSidebarFolder(folderKey: FolderKey): Promise<void> {
  activeMailbox = folderKey;
  activeFolder = getFolderLabel(folderKey);
  updateFeedTitle();
  updateSidebarFolderActiveState();
  renderAccountSidebar();
  setStatus(`Loading ${activeFolder}...`);
  await loadMessages();
}

function setActiveAccount(emailAddress: string | undefined): void {
  activeAccount = emailAddress;
  activeAccountEmail = emailAddress;
  accountSelector.value = emailAddress ?? "";
}

function renderAccountSelector(): void {
  accountSelector.replaceChildren();

  const allAccountsOption = document.createElement("option");
  allAccountsOption.value = "";
  allAccountsOption.textContent = "All Accounts";
  accountSelector.append(allAccountsOption);

  for (const account of accounts) {
    const option = document.createElement("option");
    option.value = account.emailAddress;
    option.textContent = account.emailAddress;
    accountSelector.append(option);
  }

  accountSelector.value = activeAccount ?? "";
}

function renderSidebarCalendar(): void {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();
  const date = today.getDate();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  calendarMonthYear.textContent = today.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
  calendarDaysGrid.replaceChildren();

  for (let index = 0; index < firstDay; index += 1) {
    calendarDaysGrid.append(document.createElement("div"));
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const dayCell = document.createElement("div");
    const calendarDate = new Date(year, month, day);
    const isToday =
      calendarDate.getFullYear() === today.getFullYear() &&
      calendarDate.getMonth() === today.getMonth() &&
      calendarDate.getDate() === date;

    dayCell.textContent = String(day);
    dayCell.classList.toggle("is-today", isToday);
    calendarDaysGrid.append(dayCell);
  }
}

function addTodoItem(): void {
  const task = todoNewItem.value.trim();

  if (!task) {
    return;
  }

  myDayTasks.push({
    id: nextMyDayTaskId,
    text: task,
    completed: false,
  });
  nextMyDayTaskId += 1;

  todoNewItem.value = "";
  renderMyDayTasks();
}

function renderMyDayTasks(): void {
  todoListItems.replaceChildren();

  for (const task of myDayTasks) {
    const item = document.createElement("li");
    item.classList.toggle("is-complete", task.completed);

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "todo-checkbox";
    checkbox.checked = task.completed;
    checkbox.dataset.taskId = String(task.id);

    const label = document.createElement("span");
    label.className = "todo-task-text";
    label.textContent = task.text;

    item.append(checkbox, label);
    todoListItems.append(item);
  }
}

function updateSidebarFolderActiveState(): void {
  for (const button of sidebarFolderButtons) {
    const isActive = parseFolderKey(button.dataset.folder) === activeMailbox;
    button.classList.toggle("is-active", isActive);

    if (isActive) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  }
}

function parseFolderKey(value: string | undefined): FolderKey {
  const normalized = (value ?? "inbox").trim().toLowerCase();
  const folderMap: Record<string, FolderKey> = {
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

  return folderMap[normalized] ?? "inbox";
}

function getFolderLabel(folderKey: FolderKey): string {
  const folderLabels: Record<FolderKey, string> = {
    inbox: "Inbox",
    sent: "Sent",
    outbox: "Outbox",
    drafts: "Drafts",
    archive: "Archive",
    spam: "Spam/Junk",
    trash: "Trash",
  };

  return folderLabels[folderKey];
}

function updateFeedTitle(): void {
  feedTitle.textContent = activeFolder;
}

function updateEmptyState(messageCount: number): void {
  emptyState.textContent = `No messages in ${activeFolder}.`;
  emptyState.hidden = messageCount > 0;
}

async function loadAccounts(): Promise<void> {
  try {
    accounts = await unsyncApi.listAccounts();

    if (accounts.length > 0 && !activeAccount) {
      setActiveAccount(accounts[0]?.emailAddress);
    }

    renderAccountSelector();
    renderAccountSidebar();
    await loadMessages();

    if (accounts.length === 0) {
      setStatus("No accounts. Click + Add Account to get started.");
    } else {
      setStatus(`${accounts.length} account${accounts.length === 1 ? "" : "s"} loaded.`);
    }
  } catch (error) {
    setStatus(formatError(error));
  }
}

function renderAccountSidebar(): void {
  // Account selection now lives exclusively in the top-bar dropdown.
}

function openSettingsForAccount(emailAddress: string | undefined): void {
  editingAccountEmail = emailAddress;
  settingsError.textContent = "";

  const deleteBtn = document.getElementById("delete-account-button");
  const modalTitle = document.querySelector<HTMLHeadingElement>(".settings-header h2");

  if (emailAddress) {
    const account = accounts.find((a) => a.emailAddress === emailAddress);
    if (account) fillAccountForm(account);
    if (deleteBtn) deleteBtn.hidden = false;
    if (modalTitle) modalTitle.textContent = "Edit Account";
  } else {
    settingsForm.reset();
    if (deleteBtn) deleteBtn.hidden = true;
    if (modalTitle) modalTitle.textContent = "Add Account";
  }

  settingsModal.showModal();
}

async function saveAccountSettings(): Promise<void> {
  settingsError.textContent = "";

  const saveButton = settingsForm.querySelector<HTMLButtonElement>('button[type="submit"]');
  const startedAt = Date.now();

  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = "Syncing...";
  }

  const timer = window.setInterval(() => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    if (settingsError.textContent?.startsWith("Syncing") || elapsed > 2) {
      settingsError.textContent = `Syncing... ${elapsed}s`;
    }
  }, 1000);

  try {
    const input = readAccountForm();
    const updatedAccounts = await unsyncApi.saveAccount(input);

    accounts = updatedAccounts;
    setActiveAccount(input.emailAddress);
    activeMailbox = "inbox";
    activeFolder = "Inbox";
    updateSidebarFolderActiveState();
    renderAccountSelector();
    renderAccountSidebar();

    window.clearInterval(timer);
    settingsError.textContent = "Account saved.";
    settingsModal.close();
    setStatus(`Account saved: ${input.emailAddress}`);
    await loadMessages();
  } catch (error) {
    window.clearInterval(timer);
    settingsError.textContent = formatError(error);
  } finally {
    if (saveButton) {
      saveButton.disabled = false;
      saveButton.textContent = "Save Account";
    }
  }
}

async function deleteActiveEditingAccount(): Promise<void> {
  if (!editingAccountEmail) return;

  const confirmed = window.confirm(`Remove ${editingAccountEmail} and all its cached emails?`);
  if (!confirmed) return;

  try {
    await unsyncApi.deleteAccount(editingAccountEmail);
    settingsModal.close();

    accounts = accounts.filter((a) => a.emailAddress !== editingAccountEmail);

    if (activeAccount === editingAccountEmail) {
      setActiveAccount(accounts[0]?.emailAddress);
      activeMailbox = "inbox";
      activeFolder = "Inbox";
      updateSidebarFolderActiveState();
    }

    editingAccountEmail = undefined;
    renderAccountSelector();
    renderAccountSidebar();
    await loadMessages();
    setStatus("Account removed.");
  } catch (error) {
    settingsError.textContent = formatError(error);
  }
}

async function sendComposeDraft(): Promise<void> {
  composeError.textContent = "";
  setComposeLoading(true);
  setStatus("Sending message...");

  try {
    const composeDraft = readComposeForm();
    const fromAccountEmail = composeFromAccountEmail ?? activeAccountEmail;
    if (fromAccountEmail !== undefined) {
      composeDraft.fromAccountEmail = fromAccountEmail;
    }
    const result = await unsyncApi.sendMail(composeDraft);

    if (!result.ok) {
      const message = formatComposeSendError(result.error);

      composeError.textContent = message;
      setStatus(message);
      showToast(message);
      return;
    }

    if (result.deliveryMode === "secure_portal" && result.portal) {
      const message = `Secure portal message created for ${result.portal.recipientEmail}.`;

      closeComposeModal();
      setStatus(message);
      showToast(message);
      return;
    }

    const mode = result.deliveryMode === "unsync_direct" ? " with Unsync Shield" : "";

    closeComposeModal();
    setStatus(`Message sent${mode}.`);
    showToast(`Message sent${mode}.`);
  } catch (error) {
    const message = formatError(error);

    composeError.textContent = message;
    setStatus(message);
    showToast(message);
  } finally {
    setComposeLoading(false);
  }
}

async function refreshInbox(): Promise<void> {
  setRefreshLoading(true);
  setStatus("Refreshing recent inbox...");

  try {
    const status = await unsyncApi.syncNow(activeAccountEmail);

    setStatus(status.message);
    await loadMessages();
  } catch (error) {
    setStatus(formatError(error));
  } finally {
    setRefreshLoading(false);
  }
}

function renderMessageList(messages: UnsyncEmailListItem[]): void {
  messageList.replaceChildren();
  let currentDateGroup = "";

  for (const message of messages) {
    const messageDateGroup = formatDateDivider(message.receivedAt);

    if (messageDateGroup && messageDateGroup !== currentDateGroup) {
      currentDateGroup = messageDateGroup;
      const divider = document.createElement("div");
      divider.className = "email-month-divider";
      divider.textContent = messageDateGroup;
      messageList.append(divider);
    }

    const preview = normalizePreview(message.decryptedPreview || "Encrypted message");
    const card = document.createElement("div");
    card.className = "message-row";
    card.role = "button";
    card.tabIndex = 0;
    card.dataset.id = String(message.id);
    card.innerHTML = `
      <input type="checkbox" class="msg-checkbox" aria-label="Select message">
      <span class="message-unread-dot" aria-hidden="true"></span>
      <div class="message-row-main">
        <div class="message-row-top">
          <span class="message-sender">${escapeHtml(message.fromName || message.fromAddress || "Unknown sender")}</span>
          <span class="message-time">${formatDate(message.receivedAt)}</span>
        </div>
        <div class="message-subject">
          ${escapeHtml(message.subject || "(no subject)")}
          ${message.isUnsyncEncrypted ? '<span class="mini-shield">Shield</span>' : ""}
        </div>
        <div class="message-preview">${escapeHtml(preview)}</div>
      </div>
      <button class="message-star" type="button" title="Star/Flag">☆</button>
    `;
    card.addEventListener("click", (event) => {
      if (isMessageControlClick(event.target)) {
        return;
      }

      void selectEmail(message.id);
    });
    card.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }

      if (isMessageControlClick(event.target)) {
        return;
      }

      event.preventDefault();
      void selectEmail(message.id);
    });
    card.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      contextMenuEmailId = message.id;
      showCustomContextMenu(event.pageX, event.pageY);
    });
    messageList.append(card);
  }

  updateEmptyState(messages.length);
  syncMessageCheckboxesToMaster();
}

async function selectEmail(id: number): Promise<void> {
  activeEmailId = id;
  highlightActiveCard(id);
  setStatus("Opening message...");

  try {
    const email = await unsyncApi.getEmail(id);
    activeEmail = email;
    await renderReader(email, email.isUnsyncEncrypted ? "" : email.bodyContent);

    if (email.isUnsyncEncrypted === 1) {
      pendingEncryptedEmail = email;
      passphraseError.textContent = "";
      passphraseInput.value = "";
      passphraseDialog.showModal();
      passphraseInput.focus();
      setStatus("Passphrase required for local decrypt.");
      return;
    }

    setStatus("Message loaded from local cache.");
  } catch (error) {
    setStatus(formatError(error));
  }
}

async function decryptPendingEmail(): Promise<void> {
  if (!pendingEncryptedEmail) {
    return;
  }

  passphraseError.textContent = "";

  try {
    const plaintext = await unsyncApi.decryptEmail({
      id: pendingEncryptedEmail.id,
      passphrase: passphraseInput.value,
    });

    await renderReader(pendingEncryptedEmail, plaintext);
    shieldBadge.classList.add("is-illuminated");
    passphraseDialog.close();
    setStatus("Unsync Shield decrypted in memory.");
    pendingEncryptedEmail = undefined;
  } catch (error) {
    passphraseError.textContent = formatError(error);
  }
}

async function renderReader(email: UnsyncEmailReadModel, body: string): Promise<void> {
  readerPane.classList.add("has-message");
  activeEmail = email;
  activeReaderBody = body;
  readerSubject.textContent = email.subject || "(no subject)";
  readerSenderAvatar.textContent = getSenderInitial(email);
  metaExactFrom.textContent = formatSender(email);
  metaExactTo.textContent = email.accountId || "Unknown account";
  metaExactDate.textContent = email.receivedAt || "Unknown date";
  const fallbackBody = body || (email.isUnsyncEncrypted ? "Encrypted message locked." : "No body text.");
  const emailBodyPayload = buildReaderDocument(
    fallbackBody,
    email.bodyContentType === "html" && email.isUnsyncEncrypted !== 1,
  );
  const safeHtml = sanitizeEmailHtml(emailBodyPayload);
  await unsyncApi.setReaderContent(safeHtml);
  readerIframe.removeAttribute("srcdoc");
  readerIframe.src = `email-reader://view?t=${Date.now()}`;
  shieldBadge.hidden = email.isUnsyncEncrypted !== 1;
  shieldBadge.classList.toggle("is-illuminated", email.isUnsyncEncrypted === 1 && body.length > 0);
}

async function handleReaderAction(action: string): Promise<void> {
  const email = getActiveReaderEmail(action);

  if (!email) {
    return;
  }

  if (action === "reply") {
    openReplyCompose(email);
    return;
  }

  if (action === "reply all") {
    openReplyAllCompose(email);
    return;
  }

  if (action === "forward") {
    openForwardCompose(email);
    return;
  }

  if (action === "delete") {
    await moveActiveEmailToFolder("trash", "Message moved to Trash.");
    return;
  }

  if (action === "report spam") {
    await moveActiveEmailToFolder("spam", "Message reported as Spam/Junk.");
  }
}

function handlePanel2HeaderAction(action: string): void {
  console.log(`[panel2 header] ${action}`, { activeFolder, activeAccount });
  setStatus(`Panel 2 action: ${action}.`);
}

function syncMessageCheckboxesToMaster(): void {
  const checkboxes = document.querySelectorAll<HTMLInputElement>(".msg-checkbox");
  checkboxes.forEach((checkbox) => {
    checkbox.checked = masterSelect.checked;
  });
}

function showCustomContextMenu(pageX: number, pageY: number): void {
  customContextMenu.classList.remove("context-menu-hidden");
  customContextMenu.style.left = `${pageX}px`;
  customContextMenu.style.top = `${pageY}px`;
  customContextMenu.style.display = "block";
}

function hideCustomContextMenu(): void {
  customContextMenu.style.display = "none";
  customContextMenu.classList.add("context-menu-hidden");
}

async function handleContextMenuAction(action: string): Promise<void> {
  const emailId = contextMenuEmailId;

  hideCustomContextMenu();

  if (emailId === undefined) {
    setStatus(`No message selected for ${action}.`);
    return;
  }

  await runMessageAction(emailId, action);
}

async function handleReaderMoreAction(action: string): Promise<void> {
  const email = getActiveReaderEmail(action);

  hideReaderMoreMenu();

  if (!email) {
    return;
  }

  await runMessageAction(email.id, action);
}

async function runMessageAction(emailId: number, action: string): Promise<void> {
  try {
    if (action === "delete" || action === "move to trash") {
      await unsyncApi.deleteEmailToTrash(emailId);
      await afterMailboxMove(emailId, "Message moved to Trash.");
      return;
    }

    if (action === "report spam") {
      await unsyncApi.reportEmailSpam(emailId);
      await afterMailboxMove(emailId, "Message reported as Spam/Junk.");
      return;
    }

    if (action === "archive") {
      await unsyncApi.archiveEmail(emailId);
      await afterMailboxMove(emailId, "Message archived.");
      return;
    }

    if (action === "mark as read") {
      await unsyncApi.markEmailRead(emailId, true);
      setStatus("Message marked as read.");
      showToast("Message marked as read.");
      await loadMessages();
      return;
    }

    if (action === "mark as unread") {
      await unsyncApi.markEmailRead(emailId, false);
      setStatus("Message marked as unread.");
      showToast("Message marked as unread.");
      await loadMessages();
    }
  } catch (error) {
    const message = formatError(error);
    setStatus(message);
    showToast(message);
  }
}

async function moveActiveEmailToFolder(
  folderKey: "trash" | "spam" | "archive",
  successMessage: string,
): Promise<void> {
  if (activeEmailId === undefined) {
    setStatus("Select a message first.");
    return;
  }

  try {
    await unsyncApi.moveEmailToFolder(activeEmailId, folderKey);
    await afterMailboxMove(activeEmailId, successMessage);
  } catch (error) {
    const message = formatError(error);
    setStatus(message);
    showToast(message);
  }
}

async function afterMailboxMove(emailId: number, message: string): Promise<void> {
  if (activeEmailId === emailId) {
    await clearReaderPane();
  }

  await loadMessages();
  setStatus(message);
  showToast(message);
}

function getActiveReaderEmail(action: string): UnsyncEmailReadModel | undefined {
  if (!activeEmail || activeEmailId === undefined) {
    setStatus(`Select a message before using ${action}.`);
    showToast("Select a message first.");
    return undefined;
  }

  return activeEmail;
}

function openReplyCompose(email: UnsyncEmailReadModel): void {
  resetComposeForAction(email);
  composeTo.value = email.fromAddress;
  composeCc.value = "";
  composeBcc.value = "";
  composeSubject.value = normalizeReplySubject(email.subject);
  composeBody.value = quoteOriginalMessage(email);
  showComposeModal("Reply");
}

function openReplyAllCompose(email: UnsyncEmailReadModel): void {
  const currentAccount = email.accountId.toLowerCase();
  const recipients = uniqueEmailAddresses([
    email.fromAddress,
    ...parseEmailAddressList(email.toAddresses),
  ]).filter((address) => address.toLowerCase() !== currentAccount);
  const ccRecipients = uniqueEmailAddresses(parseEmailAddressList(email.ccAddresses))
    .filter((address) => address.toLowerCase() !== currentAccount);

  resetComposeForAction(email);
  composeTo.value = recipients.join(", ");
  composeCc.value = ccRecipients.join(", ");
  composeBcc.value = "";
  composeSubject.value = normalizeReplySubject(email.subject);
  composeBody.value = quoteOriginalMessage(email);
  showComposeModal("Reply All");
}

function openForwardCompose(email: UnsyncEmailReadModel): void {
  resetComposeForAction(email);
  composeTo.value = "";
  composeCc.value = "";
  composeBcc.value = "";
  composeSubject.value = normalizeForwardSubject(email.subject);
  composeBody.value = buildForwardBody(email);
  showComposeModal("Forward");
}

function resetComposeForAction(email: UnsyncEmailReadModel): void {
  composeForm.reset();
  composeShield.checked = true;
  composeAttachments = [];
  composeFromAccountEmail = email.accountId;
  composeError.textContent = "";
  renderAttachmentList();
}

function showComposeModal(mode: string): void {
  const kicker = document.querySelector<HTMLElement>(".compose-kicker");
  const title = document.querySelector<HTMLHeadingElement>(".compose-header h2");

  if (kicker) {
    kicker.textContent = mode;
  }

  if (title) {
    title.textContent = `${mode} Email`;
  }

  composeModal.showModal();
  composeBody.focus();
  composeBody.setSelectionRange(0, 0);
  setStatus(`${mode} draft ready.`);
}

function quoteOriginalMessage(email: UnsyncEmailReadModel): string {
  const body = getPlainOriginalBody(email);
  const quotedBody = body
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");

  return `\n\nOn ${email.receivedAt || "unknown date"}, ${formatSender(email)} wrote:\n${quotedBody}`;
}

function buildForwardBody(email: UnsyncEmailReadModel): string {
  return [
    "",
    "",
    "---------- Forwarded message ---------",
    `From: ${formatSender(email)}`,
    `Date: ${email.receivedAt || "Unknown date"}`,
    `Subject: ${email.subject || "(no subject)"}`,
    `To: ${parseEmailAddressList(email.toAddresses).join(", ") || email.accountId}`,
    "",
    getPlainOriginalBody(email),
  ].join("\n");
}

function getPlainOriginalBody(email: UnsyncEmailReadModel): string {
  const body = activeReaderBody || email.localSearchText || email.decryptedPreview || "";
  const plainBody = email.bodyContentType === "html" ? htmlToPlainText(body) : body;

  return plainBody.trim() || "No body text.";
}

function normalizeReplySubject(subject: string): string {
  const normalized = subject.trim() || "(no subject)";
  return /^re:/i.test(normalized) ? normalized : `Re: ${normalized}`;
}

function normalizeForwardSubject(subject: string): string {
  const normalized = subject.trim() || "(no subject)";
  return /^fwd:/i.test(normalized) ? normalized : `Fwd: ${normalized}`;
}

function parseEmailAddressList(value: string): string[] {
  try {
    const parsed = JSON.parse(value || "[]");

    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
    }
  } catch {
    // Fall through to comma splitting for older cached data.
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueEmailAddresses(addresses: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const address of addresses) {
    const key = address.toLowerCase();

    if (!address || seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(address);
  }

  return unique;
}

function htmlToPlainText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.body.textContent?.replace(/\n{3,}/g, "\n\n") ?? "";
}

async function clearReaderPane(): Promise<void> {
  activeEmailId = undefined;
  activeEmail = undefined;
  activeReaderBody = "";
  pendingEncryptedEmail = undefined;
  readerPane.classList.remove("has-message");
  readerSubject.textContent = "Select a message";
  readerSenderAvatar.textContent = "?";
  metaExactFrom.textContent = "Unknown sender";
  metaExactTo.textContent = "Unknown account";
  metaExactDate.textContent = "Unknown date";
  shieldBadge.hidden = true;
  shieldBadge.classList.remove("is-illuminated");
  highlightActiveCard(-1);
  await unsyncApi.setReaderContent("<!doctype html><html><body></body></html>");
  readerIframe.removeAttribute("srcdoc");
  readerIframe.src = `email-reader://view?t=${Date.now()}`;
}

function toggleReaderMoreMenu(): void {
  if (readerMoreMenu.style.display === "block") {
    hideReaderMoreMenu();
    return;
  }

  const rect = moreMenuButton.getBoundingClientRect();
  readerMoreMenu.classList.remove("context-menu-hidden");
  readerMoreMenu.style.left = `${Math.max(8, rect.right - 168)}px`;
  readerMoreMenu.style.top = `${rect.bottom + 6}px`;
  readerMoreMenu.style.display = "block";
}

function hideReaderMoreMenu(): void {
  readerMoreMenu.style.display = "none";
  readerMoreMenu.classList.add("context-menu-hidden");
}

function handleMessageControlInteraction(event: MouseEvent): void {
  const target = event.target;

  if (!(target instanceof Element)) {
    return;
  }

  const checkbox = target.closest<HTMLInputElement>(".msg-checkbox");
  const starButton = target.closest<HTMLButtonElement>(".message-star");

  if (!checkbox && !starButton) {
    return;
  }

  event.stopPropagation();
  event.stopImmediatePropagation();

  if (starButton) {
    starButton.classList.toggle("star-active");
    return;
  }
}

function isMessageControlClick(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(".msg-checkbox, .message-star"));
}

function injectReaderIframeScrollbarStyles(): void {
  try {
    const iframeDocument = readerIframe.contentDocument || readerIframe.contentWindow?.document;

    if (!iframeDocument?.head || iframeDocument.getElementById("reader-scrollbar-theme")) {
      return;
    }

    const style = iframeDocument.createElement("style");
    style.id = "reader-scrollbar-theme";
    style.textContent = `
      :root { color-scheme: dark !important; background-color: #111111 !important; }
      html { background-color: #111111 !important; color: #ffffff !important; }
      ::-webkit-scrollbar { width: 8px !important; height: 8px !important; }
      ::-webkit-scrollbar-track { background: #111111 !important; }
      ::-webkit-scrollbar-thumb { background: #333333 !important; border-radius: 0px !important; }
      body { background-color: #111111 !important; color: #ffffff !important; }
    `;
    iframeDocument.head.append(style);
  } catch (error) {
    console.warn("Unable to inject reader iframe scrollbar styles.", error);
  }
}

function applyReaderIframeTheme(useDarkView: boolean): void {
  try {
    const iframeDocument = readerIframe.contentDocument;
    const iframeBody = iframeDocument?.body;

    if (!iframeBody) {
      return;
    }

    iframeDocument.documentElement.style.backgroundColor = useDarkView ? "#050505" : "";
    iframeBody.style.backgroundColor = useDarkView ? "#050505" : "";
    iframeBody.style.color = useDarkView ? "#f2f2f2" : "";
    iframeBody.style.filter = useDarkView ? "invert(1) hue-rotate(180deg)" : "";
  } catch (error) {
    console.warn("Unable to apply reader iframe theme.", error);
  }
}

function highlightActiveCard(id: number): void {
  for (const card of messageList.querySelectorAll<HTMLElement>(".message-row")) {
    card.classList.toggle("is-selected", card.dataset.id === String(id));
  }
}

function setStatus(message: string): void {
  statusText.textContent = message;
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`Missing #${id}`);
  }

  return element as T;
}

function formatDate(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatDateDivider(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startOfMessageDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayOffset = Math.round(
    (startOfToday.getTime() - startOfMessageDate.getTime()) / 86_400_000,
  );

  if (dayOffset === 0) {
    return "Today";
  }

  if (dayOffset === 1) {
    return "Yesterday";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function formatSender(email: UnsyncEmailReadModel): string {
  if (email.fromName && email.fromAddress) {
    return `${email.fromName} [${email.fromAddress}]`;
  }

  if (email.fromAddress) {
    return `[${email.fromAddress}]`;
  }

  return email.fromName || "Unknown sender";
}

function getSenderInitial(email: UnsyncEmailReadModel): string {
  const value = email.fromName || email.fromAddress || "?";
  return value.trim().charAt(0).toUpperCase() || "?";
}

function normalizePreview(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatComposeSendError(error: ComposeSendError): string {
  if (error.code === "MISSING_RECIPIENT_PUBLIC_KEY" && error.recipientEmail) {
    return `Unsync Shield cannot directly encrypt for ${error.recipientEmail}. Secure web-reader fallback is not available yet.`;
  }

  return error.message;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fillAccountForm(account: MailAccountSettings): void {
  accountEmail.value = account.emailAddress;
  imapHost.value = account.imapHost;
  imapPort.value = String(account.imapPort);
  smtpHost.value = account.smtpHost;
  smtpPort.value = String(account.smtpPort);
  accountPassword.value = account.appPassword;
}

function readAccountForm(): MailAccountSettings {
  return {
    emailAddress: accountEmail.value.trim(),
    imapHost: imapHost.value.trim(),
    imapPort: readPort(imapPort.value, "IMAP Port"),
    smtpHost: smtpHost.value.trim(),
    smtpPort: readPort(smtpPort.value, "SMTP Port"),
    appPassword: accountPassword.value,
  };
}

function readPort(value: string, label: string): number {
  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be a valid TCP port.`);
  }

  return port;
}

function readComposeForm(): ComposeMailRequest {
  return {
    to: composeTo.value.trim(),
    cc: composeCc.value.trim(),
    bcc: composeBcc.value.trim(),
    subject: composeSubject.value.trim(),
    body: composeBody.value,
    attachments: composeAttachments,
    useUnsyncShield: composeShield.checked,
  };
}

function closeComposeModal(): void {
  composeModal.close();
  composeForm.reset();
  composeAttachments = [];
  composeFromAccountEmail = undefined;
  renderAttachmentList();
  composeError.textContent = "";
  const kicker = document.querySelector<HTMLElement>(".compose-kicker");
  const title = document.querySelector<HTMLHeadingElement>(".compose-header h2");

  if (kicker) {
    kicker.textContent = "New Message";
  }

  if (title) {
    title.textContent = "Compose Email";
  }
}

function setComposeLoading(isLoading: boolean): void {
  sendCompose.disabled = isLoading;
  cancelCompose.disabled = isLoading;
  closeCompose.disabled = isLoading;
  attachFileButton.disabled = isLoading;
  sendCompose.textContent = isLoading ? "Sending..." : "Send";
}

function setRefreshLoading(isLoading: boolean): void {
  refreshButton.disabled = isLoading;
  refreshButton.lastElementChild!.textContent = isLoading ? "Refreshing..." : "Refresh";
}

function showToast(message: string): void {
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(Number(toast.dataset.timer));
  toast.dataset.timer = String(
    window.setTimeout(() => {
      toast.hidden = true;
    }, 3200),
  );
}

async function attachFilesToDraft(): Promise<void> {
  try {
    const selectedAttachments = await unsyncApi.selectAttachments();

    for (const attachment of selectedAttachments) {
      if (!composeAttachments.some((item) => item.path === attachment.path)) {
        composeAttachments.push(attachment);
      }
    }

    renderAttachmentList();
  } catch (error) {
    const message = formatError(error);
    composeError.textContent = message;
    setStatus(message);
  }
}

function renderAttachmentList(): void {
  attachmentList.replaceChildren();

  for (const [index, attachment] of composeAttachments.entries()) {
    const item = document.createElement("li");
    item.className = "attachment-item";

    const name = document.createElement("span");
    name.className = "attachment-name";
    name.textContent = attachment.filename;
    name.title = attachment.path;

    const removeButton = document.createElement("button");
    removeButton.className = "attachment-remove";
    removeButton.type = "button";
    removeButton.setAttribute("aria-label", `Remove ${attachment.filename}`);
    removeButton.textContent = "x";
    removeButton.addEventListener("click", () => {
      composeAttachments.splice(index, 1);
      renderAttachmentList();
    });

    item.append(name, removeButton);
    attachmentList.append(item);
  }
}

function buildReaderDocument(body: string, isHtml: boolean): string {
  const content = isHtml ? body : `<pre>${escapeHtml(body)}</pre>`;
  const emailBodyPayload = content;
  const readerStyleNonce = "unsync-reader-style";

  return `<!DOCTYPE html>
<html>
  <head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${readerStyleNonce}'; img-src http: https: data:;">
    <style nonce="${readerStyleNonce}">
      html,
      body {
        margin: 0;
        min-height: 100%;
      }

      img {
        max-width: 100%;
        height: auto;
      }

      pre {
        margin: 0;
        padding: 24px;
        white-space: pre-wrap;
        word-break: break-word;
        font: 13px/1.7 ui-monospace, SFMono-Regular, Consolas, monospace;
      }
    </style>
  </head>
  <body>
    ${emailBodyPayload}
  </body>
</html>`;
}

function sanitizeEmailHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");

  doc
    .querySelectorAll(
      'script, style, iframe, object, embed, form, input, button, link[rel="stylesheet"], meta[http-equiv]',
    )
    .forEach((element) => element.remove());

  doc.querySelectorAll("*").forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const attributeName = attribute.name.toLowerCase();
      const attributeValue = attribute.value.trim().toLowerCase();

      if (attributeName.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }

      if (attributeName === "style") {
        element.removeAttribute(attribute.name);
        continue;
      }

      if (
        (attributeName === "href" || attributeName === "src") &&
        attributeValue.startsWith("javascript:")
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  });

  doc.querySelectorAll('meta[name="viewport" i]').forEach((element) => {
    const content = element.getAttribute("content");

    if (!content) {
      return;
    }

    const cleanedContent = content
      .split(",")
      .map((part) => part.trim())
      .filter((part) => !part.toLowerCase().startsWith("target-densitydpi"))
      .join(", ");

    element.setAttribute("content", cleanedContent);
  });

  return `<!doctype html>${doc.documentElement.outerHTML}`;
}
