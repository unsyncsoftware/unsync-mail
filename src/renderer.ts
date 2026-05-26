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

type MailAttachment = {
  filename: string;
  path: string;
};

type MyDayTask = {
  id: number;
  text: string;
  completed: boolean;
};

type UnsyncPreloadApi = {
  listEmails(options?: { accountId?: string; mailbox?: string; query?: string }): Promise<UnsyncEmailListItem[]>;
  getFolderEmails(folderName: string, accountEmail?: string): Promise<UnsyncEmailListItem[]>;
  getEmail(id: number): Promise<UnsyncEmailReadModel>;
  decryptEmail(input: { id: number; passphrase: string; userId?: string }): Promise<string>;
  generateUserKey(input: unknown): Promise<unknown>;
  generateSafetyNumber(firstPublicKeyArmored: string, secondPublicKeyArmored: string): Promise<string>;
  listAccounts(): Promise<MailAccountSettings[]>;
  saveAccount(input: MailAccountSettings): Promise<MailAccountSettings[]>;
  deleteAccount(emailAddress: string): Promise<void>;
  syncNow(accountEmail?: string): Promise<SyncStatusEvent>;
  sendMail(input: ComposeMailRequest): Promise<{ shielded: boolean }>;
  selectAttachments(): Promise<MailAttachment[]>;
  setReaderContent(html: string): Promise<boolean>;
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
const readerPane = getElement<HTMLElement>("reader-pane");
const readerSubject = getElement<HTMLHeadingElement>("reader-subject");
const metaExactFrom = getElement<HTMLSpanElement>("meta-exact-from");
const metaExactTo = getElement<HTMLSpanElement>("meta-exact-to");
const metaExactDate = getElement<HTMLSpanElement>("meta-exact-date");
const readerIframe = getElement<HTMLIFrameElement>("reader-iframe");
const iframeThemeToggle = getElement<HTMLInputElement>("iframe-theme-toggle");
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
const calendarMonthYear = getElement<HTMLSpanElement>("calendar-month-year");
const calendarDaysGrid = getElement<HTMLDivElement>("calendar-days-grid");
const todoNewItem = getElement<HTMLInputElement>("todo-new-item");
const todoAddButton = getElement<HTMLButtonElement>("todo-add-btn");
const todoListItems = getElement<HTMLUListElement>("todo-list-items");

let activeMailbox = "inbox";
let activeFolder = "Inbox";
let activeAccount: string | undefined;
let activeAccountEmail: string | undefined;
let accounts: MailAccountSettings[] = [];
let activeEmailId: number | undefined;
let pendingEncryptedEmail: UnsyncEmailReadModel | undefined;
let editingAccountEmail: string | undefined; // which account the settings modal is editing
let composeAttachments: MailAttachment[] = [];
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
    activeMailbox = button.dataset.mailbox ?? "inbox";
    activeFolder = mailboxToFolderName(activeMailbox);
    folderButtons.forEach((item) => item.classList.remove("is-active"));
    button.classList.add("is-active");
    updateSidebarFolderActiveState();
    void loadMessages();
  });
});

sidebarFolderButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const folderName = button.dataset.folder ?? "Inbox";
    void selectSidebarFolder(folderName);
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

replyButton.addEventListener("click", () => handleReaderAction("reply"));
replyAllButton.addEventListener("click", () => handleReaderAction("reply all"));
forwardButton.addEventListener("click", () => handleReaderAction("forward"));
deleteButton.addEventListener("click", () => handleReaderAction("delete"));
spamButton.addEventListener("click", () => handleReaderAction("report spam"));
moreMenuButton.addEventListener("click", () => handleReaderAction("more menu"));

iframeThemeToggle.addEventListener("change", () => {
  applyReaderIframeTheme(iframeThemeToggle.checked);
});

