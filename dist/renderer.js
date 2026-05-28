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
const feedTitle = getElement("feed-title");
const readerPane = getElement("reader-pane");
const readerSubject = getElement("reader-subject");
const readerSenderAvatar = getElement("reader-sender-avatar");
const metaExactFrom = getElement("meta-exact-from");
const metaExactTo = getElement("meta-exact-to");
const metaExactDate = getElement("meta-exact-date");
const readerIframe = getElement("reader-iframe");
const iframeThemeToggle = getElement("iframe-theme-toggle");
const masterSelect = getElement("master-select-all");
const headerJumpButton = getElement("btn-hdr-jump");
const headerFilterButton = getElement("btn-hdr-filter");
const headerSortButton = getElement("btn-hdr-sort");
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
const customContextMenu = getElement("custom-context-menu");
const ctxMarkRead = getElement("ctx-mark-read");
const ctxMarkUnread = getElement("ctx-mark-unread");
const ctxDelete = getElement("ctx-delete");
const ctxArchive = getElement("ctx-archive");
const ctxSpam = getElement("ctx-spam");
const readerMoreMenu = getElement("reader-more-menu");
const readerMoreMarkUnread = getElement("reader-more-mark-unread");
const readerMoreMarkRead = getElement("reader-more-mark-read");
const readerMoreArchive = getElement("reader-more-archive");
const readerMoreTrash = getElement("reader-more-trash");
const calendarMonthYear = getElement("calendar-month-year");
const calendarDaysGrid = getElement("calendar-days-grid");
const todoNewItem = getElement("todo-new-item");
const todoAddButton = getElement("todo-add-btn");
const todoListItems = getElement("todo-list-items");
let activeMailbox = "inbox";
let activeFolder = getFolderLabel(activeMailbox);
let activeAccount;
let activeAccountEmail;
let accounts = [];
let activeEmailId;
let activeEmail;
let activeReaderBody = "";
let pendingEncryptedEmail;
let editingAccountEmail; // which account the settings modal is editing
let composeAttachments = [];
let composeFromAccountEmail;
let contextMenuEmailId;
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
    if (target instanceof Node &&
        (customContextMenu.contains(target) || readerMoreMenu.contains(target) || moreMenuButton.contains(target))) {
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
async function loadMessages() {
    setStatus("Loading local cache...");
    updateFeedTitle();
    try {
        const query = searchInput.value.trim();
        const messages = await unsyncApi.getFolderEmails(activeMailbox, activeAccount, query || undefined);
        renderMessageList(messages);
        updateEmptyState(messages.length);
        setStatus(`${messages.length} cached message${messages.length === 1 ? "" : "s"}`);
    }
    catch (error) {
        setStatus(formatError(error));
    }
}
async function selectSidebarFolder(folderKey) {
    activeMailbox = folderKey;
    activeFolder = getFolderLabel(folderKey);
    updateFeedTitle();
    updateSidebarFolderActiveState();
    renderAccountSidebar();
    setStatus(`Loading ${activeFolder}...`);
    await loadMessages();
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
        const isActive = parseFolderKey(button.dataset.folder) === activeMailbox;
        button.classList.toggle("is-active", isActive);
        if (isActive) {
            button.setAttribute("aria-current", "page");
        }
        else {
            button.removeAttribute("aria-current");
        }
    }
}
function parseFolderKey(value) {
    const normalized = (value ?? "inbox").trim().toLowerCase();
    const folderMap = {
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
function getFolderLabel(folderKey) {
    const folderLabels = {
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
function updateFeedTitle() {
    feedTitle.textContent = activeFolder;
}
function updateEmptyState(messageCount) {
    emptyState.textContent = `No messages in ${activeFolder}.`;
    emptyState.hidden = messageCount > 0;
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
async function selectEmail(id) {
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
    activeEmail = email;
    activeReaderBody = body;
    readerSubject.textContent = email.subject || "(no subject)";
    readerSenderAvatar.textContent = getSenderInitial(email);
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
async function handleReaderAction(action) {
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
function handlePanel2HeaderAction(action) {
    console.log(`[panel2 header] ${action}`, { activeFolder, activeAccount });
    setStatus(`Panel 2 action: ${action}.`);
}
function syncMessageCheckboxesToMaster() {
    const checkboxes = document.querySelectorAll(".msg-checkbox");
    checkboxes.forEach((checkbox) => {
        checkbox.checked = masterSelect.checked;
    });
}
function showCustomContextMenu(pageX, pageY) {
    customContextMenu.classList.remove("context-menu-hidden");
    customContextMenu.style.left = `${pageX}px`;
    customContextMenu.style.top = `${pageY}px`;
    customContextMenu.style.display = "block";
}
function hideCustomContextMenu() {
    customContextMenu.style.display = "none";
    customContextMenu.classList.add("context-menu-hidden");
}
async function handleContextMenuAction(action) {
    const emailId = contextMenuEmailId;
    hideCustomContextMenu();
    if (emailId === undefined) {
        setStatus(`No message selected for ${action}.`);
        return;
    }
    await runMessageAction(emailId, action);
}
async function handleReaderMoreAction(action) {
    const email = getActiveReaderEmail(action);
    hideReaderMoreMenu();
    if (!email) {
        return;
    }
    await runMessageAction(email.id, action);
}
async function runMessageAction(emailId, action) {
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
    }
    catch (error) {
        const message = formatError(error);
        setStatus(message);
        showToast(message);
    }
}
async function moveActiveEmailToFolder(folderKey, successMessage) {
    if (activeEmailId === undefined) {
        setStatus("Select a message first.");
        return;
    }
    try {
        await unsyncApi.moveEmailToFolder(activeEmailId, folderKey);
        await afterMailboxMove(activeEmailId, successMessage);
    }
    catch (error) {
        const message = formatError(error);
        setStatus(message);
        showToast(message);
    }
}
async function afterMailboxMove(emailId, message) {
    if (activeEmailId === emailId) {
        await clearReaderPane();
    }
    await loadMessages();
    setStatus(message);
    showToast(message);
}
function getActiveReaderEmail(action) {
    if (!activeEmail || activeEmailId === undefined) {
        setStatus(`Select a message before using ${action}.`);
        showToast("Select a message first.");
        return undefined;
    }
    return activeEmail;
}
function openReplyCompose(email) {
    resetComposeForAction(email);
    composeTo.value = email.fromAddress;
    composeCc.value = "";
    composeBcc.value = "";
    composeSubject.value = normalizeReplySubject(email.subject);
    composeBody.value = quoteOriginalMessage(email);
    showComposeModal("Reply");
}
function openReplyAllCompose(email) {
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
function openForwardCompose(email) {
    resetComposeForAction(email);
    composeTo.value = "";
    composeCc.value = "";
    composeBcc.value = "";
    composeSubject.value = normalizeForwardSubject(email.subject);
    composeBody.value = buildForwardBody(email);
    showComposeModal("Forward");
}
function resetComposeForAction(email) {
    composeForm.reset();
    composeShield.checked = true;
    composeAttachments = [];
    composeFromAccountEmail = email.accountId;
    composeError.textContent = "";
    renderAttachmentList();
}
function showComposeModal(mode) {
    const kicker = document.querySelector(".compose-kicker");
    const title = document.querySelector(".compose-header h2");
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
function quoteOriginalMessage(email) {
    const body = getPlainOriginalBody(email);
    const quotedBody = body
        .split(/\r?\n/)
        .map((line) => `> ${line}`)
        .join("\n");
    return `\n\nOn ${email.receivedAt || "unknown date"}, ${formatSender(email)} wrote:\n${quotedBody}`;
}
function buildForwardBody(email) {
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
function getPlainOriginalBody(email) {
    const body = activeReaderBody || email.localSearchText || email.decryptedPreview || "";
    const plainBody = email.bodyContentType === "html" ? htmlToPlainText(body) : body;
    return plainBody.trim() || "No body text.";
}
function normalizeReplySubject(subject) {
    const normalized = subject.trim() || "(no subject)";
    return /^re:/i.test(normalized) ? normalized : `Re: ${normalized}`;
}
function normalizeForwardSubject(subject) {
    const normalized = subject.trim() || "(no subject)";
    return /^fwd:/i.test(normalized) ? normalized : `Fwd: ${normalized}`;
}
function parseEmailAddressList(value) {
    try {
        const parsed = JSON.parse(value || "[]");
        if (Array.isArray(parsed)) {
            return parsed
                .filter((item) => typeof item === "string")
                .map((item) => item.trim())
                .filter(Boolean);
        }
    }
    catch {
        // Fall through to comma splitting for older cached data.
    }
    return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}
function uniqueEmailAddresses(addresses) {
    const seen = new Set();
    const unique = [];
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
function htmlToPlainText(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return doc.body.textContent?.replace(/\n{3,}/g, "\n\n") ?? "";
}
async function clearReaderPane() {
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
function toggleReaderMoreMenu() {
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
function hideReaderMoreMenu() {
    readerMoreMenu.style.display = "none";
    readerMoreMenu.classList.add("context-menu-hidden");
}
function handleMessageControlInteraction(event) {
    const target = event.target;
    if (!(target instanceof Element)) {
        return;
    }
    const checkbox = target.closest(".msg-checkbox");
    const starButton = target.closest(".message-star");
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
function isMessageControlClick(target) {
    return target instanceof Element && Boolean(target.closest(".msg-checkbox, .message-star"));
}
function injectReaderIframeScrollbarStyles() {
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
    }
    catch (error) {
        console.warn("Unable to inject reader iframe scrollbar styles.", error);
    }
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
    for (const card of messageList.querySelectorAll(".message-row")) {
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
function formatDateDivider(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return "";
    }
    const today = new Date();
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const startOfMessageDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const dayOffset = Math.round((startOfToday.getTime() - startOfMessageDate.getTime()) / 86_400_000);
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
function formatSender(email) {
    if (email.fromName && email.fromAddress) {
        return `${email.fromName} [${email.fromAddress}]`;
    }
    if (email.fromAddress) {
        return `[${email.fromAddress}]`;
    }
    return email.fromName || "Unknown sender";
}
function getSenderInitial(email) {
    const value = email.fromName || email.fromAddress || "?";
    return value.trim().charAt(0).toUpperCase() || "?";
}
function normalizePreview(value) {
    return value.replace(/\s+/g, " ").trim();
}
function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}
function formatComposeSendError(error) {
    if (error.code === "MISSING_RECIPIENT_PUBLIC_KEY" && error.recipientEmail) {
        return `Unsync Shield cannot directly encrypt for ${error.recipientEmail}. Secure web-reader fallback is not available yet.`;
    }
    return error.message;
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
    composeFromAccountEmail = undefined;
    renderAttachmentList();
    composeError.textContent = "";
    const kicker = document.querySelector(".compose-kicker");
    const title = document.querySelector(".compose-header h2");
    if (kicker) {
        kicker.textContent = "New Message";
    }
    if (title) {
        title.textContent = "Compose Email";
    }
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