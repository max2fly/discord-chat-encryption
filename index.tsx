import "./styles.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Devs } from "@utils/constants";
import { openModal } from "@utils/modal";
import definePlugin from "@utils/types";
import { Message } from "@vencord/discord-types";
import { ChannelStore, Menu } from "@webpack/common";
import { findByPropsLazy } from "@webpack";

import { DecryptionModal } from "./DecryptionModal";
import { EncryptionAccessory, handleDecryption, getDecryptedMessages } from "./EncryptionAccessory";
import { EncryptionChatBarIcon, EncryptionIcon, setShouldShowEncryptionEnabledTooltip } from "./EncryptionIcon";
import { settings } from "./settings";
import { decryptWithMultiplePhrases, encrypt, isEncryptedMessage, createHiddenMessage, extractHiddenMessage, isHiddenMessage, encryptImageToMessage } from "./utils";
import { cleanupLegacyCache } from "./EncryptionAccessory";

// Find Discord's upload modules  
const UploadStore = findByPropsLazy("getUploads", "upload");
const FileUtils = findByPropsLazy("makeFile");
const UploadAttachmentStore = findByPropsLazy("addFiles");
const CloudUpload = findByPropsLazy("CloudUpload", "upload");

// Helper function to check if file is an image
function isImageFile(fileItem: any): boolean {
    // Handle both direct File objects and Discord's file wrapper objects
    const actualFile = fileItem?.file || fileItem;
    
    if (!actualFile || !actualFile.type) {
        console.log("ChatEncryption: No file.type found for:", fileItem);
        return false;
    }
    
    console.log("ChatEncryption: Checking file type:", actualFile.type);
    return actualFile.type.startsWith('image/');
}

// Helper function to create encrypted file replacement
async function createEncryptedFile(originalFile: File): Promise<File> {
    const result = await encryptImageToMessage(originalFile, settings.store.secretPhrase);
    
    if (!result.success) {
        throw new Error(result.error || "Encryption failed");
    }
    
    // Create a text file with the encrypted content (explicitly UTF-8)
    const encryptedBlob = new Blob([result.text], { type: 'text/plain; charset=utf-8' });
    
    // Remove extension from filename and add .txt to make it a valid text file
    const baseName = originalFile.name.replace(/\.[^/.]+$/, "");
    
    return new File([encryptedBlob], `${baseName}.txt`, {
        type: 'text/plain; charset=utf-8'
    });
}

const messageCtxPatch: NavContextMenuPatchCallback = (children, { message }: { message: Message; }) => {
    const content = getMessageContent(message);
    if (!content) return;

    const group = findGroupChildrenByChildId("copy-text", children);
    if (!group) return;

    group.splice(group.findIndex(c => c?.props?.id === "copy-text") + 1, 0, (
        <Menu.MenuItem
            id="vc-decrypt"
            label="Decrypt Message"
            icon={EncryptionIcon}
            action={async () => {
                let contentToDecrypt = content;

                // Check if this is a hidden message first
                if (isHiddenMessage(content)) {
                    const extractedEncrypted = extractHiddenMessage(content);
                    if (extractedEncrypted) {
                        contentToDecrypt = extractedEncrypted;
                    }
                }

                if (isEncryptedMessage(contentToDecrypt)) {
                    // Try auto-decryption first
                    const allPhrases = [
                        settings.store.secretPhrase,
                        ...settings.store.backupSecretPhrases.split(',').map(p => p.trim()).filter(Boolean)
                    ].filter(Boolean);

                    if (allPhrases.length > 0) {
                        const result = await decryptWithMultiplePhrases(contentToDecrypt, allPhrases);
                        if (result.success) {
                            handleDecryption(message.id, result);
                            return;
                        }
                    }
                }

                // Show manual decryption modal
                openModal(props => (
                    <DecryptionModal
                        rootProps={props}
                        encryptedContent={contentToDecrypt}
                        onSuccess={(decryptedText, usedPhrase) => {
                            handleDecryption(message.id, { text: decryptedText, success: true });
                        }}
                    />
                ));
            }}
        />
    ));
};

function getMessageContent(message: Message) {
    return message.content
        || message.messageSnapshots?.[0]?.message.content
        || message.embeds?.find(embed => embed.type === "auto_moderation_message")?.rawDescription || "";
}


let tooltipTimeout: any;

