import { insertTextIntoChatInputBox } from "@utils/discord";

import { publicBundle } from "./crypto/asymmetric";
import { buildKeyAnnounceWire } from "./crypto/stealth";
import { wrapWire } from "./crypto/stego";
import { ensureIdentity } from "./store";
import { getRandomWords } from "./utils";

/**
 * Insert our public-key announce blob (markerless wire format) into the message box so the user
 * can review and send it themselves — no auto-send. Same mechanism the gifPaste plugin uses.
 * Steganography (if enabled for the DM) is applied at SEND time, exactly like encrypted messages.
 */
export async function insertMyKeyIntoChat(): Promise<void> {
    const id = await ensureIdentity();
    const bytes = await buildKeyAnnounceWire(publicBundle(id));
    insertTextIntoChatInputBox(wrapWire(bytes, { stego: false, words: getRandomWords(4) }));
}
