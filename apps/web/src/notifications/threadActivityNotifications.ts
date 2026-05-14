import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import type {
  DesktopNotificationRequest,
  DesktopNotificationResult,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";

import { isLatestTurnSettled } from "../session-logic";
import type { SidebarThreadSummary } from "../types";

export type ThreadActivityNotificationState =
  | "needs-approval"
  | "needs-input"
  | "plan-ready"
  | "failed"
  | "completed";

export interface ThreadActivityNotificationIntent {
  readonly threadRef: ScopedThreadRef;
  readonly threadKey: string;
  readonly occurrenceKey: string;
  readonly request: DesktopNotificationRequest;
}

export interface ThreadActivityNotificationTracker {
  collect: (
    threads: readonly SidebarThreadSummary[],
    options: {
      readonly activeThreadRef: ScopedThreadRef | null;
      readonly bootstrappedEnvironmentIds: readonly EnvironmentId[];
      readonly windowFocused: boolean;
    },
  ) => ThreadActivityNotificationIntent[];
  recordDelivery: (
    intent: ThreadActivityNotificationIntent,
    result: DesktopNotificationResult,
  ) => void;
  reset: () => void;
}

interface ThreadNotificationRecord {
  lastSeenOccurrenceKey: string | null;
  deliveredOccurrenceKey: string | null;
  reservedOccurrenceKey: string | null;
}

const COPY_BY_STATE: Record<
  ThreadActivityNotificationState,
  {
    readonly severity: DesktopNotificationRequest["severity"];
    readonly title: string;
  }
> = {
  "needs-approval": {
    severity: "warning",
    title: "Approval needed",
  },
  "needs-input": {
    severity: "warning",
    title: "Input needed",
  },
  "plan-ready": {
    severity: "info",
    title: "Plan ready",
  },
  failed: {
    severity: "error",
    title: "Thread failed",
  },
  completed: {
    severity: "success",
    title: "Thread finished",
  },
};

function sameThreadRef(left: ScopedThreadRef | null, right: ScopedThreadRef): boolean {
  return left?.environmentId === right.environmentId && left.threadId === right.threadId;
}

function turnKey(thread: SidebarThreadSummary): string {
  return thread.session?.activeTurnId ?? thread.latestTurn?.turnId ?? "no-turn";
}

function sourcePlanKey(thread: SidebarThreadSummary): string {
  return thread.latestTurn?.sourceProposedPlan?.planId ?? "no-plan";
}

function terminalTimestamp(thread: SidebarThreadSummary): string {
  return (
    thread.latestTurn?.completedAt ?? thread.session?.updatedAt ?? thread.updatedAt ?? "no-time"
  );
}

export function deriveThreadActivityNotificationState(
  thread: SidebarThreadSummary,
): ThreadActivityNotificationState | null {
  if (thread.archivedAt !== null) {
    return null;
  }
  if (thread.hasPendingApprovals) {
    return "needs-approval";
  }
  if (thread.hasPendingUserInput) {
    return "needs-input";
  }
  if (
    thread.interactionMode === "plan" &&
    thread.hasActionableProposedPlan &&
    isLatestTurnSettled(thread.latestTurn, thread.session)
  ) {
    return "plan-ready";
  }
  if (thread.session?.status === "error" || thread.session?.lastError) {
    return "failed";
  }
  if (isLatestTurnSettled(thread.latestTurn, thread.session)) {
    return "completed";
  }
  return null;
}

export function buildThreadActivityOccurrenceKey(
  thread: SidebarThreadSummary,
  state: ThreadActivityNotificationState,
): string {
  switch (state) {
    case "needs-approval":
    case "needs-input":
      return `${state}:${turnKey(thread)}:pending`;
    case "plan-ready":
      return `${state}:${thread.latestTurn?.turnId ?? "no-turn"}:${sourcePlanKey(thread)}`;
    case "failed":
    case "completed":
      return `${state}:${thread.latestTurn?.turnId ?? turnKey(thread)}:${terminalTimestamp(thread)}`;
  }
}

export function deriveThreadActivityNotificationIntent(
  thread: SidebarThreadSummary,
  state: ThreadActivityNotificationState,
  occurrenceKey: string,
): ThreadActivityNotificationIntent {
  const copy = COPY_BY_STATE[state];
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const threadKey = scopedThreadKey(threadRef);
  const notificationId = `${threadKey}:${occurrenceKey}`;

  return {
    threadRef,
    threadKey,
    occurrenceKey,
    request: {
      notificationId,
      dedupeKey: notificationId,
      topic: "thread.activity",
      severity: copy.severity,
      title: copy.title,
      body: thread.title,
      groupKey: threadKey,
      route: {
        kind: "thread",
        environmentId: thread.environmentId,
        threadId: thread.id,
      },
    },
  };
}

export function createThreadActivityNotificationTracker(): ThreadActivityNotificationTracker {
  const seededEnvironmentIds = new Set<EnvironmentId>();
  const recordsByThreadKey = new Map<string, ThreadNotificationRecord>();

  const ensureRecord = (threadKey: string): ThreadNotificationRecord => {
    const existing = recordsByThreadKey.get(threadKey);
    if (existing) {
      return existing;
    }
    const record: ThreadNotificationRecord = {
      lastSeenOccurrenceKey: null,
      deliveredOccurrenceKey: null,
      reservedOccurrenceKey: null,
    };
    recordsByThreadKey.set(threadKey, record);
    return record;
  };

  return {
    collect: (threads, options) => {
      const bootstrappedEnvironmentIds = new Set(options.bootstrappedEnvironmentIds);
      const currentThreadKeys = new Set<string>();
      const newlyBootstrappedEnvironmentIds = new Set(
        options.bootstrappedEnvironmentIds.filter(
          (environmentId) => !seededEnvironmentIds.has(environmentId),
        ),
      );
      const intents: ThreadActivityNotificationIntent[] = [];

      for (const thread of threads) {
        if (!bootstrappedEnvironmentIds.has(thread.environmentId)) {
          continue;
        }

        const threadRef = scopeThreadRef(thread.environmentId, thread.id);
        const threadKey = scopedThreadKey(threadRef);
        const record = ensureRecord(threadKey);
        currentThreadKeys.add(threadKey);

        const state = deriveThreadActivityNotificationState(thread);
        if (state === null) {
          record.lastSeenOccurrenceKey = null;
          record.deliveredOccurrenceKey = null;
          record.reservedOccurrenceKey = null;
          continue;
        }

        const occurrenceKey = buildThreadActivityOccurrenceKey(thread, state);
        if (newlyBootstrappedEnvironmentIds.has(thread.environmentId)) {
          record.lastSeenOccurrenceKey = occurrenceKey;
          record.deliveredOccurrenceKey = occurrenceKey;
          record.reservedOccurrenceKey = null;
          continue;
        }

        const activeFocused =
          options.windowFocused && sameThreadRef(options.activeThreadRef, threadRef);
        if (activeFocused) {
          continue;
        }

        if (
          record.lastSeenOccurrenceKey === occurrenceKey ||
          record.deliveredOccurrenceKey === occurrenceKey ||
          record.reservedOccurrenceKey === occurrenceKey
        ) {
          continue;
        }

        record.reservedOccurrenceKey = occurrenceKey;
        intents.push(deriveThreadActivityNotificationIntent(thread, state, occurrenceKey));
      }

      for (const environmentId of newlyBootstrappedEnvironmentIds) {
        seededEnvironmentIds.add(environmentId);
      }

      for (const threadKey of recordsByThreadKey.keys()) {
        if (!currentThreadKeys.has(threadKey)) {
          recordsByThreadKey.delete(threadKey);
        }
      }

      return intents;
    },
    recordDelivery: (intent, result) => {
      const record = recordsByThreadKey.get(intent.threadKey);
      if (!record || record.reservedOccurrenceKey !== intent.occurrenceKey) {
        return;
      }

      if (result.status === "shown" || result.status === "suppressed") {
        record.lastSeenOccurrenceKey = intent.occurrenceKey;
        record.deliveredOccurrenceKey = intent.occurrenceKey;
      }
      record.reservedOccurrenceKey = null;
    },
    reset: () => {
      seededEnvironmentIds.clear();
      recordsByThreadKey.clear();
    },
  };
}
