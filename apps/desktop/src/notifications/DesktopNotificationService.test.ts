import { assert, describe, it } from "@effect/vitest";
import type {
  DesktopNotificationActivation,
  DesktopNotificationRequest,
  DesktopNotificationResult,
} from "@t3tools/contracts";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import type * as Electron from "electron";
import { beforeEach, vi } from "vitest";

const { FakeNotification, isSupportedMock, notificationInstances } = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  const instances: FakeNotification[] = [];
  class FakeNotification {
    static isSupported = vi.fn(() => true);
    readonly listeners = new Map<string, Listener[]>();
    readonly options: Record<string, unknown>;
    readonly close = vi.fn(() => {
      this.emit("close");
    });
    readonly show = vi.fn(() => {
      if (this.options.title === "Fail") {
        this.emit("failed", {}, "permission denied");
        return;
      }
      this.emit("show");
    });

    constructor(options: Record<string, unknown>) {
      this.options = options;
      instances.push(this);
    }

    once(eventName: string, listener: Listener) {
      const wrapped: Listener = (...args) => {
        this.off(eventName, wrapped);
        listener(...args);
      };
      this.on(eventName, wrapped);
      return this;
    }

    on(eventName: string, listener: Listener) {
      this.listeners.set(eventName, [...(this.listeners.get(eventName) ?? []), listener]);
      return this;
    }

    off(eventName: string, listener: Listener) {
      this.listeners.set(
        eventName,
        (this.listeners.get(eventName) ?? []).filter((entry) => entry !== listener),
      );
      return this;
    }

    emit(eventName: string, ...args: unknown[]) {
      for (const listener of this.listeners.get(eventName) ?? []) {
        listener(...args);
      }
      return true;
    }
  }
  return {
    isSupportedMock: FakeNotification.isSupported,
    notificationInstances: instances,
    FakeNotification,
  };
});

vi.mock("electron", () => ({
  Notification: FakeNotification,
}));

import * as IpcChannels from "../ipc/channels.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopNotificationService from "./DesktopNotificationService.ts";

function notificationRequest(
  overrides: Partial<DesktopNotificationRequest> = {},
): DesktopNotificationRequest {
  return {
    notificationId: "environment-local:thread-1:completed:turn-1",
    dedupeKey: "environment-local:thread-1:completed:turn-1",
    topic: "thread.activity",
    severity: "success",
    title: "Thread finished",
    body: "Implement notifications",
    groupKey: "environment-local:thread-1",
    route: {
      kind: "thread",
      environmentId: EnvironmentId.make("environment-local"),
      threadId: ThreadId.make("thread-1"),
    },
    ...overrides,
  };
}

function makeLayer(input: {
  readonly mainWindow?: Electron.BrowserWindow;
  readonly activations?: DesktopNotificationActivation[];
  readonly revealed?: Electron.BrowserWindow[];
}) {
  const activations = input.activations ?? [];
  const revealed = input.revealed ?? [];
  return Layer.succeed(
    ElectronWindow.ElectronWindow,
    ElectronWindow.ElectronWindow.of({
      create: () => Effect.die("not implemented"),
      main: Effect.succeed(Option.fromNullishOr(input.mainWindow)),
      currentMainOrFirst: Effect.succeed(Option.fromNullishOr(input.mainWindow)),
      focusedMainOrFirst: Effect.succeed(Option.fromNullishOr(input.mainWindow)),
      setMain: () => Effect.void,
      clearMain: () => Effect.void,
      reveal: (window) =>
        Effect.sync(() => {
          revealed.push(window);
        }),
      sendAll: (channel, activation) =>
        Effect.sync(() => {
          if (channel === IpcChannels.NOTIFICATION_ACTIVATED_CHANNEL) {
            activations.push(activation as DesktopNotificationActivation);
          }
        }),
      destroyAll: Effect.void,
      syncAllAppearance: () => Effect.void,
    }),
  );
}

function notificationLayer(input: Parameters<typeof makeLayer>[0]) {
  return DesktopNotificationService.layer.pipe(
    Layer.provideMerge(makeLayer(input)),
    Layer.provideMerge(TestClock.layer()),
  );
}

