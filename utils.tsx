import { WORD_BANK } from "./wordbank";

export const cl = (className: string | Record<string, boolean>) => {
    if (typeof className === "string") return `vc-encryption-${className}`;
    return Object.entries(className)
        .filter(([, value]) => value)
        .map(([key]) => `vc-encryption-${key}`)
        .join(" ");
};

export interface EncryptionResult {
    text: string;
    success: boolean;
    error?: string;
    mentions?: string;
}

export interface EncryptionData {
    content: string;
    mentions: string;
}

const ENCRYPTION_PREFIX = "[ENC:v1:";
const ENCRYPTION_SUFFIX = "]";
const PBKDF2_ITERATIONS = 100000;

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
    const passwordBuffer = new TextEncoder().encode(password);
    const importedKey = await crypto.subtle.importKey(
        "raw",
        passwordBuffer,
        "PBKDF2",
        false,
        ["deriveKey"]
    );

    return await crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: salt,
            iterations: PBKDF2_ITERATIONS,
            hash: "SHA-256"
        },
        importedKey,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

function extractMentions(message: string): EncryptionData {
    const mentionRegex = /<@!?(\d+)>|<@&(\d+)>|<#(\d+)>/g;
    const mentions: string[] = [];
    let content = message;

    let match;
    while ((match = mentionRegex.exec(message)) !== null) {
        mentions.push(match[0]);
    }

    content = content.replace(mentionRegex, '').trim();

    return {
        content,
        mentions: mentions.join(' ')
    };
}

export async function encrypt(message: string, secretPhrase: string): Promise<EncryptionResult> {
    if (!message || !secretPhrase) {
        return { text: message, success: false, error: "Missing message or secret phrase" };
    }

    try {
        const { content, mentions } = extractMentions(message);

        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const key = await deriveKey(secretPhrase, salt);

        const messageBuffer = new TextEncoder().encode(content);
        const encrypted = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: iv },
            key,
            messageBuffer
        );

        const encryptedArray = new Uint8Array(encrypted);
        const saltBase64 = arrayBufferToBase64(salt.buffer);
        const ivBase64 = arrayBufferToBase64(iv.buffer);
        const encryptedBase64 = arrayBufferToBase64(encrypted);

        const encryptedMessage = `${ENCRYPTION_PREFIX}${saltBase64}:${ivBase64}:${encryptedBase64}${ENCRYPTION_SUFFIX}`;
        const finalMessage = mentions ? `${encryptedMessage} ${mentions}` : encryptedMessage;

        return { text: finalMessage, success: true, mentions };
    } catch (error) {
        console.error("Encryption failed:", error);
        return { text: message, success: false, error: "Encryption failed" };
    }
}

export async function decrypt(encryptedMessage: string, secretPhrase: string): Promise<EncryptionResult> {
    if (!encryptedMessage || !secretPhrase) {
        return { text: encryptedMessage, success: false, error: "Missing message or secret phrase" };
    }

    // For non-encrypted messages, try to decrypt anyway (manual decryption attempt)
    const messageToDecrypt = isEncryptedMessage(encryptedMessage)
        ? encryptedMessage
        : `[ENC:v1:${encryptedMessage}]`; // Assume it might be just the content part

    try {
        const encryptedPart = extractEncryptedPart(messageToDecrypt);
        if (!encryptedPart.startsWith(ENCRYPTION_PREFIX)) {
            return { text: encryptedMessage, success: false, error: "Not an encrypted message" };
        }

        const content = encryptedPart.slice(ENCRYPTION_PREFIX.length, -ENCRYPTION_SUFFIX.length);
        const [saltBase64, ivBase64, encryptedBase64] = content.split(":");

        if (!saltBase64 || !ivBase64 || !encryptedBase64) {
            return { text: encryptedMessage, success: false, error: "Invalid encrypted message format" };
        }

        try {
            const salt = new Uint8Array(base64ToArrayBuffer(saltBase64));
            const iv = new Uint8Array(base64ToArrayBuffer(ivBase64));
            const encrypted = base64ToArrayBuffer(encryptedBase64);

            const key = await deriveKey(secretPhrase, salt);
            const decrypted = await crypto.subtle.decrypt(
                { name: "AES-GCM", iv: iv },
                key,
                encrypted
            );

            const decryptedMessage = new TextDecoder().decode(decrypted);
            return { text: decryptedMessage, success: true };
        } catch (cryptoError) {
            // More specific error handling for crypto operations
            if (cryptoError instanceof DOMException) {
                if (cryptoError.name === "OperationError") {
                    return { text: encryptedMessage, success: false, error: "Wrong secret phrase" };
                } else if (cryptoError.name === "DataError") {
                    return { text: encryptedMessage, success: false, error: "Invalid encrypted data format" };
                }
            }
            throw cryptoError; // Re-throw if it's not a crypto-specific error
        }
    } catch (error) {
        console.error("Decryption failed:", error);
        return { text: encryptedMessage, success: false, error: "Decryption failed - invalid format or wrong phrase" };
    }
}

