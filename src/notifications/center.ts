import {
  notificationVisible,
  type NotificationCenterState,
  type NotificationEntry,
  type NotificationEvent,
  type NotificationMode,
} from "./types";

export const NOTIFICATION_LIMIT = 100;

export type NotificationCenter = {
  publish: (events: readonly NotificationEvent[]) => void;
  setMode: (mode: NotificationMode) => void;
  mode: () => NotificationMode;
  markAllRead: () => void;
  markRead: (id: string) => void;
  clear: () => void;
  state: () => NotificationCenterState;
  find: (id: string) => NotificationEntry | undefined;
};

export const createNotificationCenter = (options: {
  mode?: NotificationMode;
  limit?: number;
} = {}): NotificationCenter => {
  const limit = options.limit ?? NOTIFICATION_LIMIT;
  let mode: NotificationMode = options.mode ?? "material";
  let entries: NotificationEntry[] = [];

  const visibleEntries = (): NotificationEntry[] =>
    entries.filter((entry) => notificationVisible(mode, entry.level));

  return {
    publish: (events) => {
      events.forEach((event) => {
        const held = entries.find((entry) => entry.id === event.id);
        if (held !== undefined && held.text === event.text) return;
        entries = [
          ...entries.filter((entry) => entry.id !== event.id),
          { ...event, read: false },
        ];
      });
      if (entries.length > limit) entries = entries.slice(entries.length - limit);
    },
    setMode: (next) => {
      mode = next;
    },
    mode: () => mode,
    markAllRead: () => {
      entries = entries.map((entry) =>
        notificationVisible(mode, entry.level) ? { ...entry, read: true } : entry);
    },
    markRead: (id) => {
      entries = entries.map((entry) => entry.id === id ? { ...entry, read: true } : entry);
    },
    clear: () => {
      entries = [];
    },
    state: () => {
      const visible = visibleEntries();
      return {
        mode,
        unread: visible.filter((entry) => !entry.read).length,
        events: [...visible].reverse(),
      };
    },
    find: (id) => entries.find((entry) => entry.id === id),
  };
};
