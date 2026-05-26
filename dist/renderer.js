"use strict";
const rendererProcess = typeof process === "undefined" ? undefined : process;
const osPlatform = rendererProcess?.platform === "darwin" || navigator.userAgent.includes("Mac")
    ? "mac"
    : rendererProcess?.platform === "win32" || navigator.userAgent.includes("Win")
        ? "win"
        : "linux";
document.documentElement.classList.add(`os-${osPlatform}`);
const appWindow = window;
const folderButtons = Array.from(document.querySelectorAll("[data-mailbox]"));
const sidebarFolderButtons = Array.from(document.querySelectorAll(".sidebar-folders [data-folder]"));
const messageList = getElement("message-list");
const emptyState = getElement("empty-state");
const readerPane = getElement("reader-pane");
const readerSubject = getElement("reader-subject");
const metaExactFrom = getElement("meta-exact-from");
const metaExactTo = getElement("meta-exact-to");
const metaExactDate = getElement("meta-exact-date");
const readerIframe = getElement("reader-iframe");
const iframeThemeToggle = getElement("iframe-theme-toggle");
const replyButton = getElement("btn-reply");
const replyAllButton = getElement("btn-reply-all");
const forwardButton = getElement("btn-forward");
const deleteButton = getElement("btn-delete");
const spamButton = getElement("btn-spam");
const moreMenuButton = getElement("btn-more-menu");
const shieldBadge = getElement("shield-badge");
const accountSelector = getElement("account-selector");
const searchInput = getElement("global-search");
const passphraseDialog = getElement("passphrase-dialog");
const passphraseForm = getElement("passphrase-form");
const passphraseInput = getElement("passphrase-input");
const passphraseError = getElement("passphrase-error");
const cancelDecrypt = getElement("cancel-decrypt");
const statusText = getElement("status-text");
const settingsButton = getElement("sidebar-gear");
const notificationsButton = getElement("btn-notifications");
const settingsModal = getElement("settings-modal");
const settingsForm = getElement("settings-form");
const closeSettings = getElement("close-settings");
const gmailDefaults = getElement("gmail-defaults");
const settingsError = getElement("settings-error");
const accountEmail = getElement("account-email");
const accountPassword = getElement("account-password");
const imapHost = getElement("imap-host");
const imapPort = getElement("imap-port");
const smtpHost = getElement("smtp-host");
const smtpPort = getElement("smtp-port");
const composeButton = getElement("compose-button");
const refreshButton = getElement("refresh-button");
const composeModal = getElement("compose-modal");
const composeForm = getElement("compose-form");
const closeCompose = getElement("close-compose");
const cancelCompose = getElement("cancel-compose");
const sendCompose = getElement("send-compose");
const composeTo = getElement("compose-to");
const composeCc = getElement("compose-cc");
const composeBcc = getElement("compose-bcc");
const composeSubject = getElement("compose-subject");
const composeBody = getElement("compose-body");
const composeShield = getElement("compose-shield");
const attachFileButton = getElement("attach-file-button");
const attachmentList = getElement("attachment-list");
const composeError = getElement("compose-error");
const toast = getElement("toast");
const calendarMonthYear = getElement("calendar-month-year");
const calendarDaysGrid = getElement("calendar-days-grid");
const todoNewItem = getElement("todo-new-item");
const todoAddButton = getElement("todo-add-btn");
const todoListItems = getElement("todo-list-items");
let activeMailbox = "inbox";
let activeFolder = "Inbox";
let activeAccount;
let activeAccountEmail;
let accounts = [];
let activeEmailId;
let pendingEncryptedEmail;
let editingAccountEmail; // which account the settings modal is editing
let composeAttachments = [];
let nextMyDayTaskId = 1;
const myDayTasks = [];
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
async function loadMessages() {
    setStatus("Loading local cache...");
    try {
        const query = searchInput.value.trim();
        if (query) {
            const options = {
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
    }
    catch (error) {
        setStatus(formatError(error));
    }
}
async function selectSidebarFolder(folderName) {
    activeFolder = folderName;
    activeMailbox = folderNameToMailbox(folderName);
    updateSidebarFolderActiveState();
    renderAccountSidebar();
    setStatus(`Loading ${folderName}...`);
    try {
        const query = searchInput.value.trim();
        if (query) {
            const options = {
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
    }
    catch (error) {
        setStatus(formatError(error));
    }
}
function setActiveAccount(emailAddress) {
    activeAccount = emailAddress;
    activeAccountEmail = emailAddress;
    accountSelector.value = emailAddress ?? "";
}
function renderAccountSelector() {
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
function renderSidebarCalendar() {
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
        const isToday = calendarDate.getFullYear() === today.getFullYear() &&
            calendarDate.getMonth() === today.getMonth() &&
            calendarDate.getDate() === date;
        dayCell.textContent = String(day);
        dayCell.classList.toggle("is-today", isToday);
        calendarDaysGrid.append(dayCell);
    }
}
function addTodoItem() {
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
function renderMyDayTasks() {
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
function updateSidebarFolderActiveState() {
    for (const button of sidebarFolderButtons) {
        const isActive = (button.dataset.folder ?? "Inbox") === activeFolder;
        button.classList.toggle("is-active", isActive);
        if (isActive) {
            button.setAttribute("aria-current", "page");
        }
        else {
            button.removeAttribute("aria-current");
        }
    }
}
function folderNameToMailbox(folderName) {
    const normalized = folderName.trim().toLowerCase();
    const mailboxMap = {
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
function mailboxToFolderName(mailbox) {
    const folderMap = {
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
async function loadAccounts() {
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
        }
        else {
            setStatus(`${accounts.length} account${accounts.length === 1 ? "" : "s"} loaded.`);
        }
    }
    catch (error) {
        setStatus(formatError(error));
    }
}
function renderAccountSidebar() {
    // Account selection now lives exclusively in the top-bar dropdown.
}
function openSettingsForAccount(emailAddress) {
    editingAccountEmail = emailAddress;
    settingsError.textContent = "";
    const deleteBtn = document.getElementById("delete-account-button");
    const modalTitle = document.querySelector(".settings-header h2");
    if (emailAddress) {
        const account = accounts.find((a) => a.emailAddress === emailAddress);
        if (account)
            fillAccountForm(account);
        if (deleteBtn)
            deleteBtn.hidden = false;
        if (modalTitle)
            modalTitle.textContent = "Edit Account";
    }
    else {
        settingsForm.reset();
        if (deleteBtn)
            deleteBtn.hidden = true;
        if (modalTitle)
            modalTitle.textContent = "Add Account";
    }
    settingsModal.showModal();
}
async function saveAccountSettings() {
    settingsError.textContent = "";
    const saveButton = settingsForm.querySelector('button[type="submit"]');
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
    }
    catch (error) {
        window.clearInterval(timer);
        settingsError.textContent = formatError(error);
    }
    finally {
        if (saveButton) {
            saveButton.disabled = false;
            saveButton.textContent = "Save Account";
        }
    }
}
async function deleteActiveEditingAccount() {
    if (!editingAccountEmail)
        return;
    const confirmed = window.confirm(`Remove ${editingAccountEmail} and all its cached emails?`);
    if (!confirmed)
        return;
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
    }
    catch (error) {
        settingsError.textContent = formatError(error);
    }
}
async function sendComposeDraft() {
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
    }
    catch (error) {
        const message = formatError(error);
        composeError.textContent = message;
        setStatus(message);
        showToast(message);
    }
    finally {
        setComposeLoading(false);
    }
}
async function refreshInbox() {
    setRefreshLoading(true);
    setStatus("Refreshing recent inbox...");
    try {
        const status = await unsyncApi.syncNow(activeAccountEmail);
        setStatus(status.message);
        await loadMessages();
    }
    catch (error) {
        setStatus(formatError(error));
    }
    finally {
        setRefreshLoading(false);
    }
}
function renderMessageList(messages) {
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
async function selectEmail(id) {
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
    }
    catch (error) {
        setStatus(formatError(error));
    }
}
async function decryptPendingEmail() {
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
    }
    catch (error) {
        passphraseError.textContent = formatError(error);
    }
}
async function renderReader(email, body) {
    readerPane.classList.add("has-message");
    readerSubject.textContent = email.subject || "(no subject)";
    metaExactFrom.textContent = formatSender(email);
    metaExactTo.textContent = email.accountId || "Unknown account";
    metaExactDate.textContent = email.receivedAt || "Unknown date";
    const fallbackBody = body || (email.isUnsyncEncrypted ? "Encrypted message locked." : "No body text.");
    const emailBodyPayload = buildReaderDocument(fallbackBody, email.bodyContentType === "html" && email.isUnsyncEncrypted !== 1);
    const safeHtml = sanitizeEmailHtml(emailBodyPayload);
    await unsyncApi.setReaderContent(safeHtml);
    readerIframe.removeAttribute("srcdoc");
    readerIframe.src = `email-reader://view?t=${Date.now()}`;
    shieldBadge.hidden = email.isUnsyncEncrypted !== 1;
    shieldBadge.classList.toggle("is-illuminated", email.isUnsyncEncrypted === 1 && body.length > 0);
}
function handleReaderAction(action) {
    console.log(`[reader action] ${action}`, { activeEmailId });
    setStatus(activeEmailId === undefined ? `No message selected for ${action}.` : `Reader action: ${action}.`);
}
function applyReaderIframeTheme(useDarkView) {
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
    }
    catch (error) {
        console.warn("Unable to apply reader iframe theme.", error);
    }
}
function highlightActiveCard(id) {
    for (const card of messageList.querySelectorAll(".message-card")) {
        card.classList.toggle("is-selected", card.dataset.id === String(id));
    }
}
function setStatus(message) {
    statusText.textContent = message;
}
function getElement(id) {
    const element = document.getElementById(id);
    if (!element) {
        throw new Error(`Missing #${id}`);
    }
    return element;
}
function formatDate(value) {
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
function formatSender(email) {
    if (email.fromName && email.fromAddress) {
        return `${email.fromName} [${email.fromAddress}]`;
    }
    if (email.fromAddress) {
        return `[${email.fromAddress}]`;
    }
    return email.fromName || "Unknown sender";
}
function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}
function escapeHtml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
function fillAccountForm(account) {
    accountEmail.value = account.emailAddress;
    imapHost.value = account.imapHost;
    imapPort.value = String(account.imapPort);
    smtpHost.value = account.smtpHost;
    smtpPort.value = String(account.smtpPort);
    accountPassword.value = account.appPassword;
}
function readAccountForm() {
    return {
        emailAddress: accountEmail.value.trim(),
        imapHost: imapHost.value.trim(),
        imapPort: readPort(imapPort.value, "IMAP Port"),
        smtpHost: smtpHost.value.trim(),
        smtpPort: readPort(smtpPort.value, "SMTP Port"),
        appPassword: accountPassword.value,
    };
}
function readPort(value, label) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`${label} must be a valid TCP port.`);
    }
    return port;
}
function readComposeForm() {
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
function closeComposeModal() {
    composeModal.close();
    composeForm.reset();
    composeAttachments = [];
    renderAttachmentList();
    composeError.textContent = "";
}
function setComposeLoading(isLoading) {
    sendCompose.disabled = isLoading;
    cancelCompose.disabled = isLoading;
    closeCompose.disabled = isLoading;
    attachFileButton.disabled = isLoading;
    sendCompose.textContent = isLoading ? "Sending..." : "Send";
}
function setRefreshLoading(isLoading) {
    refreshButton.disabled = isLoading;
    refreshButton.lastElementChild.textContent = isLoading ? "Refreshing..." : "Refresh";
}
function showToast(message) {
    toast.textContent = message;
    toast.hidden = false;
    window.clearTimeout(Number(toast.dataset.timer));
    toast.dataset.timer = String(window.setTimeout(() => {
        toast.hidden = true;
    }, 3200));
}
async function attachFilesToDraft() {
    try {
        const selectedAttachments = await unsyncApi.selectAttachments();
        for (const attachment of selectedAttachments) {
            if (!composeAttachments.some((item) => item.path === attachment.path)) {
                composeAttachments.push(attachment);
            }
        }
        renderAttachmentList();
    }
    catch (error) {
        const message = formatError(error);
        composeError.textContent = message;
        setStatus(message);
    }
}
function renderAttachmentList() {
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
function buildReaderDocument(body, isHtml) {
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
function sanitizeEmailHtml(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc
        .querySelectorAll('script, iframe, object, embed, form, input, button, link[rel="stylesheet"], meta[http-equiv]')
        .forEach((element) => element.remove());
    doc.querySelectorAll("*").forEach((element) => {
        for (const attribute of Array.from(element.attributes)) {
            const attributeName = attribute.name.toLowerCase();
            const attributeValue = attribute.value.trim().toLowerCase();
            if (attributeName.startsWith("on")) {
                element.removeAttribute(attribute.name);
                continue;
            }
            if ((attributeName === "href" || attributeName === "src") &&
                attributeValue.startsWith("javascript:")) {
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
//# sourceMappingURL=renderer.js.map