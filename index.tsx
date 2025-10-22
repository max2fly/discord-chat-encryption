import "./styles.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Devs } from "@utils/constants";
import { openModal } from "@utils/modal";
import definePlugin from "@utils/types";
import { Message } from "@vencord/discord-types";
import { ChannelStore, Menu } from "@webpack/common";
import { findByPropsLazy } from "@webpack";

import { DecryptionModal } from "./DecryptionModal";
import { EncryptionAccessory, handleDecryption, getDecryptedMessages, getDecryptedImages } from "./EncryptionAccessory";
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

const messageCtxPatch: NavContextMenuPatchCallback = (children, props) => {
    console.log("ChatEncryption: Message context menu patch called with props:", props);
    
    // Handle text decryption - check if there's a message
    if (props?.message) {
        const message = props.message;
        const content = getMessageContent(message);
        
        if (content) {
            const group = findGroupChildrenByChildId("copy-text", children);
            if (group) {
                // Add decrypt message option
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
                            openModal(modalProps => (
                                <DecryptionModal
                                    rootProps={modalProps}
                                    encryptedContent={contentToDecrypt}
                                    onSuccess={(decryptedText, usedPhrase) => {
                                        handleDecryption(message.id, { text: decryptedText, success: true });
                                    }}
                                />
                            ));
                        }}
                    />
                ));
            }
        }
    }

    // Handle image copy/save for decrypted images - similar to reverse image search
    if (props?.reverseImageSearchType === "img") {
        console.log("ChatEncryption: Image in message context menu detected");
        const src = props.itemHref ?? props.itemSrc;
        
        if (src && isDecryptedImage(src)) {
            console.log("ChatEncryption: Adding copy/save options for decrypted image in message context");
            // Try to find the group with copy-native-link (where Copy Link and Open Link are)
            const group = findGroupChildrenByChildId("copy-native-link", children) || 
                         findGroupChildrenByChildId("copy-link", children) ||
                         findGroupChildrenByChildId("open-native-link", children);
            
            console.log("ChatEncryption: Found group for copy/open link:", group);
            
            if (group) {
                group.push(
                    <Menu.MenuItem
                        id="vc-copy-decrypted-image-msg"
                        label="Copy Image"
                        icon={EncryptionIcon}
                        action={() => copyDecryptedImage(src)}
                    />,
                    <Menu.MenuItem
                        id="vc-save-decrypted-image-msg"
                        label="Save Image"
                        icon={EncryptionIcon}
                        action={() => saveDecryptedImage(src)}
                    />
                );
                console.log("ChatEncryption: Added copy/save options to message context menu");
            } else {
                console.log("ChatEncryption: No suitable group found in message context");
            }
        }
    }
};

// Image context menu patch for encrypted images - simplified like reverse image search
const imageContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    console.log("ChatEncryption: Image context menu patch called with props:", props);
    console.log("ChatEncryption: Props src:", props?.src);
    console.log("ChatEncryption: Props keys:", Object.keys(props || {}));
    
    if (!props?.src) {
        console.log("ChatEncryption: No src, skipping");
        return;
    }
    
    // Check if this is a decrypted image (data URL from our cache)
    const isDecrypted = isDecryptedImage(props.src);
    console.log("ChatEncryption: Is decrypted image:", isDecrypted);
    console.log("ChatEncryption: Image URL starts with:", props.src.substring(0, 50));
    
    if (isDecrypted) {
        console.log("ChatEncryption: Adding context menu items for decrypted image");
        
        // Find the group with copy-native-link (where "Copy Link" and "Open Link" are)
        const group = findGroupChildrenByChildId("copy-native-link", children);
        console.log("ChatEncryption: Found copy-native-link group:", group);
        
        if (group) {
            // Add copy and save options for decrypted images in the same group as copy/open link
            group.push(
                <Menu.MenuItem
                    id="vc-copy-decrypted-image"
                    label="Copy Image"
                    icon={EncryptionIcon}
                    action={() => copyDecryptedImage(props.src)}
                />,
                <Menu.MenuItem
                    id="vc-save-decrypted-image"
                    label="Save Image"
                    icon={EncryptionIcon}
                    action={() => saveDecryptedImage(props.src)}
                />
            );
            
            console.log("ChatEncryption: Added menu items to copy-native-link group, length now:", group.length);
        } else {
            console.log("ChatEncryption: copy-native-link group not found, adding to main children");
            // Fallback: add to main children if group not found
            children.push(
                <Menu.MenuItem
                    id="vc-copy-decrypted-image"
                    label="Copy Image"
                    icon={EncryptionIcon}
                    action={() => copyDecryptedImage(props.src)}
                />,
                <Menu.MenuItem
                    id="vc-save-decrypted-image"
                    label="Save Image"
                    icon={EncryptionIcon}
                    action={() => saveDecryptedImage(props.src)}
                />
            );
        }
    } else {
        console.log("ChatEncryption: Not a decrypted image, skipping");
    }
};

