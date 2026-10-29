import type { AuthState, GoogleDriveAuth, IceboltAuthError } from './GoogleDriveAuth.js';

export interface DriveConnectButtonOptions {
  /** Runs after a successful sign-in (e.g. pull the database and start the app). */
  onConnected?: (accessToken: string) => void | Promise<void>;
  /** Sign-in errors (cancelled popup, scope denied, …). The message is already shown under the button. */
  onError?: (error: IceboltAuthError) => void;
  labels?: Partial<Record<AuthState, string>>;
  doc?: Document;
}

const DEFAULT_LABELS: Record<AuthState, string> = {
  'signed-out': 'Connect Google Drive',
  'signing-in': 'Connecting…',
  'signed-in': 'Google Drive connected',
  'needs-reconnect': 'Reconnect Google Drive',
};

/**
 * A button that tracks auth state. Clicking it while signed out or
 * disconnected opens Google's popup inside the click, so it is never blocked.
 */
export function renderDriveConnectButton(auth: GoogleDriveAuth, options: DriveConnectButtonOptions = {}): HTMLElement {
  const doc = options.doc ?? document;
  const labels = { ...DEFAULT_LABELS, ...options.labels };

  const wrap = doc.createElement('div');
  wrap.className = 'icebolt-drive-connect';
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'icebolt-drive-connect__button';
  const status = doc.createElement('small');
  status.className = 'icebolt-drive-connect__status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  wrap.append(button, status);

  const render = (): void => {
    const s = auth.state;
    button.textContent = labels[s];
    button.dataset['state'] = s;
    button.disabled = s === 'signing-in' || s === 'signed-in';
  };

  button.addEventListener('click', () => {
    status.textContent = '';
    auth.signIn().then(
      (token) => {
        void Promise.resolve(options.onConnected?.(token)).catch((err: unknown) => {
          status.textContent = err instanceof Error ? err.message : String(err);
        });
      },
      (err: IceboltAuthError) => {
        status.textContent = err.authCode === 'cancelled' ? '' : err.message;
        options.onError?.(err);
      },
    );
  });

  const off = auth.subscribe((e) => {
    if (e.type === 'state') render();
    if (e.type === 'error' && e.error.authCode === 'interaction-required') status.textContent = 'Your Google session expired. Reconnect to keep syncing.';
    if (e.type === 'token') status.textContent = '';
  });
  // Allow callers to detach the listener by removing the element and calling this.
  (wrap as HTMLElement & { iceboltDispose?: () => void }).iceboltDispose = off;
  render();
  return wrap;
}
