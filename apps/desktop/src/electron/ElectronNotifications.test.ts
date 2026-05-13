import { assert, describe, it } from "@effect/vitest";
import type {
  DesktopNotificationActivation,
  DesktopNotificationInput,
  DesktopNotificationShowResult,
} from "@t3tools/contracts";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
import * as ElectronNotifications from "./ElectronNotifications.ts";
import * as ElectronWindow from "./ElectronWindow.ts";

function notificationInput(
  overrides: Partial<DesktopNotificationInput> = {},
): DesktopNotificationInput {
  return {
    id: "environment-local:thread-1:completed:turn-1:2026-05-14T00:00:00.000Z",
    kind: "thread.completed",
    title: "Thread completed",
    body: "Implement notifications",
    groupId: "environment-local:thread-1",
    route: {
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
  return ElectronNotifications.layer.pipe(Layer.provideMerge(makeLayer(input)));
}

describe("ElectronNotifications", () => {
  beforeEach(() => {
    isSupportedMock.mockReset();
    isSupportedMock.mockReturnValue(true);
    notificationInstances.length = 0;
  });

  it.effect("returns unsupported when notifications are unavailable", () =>
    Effect.gen(function* () {
      isSupportedMock.mockReturnValue(false);
      const notifications = yield* ElectronNotifications.ElectronNotifications;

      const support = yield* notifications.getSupport;
      const result = yield* notifications.show(notificationInput());

      assert.deepEqual(support.supported, false);
      assert.deepEqual(result, { shown: false, reason: "unsupported" });
      assert.equal(notificationInstances.length, 0);
    }).pipe(Effect.provide(notificationLayer({}))),
  );

  it.effect("shows supported notifications with id, body, and group id", () =>
    Effect.gen(function* () {
      const notifications = yield* ElectronNotifications.ElectronNotifications;
      const result = yield* notifications.show(notificationInput());
      const [instance] = notificationInstances;

      assert.deepEqual(result, { shown: true, reason: "shown" });
      assert.deepEqual(instance?.options, {
        id: "environment-local:thread-1:completed:turn-1:2026-05-14T00:00:00.000Z",
        title: "Thread completed",
        body: "Implement notifications",
        groupId: "environment-local:thread-1",
      });
    }).pipe(Effect.provide(notificationLayer({}))),
  );

  it.effect("emits activation payloads and reveals the window when clicked", () => {
    const mainWindow = {} as Electron.BrowserWindow;
    const activations: DesktopNotificationActivation[] = [];
    const revealed: Electron.BrowserWindow[] = [];

    return Effect.gen(function* () {
      const notifications = yield* ElectronNotifications.ElectronNotifications;

      yield* notifications.show(notificationInput());
      notificationInstances[0]?.emit("click");
      yield* Effect.sleep("0 millis");

      assert.deepEqual(revealed, [mainWindow]);
      assert.deepEqual(activations, [
        {
          id: "environment-local:thread-1:completed:turn-1:2026-05-14T00:00:00.000Z",
          kind: "thread.completed",
          route: {
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
      const notifications = yield* ElectronNotifications.ElectronNotifications;
      const result = yield* notifications.show(notificationInput({ title: "Fail" }));

      assert.deepEqual(result, {
        shown: false,
        reason: "failed",
        message: "permission denied",
      } satisfies DesktopNotificationShowResult);
    }).pipe(Effect.provide(notificationLayer({}))),
  );
});