// Helper function to check if an image URL is from our decrypted cache
function isDecryptedImage(imageUrl: string): boolean {
    console.log("ChatEncryption: Checking if image is decrypted:", imageUrl?.substring(0, 50));
    // Our decrypted images use data URLs
    const isDataUrl = imageUrl?.startsWith('data:image/');
    
    // Also check if this URL exists in our decrypted images cache
    const decryptedImages = getDecryptedImages();
    let isInCache = false;
    for (const [key, imageInfo] of decryptedImages.entries()) {
        const cachedDataUrl = `data:${imageInfo.mimeType};base64,${imageInfo.imageData}`;
        if (cachedDataUrl === imageUrl) {
            isInCache = true;
            break;
        }
    }
    
    console.log("ChatEncryption: Is data URL:", isDataUrl, "Is in cache:", isInCache);
    return isDataUrl || isInCache;
}

// Helper function to copy decrypted image to clipboard
async function copyDecryptedImage(imageUrl: string) {
    try {
        // Convert data URL to blob
        const response = await fetch(imageUrl);
        let imageData = await response.blob();
        
        // Get original image info from our cache
        const decryptedImages = getDecryptedImages();
        let originalMimeType = imageData.type;
        let filename = "image";
        
        // Find the original image data to get proper mime type and filename
        for (const [key, imageInfo] of decryptedImages.entries()) {
            const cachedDataUrl = `data:${imageInfo.mimeType};base64,${imageInfo.imageData}`;
            if (cachedDataUrl === imageUrl) {
                originalMimeType = imageInfo.mimeType;
                filename = imageInfo.filename;
                console.log("ChatEncryption: Found original image info:", filename, originalMimeType);
                break;
            }
        }
        
        // Try to copy in original format first
        try {
            const clipboardData: Record<string, Blob> = {};
            
            // Add the original format
            if (originalMimeType && originalMimeType.startsWith('image/')) {
                clipboardData[originalMimeType] = imageData;
                console.log("ChatEncryption: Adding original format to clipboard:", originalMimeType);
            }
            
            // Also add PNG as fallback for compatibility
            if (originalMimeType !== "image/png") {
                const bitmap = await createImageBitmap(imageData);
                const canvas = document.createElement("canvas");
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
                const ctx = canvas.getContext("2d");
                if (ctx) {
                    ctx.drawImage(bitmap, 0, 0);
                    
                    const pngBlob = await new Promise<Blob | null>(resolve => {
                        canvas.toBlob(data => resolve(data), "image/png");
                    });
                    
                    if (pngBlob) {
                        clipboardData["image/png"] = pngBlob;
                        console.log("ChatEncryption: Added PNG fallback to clipboard");
                    }
                }
            }
            
            // Copy to clipboard with multiple formats
            await navigator.clipboard.write([new ClipboardItem(clipboardData)]);
            
            console.log(`ChatEncryption: Successfully copied decrypted image "${filename}" to clipboard in original format (${originalMimeType})`);
        } catch (error) {
            console.warn("ChatEncryption: Failed to copy in original format, falling back to PNG:", error);
            
            // Fallback: convert to PNG and copy
            const bitmap = await createImageBitmap(imageData);
            const canvas = document.createElement("canvas");
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const ctx = canvas.getContext("2d");
            if (ctx) {
                ctx.drawImage(bitmap, 0, 0);
                
                const pngBlob = await new Promise<Blob | null>(resolve => {
                    canvas.toBlob(data => resolve(data), "image/png");
                });
                
                if (pngBlob) {
                    await navigator.clipboard.write([
                        new ClipboardItem({ "image/png": pngBlob })
                    ]);
                    console.log("ChatEncryption: Successfully copied as PNG fallback");
                }
            }
        }
        
    } catch (error) {
        console.error("ChatEncryption: Failed to copy decrypted image:", error);
    }
}

// Helper function to save decrypted image
async function saveDecryptedImage(imageUrl: string) {
    try {
        // Convert data URL to blob
        const response = await fetch(imageUrl);
        const imageData = await response.blob();
        
        // Get original filename from decrypted images cache or create default
        const decryptedImages = getDecryptedImages();
        let filename = "decrypted_image.png";
        
        // Try to find the original filename
        for (const [key, imageInfo] of decryptedImages.entries()) {
            const cachedDataUrl = `data:${imageInfo.mimeType};base64,${imageInfo.imageData}`;
            if (cachedDataUrl === imageUrl) {
                filename = imageInfo.filename;
                break;
            }
        }
        
        // Create file and trigger download
        const file = new File([imageData], filename, { type: imageData.type });
        
        // Create download link
        const downloadUrl = URL.createObjectURL(file);
        const link = document.createElement('a');
        link.href = downloadUrl;
        link.download = filename;
        link.style.display = 'none';
        
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        // Clean up object URL
        URL.revokeObjectURL(downloadUrl);
        
        console.log("ChatEncryption: Successfully saved decrypted image:", filename);
    } catch (error) {
        console.error("ChatEncryption: Failed to save decrypted image:", error);
    }
}

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
        "message": messageCtxPatch,
        "image-context": imageContextMenuPatch
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
