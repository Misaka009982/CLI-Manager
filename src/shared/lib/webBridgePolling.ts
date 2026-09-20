interface BridgePollingCallbacks {
  getStatus: () => Promise<{ connected: boolean; paired: boolean }>;
  drainTerminalCommands: () => Promise<void>;
  drainOperations: () => Promise<void>;
  onConnected: () => void;
  onError: (error: unknown) => void;
}

/** Keep fast command polling off while disconnected; never overlap status probes. */
export function startWebBridgePolling(callbacks: BridgePollingCallbacks) {
  let disposed = false;
  let online = false;
  let checking = false;
  let checkAgain = false;
  let operationWakePending = false;
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  let drainingTerminal = false;
  let drainingOperations = false;

  async function drainOperationsNow() {
    if (!online || disposed) return;
    if (drainingOperations) {
      operationWakePending = true;
      return;
    }
    drainingOperations = true;
    try {
      await callbacks.drainOperations();
    } catch (error) {
      if (!disposed) callbacks.onError(error);
    } finally {
      drainingOperations = false;
      if (!disposed && operationWakePending) {
        operationWakePending = false;
        void drainOperationsNow();
      }
    }
  }

  async function checkStatus() {
    if (disposed) return;
    if (checking) { checkAgain = true; return; }
    checking = true;
    try {
      const status = await callbacks.getStatus();
      if (disposed) return;
      const connected = status.connected && status.paired;
      const becameConnected = connected && !online;
      online = connected;
      if (becameConnected) callbacks.onConnected();
      if (connected && operationWakePending) {
        operationWakePending = false;
        void drainOperationsNow();
      }
    } catch (error) {
      online = false;
      if (!disposed) callbacks.onError(error);
    } finally {
      checking = false;
      if (!disposed) {
        statusTimer = setTimeout(() => void checkStatus(), checkAgain ? 0 : 3_000);
        checkAgain = false;
      }
    }
  }

  const terminalTimer = setInterval(async () => {
    if (!online || disposed || drainingTerminal) return;
    drainingTerminal = true;
    try { await callbacks.drainTerminalCommands(); }
    catch (error) { if (!disposed) callbacks.onError(error); }
    finally { drainingTerminal = false; }
  }, 75);
  const operationTimer = setInterval(() => void drainOperationsNow(), 1_000);
  void checkStatus();

  return {
    wake() {
      clearTimeout(statusTimer);
      void checkStatus();
    },
    wakeOperations() {
      operationWakePending = true;
      if (online) {
        operationWakePending = false;
        void drainOperationsNow();
        return;
      }
      clearTimeout(statusTimer);
      void checkStatus();
    },
    stop() {
      disposed = true;
      online = false;
      operationWakePending = false;
      clearTimeout(statusTimer);
      clearInterval(terminalTimer);
      clearInterval(operationTimer);
    },
  };
}
