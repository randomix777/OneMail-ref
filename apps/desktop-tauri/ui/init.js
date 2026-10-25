// Injected by the Rust shell as a webview initialization script, so it runs
// before the renderer bundle. Rebuilds the surface the Electron preload used to
// expose (`window.inboxZeroDesktop`) on top of Tauri IPC.
//
// Two ordering hazards drive the shape of this file:
//
//  1. Tauri's `window.__TAURI__` global is not guaranteed to exist yet when an
//     initialization script runs, so every command resolves the transport at call
//     time and the snapshot listener attaches as soon as the event API appears.
//  2. Bundled dependencies read the Node `process` global, which Electron's
//     renderer had and a plain webview does not. The shim below is what keeps
//     `main.js` from throwing `process is not defined`.
(() => {
  if (window.__ONEMAIL_BRIDGE__) return;
  window.__ONEMAIL_BRIDGE__ = true;

  if (typeof window.process === "undefined") {
    window.process = {
      env: { NODE_ENV: "production" },
      platform: "win32",
      versions: {},
      emit() {
        return false;
      },
    };
  }

  const snapshotListeners = new Set();
  let eventApiReady = false;

  function invokeFn() {
    const api = window.__TAURI__;
    if (typeof api?.invoke === "function") {
      return (command, args) => api.invoke(command, args);
    }
    const internals = window.__TAURI_INTERNALS__;
    if (typeof internals?.invoke === "function") {
      return (command, args) => internals.invoke(command, args);
    }
    return null;
  }

  function call(command, args) {
    const invoke = invokeFn();
    if (!invoke) {
      return Promise.reject(new Error(`Tauri IPC is unavailable (${command})`));
    }
    // Tauri rejects with the command's error payload, usually a plain string. The
    // renderer reports `failure.message`, so a bare string would be replaced by a
    // generic message. Normalize every rejection into an Error.
    return Promise.resolve(invoke(command, args)).catch((failure) => {
      throw asError(failure);
    });
  }

  function asError(failure) {
    if (failure instanceof Error) return failure;
    if (typeof failure === "string") return new Error(failure);
    if (failure && typeof failure.message === "string") {
      return new Error(failure.message);
    }
    try {
      return new Error(JSON.stringify(failure));
    } catch {
      return new Error(String(failure));
    }
  }

  function attachSnapshotListener() {
    if (eventApiReady || snapshotListeners.size === 0) return;
    const listen = window.__TAURI__?.event?.listen;
    if (typeof listen !== "function") {
      setTimeout(attachSnapshotListener, 10);
      return;
    }
    eventApiReady = true;
    listen("mail-engine-snapshot", (event) => {
      for (const listener of snapshotListeners) listener(event.payload);
    });
  }

  window.inboxZeroDesktop = {
    // Window chrome belongs to the shell; the renderer's calls are no-ops.
    setUnreadCount: () => undefined,
    signalReady: () => undefined,
    openWindow: () => Promise.resolve(null),
    onOpenSettings: () => () => undefined,

    mailEngine: (payload) => call("mail_engine", { payload }),
    mailEngineSubscribe: (input) => call("mail_engine_subscribe", { input }),
    mailEngineUnsubscribe: (subscriptionId) =>
      call("mail_engine_unsubscribe", { subscriptionId }),
    onMailEngineSnapshot(listener) {
      snapshotListeners.add(listener);
      attachSnapshotListener();
      return () => snapshotListeners.delete(listener);
    },

    // Tauri serializes `Vec<u8>` as a JSON array, but the renderer wraps the
    // result in `new Blob([...])`, which only takes a BufferSource. Restore the
    // `Uint8Array` shape Electron's IPC used to deliver.
    readAttachment: async (input) => {
      const bytes = await call("read_attachment", { input });
      return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    },
    wipeMailbox: () => call("wipe_mailbox"),
    getDesktopHealth: () => call("desktop_health"),

    localAssistant: {
      settings: () => call("local_settings"),
      saveAccount: (input) => call("local_account_save", { input }),
      removeAccount: (id) => call("local_account_remove", { id }),
      connectAi: () => call("local_ai_connect"),
      refreshAi: () => call("local_ai_refresh"),
      disconnectAi: () => call("local_ai_disconnect"),
      models: () => call("local_ai_models"),
      analyze: (input) => call("local_ai_analyze", { input }),
    },
  };
})();
