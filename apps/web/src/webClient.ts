import type {
  AuthStatus,
  BrowserSession,
  ConversationEvent,
  BrowserMessage,
  BrowserTerminalCommand,
  Device,
  HistorySessionSummary,
  JsonObject,
  Operation,
  Pairing,
  WorkspaceSnapshot,
} from "./domain";
import { publishFileOperation } from "./fileOperationEvents";
import { projectDirectoryCache } from "./projectDirectoryCache";

import { ApiError, webRequest } from "../../../src/shared/lib/webBrowserHttp";
import {
  connectBrowserSocket as connectSharedSocket,
  type BrowserSocketOptions,
  type BrowserSocketConnection,
} from "../../../src/shared/lib/webBrowserSocket";
export { ApiError };
export type { BrowserSocketConnection };

// Keep classic cache invalidation local; the transport has no UI/cache dependency.
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  try { return await webRequest<T>(path, init); }
  catch (error) {
    if (error instanceof ApiError && error.status === 401)
      projectDirectoryCache.clear(undefined, new Error("session_expired"));
    throw error;
  }
}

export const webClient = {
  operation: (id: string, signal?: AbortSignal) => request<{ operation: Operation }>(`/operations/${encodeURIComponent(id)}`, { signal }),
  authStatus: () => request<AuthStatus>("/auth/status"),
  redeemMobile: (token: string, name: string) => request<AuthStatus>("/mobile/redeem", { method: "POST", body: JSON.stringify({ token, name }) }),
  browserSessions: () => request<{ sessions: BrowserSession[] }>("/mobile/sessions"),
  mobileTicket: (deviceId: string) => request<{ token: string; expiresAt: number }>("/mobile/tickets", { method: "POST", body: JSON.stringify({ deviceId }) }),
  stopMobileTicket: (deviceId: string) => request<{ ok: true }>(`/mobile/tickets/${encodeURIComponent(deviceId)}`, { method: "DELETE" }),
  revokeBrowser: (id: string) => request<{ ok: true }>(`/mobile/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  conversations: (deviceId: string, signal?: AbortSignal) => request<{ sessions: HistorySessionSummary[] }>(`/conversations?${new URLSearchParams({ deviceId })}`, { signal }),
  conversation: (deviceId: string, sessionId: string) => request<{ events: ConversationEvent[] }>(`/conversations/${encodeURIComponent(sessionId)}?${new URLSearchParams({ deviceId })}`),
  login: (username: string, password: string) =>
    request<AuthStatus>("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: async () => {
    projectDirectoryCache.clear();
    try { return await request<{ ok: true }>("/auth/logout", { method: "POST" }); }
    finally { projectDirectoryCache.clear(); }
  },
  devices: () => request<{ devices: Device[] }>("/devices"),
  removeDevice: async (deviceId: string) => {
    const result = await request<{ ok: true }>(`/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
    projectDirectoryCache.clearDevice(deviceId);
    return result;
  },
  claimPairing: (code: string) =>
    request<{ pairing: Pairing; device: Device }>("/pairing/claim", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),
  history: (deviceId: string, limit = 50, offset = 0, signal?: AbortSignal) => {
    const query = new URLSearchParams({ deviceId, limit: String(limit), offset: String(offset) });
    return request<{ items: HistorySessionSummary[]; nextOffset: number | null; workspace: WorkspaceSnapshot | null }>(`/history?${query}`, { signal });
  },
  createOperation: (input: {
    deviceId: string;
    kind: string;
    idempotencyKey: string;
    payload: JsonObject;
  }, signal?: AbortSignal) => request<{ operation: Operation }>("/operations", { method: "POST", body: JSON.stringify(input), signal }),
};

export function deviceWallpaperUrl(device: Pick<Device, "id" | "wallpaperRevision">): string | null {
  if (!device.wallpaperRevision) return null;
  return `/api/devices/${encodeURIComponent(device.id)}/wallpaper?revision=${encodeURIComponent(device.wallpaperRevision)}`;
}

// Preserve classic operation/cache effects around the shared wire connection.
export function connectBrowserSocket(options: BrowserSocketOptions): BrowserSocketConnection {
  let highWater = 0;
  const connection = connectSharedSocket({
    ...options,
    onUnauthorized: () => { projectDirectoryCache.clear(); options.onUnauthorized(); },
    onMessage: (message) => {
      if (message.type === "ready") {
        highWater = message.latestSequence;
        projectDirectoryCache.invalidate();
      }
      if (message.type === "event" && message.payload.type === "operation.updated")
        publishFileOperation(message.payload.operation);
      if (message.type === "event" && message.sequence > highWater
        && message.payload.type === "device.updated" && message.payload.device.status !== "online")
        projectDirectoryCache.clearDevice(message.payload.device.id);
      options.onMessage(message);
    },
  });
  return {
    sendTerminal: connection.sendTerminal,
    close: () => { projectDirectoryCache.clear(); connection.close(); },
  };
}
