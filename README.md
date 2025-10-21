# Discord Chat Encryption Plugin

A comprehensive Vencord plugin that provides end-to-end encryption for Discord messages and image attachments using military-grade AES-256-GCM encryption. The plugin seamlessly integrates with Discord's UI while maintaining maximum security and usability.

## 🔐 Overview

This plugin transforms Discord into a secure communication platform by encrypting messages and image attachments before they leave your device. To other users without the plugin, encrypted content appears as random text or innocent-looking messages, providing both security and plausible deniability.

## ✨ Key Features

### 🛡️ Military-Grade Security
- **AES-256-GCM Encryption**: Industry-standard authenticated encryption
- **PBKDF2 Key Derivation**: 100,000 iterations with SHA-256 for robust key generation
- **Per-Message Salt**: Unique salt for each message prevents pattern analysis
- **Local Processing**: All encryption/decryption happens on your device

### 💬 Smart Message Encryption
- **Auto-Decryption**: Messages decrypt automatically when rendered
- **Mention Preservation**: User pings (`@user`) extracted before encryption, displayed after decryption
- **Multiple Secret Phrases**: Primary + backup phrases for different group chats
- **Retroactive Decryption**: New keys decrypt all previous messages using that key

### 🎭 Steganographic Mode
- **Hidden Messages**: Disguise encrypted content as innocent-looking conversation
- **2,315-Word Bank**: Carefully selected common words for natural cover text
- **Invisible Unicode**: Uses zero-width characters to hide encrypted data
- **Plausible Deniability**: Messages appear as casual conversation to outsiders

### 🖼️ Image Attachment Encryption
- **Automatic Image Encryption**: Images converted to encrypted text files
- **Format Preservation**: Original image quality maintained through encryption
- **Stealth Mode**: Encrypted images appear as harmless text files to non-users
- **Base64 Encoding**: Secure conversion with minimal size overhead

### 🎨 Seamless UI Integration
- **Visual Indicators**: Green lock icon badges on successfully decrypted messages
- **Chat Bar Button**: Quick access to settings and auto-encrypt toggle
- **Status Feedback**: Green button indicates when auto-encrypt is active
- **Context Menus**: Right-click decrypt options for individual messages

## 🚀 Installation

