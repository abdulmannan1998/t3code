import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import { EnvironmentId, ThreadId } from "./baseSchemas.ts";
import {
  DesktopNotificationActivationSchema,
  DesktopNotificationRequestSchema,
  DesktopNotificationResultSchema,
} from "./ipc.ts";

const decodeNotificationRequest = Schema.decodeUnknownSync(DesktopNotificationRequestSchema);
const decodeNotificationResult = Schema.decodeUnknownSync(DesktopNotificationResultSchema);
const decodeNotificationActivation = Schema.decodeUnknownSync(DesktopNotificationActivationSchema);

describe("Desktop notification IPC schemas", () => {
  it("decodes valid thread notification requests with a route", () => {
    const decoded = decodeNotificationRequest({
      notificationId: "thread-1:completed",
      dedupeKey: "thread-1:completed",
      topic: "thread.activity",
      severity: "success",
      title: "Thread finished",
      body: "Implement notifications",
      subtitle: "T3 Code",
      groupKey: "thread-1",
      silent: false,
      ttlMs: 30_000,
      route: {
        kind: "thread",
        environmentId: "environment-local",
        threadId: "thread-1",
      },
    });

    expect(decoded.route).toEqual({
      kind: "thread",
      environmentId: EnvironmentId.make("environment-local"),
      threadId: ThreadId.make("thread-1"),
    });
  });

  it("rejects invalid notification result reasons", () => {
    expect(() =>
      decodeNotificationResult({
        status: "failed",
        reason: "blocked",
      }),
    ).toThrow();
  });

  it("decodes activation payloads without routes for permission tests", () => {
    const decoded = decodeNotificationActivation({
      notificationId: "permission-test:1",
      topic: "permission-test",
      createdAt: "2026-05-14T10:00:00.000Z",
    });

    expect(decoded).toEqual({
      notificationId: "permission-test:1",
      topic: "permission-test",
      createdAt: "2026-05-14T10:00:00.000Z",
    });
  });
});
