import type {
  DesktopNotificationActivation,
  DesktopNotificationRequest,
  DesktopNotificationResult,
  DesktopNotificationSupport,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";

const DEFAULT_NOTIFICATION_TTL_MS = 30_000;
const MAX_LIVE_NOTIFICATIONS = 100;
const MAX_RECENT_DEDUPE_KEYS = 500;

export interface DesktopNotificationServiceShape {
  readonly getSupport: Effect.Effect<DesktopNotificationSupport>;
  readonly show: (request: DesktopNotificationRequest) => Effect.Effect<DesktopNotificationResult>;
}

export class DesktopNotificationService extends Context.Service<
  DesktopNotificationService,
  DesktopNotificationServiceShape
>()("t3/desktop/notifications/Service") {}

const { logDebug, logWarning } = DesktopObservability.makeComponentLogger("desktop-notifications");

const toActivation = (request: DesktopNotificationRequest) =>
  Effect.map(
    DateTime.now,
    (now): DesktopNotificationActivation => ({
      notificationId: request.notificationId,
      topic: request.topic,
      createdAt: DateTime.formatIso(now),
      ...(request.route ? { route: request.route } : {}),
    }),
  );

function positiveTtlMs(ttlMs: number | undefined): number {
  return ttlMs !== undefined && Number.isFinite(ttlMs) && ttlMs > 0
    ? ttlMs
    : DEFAULT_NOTIFICATION_TTL_MS;
}

const make = Effect.gen(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);
  const runFork = Effect.runForkWith(context);
  const liveByNotificationId = new Map<string, Electron.Notification>();
  const liveTimers = new Map<string, Fiber.Fiber<void>>();
  const recentDedupeExpiresAt = new Map<string, number>();

  const clearLiveTimer = (notificationId: string) => {
    const timer = liveTimers.get(notificationId);
    if (timer) {
      timer.interruptUnsafe();
      liveTimers.delete(notificationId);
    }
  };

  const forgetLiveNotification = (notificationId: string, notification: Electron.Notification) => {
    if (liveByNotificationId.get(notificationId) === notification) {
      liveByNotificationId.delete(notificationId);
      clearLiveTimer(notificationId);
    }
  };

  const closeLiveNotification = (notificationId: string) => {
    const notification = liveByNotificationId.get(notificationId);
    liveByNotificationId.delete(notificationId);
    clearLiveTimer(notificationId);
    notification?.close();
  };

  const evictOldestLiveNotification = () => {
    const oldestNotificationId = liveByNotificationId.keys().next().value as string | undefined;
    if (oldestNotificationId !== undefined) {
      closeLiveNotification(oldestNotificationId);
    }
  };

  const pruneExpiredDedupeKeys = (nowMs: number) => {
    for (const [dedupeKey, expiresAt] of recentDedupeExpiresAt) {
      if (expiresAt <= nowMs) {
        recentDedupeExpiresAt.delete(dedupeKey);
      }
    }
  };

  const retainDedupeKey = (dedupeKey: string, expiresAt: number) => {
    recentDedupeExpiresAt.set(dedupeKey, expiresAt);
    while (recentDedupeExpiresAt.size > MAX_RECENT_DEDUPE_KEYS) {
      const oldestDedupeKey = recentDedupeExpiresAt.keys().next().value as string | undefined;
      if (oldestDedupeKey === undefined) {
        break;
      }
      recentDedupeExpiresAt.delete(oldestDedupeKey);
    }
  };

  const retainLiveNotification = (
    notificationId: string,
    notification: Electron.Notification,
    ttlMs: number,
  ) => {
    liveByNotificationId.set(notificationId, notification);
    clearLiveTimer(notificationId);
    const timer = runFork(
      Effect.sleep(ttlMs).pipe(
        Effect.andThen(
          Effect.sync(() => {
            closeLiveNotification(notificationId);
          }),
        ),
      ),
    );
    liveTimers.set(notificationId, timer);
    while (liveByNotificationId.size > MAX_LIVE_NOTIFICATIONS) {
      evictOldestLiveNotification();
    }
  };

  return DesktopNotificationService.of({
    getSupport: Effect.sync(() => ({
      supported: Electron.Notification.isSupported(),
      platform: process.platform,
    })),
    show: (request) =>
      Effect.gen(function* () {
        if (!Electron.Notification.isSupported()) {
          yield* logWarning("notification unsupported", {
            topic: request.topic,
            dedupeKey: request.dedupeKey,
          });
          return {
            status: "unsupported",
            reason: "unsupported",
          } satisfies DesktopNotificationResult;
        }

        const nowMs = yield* Clock.currentTimeMillis;
        const ttlMs = positiveTtlMs(request.ttlMs);
        pruneExpiredDedupeKeys(nowMs);

        if (
          liveByNotificationId.has(request.notificationId) ||
          recentDedupeExpiresAt.has(request.dedupeKey)
        ) {
          yield* logDebug("notification suppressed", {
            topic: request.topic,
            dedupeKey: request.dedupeKey,
          });
          return { status: "suppressed", reason: "duplicate" } satisfies DesktopNotificationResult;
        }

        return yield* Effect.promise<DesktopNotificationResult>(() => {
          return new Promise<DesktopNotificationResult>((resolve) => {
            let settled = false;
            const notificationOptions: Electron.NotificationConstructorOptions & {
              id?: string;
              groupId?: string;
            } = {
              id: request.notificationId,
              title: request.title,
              body: request.body,
              ...(request.subtitle ? { subtitle: request.subtitle } : {}),
              ...(request.groupKey ? { groupId: request.groupKey } : {}),
              ...(request.silent !== undefined ? { silent: request.silent } : {}),
            };
            const notification = new Electron.Notification(notificationOptions);

            notification.once("show", () => {
              retainDedupeKey(request.dedupeKey, nowMs + ttlMs);
              if (!settled) {
                settled = true;
                resolve({ status: "shown", reason: "shown" });
              }
            });
            notification.once("failed", (_event, error) => {
              forgetLiveNotification(request.notificationId, notification);
              if (!settled) {
                settled = true;
                resolve({
                  status: "failed",
                  reason: "failed",
                  ...(typeof error === "string" ? { message: error } : {}),
                });
              }
            });
            notification.once("close", () => {
              forgetLiveNotification(request.notificationId, notification);
            });
            notification.once("click", () => {
              void runPromise(
                Effect.gen(function* () {
                  const activation = yield* toActivation(request);
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

            retainLiveNotification(request.notificationId, notification, ttlMs);
            notification.show();
          });
        }).pipe(
          Effect.tap((result) =>
            result.status === "failed"
              ? logWarning("notification failed", {
                  topic: request.topic,
                  dedupeKey: request.dedupeKey,
                  message: result.message,
                })
              : Effect.void,
          ),
          Effect.withSpan("desktop.notifications.show"),
        );
      }),
  });
});

export const layer = Layer.effect(DesktopNotificationService, make);
