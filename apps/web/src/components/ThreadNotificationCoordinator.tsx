import type { EnvironmentId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { type AppState, selectSidebarThreadsAcrossEnvironments, useStore } from "../store";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import { createThreadNotificationTracker } from "../threadNotifications";
import { useSettings } from "../hooks/useSettings";
import { isElectron } from "../env";

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

export function ThreadNotificationCoordinator() {
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
  const tracker = useMemo(() => createThreadNotificationTracker(), []);
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

    for (const intent of intents) {
      void bridge
        .showNotification({
          id: intent.key,
          kind: intent.kind,
          title: intent.title,
          body: intent.body,
          groupId: intent.groupId,
          route: buildThreadRouteParams(intent.threadRef),
        })
        .then((result) => {
          if (!result.shown) {
            console.warn("[THREAD_NOTIFICATIONS] show failed", {
              key: intent.key,
              reason: result.reason,
              message: result.message,
            });
          }
        })
        .catch((error: unknown) => {
          console.warn("[THREAD_NOTIFICATIONS] show failed", {
            key: intent.key,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
  }, [activeThreadRef, bootstrappedEnvironmentIds, enabled, threads, tracker, windowFocused]);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!isElectron || !bridge) {
      return;
    }

    return bridge.onNotificationActivated((activation) => {
      if (!activation.route) {
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: activation.route,
      });
    });
  }, [navigate]);

  return null;
}
