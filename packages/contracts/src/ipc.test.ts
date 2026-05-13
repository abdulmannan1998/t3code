import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import { EnvironmentId, ThreadId } from "./baseSchemas.ts";
import {
  DesktopNotificationActivationSchema,
  DesktopNotificationInputSchema,
  DesktopNotificationShowResultSchema,
} from "./ipc.ts";

const decodeNotificationInput = Schema.decodeUnknownSync(DesktopNotificationInputSchema);
const decodeNotificationShowResult = Schema.decodeUnknownSync(DesktopNotificationShowResultSchema);
const decodeNotificationActivation = Schema.decodeUnknownSync(DesktopNotificationActivationSchema);

describe("Desktop notification IPC schemas", () => {
  it("decodes valid thread notification input with a route", () => {
    const decoded = decodeNotificationInput({
      id: "thread-1:completed",
      kind: "thread.completed",
      title: "Thread completed",
      body: "Implement notifications",
      subtitle: "T3 Code",
      groupId: "thread-1",
      silent: false,
      route: {
        environmentId: "environment-local",
        threadId: "thread-1",
      },
    });

    expect(decoded.route).toEqual({
      environmentId: EnvironmentId.make("environment-local"),
      threadId: ThreadId.make("thread-1"),
    });
  });

  it("rejects invalid notification show result reasons", () => {
    expect(() =>
      decodeNotificationShowResult({
        shown: false,
        reason: "blocked",
      }),
    ).toThrow();
  });

  it("decodes activation payloads without routes for permission tests", () => {
    const decoded = decodeNotificationActivation({
      id: "permission-test:1",
      kind: "permission-test",
    });

    expect(decoded).toEqual({
      id: "permission-test:1",
      kind: "permission-test",
    });
  });
});
