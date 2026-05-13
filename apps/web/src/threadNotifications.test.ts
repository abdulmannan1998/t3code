import { describe, expect, it } from "vitest";
import { EnvironmentId, ProjectId, ProviderDriverKind, ThreadId, TurnId } from "@t3tools/contracts";
import type { SidebarThreadSummary, ThreadSession } from "./types";
import {
  buildThreadNotificationKey,
  createThreadNotificationTracker,
  deriveThreadNotificationIntent,
  deriveThreadNotificationState,
} from "./threadNotifications";

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
    Parameters<ReturnType<typeof createThreadNotificationTracker>["collect"]>[1]
  > = {},
): Parameters<ReturnType<typeof createThreadNotificationTracker>["collect"]>[1] {
  return {
    activeThreadRef: null,
    bootstrappedEnvironmentIds: [environmentId],
    windowFocused: false,
    ...overrides,
  };
}

describe("thread notification derivation", () => {
  it("derives pending approval intents", () => {
    const summary = thread({ hasPendingApprovals: true });
    const intent = deriveThreadNotificationIntent(summary);

    expect(deriveThreadNotificationState(summary)).toBe("pending-approval");
    expect(intent).toMatchObject({
      kind: "thread.pending-approval",
      title: "Approval needed",
      body: "Implement notifications",
    });
  });

  it("derives awaiting input intents", () => {
    const summary = thread({ hasPendingUserInput: true });
    const intent = deriveThreadNotificationIntent(summary);

    expect(deriveThreadNotificationState(summary)).toBe("awaiting-input");
    expect(intent?.kind).toBe("thread.awaiting-input");
  });

  it("derives plan-ready intents only for settled plan-mode threads with actionable plans", () => {
    const unsettled = thread({
      interactionMode: "plan",
      hasActionableProposedPlan: true,
      latestTurn: latestTurn({ completedAt: null, state: "running" }),
      session: session({ status: "running", orchestrationStatus: "running" }),
    });
    const settled = thread({
      interactionMode: "plan",
      hasActionableProposedPlan: true,
      latestTurn: latestTurn(),
      session: session(),
    });

    expect(deriveThreadNotificationState(unsettled)).toBeNull();
    expect(deriveThreadNotificationState(settled)).toBe("plan-ready");
    expect(deriveThreadNotificationIntent(settled)?.kind).toBe("thread.plan-ready");
  });

  it("derives completed intents", () => {
    const summary = thread({ latestTurn: latestTurn() });

    expect(deriveThreadNotificationState(summary)).toBe("completed");
    expect(deriveThreadNotificationIntent(summary)?.kind).toBe("thread.completed");
  });

  it("derives error intents before completed intents", () => {
    const summary = thread({
      latestTurn: latestTurn(),
      session: session({ status: "error", orchestrationStatus: "error", lastError: "boom" }),
    });

    expect(deriveThreadNotificationState(summary)).toBe("error");
    expect(deriveThreadNotificationIntent(summary)?.kind).toBe("thread.error");
  });

  it("does not derive working, connecting, or archived intents", () => {
    expect(
      deriveThreadNotificationState(
        thread({
          latestTurn: latestTurn({ state: "running", completedAt: null }),
          session: session({ status: "running", orchestrationStatus: "running" }),
        }),
      ),
    ).toBeNull();
    expect(
      deriveThreadNotificationState(thread({ session: session({ status: "connecting" }) })),
    ).toBeNull();
    expect(
      deriveThreadNotificationState(thread({ archivedAt: baseTime, latestTurn: latestTurn() })),
    ).toBeNull();
  });

  it("builds stable duplicate suppression keys", () => {
    const summary = thread({ latestTurn: latestTurn() });

    expect(buildThreadNotificationKey(summary, "completed")).toBe(
      "environment-local:thread-1:completed:turn-1:2026-05-14T10:00:00.000Z",
    );
  });
});

