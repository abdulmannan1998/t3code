import "../index.css";

import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  type DesktopBridge,
  type DesktopNotificationActivation,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useStore, type EnvironmentState } from "../store";
import type { SidebarThreadSummary, ThreadSession } from "../types";

const settingsHarness = vi.hoisted(() => ({
  desktopThreadNotificationsEnabled: false,
}));

vi.mock("../hooks/useSettings", () => ({
  __resetClientSettingsPersistenceForTests: () => undefined,
  getClientSettings: () => settingsHarness,
  useClientSettingsHydrated: () => true,
  useSettings: (selector?: (settings: typeof settingsHarness) => unknown) =>
    selector ? selector(settingsHarness) : settingsHarness,
  useUpdateSettings: () => ({
    updateSettings: (patch: Partial<typeof settingsHarness>) => {
      Object.assign(settingsHarness, patch);
    },
    resetSettings: () => {
      settingsHarness.desktopThreadNotificationsEnabled = false;
    },
  }),
}));

vi.mock("../env", () => ({
  isElectron: true,
}));

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadId = "thread-1" as ThreadId;
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

function summary(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: threadId,
    environmentId,
    projectId,
    title: "Notification regression",
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

function environmentState(
  threadSummary: SidebarThreadSummary,
  options: { readonly bootstrapComplete?: boolean } = {},
): EnvironmentState {
  return {
    projectIds: [],
    projectById: {},
    threadIds: [threadSummary.id],
    threadIdsByProjectId: {},
    threadShellById: {},
    threadSessionById: {},
    threadTurnStateById: {},
    messageIdsByThreadId: {},
    messageByThreadId: {},
    activityIdsByThreadId: {},
    activityByThreadId: {},
    proposedPlanIdsByThreadId: {},
    proposedPlanByThreadId: {},
    turnDiffIdsByThreadId: {},
    turnDiffSummaryByThreadId: {},
    sidebarThreadSummaryById: {
      [threadSummary.id]: threadSummary,
    },
    bootstrapComplete: options.bootstrapComplete ?? true,
  };
}

function seedStore(
  threadSummary: SidebarThreadSummary,
  options: { readonly bootstrapComplete?: boolean } = {},
) {
  useStore.setState({
    activeEnvironmentId: environmentId,
    environmentStateById: {
      [environmentId]: environmentState(threadSummary, options),
    },
  });
}

function updateThreadSummary(threadSummary: SidebarThreadSummary) {
  const state = useStore.getState();
  const previousEnvironmentState = state.environmentStateById[environmentId];
  if (!previousEnvironmentState) {
    throw new Error("Test environment state was not seeded.");
  }

  useStore.setState({
    environmentStateById: {
      ...state.environmentStateById,
      [environmentId]: {
        ...previousEnvironmentState,
        sidebarThreadSummaryById: {
          ...previousEnvironmentState.sidebarThreadSummaryById,
          [threadSummary.id]: threadSummary,
        },
      },
    },
  });
}

function updateBootstrapComplete(bootstrapComplete: boolean) {
  const state = useStore.getState();
  const previousEnvironmentState = state.environmentStateById[environmentId];
  if (!previousEnvironmentState) {
    throw new Error("Test environment state was not seeded.");
  }

  useStore.setState({
    environmentStateById: {
      ...state.environmentStateById,
      [environmentId]: {
        ...previousEnvironmentState,
        bootstrapComplete,
      },
    },
  });
}

function installDesktopBridge() {
  let activationListener: ((activation: DesktopNotificationActivation) => void) | null = null;
  const showNotification = vi.fn().mockResolvedValue({ status: "shown", reason: "shown" });
  const bridge = {
    getClientSettings: vi.fn().mockImplementation(async () => ({
      desktopThreadNotificationsEnabled: settingsHarness.desktopThreadNotificationsEnabled,
    })),
    setClientSettings: vi.fn().mockResolvedValue(undefined),
    getLocalEnvironmentBootstrap: () => null,
    getNotificationSupport: vi.fn().mockResolvedValue({ supported: true, platform: "darwin" }),
    showNotification,
    onNotificationActivated: vi.fn((listener) => {
      activationListener = listener;
      return () => {
        activationListener = null;
      };
    }),
  } as unknown as DesktopBridge;

  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: bridge,
  });

  return {
    bridge,
    showNotification,
    activate: (activation: DesktopNotificationActivation) => activationListener?.(activation),
  };
}

