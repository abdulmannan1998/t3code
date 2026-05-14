import { describe, expect, it } from "vitest";
import { EnvironmentId, ProjectId, ProviderDriverKind, ThreadId, TurnId } from "@t3tools/contracts";
import type { SidebarThreadSummary, ThreadSession } from "../types";
import {
  createThreadActivityNotificationTracker,
  deriveThreadActivityNotificationState,
} from "./threadActivityNotifications";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const baseTime = "2026-05-14T10:00:00.000Z";

function session(overrides: Partial<ThreadSession> = {}): ThreadSession {
  return {
    provider: ProviderDriverKind.make("codex"),
    status: "closed",
    createdAt: baseTime,
    updatedAt: baseTime,
    orchestrationStatus: "stopped",
    ...overrides,
  };
}

function latestTurn(overrides: Partial<NonNullable<SidebarThreadSummary["latestTurn"]>> = {}) {
  return {
    turnId: TurnId.make("turn-1"),
    state: "completed" as const,
    requestedAt: "2026-05-14T09:59:00.000Z",
    startedAt: "2026-05-14T09:59:05.000Z",
    completedAt: baseTime,
    assistantMessageId: null,
    ...overrides,
  };
}

function thread(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: threadId,
    environmentId,
    projectId,
    title: "Implement notifications",
    interactionMode: "default",
    session: null,
    createdAt: "2026-05-14T09:58:00.000Z",
    archivedAt: null,
    updatedAt: baseTime,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function collectOptions(
  overrides: Partial<
    Parameters<ReturnType<typeof createThreadActivityNotificationTracker>["collect"]>[1]
  > = {},
): Parameters<ReturnType<typeof createThreadActivityNotificationTracker>["collect"]>[1] {
  return {
    activeThreadRef: null,
    bootstrappedEnvironmentIds: [environmentId],
    windowFocused: false,
    ...overrides,
  };
}

function shown() {
  return { status: "shown", reason: "shown" } as const;
}

describe("thread activity notification derivation", () => {
  it("does not derive completed while the session is still running", () => {
    expect(
      deriveThreadActivityNotificationState(
        thread({
          latestTurn: latestTurn(),
          session: session({
            status: "running",
            orchestrationStatus: "running",
            activeTurnId: TurnId.make("turn-2"),
          }),
        }),
      ),
    ).toBeNull();
  });

  it("derives completed only after the latest turn is settled", () => {
    expect(
      deriveThreadActivityNotificationState(
        thread({
          latestTurn: latestTurn({ completedAt: null, state: "running" }),
          session: session({ status: "running", orchestrationStatus: "running" }),
        }),
      ),
    ).toBeNull();
    expect(
      deriveThreadActivityNotificationState(
        thread({
          latestTurn: latestTurn(),
          session: session(),
        }),
      ),
    ).toBe("completed");
  });
});

describe("thread activity notification tracker", () => {
  it("does not emit the initial bootstrap snapshot", () => {
    const tracker = createThreadActivityNotificationTracker();

    expect(tracker.collect([thread({ hasPendingUserInput: true })], collectOptions())).toEqual([]);
  });

  it("does not emit the active focused thread", () => {
    const tracker = createThreadActivityNotificationTracker();
    const activeRef = { environmentId, threadId };

    tracker.collect(
      [thread()],
      collectOptions({ activeThreadRef: activeRef, windowFocused: true }),
    );

    expect(
      tracker.collect([thread({ hasPendingUserInput: true })], {
        activeThreadRef: activeRef,
        bootstrappedEnvironmentIds: [environmentId],
        windowFocused: true,
      }),
    ).toEqual([]);
  });

  it("emits inactive thread updates while the app is focused", () => {
    const tracker = createThreadActivityNotificationTracker();
    const activeRef = { environmentId, threadId: ThreadId.make("active-thread") };

    tracker.collect(
      [thread()],
      collectOptions({ activeThreadRef: activeRef, windowFocused: true }),
    );
    const intents = tracker.collect([thread({ hasPendingUserInput: true })], {
      activeThreadRef: activeRef,
      bootstrappedEnvironmentIds: [environmentId],
      windowFocused: true,
    });

    expect(intents).toHaveLength(1);
    expect(intents[0]?.request).toMatchObject({
      topic: "thread.activity",
      severity: "warning",
      title: "Input needed",
      body: "Implement notifications",
      route: {
        kind: "thread",
        environmentId,
        threadId,
      },
    });
  });

  it("emits inactive thread updates while the app is blurred", () => {
    const tracker = createThreadActivityNotificationTracker();

    tracker.collect([thread()], collectOptions());
    const intents = tracker.collect([thread({ hasPendingApprovals: true })], collectOptions());

    expect(intents).toHaveLength(1);
    expect(intents[0]?.request.title).toBe("Approval needed");
  });

  it("does not duplicate after projection updatedAt churn once delivery is accepted", () => {
    const tracker = createThreadActivityNotificationTracker();

    tracker.collect([thread()], collectOptions());
    const [intent] = tracker.collect(
      [
        thread({
          hasPendingUserInput: true,
          session: session({ activeTurnId: TurnId.make("turn-1") }),
        }),
      ],
      collectOptions(),
    );
    expect(intent).toBeDefined();
    tracker.recordDelivery(intent!, shown());

    expect(
      tracker.collect(
        [
          thread({
            hasPendingUserInput: true,
            session: session({ activeTurnId: TurnId.make("turn-1") }),
            updatedAt: "2026-05-14T10:00:00.500Z",
          }),
        ],
        collectOptions(),
      ),
    ).toEqual([]);
  });

  it("does not let focus suppression consume a later eligible occurrence", () => {
    const tracker = createThreadActivityNotificationTracker();
    const activeRef = { environmentId, threadId };
    const pendingInput = thread({
      hasPendingUserInput: true,
      session: session({ activeTurnId: TurnId.make("turn-1") }),
    });

    tracker.collect(
      [thread()],
      collectOptions({ activeThreadRef: activeRef, windowFocused: true }),
    );
    expect(
      tracker.collect([pendingInput], {
        activeThreadRef: activeRef,
        bootstrappedEnvironmentIds: [environmentId],
        windowFocused: true,
      }),
    ).toEqual([]);

    expect(
      tracker.collect([pendingInput], {
        activeThreadRef: null,
        bootstrappedEnvironmentIds: [environmentId],
        windowFocused: false,
      }),
    ).toHaveLength(1);
  });

  it("emits again when an actionable state clears and returns", () => {
    const tracker = createThreadActivityNotificationTracker();
    const pendingInput = thread({
      hasPendingUserInput: true,
      session: session({ activeTurnId: TurnId.make("turn-1") }),
    });

    tracker.collect([thread()], collectOptions());
    const [firstIntent] = tracker.collect([pendingInput], collectOptions());
    expect(firstIntent).toBeDefined();
    tracker.recordDelivery(firstIntent!, shown());
    expect(tracker.collect([thread()], collectOptions())).toEqual([]);

    expect(tracker.collect([pendingInput], collectOptions())).toHaveLength(1);
  });
});
