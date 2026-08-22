import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { DEFAULT_SERVER_URL, normalizeServerUrl } from './ServerDiscovery';

const STORE_NAME: string = 'dsh_client_settings';
const KEY_SERVER_URL: string = 'serverUrl';
const KEY_AUTO_START: string = 'autoStartEmbedded';

/** Read the user-configured server URL, falling back to the loopback default. */
export function loadServerUrl(context: common.UIAbilityContext): string {
  const store = preferences.getPreferencesSync(context, { name: STORE_NAME });
  const saved = store.getSync(KEY_SERVER_URL, DEFAULT_SERVER_URL) as string;
  return normalizeServerUrl(saved);
}

/** Persist a server URL; the value is normalized before writing. */
export function saveServerUrl(context: common.UIAbilityContext, url: string): void {
  const store = preferences.getPreferencesSync(context, { name: STORE_NAME });
  store.putSync(KEY_SERVER_URL, normalizeServerUrl(url));
  store.flush();
}

/** Whether the client should boot the embedded dsh when no external server is found. Default on. */
export function loadAutoStartEnabled(context: common.UIAbilityContext): boolean {
  const store = preferences.getPreferencesSync(context, { name: STORE_NAME });
  return store.getSync(KEY_AUTO_START, true) as boolean;
}

/** Persist the embedded auto-start toggle. */
export function saveAutoStartEnabled(context: common.UIAbilityContext, enabled: boolean): void {
  const store = preferences.getPreferencesSync(context, { name: STORE_NAME });
  store.putSync(KEY_AUTO_START, enabled);
  store.flush();
}
