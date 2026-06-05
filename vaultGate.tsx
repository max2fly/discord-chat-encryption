import { openModal } from "@utils/modal";

import { hasVault, isVaultLocked } from "./store";
import { VaultUnlockModal } from "./VaultUnlockModal";

/**
 * Ensure the encryption vault is unlocked before a write.
 *
 * If the vault is encrypted but not yet unlocked this session, this opens the
 * setup (first run) / unlock (returning) modal and returns `false` so the caller
 * aborts — the user retries the action after completing the modal. Returns `true`
 * when the vault is ready (plaintext, or already unlocked).
 */
export function ensureVaultUnlocked(): boolean {
    if (!isVaultLocked()) return true;
    openModal(props => <VaultUnlockModal rootProps={props} fresh={!hasVault()} />);
    return false;
}
