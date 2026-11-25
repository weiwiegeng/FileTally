import { useSettingsStore } from '../stores/settingsStore';
import { useNavigationStore } from '../stores/navigationStore';

let permissionAsked = false;

async function ensurePermission(): Promise<boolean> {
  if (typeof Notification === 'undefined') {
    return false;
  }
  if (Notification.permission === 'granted') {
    return true;
  }
  if (Notification.permission === 'denied') {
    return false;
  }
  if (!permissionAsked) {
    permissionAsked = true;
    try {
      const perm = await Notification.requestPermission();
      return perm === 'granted';
    } catch {
      return false;
    }
  }
  return false;
}

/** Reserved hook for future OS click callbacks. */
export async function bindNotificationActions(): Promise<void> {
  // Per-notification onclick is attached in notifyTaskDone.
}

export async function notifyTaskDone(opts: {
  title: string;
  body?: string;
  openTasks?: boolean;
}): Promise<void> {
  if (!useSettingsStore.getState().settings.desktopNotifications) {
    return;
  }

  const openTasks = () => {
    if (opts.openTasks) {
      useNavigationStore.getState().openMenu('tasks');
    }
  };

  const ok = await ensurePermission();
  if (ok) {
    try {
      const n = new Notification(opts.title, {
        body: opts.body,
        tag: 'filetally-task',
      });
      n.onclick = () => {
        window.focus();
        useNavigationStore.getState().openMenu('tasks');
        n.close();
      };
    } catch {
      // ignore
    }
  }
  openTasks();
}
