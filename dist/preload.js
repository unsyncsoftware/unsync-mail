"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const api = {
    listEmails(options) {
        return electron_1.ipcRenderer.invoke("emails:list", options);
    },
    getFolderEmails(folderName, accountEmail) {
        return electron_1.ipcRenderer.invoke("mail:get-folder-emails", folderName, accountEmail);
    },
    getEmail(id) {
        return electron_1.ipcRenderer.invoke("emails:get", id);
    },
    decryptEmail(input) {
        return electron_1.ipcRenderer.invoke("emails:decrypt", input);
    },
    generateUserKey(input) {
        return electron_1.ipcRenderer.invoke("crypto:generate-user-key", input);
    },
    generateSafetyNumber(firstPublicKeyArmored, secondPublicKeyArmored) {
        return electron_1.ipcRenderer.invoke("crypto:safety-number", firstPublicKeyArmored, secondPublicKeyArmored);
    },
    listAccounts() {
        return electron_1.ipcRenderer.invoke("accounts:list");
    },
    saveAccount(input) {
        return electron_1.ipcRenderer.invoke("accounts:save", input);
    },
    deleteAccount(emailAddress) {
        return electron_1.ipcRenderer.invoke("accounts:delete", emailAddress);
    },
    syncNow(accountEmail) {
        return electron_1.ipcRenderer.invoke("mail:sync-now", accountEmail);
    },
    sendMail(input) {
        return electron_1.ipcRenderer.invoke("mail:send", input);
    },
    selectAttachments() {
        return electron_1.ipcRenderer.invoke("mail:select-attachments");
    },
    setReaderContent(html) {
        return electron_1.ipcRenderer.invoke("mail:set-reader-content", html);
    },
    onMailboxUpdated(callback) {
        const listener = () => callback();
        electron_1.ipcRenderer.on("mailbox:updated", listener);
        return () => electron_1.ipcRenderer.removeListener("mailbox:updated", listener);
    },
    onSyncStatus(callback) {
        const listener = (_event, status) => {
            callback(status);
        };
        electron_1.ipcRenderer.on("mail:sync-status", listener);
        return () => electron_1.ipcRenderer.removeListener("mail:sync-status", listener);
    },
};
electron_1.contextBridge.exposeInMainWorld("unsync", api);
//# sourceMappingURL=preload.js.map