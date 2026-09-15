/**
 * @name SaveAllAttachments
 * @author @whitew9ne
 * @description Adds a context-menu action for saving every file attached to a single message.
 * @version 1.0.0
 */

"use strict";

const fs = require("fs");
const path = require("path");

module.exports = class SaveAllAttachments {
    constructor() {
        this.api = new BdApi("SaveAllAttachments");
        this.unpatchMessageMenu = null;
    }

    start() {
        this.unpatchMessageMenu = this.api.ContextMenu.patch("message", (tree, context) => {
            try {
                const attachments = this.getAttachments(context?.message);
                if (!attachments.length) return;

                const menuChildren = this.findMenuChildren(tree);
                if (!menuChildren) {
                    this.api.Logger.warn("Could not find the message context-menu container.");
                    return;
                }

                const count = attachments.length;
                menuChildren.push(this.api.ContextMenu.buildItem({
                    type: "item",
                    id: "save-all-attachments",
                    label: count === 1
                        ? "Save attachment..."
                        : `Save all ${count} attachments...`,
                    action: () => void this.chooseFolderAndDownload(attachments)
                }));
            }
            catch (error) {
                this.api.Logger.error("Failed to add the attachment menu item.", error);
            }
        });
    }

    stop() {
        if (typeof this.unpatchMessageMenu === "function") {
            this.unpatchMessageMenu();
        }
        this.unpatchMessageMenu = null;
    }

    getAttachments(message) {
        const source = message?.attachments;
        let rawAttachments = [];

        if (Array.isArray(source)) rawAttachments = source;
        else if (typeof source?.toArray === "function") rawAttachments = source.toArray();
        else if (source && typeof source[Symbol.iterator] === "function") rawAttachments = [...source];

        return rawAttachments.map((attachment, index) => {
            const read = (key) => typeof attachment?.get === "function"
                ? attachment.get(key)
                : attachment?.[key];

            const urls = [read("url"), read("proxy_url"), read("proxyUrl")]
                .filter((url, position, all) => typeof url === "string" && url && all.indexOf(url) === position);

            const filename = read("filename") || this.filenameFromUrl(urls[0]) || `attachment-${index + 1}`;
            const parsedSize = Number(read("size"));

            return {
                filename: String(filename),
                size: Number.isFinite(parsedSize) && parsedSize > 0 ? parsedSize : 0,
                urls
            };
        }).filter((attachment) => attachment.urls.length > 0);
    }

    findMenuChildren(tree) {
        const rootChildren = tree?.props?.children?.props?.children;
        const lastRootChild = Array.isArray(rootChildren) ? rootChildren.at(-1) : null;
        const nestedGroup = lastRootChild?.props?.children;
        const nestedItem = Array.isArray(nestedGroup) ? nestedGroup.at(0) : null;

        const candidates = [
            nestedItem?.props?.children,
            rootChildren,
            tree?.props?.children
        ];

        return candidates.find(Array.isArray) || null;
    }

    filenameFromUrl(url) {
        if (!url) return "";

        try {
            const finalSegment = new URL(url).pathname.split("/").pop() || "";
            return decodeURIComponent(finalSegment);
        }
        catch (_) {
            return "";
        }
    }

    async chooseFolderAndDownload(attachments) {
        try {
            const lastFolder = this.api.Data.load("lastFolder");
            const defaultPath = typeof lastFolder === "string" && fs.existsSync(lastFolder)
                ? lastFolder
                : undefined;

            const result = await this.api.UI.openDialog({
                mode: "open",
                title: `Choose where to save ${attachments.length} attachment${attachments.length === 1 ? "" : "s"}`,
                message: "Select a folder for the attached files.",
                defaultPath,
                openDirectory: true,
                openFile: false,
                multiSelections: false,
                promptToCreate: true,
                modal: true
            });

            if (result?.canceled || result?.cancelled || !result?.filePaths?.[0]) return;

            const targetFolder = result.filePaths[0];
            this.api.Data.save("lastFolder", targetFolder);
            await this.downloadAll(attachments, targetFolder);
        }
        catch (error) {
            this.api.Logger.error("Could not start the attachment download.", error);
            this.api.UI.showToast("Could not save the attachments. Check the console for details.", {type: "error"});
        }
    }

    async downloadAll(attachments, targetFolder) {
        const reservedNames = new Set();
        const jobs = attachments.map((attachment, index) => ({
            attachment,
            targetPath: this.createUniquePath(
                targetFolder,
                this.sanitizeFilename(attachment.filename, index),
                reservedNames
            )
        }));

        const totalBytes = attachments.reduce((total, attachment) => total + attachment.size, 0);
        const hasLargeFile = attachments.some((attachment) => attachment.size >= 100 * 1024 * 1024);
        const concurrency = hasLargeFile || totalBytes >= 300 * 1024 * 1024
            ? 1
            : Math.min(3, jobs.length);

        this.api.UI.showToast(
            `Downloading ${jobs.length} attachment${jobs.length === 1 ? "" : "s"}...`,
            {type: "info"}
        );

        const saved = [];
        const failed = [];
        let nextJob = 0;

        const worker = async () => {
            while (nextJob < jobs.length) {
                const job = jobs[nextJob++];

                try {
                    const data = await this.fetchAttachment(job.attachment);
                    await this.writeFileExclusive(job.targetPath, data);
                    saved.push(job);
                }
                catch (error) {
                    failed.push({job, error});
                    this.api.Logger.error(`Failed to save ${job.attachment.filename}.`, error);
                }
            }
        };

        await Promise.all(Array.from({length: concurrency}, () => worker()));

        if (!failed.length) {
            this.api.UI.showToast(
                `Saved ${saved.length} attachment${saved.length === 1 ? "" : "s"}.`,
                {type: "success"}
            );
            return;
        }

        const failedNames = failed
            .slice(0, 6)
            .map(({job}) => job.attachment.filename)
            .join(", ");
        const more = failed.length > 6 ? ` and ${failed.length - 6} more` : "";

        this.api.UI.alert(
            "Save All Attachments",
            `Saved ${saved.length} of ${jobs.length} files. Failed: ${failedNames}${more}. You can retry from the message menu.`
        );
    }

    async fetchAttachment(attachment) {
        let lastError = null;

        for (const url of attachment.urls) {
            try {
                const parsed = new URL(url);
                if (parsed.protocol !== "https:") throw new Error("Only HTTPS attachment URLs are allowed.");

                const response = await this.api.Net.fetch(parsed.href, {
                    method: "GET",
                    redirect: "follow",
                    timeout: 120000
                });

                if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
                return Buffer.from(await response.arrayBuffer());
            }
            catch (error) {
                lastError = error;
            }
        }

        throw lastError || new Error("The attachment has no usable download URL.");
    }

    sanitizeFilename(originalName, index) {
        let filename = path.basename(String(originalName || ""))
            .normalize("NFC")
            .replace(/[<>:"/\\|?*\u0000-\u001F\u007F]/g, "_")
            .replace(/[. ]+$/g, "")
            .trim();

        if (!filename || filename === "." || filename === "..") {
            filename = `attachment-${index + 1}`;
        }

        const parsed = path.parse(filename);
        if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(parsed.name)) {
            filename = `_${filename}`;
        }

        if (filename.length > 180) {
            const shortened = path.parse(filename);
            const extension = shortened.ext.slice(0, 20);
            const maximumStemLength = Math.max(1, 180 - extension.length);
            filename = `${shortened.name.slice(0, maximumStemLength)}${extension}`;
        }

        return filename;
    }

    createUniquePath(folder, filename, reservedNames) {
        const parsed = path.parse(filename);
        let number = 1;

        while (number < 10000) {
            const candidateName = number === 1
                ? filename
                : `${parsed.name} (${number})${parsed.ext}`;
            const reservationKey = candidateName.toLocaleLowerCase();
            const candidatePath = path.join(folder, candidateName);

            if (!reservedNames.has(reservationKey) && !fs.existsSync(candidatePath)) {
                reservedNames.add(reservationKey);
                return candidatePath;
            }

            number++;
        }

        throw new Error(`Could not create a unique filename for ${filename}.`);
    }

    writeFileExclusive(filePath, data) {
        return new Promise((resolve, reject) => {
            fs.writeFile(filePath, data, {flag: "wx"}, (error) => {
                if (error) reject(error);
                else resolve();
            });
        });
    }
};