export default definePlugin({
    name: "ChatEncryption",
    description: "Encrypt and decrypt Discord messages with AES-256-GCM encryption",
    authors: [
        {
        id: 236950175480807424n,
        name: "max2fly"
        }
    ],
    settings,

    patches: [],

    contextMenus: {
        "message": messageCtxPatch
    },

    renderMessageAccessory: props => <EncryptionAccessory message={props.message} />,

    renderChatBarButton: EncryptionChatBarIcon,

    // Runtime interception setup
    originalAddFiles: null as any,
    
    setupUploadInterception() {
        console.log("ChatEncryption: Setting up upload interception...");
        
        try {
            // Wait for modules to be available
            setTimeout(() => {
                if (UploadAttachmentStore && UploadAttachmentStore.addFiles) {
                    console.log("ChatEncryption: Found UploadAttachmentStore.addFiles, intercepting...");
                    
                    // Store original function
                    this.originalAddFiles = UploadAttachmentStore.addFiles.bind(UploadAttachmentStore);
                    
                    // Replace with our interceptor
                    UploadAttachmentStore.addFiles = async (uploadConfig: any) => {
                        console.log("ChatEncryption: addFiles intercepted with uploadConfig:", uploadConfig);
                        
                        if (uploadConfig && uploadConfig.files && Array.isArray(uploadConfig.files)) {
                            console.log("ChatEncryption: Found files in uploadConfig:", uploadConfig.files);
                            
                            if (settings.store.autoEncryptImages && settings.store.autoEncrypt && settings.store.secretPhrase) {
                                console.log("ChatEncryption: Processing files...");
                                const processedFiles = await this.processFilesBeforeAdd(uploadConfig.files);
                                
                                // Create modified config with processed files
                                const modifiedConfig = {
                                    ...uploadConfig,
                                    files: processedFiles
                                };
                                
                                console.log("ChatEncryption: Calling original addFiles with processed files");
                                return this.originalAddFiles(modifiedConfig);
                            }
                        }
                        
                        return this.originalAddFiles(uploadConfig);
                    };
                    
                    console.log("ChatEncryption: Upload interception setup complete");
                } else {
                    console.warn("ChatEncryption: UploadAttachmentStore.addFiles not found, retrying...");
                    // Retry in case modules aren't loaded yet
                    setTimeout(() => this.setupUploadInterception(), 1000);
                }
            }, 100);
        } catch (error) {
            console.error("ChatEncryption: Failed to setup upload interception:", error);
        }
    },

    // Process files before they're added to the upload store
    async processFilesBeforeAdd(files: any) {
        console.log("ChatEncryption: processFilesBeforeAdd called with files:", files);
        console.log("ChatEncryption: files type:", typeof files);
        console.log("ChatEncryption: files is array:", Array.isArray(files));
        
        // Handle case where files might not be an array or might be undefined
        if (!files) {
            console.log("ChatEncryption: files is null/undefined, returning as-is");
            return files;
        }
        
        // Convert to array if it's not already
        const filesArray = Array.isArray(files) ? files : [files];
        console.log("ChatEncryption: filesArray:", filesArray);
        
        if (!settings.store.autoEncryptImages || !settings.store.autoEncrypt || !settings.store.secretPhrase) {
            console.log("ChatEncryption: Skipping - settings not enabled");
            return files;
        }

        // Process each file and replace with encrypted version if it's an image
        const processedFiles = [];
        for (let i = 0; i < filesArray.length; i++) {
            const fileItem = filesArray[i];
            console.log(`ChatEncryption: Processing file ${i}:`, fileItem);
            
            if (fileItem && isImageFile(fileItem)) {
                try {
                    // Extract the actual File object from Discord's wrapper
                    const actualFile = fileItem.file || fileItem;
                    console.log("ChatEncryption: Encrypting image file:", actualFile.name);
                    
                    const encryptedFile = await createEncryptedFile(actualFile);
                    console.log("ChatEncryption: Created encrypted file:", encryptedFile);
                    
                    // Create new file item with encrypted file
                    const processedFileItem = {
                        ...fileItem,
                        file: encryptedFile
                    };
                    
                    processedFiles.push(processedFileItem);
                    console.log("ChatEncryption: Successfully processed image file");
                    
                } catch (error) {
                    console.error("ChatEncryption: Failed to encrypt file:", error);
                    processedFiles.push(fileItem); // fallback to original
                }
            } else {
                console.log(`ChatEncryption: File ${i} is not an image, keeping original`);
                processedFiles.push(fileItem);
            }
        }
        
        console.log("ChatEncryption: Finished processing files, returning:", processedFiles);
        return processedFiles;
    },

    // Process all uploads in-place before Discord handles them
    async processUploadsBlocking(uploads: any[]) {
        console.log("ChatEncryption: processUploadsBlocking called with uploads:", uploads);
        
        if (!settings.store.autoEncryptImages || !settings.store.secretPhrase) {
            console.log("ChatEncryption: Skipping - settings not enabled");
            return;
        }

        // Process uploads in-place - modify the array elements directly
        for (let i = 0; i < uploads.length; i++) {
            const upload = uploads[i];
            console.log(`ChatEncryption: Processing upload ${i}:`, upload);
            
            // Check if this upload has an image file
            if (upload?.item?.file && isImageFile(upload.item.file)) {
                try {
                    console.log("ChatEncryption: Encrypting image upload:", upload.filename);
                    
                    const encryptedFile = await createEncryptedFile(upload.item.file);
                    console.log("ChatEncryption: Created encrypted file:", encryptedFile);
                    
                    // Modify the upload object in-place
                    upload.item.file = encryptedFile;
                    upload.filename = encryptedFile.name;
                    upload.mimeType = encryptedFile.type;
                    upload.isImage = false;
                    upload.isVideo = false;
                    upload.classification = null;
                    
                    // Update size properties
                    upload.currentSize = encryptedFile.size;
                    upload.preCompressionSize = encryptedFile.size;
                    upload.postCompressionSize = encryptedFile.size;
                    
                    // Clear cached properties
                    upload.contentHash = null;
                    upload.etag = null;
                    
                    console.log("ChatEncryption: Successfully encrypted upload:", upload.filename);
                    
                    // Log file content preview
                    const reader = new FileReader();
                    reader.onload = () => {
                        const content = reader.result as string;
                        console.log("ChatEncryption: Encrypted file content preview:", content.substring(0, 100));
                    };
                    reader.readAsText(encryptedFile);
                    
                } catch (error) {
                    console.error("ChatEncryption: Failed to encrypt upload:", error);
                }
            } else {
                console.log(`ChatEncryption: Upload ${i} is not an image file, skipping`);
            }
        }
        
        console.log("ChatEncryption: Finished processing all uploads");
    },

    start() {
        // Clean up old cached data without dimensions
        cleanupLegacyCache();
        
        // Auto-decrypt messages when the plugin starts
        this.autoDecryptVisibleMessages();
        
        // Intercept Discord's upload functions at runtime
        this.setupUploadInterception();
    },

    stop() {
        // Clean up when plugin is disabled
        if (this.originalAddFiles && UploadAttachmentStore) {
            console.log("ChatEncryption: Restoring original addFiles function");
            UploadAttachmentStore.addFiles = this.originalAddFiles;
            this.originalAddFiles = null;
        }
    },

    async autoDecryptVisibleMessages() {
        // This will be called to decrypt all visible messages
        const allPhrases = [
            settings.store.secretPhrase,
            ...settings.store.backupSecretPhrases.split(',').map(p => p.trim()).filter(Boolean)
        ].filter(Boolean);

        if (allPhrases.length === 0) return;

        // Process messages in the background, with delay to let Discord load messages first
        setTimeout(async () => {
            const { decryptAllQueuedMessages, restoreAllCachedAttachments } = await import("./EncryptionAccessory");
            
            // Process any new encrypted messages first
            decryptAllQueuedMessages();
            
            // Then restore cached attachments after Discord has loaded messages
            setTimeout(() => {
                restoreAllCachedAttachments();
                
                // Set up periodic restoration in case of race conditions
                const intervalId = setInterval(() => {
                    restoreAllCachedAttachments();
                }, 2000);
                
                // Stop after 10 seconds to avoid infinite checking
                setTimeout(() => clearInterval(intervalId), 10000);
            }, 2000);
        }, 1000);
    },

    renderMessagePopoverButton(message: Message) {
        const content = getMessageContent(message);
        if (!content) return null;

        return {
            label: "Decrypt",
            icon: EncryptionIcon,
            message,
            channel: ChannelStore.getChannel(message.channel_id),
            onClick: async () => {
                let contentToDecrypt = content;

                // Check if this is a hidden message first
                if (isHiddenMessage(content)) {
                    const extractedEncrypted = extractHiddenMessage(content);
                    if (extractedEncrypted) {
                        contentToDecrypt = extractedEncrypted;
                    }
                }

                if (isEncryptedMessage(contentToDecrypt)) {
                    // Try auto-decryption first
                    const allPhrases = [
                        settings.store.secretPhrase,
                        ...settings.store.backupSecretPhrases.split(',').map(p => p.trim()).filter(Boolean)
                    ].filter(Boolean);

                    if (allPhrases.length > 0) {
                        const result = await decryptWithMultiplePhrases(contentToDecrypt, allPhrases);
                        if (result.success) {
                            handleDecryption(message.id, result);
                            return;
                        }
                    }
                }

                // Show manual decryption modal
                openModal(props => (
                    <DecryptionModal
                        rootProps={props}
                        encryptedContent={contentToDecrypt}
                        onSuccess={(decryptedText, usedPhrase) => {
                            handleDecryption(message.id, { text: decryptedText, success: true });
                        }}
                    />
                ));
            }
        };
    },

    async onBeforeMessageSend(_, message) {
        if (!settings.store.autoEncrypt) return;
        if (!message.content) return;
        if (!settings.store.secretPhrase) {
            console.warn("Auto-encrypt enabled but no secret phrase set");
            return;
        }

        setShouldShowEncryptionEnabledTooltip?.(true);
        clearTimeout(tooltipTimeout);
        tooltipTimeout = setTimeout(() => setShouldShowEncryptionEnabledTooltip?.(false), 2000);

        const result = await encrypt(message.content, settings.store.secretPhrase);
        if (result.success) {
            if (settings.store.useHiddenMessages) {
                // Use steganographic hiding mode
                try {
                    const hiddenMessage = await createHiddenMessage(result.text);
                    message.content = hiddenMessage;
                } catch (error) {
                    console.error("Failed to create hidden message, falling back to normal encryption:", error);
                    message.content = result.text;
                }
            } else {
                // Use normal encryption display
                message.content = result.text;
            }
        } else {
            console.error("Failed to encrypt message:", result.error);
        }
    }
});