readerIframe.addEventListener("load", () => {
  applyReaderIframeTheme(iframeThemeToggle.checked);
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

  try {
    const query = searchInput.value.trim();
    if (query) {
      const options: { accountId?: string; mailbox: string; query?: string } = {
        mailbox: activeMailbox,
        query,
      };

      if (activeAccount !== undefined) {
        options.accountId = activeAccount;
      }

      const messages = await unsyncApi.listEmails(options);
      renderMessageList(messages);
      setStatus(`${messages.length} cached message${messages.length === 1 ? "" : "s"}`);
      return;
    }

    const messages = await unsyncApi.getFolderEmails(activeFolder, activeAccount);
    console.log("[renderer emails]", messages);

    renderMessageList(messages);
    setStatus(`${messages.length} cached message${messages.length === 1 ? "" : "s"}`);
  } catch (error) {
    setStatus(formatError(error));
  }
}

async function selectSidebarFolder(folderName: string): Promise<void> {
  activeFolder = folderName;
  activeMailbox = folderNameToMailbox(folderName);
  updateSidebarFolderActiveState();
  renderAccountSidebar();
  setStatus(`Loading ${folderName}...`);

  try {
    const query = searchInput.value.trim();

    if (query) {
      const options: { accountId?: string; mailbox: string; query: string } = {
        mailbox: activeMailbox,
        query,
      };

      if (activeAccount !== undefined) {
        options.accountId = activeAccount;
      }

      const emails = await unsyncApi.listEmails(options);
      renderMessageList(emails);
      setStatus(`${folderName}: ${emails.length} cached message${emails.length === 1 ? "" : "s"}`);
      return;
    }

    const emails = await unsyncApi.getFolderEmails(folderName, activeAccount);
    renderMessageList(emails);
    setStatus(`${folderName}: ${emails.length} cached message${emails.length === 1 ? "" : "s"}`);
  } catch (error) {
    setStatus(formatError(error));
  }
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
    const isActive = (button.dataset.folder ?? "Inbox") === activeFolder;
    button.classList.toggle("is-active", isActive);

    if (isActive) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  }
}

function folderNameToMailbox(folderName: string): string {
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

function mailboxToFolderName(mailbox: string): string {
  const folderMap: Record<string, string> = {
    inbox: "Inbox",
    junk: "Junk Email",
    drafts: "Drafts",
    sent: "Sent Items",
    deleted: "Deleted Items",
    archive: "Archive",
    "conversation history": "Conversation History",
    notes: "Notes",
    outbox: "Outbox",
    groups: "Go to Groups",
  };

  return folderMap[mailbox.trim().toLowerCase()] ?? "Inbox";
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
    if (activeAccountEmail !== undefined) {
      composeDraft.fromAccountEmail = activeAccountEmail;
    }
    const result = await unsyncApi.sendMail(composeDraft);
    const mode = result.shielded ? " with Unsync Shield" : "";

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

  for (const message of messages) {
    const card = document.createElement("button");
    card.className = "message-card";
    card.type = "button";
    card.dataset.id = String(message.id);
    card.innerHTML = `
      <span class="message-card__topline">
        <span>${escapeHtml(message.fromName || message.fromAddress || "Unknown sender")}</span>
        ${message.isUnsyncEncrypted ? '<span class="mini-shield">Shield</span>' : ""}
      </span>
      <span class="message-card__subject">${escapeHtml(message.subject || "(no subject)")}</span>
      <span class="message-card__preview">${escapeHtml(message.decryptedPreview || "Encrypted message")}</span>
      <span class="message-card__date">${formatDate(message.receivedAt)}</span>
    `;
    card.addEventListener("click", () => void selectEmail(message.id));
    messageList.append(card);
  }

  emptyState.hidden = messages.length > 0;
}

async function selectEmail(id: number): Promise<void> {
  activeEmailId = id;
  highlightActiveCard(id);
  setStatus("Opening message...");

  try {
    const email = await unsyncApi.getEmail(id);
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
  readerSubject.textContent = email.subject || "(no subject)";
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

function handleReaderAction(action: string): void {
  console.log(`[reader action] ${action}`, { activeEmailId });
  setStatus(activeEmailId === undefined ? `No message selected for ${action}.` : `Reader action: ${action}.`);
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
  for (const card of messageList.querySelectorAll<HTMLButtonElement>(".message-card")) {
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

function formatSender(email: UnsyncEmailReadModel): string {
  if (email.fromName && email.fromAddress) {
    return `${email.fromName} [${email.fromAddress}]`;
  }

  if (email.fromAddress) {
    return `[${email.fromAddress}]`;
  }

  return email.fromName || "Unknown sender";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  renderAttachmentList();
  composeError.textContent = "";
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

  return `<!DOCTYPE html>
<html>
  <head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src http: https: data:;">
    <style>
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
      'script, iframe, object, embed, form, input, button, link[rel="stylesheet"], meta[http-equiv]',
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
