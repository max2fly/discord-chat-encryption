import { insertTextIntoChatInputBox } from "@utils/discord";

import { publicBundle } from "./crypto/asymmetric";
import { encodeKeyAnnounce } from "./crypto/codec";
import { ensureIdentity } from "./store";

/**
 * Insert our public-key announce blob (`[PGPKEY:v1:…]`) into the message box so the user can
 * review and send it themselves — no auto-send. Same mechanism the gifPaste plugin uses.
 * Steganography (if enabled for the DM) is applied at SEND time, exactly like encrypted messages.
 */
export async function insertMyKeyIntoChat(): Promise<void> {
    const id = await ensureIdentity();
    insertTextIntoChatInputBox(encodeKeyAnnounce(publicBundle(id)));
}