async function renderCoordinator(activeRouteThreadId: ThreadId = threadId) {
  const { NotificationCoordinator } = await import("./NotificationCoordinator");
  const rootRoute = createRootRoute({
    component: () => <NotificationCoordinator />,
  });
  const threadRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/$environmentId/$threadId",
  });
  const history = createMemoryHistory({
    initialEntries: [`/${environmentId}/${activeRouteThreadId}`],
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([threadRoute]),
    history,
  });

  return {
    history,
    mounted: await render(<RouterProvider router={router} />),
  };
}

async function waitForEffects() {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("NotificationCoordinator", () => {
  beforeEach(() => {
    settingsHarness.desktopThreadNotificationsEnabled = false;
    seedStore(summary());
  });

  afterEach(() => {
    useStore.setState({
      activeEnvironmentId: null,
      environmentStateById: {},
    });
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: undefined,
    });
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("does not notify when settings are disabled", async () => {
    const { showNotification } = installDesktopBridge();
    const { mounted } = await renderCoordinator();

    try {
      await waitForEffects();
      expect(showNotification).not.toHaveBeenCalled();
    } finally {
      await mounted.unmount();
    }
  });

  it("does not notify on initial bootstrap snapshot when enabled", async () => {
    settingsHarness.desktopThreadNotificationsEnabled = true;
    seedStore(
      summary({
        hasPendingUserInput: true,
        session: session({ activeTurnId: TurnId.make("turn-1") }),
      }),
    );
    const { showNotification } = installDesktopBridge();
    const { mounted } = await renderCoordinator();

    try {
      await waitForEffects();
      expect(showNotification).not.toHaveBeenCalled();
    } finally {
      await mounted.unmount();
    }
  });

  it("does not notify when the first real sidebar snapshot arrives after startup", async () => {
    settingsHarness.desktopThreadNotificationsEnabled = true;
    seedStore(
      summary({
        hasPendingUserInput: true,
        session: session({ activeTurnId: TurnId.make("turn-1") }),
      }),
      { bootstrapComplete: false },
    );
    const { showNotification } = installDesktopBridge();
    const { mounted } = await renderCoordinator("active-thread" as ThreadId);

    try {
      await waitForEffects();
      expect(showNotification).not.toHaveBeenCalled();

      updateBootstrapComplete(true);
      await waitForEffects();
      expect(showNotification).not.toHaveBeenCalled();
    } finally {
      await mounted.unmount();
    }
  });

  it("notifies on a later inactive thread state transition", async () => {
    settingsHarness.desktopThreadNotificationsEnabled = true;
    const { showNotification } = installDesktopBridge();
    const { mounted } = await renderCoordinator("active-thread" as ThreadId);

    try {
      await waitForEffects();
      expect(showNotification).not.toHaveBeenCalled();

      updateThreadSummary(
        summary({
          hasPendingUserInput: true,
          updatedAt: "2026-05-14T10:01:00.000Z",
          session: session({ activeTurnId: TurnId.make("turn-2") }),
        }),
      );

      await vi.waitFor(() => {
        expect(showNotification).toHaveBeenCalledTimes(1);
      });
      expect(showNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: "thread.activity",
          severity: "warning",
          title: "Input needed",
          body: "Notification regression",
          route: {
            kind: "thread",
            environmentId,
            threadId,
          },
        }),
      );
    } finally {
      await mounted.unmount();
    }
  });

  it("routes thread notification activations", async () => {
    settingsHarness.desktopThreadNotificationsEnabled = true;
    const { activate } = installDesktopBridge();
    const { history, mounted } = await renderCoordinator("active-thread" as ThreadId);

    try {
      activate({
        notificationId: "notification-1",
        topic: "thread.activity",
        createdAt: "2026-05-14T10:00:00.000Z",
        route: {
          kind: "thread",
          environmentId,
          threadId,
        },
      });

      await vi.waitFor(() => {
        expect(history.location.pathname).toBe(`/${environmentId}/${threadId}`);
      });
    } finally {
      await mounted.unmount();
    }
  });
});
