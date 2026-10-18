# Discord Chat Encryption

A [Vencord](https://vencord.dev/) userplugin for end‑to‑end encrypting Discord messages, attachments, stickers, and media embeds. Encryption and decryption happen entirely on your device; Discord (and anyone without the plugin and the key) only ever sees innocuous‑looking text or an ordinary‑looking image.

It uses two key models depending on where you are:

- **Servers & group DMs** — a shared symmetric key per *context* (you and your peers agree on a passphrase).
- **1:1 DMs** — a PGP‑style sealed box: each side has a local keypair, exchanges public keys once (trust‑on‑first‑use), and messages are sealed to the recipient.

There is **nothing on the wire that says "this is encrypted."** No `[ENC]`/`[PGP]` markers, no tagged `.txt` files — ciphertext is either hidden between ordinary cover words (steganography) or carried as a single unremarkable token, and attachments ride inside a normal‑looking PNG. The only way the plugin recognizes its own messages is by trial‑decrypting and checking the AES‑GCM authentication tag.

> ⚠️ **Honest disclaimer.** This is a research project, not an audited secure‑messaging product. It defeats casual reading, keyword/regex scanning, and the "this is obviously encrypted" metadata signal. It does **not** claim to defeat a determined analyst who scans for zero‑width characters or structurally diffs your images, and it does not protect metadata like *who you talk to* or *when*. Don't use it where your safety depends on it. See [Security & threat model](#security--threat-model).

See: https://docs.vencord.dev/installing/custom-plugins/ for installation directions

---

## Features

- **Per‑context symmetric encryption** for servers and group DMs — AES‑256‑GCM, key derived from a passphrase you share with your peers. Keep a history of keys per context so older messages still decrypt; a newly added key retroactively decrypts everything sent under it.
- **1:1 DM sealed box (PGP‑style)** — automatic local identity, public‑key exchange with trust‑on‑first‑use (TOFU) pinning, per‑message sealing, and sender signatures. Multi‑recipient sealing means group‑DM key handoff works too.
- **Markerless stealth format** — two interchangeable transports per context:
  - **Steganographic (hidden):** ciphertext encoded as zero‑width characters tucked between a few random cover words, so the message reads as harmless small talk.
  - **Plain token:** ciphertext as a single compact base64url token when you don't need the cover text.
- **Encrypted attachments** — images, video, audio, and arbitrary files are sealed into an innocuous **cover PNG** (ciphertext lives in a private PNG chunk, raw binary — no base64 size tax). Plugin users see the real file rendered/downloaded natively; everyone else sees a small piece of abstract art.
- **Long‑message fallback** — a message too long to hide inline is automatically carried as a cover PNG instead of leaking as plaintext.
- **Encrypted stickers** — a sent sticker is folded into the encrypted message instead of being transmitted as a real (plaintext) Discord sticker, and re‑rendered natively for recipients who hold the key. Custom emojis already ride inside the encrypted text.
- **Client‑side media embeds** — Tenor/Giphy/direct image & video links inside decrypted messages are re‑created locally so they still render as embeds (toggleable; see the privacy note in settings).
- **Local key vault** — your keys are stored via Vencord's DataStore and, by default, encrypted at rest under a master passphrase you enter once per launch.
- **Zero runtime dependencies** — pure WebCrypto. Nothing to `npm install`; just drop the folder in and build.

---

## Installation

This is a Vencord **userplugin**, so it requires a [development install of Vencord](https://docs.vencord.dev/installing/).

```bash
# 1. Set up Vencord (if you haven't already)
git clone https://github.com/Vendicated/Vencord
cd Vencord
pnpm install

# 2. Clone this plugin into src/userplugins
git clone <this-repo-url> src/userplugins/discord-chat-encryption

# 3. Build and inject
pnpm build
pnpm inject     # skip if Vencord is already injected

# 4. Restart Discord, then enable "ChatEncryption" in Settings → Plugins
```
---

## Usage

Open the **lock button in the chat bar** of any channel to manage encryption for that channel. Right click the button to enable auto encryption. The button turns green when auto‑encrypt is active in this channel.

### Servers & group DMs (shared key)

1. In the channel, open the chat‑bar lock button and **set or pick a key** for the context (a passphrase you and your peers agree on).
2. **Toggle auto‑encrypt** for that context — outgoing messages are now encrypted automatically.
3. **Share the key.** Either communicate the passphrase out‑of‑band, or use the built‑in key handoff: send your key to a peer's DM and they accept it via the **"Save key to server…"** card (you choose the target server/group; nothing is auto‑applied without your click).

Anyone in the context with the same key and the plugin sees decrypted messages with a small lock badge; everyone else sees the cover text or token.

### 1:1 DMs (sealed box)

1. The plugin creates a local **identity** (ECDH + ECDSA keypair) the first time it's needed.
2. **Exchange public keys.** Post your key into the DM; the peer's plugin pins it on first sight (TOFU), and you pin theirs. A changed key is flagged and **not** silently trusted.
3. Enable **auto‑encrypt** for the DM. Messages are now sealed to your peer and signed by you.

### Steganography toggle

Stego mode is **per context**. With it on, ciphertext hides as zero‑width characters between random cover words; with it off, messages carry a single base64url token. Detection works either way.

### Attachments & stickers

Enable encryption for the context, then send files/images normally — they're sealed into a cover PNG and rendered natively on the other side. Stickers are handled automatically once auto‑encrypt is on.

---

## Settings

These are the global toggles (in **Settings → Plugins → ChatEncryption**). Per‑context state — keys, key history, auto‑encrypt, and stego mode — is **not** here; it lives with each channel/server and is managed from the chat‑bar button and key UIs.

| Setting | Description                                                                                                                                                                                                                                    | Default |
|---|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|---|
| **Encrypt local key vault at rest** | Encrypt stored keys under a master passphrase (prompted once per launch). Disable to store keys in plaintext. While on requires reenter of the keyphrase on each discord launch.                                                               | `on` |
| **Auto‑encrypt tooltip** | Show a tooltip on the chat‑bar button when a message is auto‑encrypted.                                                                                                                                                                        | `on` |
| **Recreate media embeds** | Re‑render Tenor/Giphy/image/video links in decrypted messages. **Privacy:** your client fetches the linked media (and the Tenor/Giphy APIs) directly, revealing to those hosts that you viewed the link. Turn off to keep links as plain text. | `on` |
| **Manage PGP keys** | Panel to view/manage your DM identity and pinned peer keys.                                                                                                                                                                                    | — |

---

## Cryptography

All primitives are standard WebCrypto (`crypto.subtle`); all randomness is from `crypto.getRandomValues`.

**Symmetric (servers & group DMs)**
- **AES‑256‑GCM** for message and attachment encryption.
- Key derived with **PBKDF2‑HMAC‑SHA‑256, 600,000 iterations**, from your context passphrase, with a per‑context salt.
- A fresh 12‑byte IV per message; the context identifier is bound in as AEAD *additional data*.

**Asymmetric (1:1 DMs — sealed box)**
- **ECDH P‑256** for key agreement, **ECDSA P‑256‑SHA‑256** for sender signatures.
- Each message uses a random **AES‑256‑GCM** content key; that key is wrapped per recipient with a KEK derived via **HKDF‑SHA‑256** from an *ephemeral* ECDH shared secret (one ephemeral key per message).
- Public keys are identified by fingerprint and pinned TOFU.

**Local vault (keys at rest)**
- **PBKDF2‑SHA‑256 + AES‑256‑GCM** under your master passphrase.

**Envelope** — the version byte and content type live *inside* the authenticated payload (`[version][contentType][body]`), so the format is crypto‑agile and self‑describing without any plaintext header. Content types: text, file, sticker. Recognition is by GCM‑tag trial‑decode, with no key‑id selector on the wire.

---

## Security & threat model

**What it does:** removes the obvious signals. No message or attachment is *labelled* as encrypted; an unlabelled token or an innocent PNG is far less salient than a tagged ciphertext. Content is authenticated (AES‑GCM), so tampering is detected. Keys never leave your device.

**What it does not do:**
- It is **not audited** and makes no formal security guarantee.
- Zero‑width steganography is **detectable** to anyone specifically looking for non‑printing characters; image carriers are **detectable** to anyone who structurally diffs your uploads. The goal is non‑salience, not strong steganographic deniability.
- It does **not** hide *metadata* — who you message, how often, message timing/size, or that *some* plugin is in use.
- TOFU pinning trusts the **first** key you see for a peer; if that first exchange is intercepted, so is the channel. Verify fingerprints out‑of‑band when it matters.
- Forward secrecy is limited (DM content‑key wrapping uses ephemeral ECDH; symmetric contexts reuse a shared passphrase‑derived key until you rotate it).

Use it for privacy from casual observation and bulk scanning. Do not rely on it in a situation where discovery has serious consequences.

---

## Project structure

```
discord-chat-encryption/
├── index.tsx                 # Plugin definition: send hook, upload interception, webpack patches, context menus
├── EncryptionAccessory.tsx   # Receive side: decrypt, lock badge, key-transfer cards, attachment/embed/sticker render
├── EncryptionIcon.tsx        # Chat-bar button + lock icon
├── settings.tsx              # Global settings schema
├── store.ts                  # Per-context state (keys, history, auto-encrypt, stego, peers, identity) in DataStore
├── embeds.ts                 # Client-side Tenor/Giphy/direct media embed recreation
├── PgpSettings.tsx / GuildKeyPicker.tsx / KeyEntryModal.tsx / DmKeyMenu.tsx / VaultUnlockModal.tsx
│                             # Key-management UIs
├── dmActions.ts, vaultGate.tsx, utils.tsx, wordbank.tsx, styles.css
├── crypto/                   # Pure crypto/format layer (no UI, unit-tested)
│   ├── symmetric.ts          # AES-256-GCM + PBKDF2 context keys
│   ├── asymmetric.ts         # ECDH/ECDSA identity + sealed box
│   ├── envelope.ts           # Inner envelope + content-type body codecs (text / file / sticker)
│   ├── stealth.ts            # Wire build + trial-decode
│   ├── stego.ts              # Zero-width steganography / base64url transport
│   ├── attachment.ts, imagecarrier.ts, png.ts, cover.ts, imagesize.ts  # Cover-PNG attachment carrier
└── ├── keyring.ts, keytransfer.ts, vault.ts, context.ts, codec.ts, encoding.ts, types.ts
```

---

## Credits & license

Author: **max2fly**. Built as a Vencord userplugin. Provided as‑is, with no warranty — see the threat model above before relying on it.

This is a research project, and it can lead to a ban of your account. Use at your own risk.

Disclaimer: The files are decrypted into memory, so if someone sends a malicious file, it will live decrypted in memory, and can be exfiltrated by a malicious plugin or an attacker with memory access.
