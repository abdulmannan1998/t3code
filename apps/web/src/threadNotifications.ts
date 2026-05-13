import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import type { DesktopNotificationKind, ScopedThreadRef } from "@t3tools/contracts";
import { isLatestTurnSettled } from "./session-logic";
import type { SidebarThreadSummary } from "./types";

export type ThreadNotificationState =
  | "pending-approval"
  | "awaiting-input"
  | "plan-ready"
  | "completed"
  | "error";

export interface ThreadNotificationIntent {
  readonly key: string;
  readonly kind: DesktopNotificationKind;
  readonly threadRef: ScopedThreadRef;
  readonly title: string;
  readonly body: string;
  readonly groupId: string;
}

export interface ThreadNotificationTracker {
  collect: (
    threads: readonly SidebarThreadSummary[],
    options: {
      readonly activeThreadRef: ScopedThreadRef | null;
      readonly windowFocused: boolean;
    },
  ) => ThreadNotificationIntent[];
  reset: () => void;
}

const COPY_BY_STATE: Record<
  ThreadNotificationState,
  {
    readonly kind: DesktopNotificationKind;
    readonly title: string;
  }
> = {
  "pending-approval": {
    kind: "thread.pending-approval",
    title: "Approval needed",
  },
  "awaiting-input": {
    kind: "thread.awaiting-input",
    title: "Input needed",
  },
  "plan-ready": {
    kind: "thread.plan-ready",
    title: "Plan ready",
  },
  completed: {
    kind: "thread.completed",
    title: "Thread completed",
  },
  error: {
    kind: "thread.error",
    title: "Thread failed",
  },
};

function sameThreadRef(left: ScopedThreadRef | null, right: ScopedThreadRef): boolean {
  return left?.environmentId === right.environmentId && left.threadId === right.threadId;
}

export function deriveThreadNotificationState(
  thread: SidebarThreadSummary,
): ThreadNotificationState | null {
  if (thread.archivedAt !== null) {
    return null;
  }
  if (thread.hasPendingApprovals) {
    return "pending-approval";
  }
  if (thread.hasPendingUserInput) {
    return "awaiting-input";
  }
  if (
    thread.interactionMode === "plan" &&
    thread.hasActionableProposedPlan &&
    isLatestTurnSettled(thread.latestTurn, thread.session)
  ) {
    return "plan-ready";
  }
  if (thread.session?.status === "error" || thread.session?.lastError) {
    return "error";
  }
  if (thread.latestTurn?.state === "completed" && thread.latestTurn.completedAt) {
    return "completed";
  }
  return null;
}

export function buildThreadNotificationKey(
  thread: SidebarThreadSummary,
  state: ThreadNotificationState,
): string {
  const turnId = thread.latestTurn?.turnId ?? thread.session?.activeTurnId ?? "no-turn";
  const timestamp =
    state === "completed"
      ? (thread.latestTurn?.completedAt ?? thread.updatedAt ?? thread.createdAt)
      : (thread.updatedAt ?? thread.latestTurn?.completedAt ?? thread.createdAt ?? "no-time");
  return `${thread.environmentId}:${thread.id}:${state}:${turnId}:${timestamp}`;
}

export function deriveThreadNotificationIntent(
  thread: SidebarThreadSummary,
): ThreadNotificationIntent | null {
  const state = deriveThreadNotificationState(thread);
  if (state === null) {
    return null;
  }

  const copy = COPY_BY_STATE[state];
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  return {
    key: buildThreadNotificationKey(thread, state),
    kind: copy.kind,
    threadRef,
    title: copy.title,
    body: thread.title,
    groupId: scopedThreadKey(threadRef),
  };
}

export function createThreadNotificationTracker(): ThreadNotificationTracker {
  let seeded = false;
  const seenKeys = new Set<string>();

  return {
    collect: (threads, options) => {
      const currentIntents = threads.flatMap((thread) => {
        const intent = deriveThreadNotificationIntent(thread);
        return intent ? [intent] : [];
      });

      if (!seeded) {
        for (const intent of currentIntents) {
          seenKeys.add(intent.key);
        }
        seeded = true;
        return [];
      }

      const nextIntents: ThreadNotificationIntent[] = [];
      for (const intent of currentIntents) {
        if (seenKeys.has(intent.key)) {
          continue;
        }
        seenKeys.add(intent.key);
        if (options.windowFocused && sameThreadRef(options.activeThreadRef, intent.threadRef)) {
          continue;
        }
        nextIntents.push(intent);
      }
      return nextIntents;
    },
    reset: () => {
      seeded = false;
      seenKeys.clear();
    },
  };
}
