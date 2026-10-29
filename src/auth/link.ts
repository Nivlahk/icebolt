import type { GoogleDriveSyncManager } from '../sync/GoogleDriveSyncManager.js';
import { IceboltSyncError } from '../sync/GoogleDriveSyncManager.js';
import type { GoogleDriveAuth } from './GoogleDriveAuth.js';

/**
 * Keep auth and sync consistent:
 * - Drive answering 401 (token revoked or expired early) invalidates the cached
 *   token, which flips auth to `needs-reconnect` so the UI can show a button;
 * - after a successful (re)connect, any push that failed or waited for auth is
 *   flushed immediately.
 */
export function linkAuthToSync(auth: GoogleDriveAuth, sync: GoogleDriveSyncManager): () => void {
  const offSync = sync.subscribe((e) => {
    if (e.type === 'error' && e.error instanceof IceboltSyncError && e.error.code === 'auth' && e.error.status === 401) {
      auth.invalidate();
    }
  });
  const offAuth = auth.subscribe((e) => {
    if (e.type === 'token' && sync.hasPendingPush && sync.state !== 'disposed') {
      void sync.flush().catch(() => undefined); // failures are reported through sync's own error events
    }
  });
  return () => {
    offSync();
    offAuth();
  };
}
