import posthog from "posthog-js";
import React from "react";
import { Data } from "ws";
import { getSettings } from "#/services/settings";
import ActionType from "#/types/ActionType";
import EventLogger from "#/utils/event-logger";

interface WebSocketClientStartOptions {
  token: string | null;
  ghToken: string | null;
}

export enum WebSocketClientStatus {
  STOPPED,
  STARTING,
  STARTED,
}

type StatusChangeListener = (status: WebSocketClientStatus) => void;
type MessageListener = (message: Record<string, unknown>) => void;
type ErrorListener = (event: Event) => void;

interface WebSocketClientContextType {
  start: (options?: WebSocketClientStartOptions) => void;
  stop: () => void;
  send: (data: Record<string, unknown>) => void;

  addStatusChangeListener: (listener: StatusChangeListener) => void;
  removeStatusChangeListener: (listener: StatusChangeListener) => void;

  addMessageListener: (listener: MessageListener) => void;
  removeMessageListener: (listener: MessageListener) => void;

  addErrorListener: (listener: ErrorListener) => void;
  removeErrorListener: (listener: ErrorListener) => void;

  status: WebSocketClientStatus;
  messages: Record<string, unknown>[];
  isStarted: boolean;
}

const WebSocketClientContext = React.createContext<
  WebSocketClientContextType | undefined
>(undefined);

interface WebSocketClientProviderProps {
  children: React.ReactNode;
}

function WebSocketClientProvider({ children }: WebSocketClientProviderProps) {
  const [ws, setWs] = React.useState<WebSocket | null>(null);
  const [status, setStatus] = React.useState<WebSocketClientStatus>(
    WebSocketClientStatus.STOPPED,
  );
  const [messages, setMessages] = React.useState<Record<string, unknown>[]>([]);
  const [statusChangeListeners, setStatusChangeListeners] = React.useState<
    StatusChangeListener[]
  >([]);
  const [messageListeners, setMessageListeners] = React.useState<
    MessageListener[]
  >([]);
  const [errorListeners, setErrorListeners] = React.useState<ErrorListener[]>(
    [],
  );

  function send(data: Record<string, unknown>) {
    if (!ws) {
      EventLogger.error("WebSocket is not connected.");
      return;
    }
    setMessages([...messages, data]);
    ws.send(JSON.stringify(data));
  }

  function handleOpen() {
    send({
      action: ActionType.INIT,
      args: getSettings(),
    });
  }

  function handleClose() {
    setStatus(WebSocketClientStatus.STOPPED);
    setWs(null);
  }

  function handleError(event: Event) {
    posthog.capture("socket_error");
    EventLogger.event(event, "SOCKET ERROR");
    for (const listener of errorListeners) {
      try {
        listener(event);
      } catch (e) {
        console.log("Error in listener", e);
      }
    }
  }

  function handleMessage(event: MessageEvent<Data>) {
    const { data } = event;
    const message = JSON.parse(data.toString());
    EventLogger.message(message);
    if (message.extras?.agent_state === "init") {
      setStatus(WebSocketClientStatus.STARTED);
    }
    setMessages([...messages, message]);
    for (const listener of messageListeners) {
      try {
        listener(message);
      } catch (e) {
        console.log("Error in listener", e);
      }
    }
  }

  function start(options?: WebSocketClientStartOptions) {
    if (ws) {
      EventLogger.warning("Overriding existing WebSocket!");
    }

    const baseUrl =
      import.meta.env.VITE_BACKEND_BASE_URL || window?.location.host;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const token = options?.token || "NO_JWT"; // not allowed to be empty or duplicated
    const ghToken = localStorage.getItem("ghToken") || "NO_GITHUB";

    const newWs = new WebSocket(`${protocol}//${baseUrl}/ws`, [
      "openhands",
      token,
      ghToken,
    ]);

    // auto closes any existing ws and handles event listeners
    setWs(newWs);
  }

  function stop() {
    if (!ws) {
      EventLogger.warning("No connected WebSocket");
      return;
    }

    // Auto closes
    setWs(null);
  }

  function addStatusChangeListener(listener: StatusChangeListener) {
    setStatusChangeListeners([...statusChangeListeners, listener]);
  }

  function removeStatusChangeListener(listener: StatusChangeListener) {
    const listeners = statusChangeListeners.filter((l) => l !== listener);
    if (listeners.length !== statusChangeListeners.length) {
      setStatusChangeListeners(listeners);
    }
  }

  function addMessageListener(listener: MessageListener) {
    setMessageListeners([...messageListeners, listener]);
  }

  function removeMessageListener(listener: MessageListener) {
    const listeners = messageListeners.filter((l) => l !== listener);
    if (listeners.length !== messageListeners.length) {
      setMessageListeners(listeners);
    }
  }

  function addErrorListener(listener: ErrorListener) {
    setErrorListeners([...errorListeners, listener]);
  }

  function removeErrorListener(listener: ErrorListener) {
    const listeners = errorListeners.filter((l) => l !== listener);
    if (listeners.length !== errorListeners.length) {
      setErrorListeners(listeners);
    }
  }

  React.useEffect(() => {
    if (ws) {
      ws.addEventListener("open", handleOpen);
      ws.addEventListener("close", handleClose);
      ws.addEventListener("error", handleError);
      ws.addEventListener("message", handleMessage);
    }
    return () => {
      if (ws) {
        if (
          ws.readyState !== WebSocket.CLOSED &&
          ws.readyState !== WebSocket.CLOSING
        ) {
          ws.close();
        }
        ws.removeEventListener("open", handleOpen);
        ws.removeEventListener("close", handleClose);
        ws.removeEventListener("error", handleError);
        ws.removeEventListener("message", handleMessage);
      }
    };
  }, [ws]);

  const value = React.useMemo(
    () => ({
      start,
      stop,
      send,
      addStatusChangeListener,
      removeStatusChangeListener,
      addMessageListener,
      removeMessageListener,
      addErrorListener,
      removeErrorListener,
      status,
      messages,
      isStarted: status === WebSocketClientStatus.STARTED,
    }),
    [status, messages],
  );

  return (
    <WebSocketClientContext.Provider value={value}>
      {children}
    </WebSocketClientContext.Provider>
  );
}

function useWebSocketClient() {
  const context = React.useContext(WebSocketClientContext);
  if (context == null) {
    throw new Error(
      "useWebSocketClient must be used within a SWebSocketClientProvider",
    );
  }
  return context;
}

export { WebSocketClientProvider, useWebSocketClient };