describe("thread notification tracker", () => {
  it("seeds the initial snapshot without emitting", () => {
    const tracker = createThreadNotificationTracker();
    const summary = thread({ latestTurn: latestTurn() });

    expect(tracker.collect([summary], collectOptions())).toHaveLength(0);
  });

  it("does not emit the same key twice", () => {
    const tracker = createThreadNotificationTracker();
    const initial = thread();
    const completed = thread({ latestTurn: latestTurn() });

    expect(tracker.collect([initial], collectOptions())).toEqual([]);
    expect(tracker.collect([completed], collectOptions())).toHaveLength(1);
    expect(tracker.collect([completed], collectOptions())).toEqual([]);
  });

  it("does not re-emit when the same actionable state receives a later projection update", () => {
    const tracker = createThreadNotificationTracker();
    const awaitingInput = thread({
      hasPendingUserInput: true,
      session: session({ activeTurnId: TurnId.make("turn-1") }),
    });
    const laterProjectionUpdate = thread({
      hasPendingUserInput: true,
      session: session({ activeTurnId: TurnId.make("turn-1") }),
      updatedAt: "2026-05-14T10:00:00.500Z",
    });

    tracker.collect([thread()], collectOptions());
    expect(tracker.collect([awaitingInput], collectOptions())).toHaveLength(1);
    expect(tracker.collect([laterProjectionUpdate], collectOptions())).toEqual([]);
  });

  it("re-emits when an actionable state clears and returns", () => {
    const tracker = createThreadNotificationTracker();
    const awaitingInput = thread({
      hasPendingUserInput: true,
      session: session({ activeTurnId: TurnId.make("turn-1") }),
    });
    const laterAwaitingInput = thread({
      hasPendingUserInput: true,
      session: session({ activeTurnId: TurnId.make("turn-1") }),
      updatedAt: "2026-05-14T10:01:00.000Z",
    });

    tracker.collect([thread()], collectOptions());
    expect(tracker.collect([awaitingInput], collectOptions())).toHaveLength(1);
    expect(tracker.collect([thread()], collectOptions())).toEqual([]);
    expect(tracker.collect([laterAwaitingInput], collectOptions())).toHaveLength(1);
  });

  it("emits once for a new turn state", () => {
    const tracker = createThreadNotificationTracker();
    const first = thread({ latestTurn: latestTurn() });
    const second = thread({
      latestTurn: latestTurn({
        turnId: TurnId.make("turn-2"),
        completedAt: "2026-05-14T10:05:00.000Z",
      }),
    });

    tracker.collect([thread()], collectOptions());
    expect(tracker.collect([first], collectOptions())).toHaveLength(1);
    expect(tracker.collect([second], collectOptions())).toHaveLength(1);
  });

  it("does not emit when an environment first becomes bootstrapped", () => {
    const tracker = createThreadNotificationTracker();
    const actionable = thread({ hasPendingUserInput: true });

    expect(
      tracker.collect([actionable], {
        activeThreadRef: null,
        bootstrappedEnvironmentIds: [],
        windowFocused: false,
      }),
    ).toEqual([]);
    expect(tracker.collect([actionable], collectOptions())).toEqual([]);
  });

  it("suppresses focused active threads while allowing focused inactive threads", () => {
    const tracker = createThreadNotificationTracker();
    const activeRef = { environmentId, threadId };
    const active = thread({ latestTurn: latestTurn() });
    const inactive = thread({
      id: ThreadId.make("thread-2"),
      latestTurn: latestTurn({ turnId: TurnId.make("turn-2") }),
    });

    tracker.collect(
      [thread()],
      collectOptions({ activeThreadRef: activeRef, windowFocused: true }),
    );
    const intents = tracker.collect([active, inactive], {
      activeThreadRef: activeRef,
      bootstrappedEnvironmentIds: [environmentId],
      windowFocused: true,
    });

    expect(intents.map((intent) => intent.threadRef.threadId)).toEqual([ThreadId.make("thread-2")]);
  });
});