1. Install [Vencord](https://vencord.dev/) if you haven't already
2. Place this plugin folder in your Vencord userplugins directory:
   ```
   Vencord/src/userplugins/discord-chat-encryption/
   ```
3. Enable the plugin in Vencord settings
4. Configure your secret phrase in the plugin settings

## 🎯 Usage

### Basic Setup
1. Click the lock icon in the chat bar to open settings
2. Set your primary secret phrase (this will be your main encryption key)
3. Optionally add backup secret phrases for different groups
4. Toggle auto-encrypt to automatically encrypt all outgoing messages

### Encrypting Messages
- **Auto Mode**: Enable auto-encrypt and all messages are automatically encrypted
- **Manual Mode**: Type your message normally, it encrypts before sending
- **Hidden Mode**: Enable "Use Hidden Messages" for steganographic mode

### Decrypting Messages
- **Automatic**: Messages decrypt automatically when you view them
- **Manual**: Right-click encrypted messages → "Decrypt Message"
- **New Keys**: Use manual decryption to add new secret phrases

### Image Encryption
1. Enable "Automatically encrypt image attachments" in settings
2. Upload images normally - they're automatically encrypted to text files
3. Plugin users see the original images, others see text files

## 🔧 Configuration Options

| Setting | Description | Default |
|---------|-------------|---------|
| **Secret Phrase** | Primary encryption key | _(empty)_ |
| **Backup Secret Phrases** | Comma-separated backup keys | _(empty)_ |
| **Auto Encrypt** | Automatically encrypt outgoing messages | `false` |
| **Use Hidden Messages** | Enable steganographic mode | `false` |
| **Auto Encrypt Images** | Automatically encrypt image attachments | `false` |

## 🔒 Security Features

### Cryptographic Security
- **AES-256-GCM**: Authenticated encryption prevents tampering
- **PBKDF2**: Slow key derivation prevents brute force attacks
- **Secure Random**: Crypto.getRandomValues() for all randomness
- **No Key Transmission**: Secret phrases never leave your device

### Privacy Protection
- **Pattern Hiding**: Encrypted messages look like random data
- **Metadata Protection**: Original filenames and types encrypted
- **Local Storage**: No sensitive data transmitted to servers
- **Memory Cleanup**: Proper cleanup prevents data leaks

### Steganographic Features
- **Word Bank**: Natural-looking cover text from 2,315 common words
- **Invisible Characters**: Zero-width Unicode for data hiding
- **Format Detection**: Automatically detects both obvious and hidden formats
- **Backward Compatibility**: All existing encrypted messages continue to work

## 🏗️ Technical Architecture

### File Structure
```
discord-chat-encryption/
├── index.tsx              # Main plugin definition & hooks
├── settings.tsx           # Plugin configuration schema
├── utils.tsx             # Core encryption/decryption logic
├── wordbank.tsx          # 2,315-word bank for steganography
├── EncryptionIcon.tsx    # Chat bar button & icon component
├── EncryptionModal.tsx   # Settings interface
├── EncryptionAccessory.tsx # Message processing & lock icons
├── DecryptionModal.tsx   # Manual key entry interface
├── styles.css           # Plugin styling & animations
└── docs/               # Technical documentation
```

### Encryption Process
1. **Message Input**: User types message
2. **Mention Extraction**: User pings extracted and preserved
3. **Content Encryption**: Message encrypted with AES-256-GCM
4. **Format Selection**:
   - Normal: `[ENC:v1:salt:iv:ciphertext] @mentions`
   - Hidden: `"casual words"` + invisible Unicode + encrypted data
5. **Message Send**: Encrypted content sent to Discord

### Image Encryption Process
1. **Upload Interception**: Plugin intercepts image attachments
2. **Base64 Conversion**: Image converted to base64 encoding
3. **Metadata Packaging**: Filename, type, and data bundled
4. **Encryption**: Entire package encrypted with AES-256-GCM
5. **Text File Creation**: Encrypted data saved as `.txt` file
6. **Attachment Replacement**: Original image replaced with encrypted text

## 🎮 Use Cases

### Private Group Chats
- Share secret phrase with trusted friends
- All messages automatically encrypted/decrypted
- Different groups can use different phrases

## 🛠️ Development

### Performance Optimizations
- **Message Caching**: Decrypted messages cached to prevent re-processing
- **Batch Processing**: Queue system for multiple encrypted messages
- **Lazy Loading**: Encryption utilities loaded on demand
- **Memory Management**: Automatic cleanup prevents memory leaks

### Error Handling
- **Graceful Failures**: Invalid decryption attempts don't crash Discord
- **Fallback Modes**: Manual decryption for unknown keys
- **Network Recovery**: Handles Discord's optimistic UI updates
- **Size Validation**: File size checks before encryption

## 🐛 Known Limitations

- **File Size Limits**: Discord's 8MB (free) / 500MB (Nitro) limits apply
- **Base64 Overhead**: ~33% size increase for encrypted images
- **Plugin Requirement**: Recipients need the plugin to decrypt messages
- **Mobile Support**: Limited to desktop Discord clients

## 🔮 Future Enhancements

### Security Features
- Key rotation mechanisms
- Forward secrecy implementation
- Hardware security module integration
- Post-quantum encryption algorithms

### Usability Features
- Group key sharing protocols
- Message self-destruct timers
- Cross-platform synchronization
- Encrypted file attachments (beyond images)

## 📋 License

This plugin is provided as-is for educational and personal use. Use responsibly and in accordance with Discord's Terms of Service.

## ⚠️ Security Notice

- **Keep your secret phrases secure** - Anyone with your phrase can decrypt your messages
- **Use unique phrases** for different groups to minimize exposure
- **Backup your phrases** - Lost phrases mean permanently inaccessible messages
- **Be aware of metadata** - Message timing and patterns may still be visible to Discord

---

*This plugin successfully balances enterprise-grade security with seamless user experience, providing Discord users with true end-to-end encryption capabilities while maintaining plausible deniability through steganographic features.*