export async function decryptWithMultiplePhrases(encryptedMessage: string, secretPhrases: string[]): Promise<EncryptionResult> {
    if (!encryptedMessage || !secretPhrases.length) {
        return { text: encryptedMessage, success: false, error: "Missing message or secret phrases" };
    }

    // Extract mentions from the full message first
    const mentionRegex = /<@!?(\d+)>|<@&(\d+)>|<#(\d+)>/g;
    const mentions: string[] = [];
    let match;
    while ((match = mentionRegex.exec(encryptedMessage)) !== null) {
        mentions.push(match[0]);
    }

    for (const phrase of secretPhrases) {
        if (!phrase.trim()) continue;

        const result = await decrypt(encryptedMessage, phrase.trim());
        if (result.success) {
            // Append mentions to decrypted text
            const finalText = mentions.length > 0 ? `${result.text} ${mentions.join(' ')}` : result.text;
            return { text: finalText, success: true };
        }
    }

    return { text: encryptedMessage, success: false, error: "Failed to decrypt with any provided secret phrases" };
}

function extractEncryptedPart(message: string): string {
    const match = message.match(/\[ENC:v1:[^\]]+\]/);
    return match ? match[0] : message;
}

export function isEncryptedMessage(message: string): boolean {
    return message.includes(ENCRYPTION_PREFIX) && message.includes(ENCRYPTION_SUFFIX);
}

// Steganographic utilities for hidden messages
const HIDDEN_MESSAGE_MARKER = "\u200b"; // Zero-width space marker
const HIDDEN_CHARS = ["\u200c", "\u200d", "\u2060", "\u2061", "\u2062", "\u2063", "\u2064"]; // Invisible Unicode chars

function getRandomWords(count: number): string[] {
    const selected: string[] = [];
    const used = new Set<number>();

    while (selected.length < count && used.size < WORD_BANK.length) {
        const randomIndex = crypto.getRandomValues(new Uint32Array(1))[0] % WORD_BANK.length;
        if (!used.has(randomIndex)) {
            used.add(randomIndex);
            selected.push(WORD_BANK[randomIndex]);
        }
    }

    return selected;
}

function encodeToInvisibleChars(text: string): string {
    let result = '';
    const encoder = new TextEncoder();
    const bytes = encoder.encode(text);

    for (const byte of bytes) {
        const binary = byte.toString(2).padStart(8, '0');
        for (const bit of binary) {
            if (bit === '1') {
                result += HIDDEN_CHARS[0]; // Use first invisible char for 1
            } else {
                result += HIDDEN_CHARS[1]; // Use second invisible char for 0
            }
        }
    }

    return result;
}

function decodeFromInvisibleChars(hiddenText: string): string {
    try {
        let binaryString = '';

        for (const char of hiddenText) {
            if (char === HIDDEN_CHARS[0]) {
                binaryString += '1';
            } else if (char === HIDDEN_CHARS[1]) {
                binaryString += '0';
            }
        }

        // Convert binary to bytes
        const bytes: number[] = [];
        for (let i = 0; i < binaryString.length; i += 8) {
            const byte = binaryString.slice(i, i + 8);
            if (byte.length === 8) {
                bytes.push(parseInt(byte, 2));
            }
        }

        const decoder = new TextDecoder();
        return decoder.decode(new Uint8Array(bytes));
    } catch (error) {
        console.error("Failed to decode invisible chars:", error);
        return "";
    }
}

export async function createHiddenMessage(encryptedText: string): Promise<string> {
    // Generate 3-5 random words for cover text
    const wordCount = 3 + (crypto.getRandomValues(new Uint8Array(1))[0] % 3); // 3-5 words
    const coverWords = getRandomWords(wordCount);
    const coverText = coverWords.join(' ');

    // Encode encrypted text as invisible characters
    const hiddenChars = encodeToInvisibleChars(encryptedText);

    // Combine cover text with hidden message and marker
    return coverText + hiddenChars + HIDDEN_MESSAGE_MARKER;
}

export function extractHiddenMessage(message: string): string | null {
    if (!message.includes(HIDDEN_MESSAGE_MARKER)) {
        return null;
    }

    // Find hidden characters between visible text and marker
    const markerIndex = message.lastIndexOf(HIDDEN_MESSAGE_MARKER);
    if (markerIndex === -1) return null;

    // Extract the portion that contains hidden characters
    let hiddenPortion = "";
    for (let i = 0; i < markerIndex; i++) {
        const char = message[i];
        if (HIDDEN_CHARS.includes(char)) {
            hiddenPortion += char;
        }
    }

    if (hiddenPortion.length === 0) return null;

    return decodeFromInvisibleChars(hiddenPortion);
}

export function isHiddenMessage(message: string): boolean {
    return message.includes(HIDDEN_MESSAGE_MARKER) &&
           HIDDEN_CHARS.some(char => message.includes(char));
}
