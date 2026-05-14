import type { EnvironmentId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { isElectron } from "../env";
import { useSettings } from "../hooks/useSettings";
import {
  createThreadActivityNotificationTracker,
  type ThreadActivityNotificationIntent,
} from "../notifications/threadActivityNotifications";
import { type AppState, selectSidebarThreadsAcrossEnvironments, useStore } from "../store";
import { resolveThreadRouteTarget } from "../threadRoutes";

function readDocumentFocused(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  return document.visibilityState === "visible" && document.hasFocus();
}

function selectBootstrappedEnvironmentIds(state: AppState): EnvironmentId[] {
  return Object.entries(state.environmentStateById).flatMap(([environmentId, environmentState]) =>
    environmentState.bootstrapComplete ? [environmentId as EnvironmentId] : [],
  );
}

function failedNotificationResult(message: string) {
  return {
    status: "failed",
    reason: "failed",
    message,
  } as const;
}

export function NotificationCoordinator() {
  const navigate = useNavigate();
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const activeEnvironmentId =
    routeTarget?.kind === "server" ? routeTarget.threadRef.environmentId : null;
  const activeThreadId = routeTarget?.kind === "server" ? routeTarget.threadRef.threadId : null;
  const activeThreadRef = useMemo(
    () =>
      activeEnvironmentId && activeThreadId
        ? scopeThreadRef(activeEnvironmentId, activeThreadId)
        : null,
    [activeEnvironmentId, activeThreadId],
  );
  const enabled = useSettings((settings) => settings.desktopThreadNotificationsEnabled);
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const bootstrappedEnvironmentIds = useStore(useShallow(selectBootstrappedEnvironmentIds));
  const tracker = useMemo(() => createThreadActivityNotificationTracker(), []);
  const [windowFocused, setWindowFocused] = useState(readDocumentFocused);

  useEffect(() => {
    const syncFocused = () => {
      setWindowFocused(readDocumentFocused());
    };

    window.addEventListener("focus", syncFocused);
    window.addEventListener("blur", syncFocused);
    document.addEventListener("visibilitychange", syncFocused);
    return () => {
      window.removeEventListener("focus", syncFocused);
      window.removeEventListener("blur", syncFocused);
      document.removeEventListener("visibilitychange", syncFocused);
    };
  }, []);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!isElectron || !bridge || !enabled) {
      tracker.reset();
      return;
    }

    const intents = tracker.collect(threads, {
      activeThreadRef,
      bootstrappedEnvironmentIds,
      windowFocused,
    });

    const recordFailure = (intent: ThreadActivityNotificationIntent, error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[NOTIFICATIONS] show failed", {
        notificationId: intent.request.notificationId,
        error: message,
      });
      tracker.recordDelivery(intent, failedNotificationResult(message));
    };

    for (const intent of intents) {
      void bridge
        .showNotification(intent.request)
        .then((result) => {
          if (result.status === "failed" || result.status === "unsupported") {
            console.warn("[NOTIFICATIONS] show failed", {
              notificationId: intent.request.notificationId,
              status: result.status,
              reason: result.reason,
              message: result.message,
            });
          }
          tracker.recordDelivery(intent, result);
        })
        .catch((error: unknown) => {
          recordFailure(intent, error);
        });
    }
  }, [activeThreadRef, bootstrappedEnvironmentIds, enabled, threads, tracker, windowFocused]);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!isElectron || !bridge) {
      return;
    }

    return bridge.onNotificationActivated((activation) => {
      if (!activation.route || activation.route.kind !== "thread") {
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: activation.route.environmentId,
          threadId: activation.route.threadId,
        },
      });
    });
  }, [navigate]);

  return null;
}
