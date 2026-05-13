import type {
  DesktopNotificationActivation,
  DesktopNotificationInput,
  DesktopNotificationShowResult,
  DesktopNotificationSupport,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

import * as IpcChannels from "../ipc/channels.ts";
import * as ElectronWindow from "./ElectronWindow.ts";

const MAX_LIVE_NOTIFICATIONS = 100;

export interface ElectronNotificationsShape {
  readonly getSupport: Effect.Effect<DesktopNotificationSupport>;
  readonly show: (input: DesktopNotificationInput) => Effect.Effect<DesktopNotificationShowResult>;
}

export class ElectronNotifications extends Context.Service<
  ElectronNotifications,
  ElectronNotificationsShape
>()("t3/desktop/electron/Notifications") {}

function toActivation(input: DesktopNotificationInput): DesktopNotificationActivation {
  return {
    id: input.id,
    kind: input.kind,
    ...(input.route ? { route: input.route } : {}),
  };
}

const make = Effect.gen(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);
  const liveNotifications = new Map<string, Electron.Notification>();

  const evictOldestNotification = () => {
    const oldestKey = liveNotifications.keys().next().value as string | undefined;
    if (oldestKey === undefined) {
      return;
    }
    const notification = liveNotifications.get(oldestKey);
    liveNotifications.delete(oldestKey);
    notification?.close();
  };

  const retainNotification = (id: string, notification: Electron.Notification) => {
    liveNotifications.set(id, notification);
    while (liveNotifications.size > MAX_LIVE_NOTIFICATIONS) {
      evictOldestNotification();
    }
  };

  return ElectronNotifications.of({
    getSupport: Effect.sync(() => ({
      supported: Electron.Notification.isSupported(),
      platform: process.platform,
    })),
    show: (input) =>
      Effect.promise<DesktopNotificationShowResult>(() => {
        if (!Electron.Notification.isSupported()) {
          return Promise.resolve({ shown: false, reason: "unsupported" });
        }

        return new Promise<DesktopNotificationShowResult>((resolve) => {
          let settled = false;
          const notificationOptions: Electron.NotificationConstructorOptions & {
            id?: string;
            groupId?: string;
          } = {
            id: input.id,
            title: input.title,
            body: input.body,
            ...(input.subtitle ? { subtitle: input.subtitle } : {}),
            ...(input.groupId ? { groupId: input.groupId } : {}),
            ...(input.silent !== undefined ? { silent: input.silent } : {}),
          };
          const notification = new Electron.Notification(notificationOptions);

          const cleanup = () => {
            if (liveNotifications.get(input.id) === notification) {
              liveNotifications.delete(input.id);
            }
          };

          notification.once("show", () => {
            if (!settled) {
              settled = true;
              resolve({ shown: true, reason: "shown" });
            }
          });
          notification.once("failed", (_event, error) => {
            cleanup();
            if (!settled) {
              settled = true;
              resolve({
                shown: false,
                reason: "failed",
                ...(typeof error === "string" ? { message: error } : {}),
              });
            }
          });
          notification.once("close", cleanup);
          notification.once("click", () => {
            const activation = toActivation(input);
            void runPromise(
              Effect.gen(function* () {
                const window = yield* electronWindow.currentMainOrFirst;
                if (Option.isSome(window)) {
                  yield* electronWindow.reveal(window.value);
                }
                yield* electronWindow.sendAll(
                  IpcChannels.NOTIFICATION_ACTIVATED_CHANNEL,
                  activation,
                );
              }),
            );
            notification.close();
          });

          retainNotification(input.id, notification);
          notification.show();
        });
      }).pipe(Effect.withSpan("desktop.electron.notifications.show")),
  });
});

export const layer = Layer.effect(ElectronNotifications, make);