describe("DesktopNotificationService", () => {
  beforeEach(() => {
    isSupportedMock.mockReset();
    isSupportedMock.mockReturnValue(true);
    notificationInstances.length = 0;
  });

  it.effect("returns unsupported when notifications are unavailable", () =>
    Effect.gen(function* () {
      isSupportedMock.mockReturnValue(false);
      const notifications = yield* DesktopNotificationService.DesktopNotificationService;

      const support = yield* notifications.getSupport;
      const result = yield* notifications.show(notificationRequest());

      assert.deepEqual(support.supported, false);
      assert.deepEqual(result, { status: "unsupported", reason: "unsupported" });
      assert.equal(notificationInstances.length, 0);
    }).pipe(Effect.provide(notificationLayer({}))),
  );

  it.effect("shows supported notifications with id, body, and group key", () =>
    Effect.gen(function* () {
      const notifications = yield* DesktopNotificationService.DesktopNotificationService;
      const result = yield* notifications.show(notificationRequest());
      const [instance] = notificationInstances;

      assert.deepEqual(result, { status: "shown", reason: "shown" });
      assert.deepEqual(instance?.options, {
        id: "environment-local:thread-1:completed:turn-1",
        title: "Thread finished",
        body: "Implement notifications",
        groupId: "environment-local:thread-1",
      });
    }).pipe(Effect.provide(notificationLayer({}))),
  );

  it.effect("suppresses duplicate dedupe keys within the ttl window", () =>
    Effect.gen(function* () {
      const notifications = yield* DesktopNotificationService.DesktopNotificationService;
      const request = notificationRequest({ ttlMs: 10 });

      const first = yield* notifications.show(request);
      notificationInstances[0]?.emit("close");
      const second = yield* notifications.show({
        ...request,
        notificationId: "environment-local:thread-1:completed:turn-1:retry",
      });

      assert.deepEqual(first, { status: "shown", reason: "shown" });
      assert.deepEqual(second, { status: "suppressed", reason: "duplicate" });
      assert.equal(notificationInstances.length, 1);
    }).pipe(Effect.provide(notificationLayer({}))),
  );

  it.effect("allows the same dedupe key again after the ttl window", () =>
    Effect.gen(function* () {
      const notifications = yield* DesktopNotificationService.DesktopNotificationService;
      const request = notificationRequest({ ttlMs: 10 });

      yield* notifications.show(request);
      notificationInstances[0]?.emit("close");
      yield* TestClock.adjust("11 millis");
      yield* notifications.show({
        ...request,
        notificationId: "environment-local:thread-1:completed:turn-1:after-ttl",
      });

      assert.equal(notificationInstances.length, 2);
    }).pipe(Effect.provide(notificationLayer({}))),
  );

  it.effect("emits activation payloads and reveals the window when clicked", () => {
    const mainWindow = {} as Electron.BrowserWindow;
    const activations: DesktopNotificationActivation[] = [];
    const revealed: Electron.BrowserWindow[] = [];

    return Effect.gen(function* () {
      const notifications = yield* DesktopNotificationService.DesktopNotificationService;

      yield* notifications.show(notificationRequest());
      notificationInstances[0]?.emit("click");
      yield* Effect.promise(() => Promise.resolve());

      assert.deepEqual(revealed, [mainWindow]);
      assert.deepEqual(activations, [
        {
          notificationId: "environment-local:thread-1:completed:turn-1",
          topic: "thread.activity",
          createdAt: "1970-01-01T00:00:00.000Z",
          route: {
            kind: "thread",
            environmentId: EnvironmentId.make("environment-local"),
            threadId: ThreadId.make("thread-1"),
          },
        },
      ]);
      assert.equal(notificationInstances[0]?.close.mock.calls.length, 1);
    }).pipe(Effect.provide(notificationLayer({ mainWindow, activations, revealed })));
  });

  it.effect("returns failed results when notification display fails", () =>
    Effect.gen(function* () {
      const notifications = yield* DesktopNotificationService.DesktopNotificationService;
      const result = yield* notifications.show(notificationRequest({ title: "Fail" }));

      assert.deepEqual(result, {
        status: "failed",
        reason: "failed",
        message: "permission denied",
      } satisfies DesktopNotificationResult);
    }).pipe(Effect.provide(notificationLayer({}))),
  );

  it.effect("evicts the oldest live notification when the live cap is exceeded", () =>
    Effect.gen(function* () {
      const notifications = yield* DesktopNotificationService.DesktopNotificationService;

      for (let index = 0; index < 101; index += 1) {
        yield* notifications.show(
          notificationRequest({
            notificationId: `notification-${index}`,
            dedupeKey: `notification-${index}`,
          }),
        );
      }

      assert.equal(notificationInstances.length, 101);
      assert.equal(notificationInstances[0]?.close.mock.calls.length, 1);
    }).pipe(Effect.provide(notificationLayer({}))),
  );
});
