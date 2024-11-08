import { useDisclosure } from "@nextui-org/react";
import React from "react";
import {
  Outlet,
  useFetcher,
  useLoaderData,
  json,
  ClientActionFunctionArgs,
  useRouteLoaderData,
} from "@remix-run/react";
import { useDispatch, useSelector } from "react-redux";
import toast from "react-hot-toast";
import { getSettings } from "#/services/settings";
import Security from "../components/modals/security/Security";
import { Controls } from "#/components/controls";
import store, { RootState } from "#/store";
import { Container } from "#/components/container";
import { handleAssistantMessage } from "#/services/actions";
import {
  addErrorMessage,
  addUserMessage,
  clearMessages,
} from "#/state/chatSlice";
import {
  getGitHubTokenCommand,
  getCloneRepoCommand,
} from "#/services/terminalService";
import { clearTerminal } from "#/state/commandSlice";
import { useEffectOnce } from "#/utils/use-effect-once";
import CodeIcon from "#/assets/code.svg?react";
import GlobeIcon from "#/assets/globe.svg?react";
import ListIcon from "#/assets/list-type-number.svg?react";
import { createChatMessage } from "#/services/chatService";
import {
  clearFiles,
  clearInitialQuery,
  clearSelectedRepository,
  setImportedProjectZip,
} from "#/state/initial-query-slice";
import { isGitHubErrorReponse, retrieveLatestGitHubCommit } from "#/api/github";
import OpenHands from "#/api/open-hands";
import AgentState from "#/types/AgentState";
import { base64ToBlob } from "#/utils/base64-to-blob";
import { clientLoader as rootClientLoader } from "#/routes/_oh";
import { clearJupyter } from "#/state/jupyterSlice";
import { FilesProvider } from "#/context/files";
import { ErrorObservation } from "#/types/core/observations";
import { ChatInterface } from "#/components/chat-interface";
import { cn } from "#/utils/utils";
import {
  useWebSocketClient,
  WebSocketClientStatus,
} from "#/context/web-socket-client";

interface ServerError {
  error: boolean | string;
  message: string;
  [key: string]: unknown;
}

const isServerError = (data: object): data is ServerError => "error" in data;

const isErrorObservation = (data: object): data is ErrorObservation =>
  "observation" in data && data.observation === "error";

const isAgentStateChange = (
  data: object,
): data is { extras: { agent_state: AgentState } } =>
  "extras" in data &&
  data.extras instanceof Object &&
  "agent_state" in data.extras;

export const clientLoader = async () => {
  const ghToken = localStorage.getItem("ghToken");

  const q = store.getState().initalQuery.initialQuery;
  const repo =
    store.getState().initalQuery.selectedRepository ||
    localStorage.getItem("repo");

  const settings = getSettings();
  const token = localStorage.getItem("token");

  if (repo) localStorage.setItem("repo", repo);

  let lastCommit: GitHubCommit | null = null;
  if (ghToken && repo) {
    const data = await retrieveLatestGitHubCommit(ghToken, repo);
    if (isGitHubErrorReponse(data)) {
      // TODO: Handle error
      console.error("Failed to retrieve latest commit", data);
    } else {
      [lastCommit] = data;
    }
  }

  return json({
    settings,
    token,
    ghToken,
    repo,
    q,
    lastCommit,
  });
};

export const clientAction = async ({ request }: ClientActionFunctionArgs) => {
  const formData = await request.formData();

  const token = formData.get("token")?.toString();
  const ghToken = formData.get("ghToken")?.toString();

  if (token) localStorage.setItem("token", token);
  if (ghToken) localStorage.setItem("ghToken", ghToken);

  return json(null);
};

function App() {
  console.log("render app");
  const dispatch = useDispatch();
  const { files, importedProjectZip } = useSelector(
    (state: RootState) => state.initalQuery,
  );
  const webSocketClient = useWebSocketClient();
  const { settings, token, ghToken, repo, q, lastCommit } =
    useLoaderData<typeof clientLoader>();
  const fetcher = useFetcher();
  const data = useRouteLoaderData<typeof rootClientLoader>("routes/_oh");

  const secrets = React.useMemo(
    () => [ghToken, token].filter((secret) => secret !== null),
    [ghToken, token],
  );

  // To avoid re-rendering the component when the user object changes, we memoize the user ID.
  // We use this to ensure the github token is valid before exporting it to the terminal.
  const userId = React.useMemo(() => {
    if (data?.user && !isGitHubErrorReponse(data.user)) return data.user.id;
    return null;
  }, [data?.user]);

  const Terminal = React.useMemo(
    () => React.lazy(() => import("../components/terminal/Terminal")),
    [],
  );

  const addIntialQueryToChat = (
    query: string,
    base64Files: string[],
    timestamp = new Date().toISOString(),
  ) => {
    dispatch(
      addUserMessage({
        content: query,
        imageUrls: base64Files,
        timestamp,
      }),
    );
  };

  const doSendInitialQuery = React.useRef<boolean>(true);

  const sendInitialQuery = (query: string, base64Files: string[]) => {
    const timestamp = new Date().toISOString();
    webSocketClient.send(createChatMessage(query, base64Files, timestamp));
  };

  const handleStatusChange = (status: WebSocketClientStatus) => {
    if (status !== WebSocketClientStatus.STARTED) {
      return;
    }
    dispatch(clearMessages());
    dispatch(clearTerminal());
    dispatch(clearJupyter());

    // display query in UI, but don't send it to the server
    if (q) addIntialQueryToChat(q, files);
  };

  const handleMessage = (message: Record<string, unknown>) => {
    // set token received from the server
    if (message.token) {
      fetcher.submit({ token: message.token as string }, { method: "post" });
      return;
    }

    if (isServerError(message)) {
      if (message.error_code === 401) {
        toast.error("Session expired.");
        fetcher.submit({}, { method: "POST", action: "/end-session" });
        return;
      }

      if (typeof message.error === "string") {
        toast.error(message.error);
      } else {
        toast.error(message.message);
      }

      return;
    }
    if (isErrorObservation(message)) {
      dispatch(
        addErrorMessage({
          id: message.extras?.error_id,
          message: message.message,
        }),
      );
      return;
    }

    handleAssistantMessage(message);

    // handle first time connection
    if (
      isAgentStateChange(message) &&
      message.extras.agent_state === AgentState.INIT
    ) {
      // handle new session
      if (!token) {
        let additionalInfo = "";
        if (ghToken && repo) {
          webSocketClient.send(getCloneRepoCommand(ghToken, repo));
          additionalInfo = `Repository ${repo} has been cloned to /workspace. Please check the /workspace for files.`;
          dispatch(clearSelectedRepository()); // reset selected repository; maybe better to move this to '/'?
        }
        // if there's an uploaded project zip, add it to the chat
        else if (importedProjectZip) {
          additionalInfo = `Files have been uploaded. Please check the /workspace for files.`;
        }

        if (q && doSendInitialQuery.current) {
          if (additionalInfo) {
            sendInitialQuery(`${q}\n\n[${additionalInfo}]`, files);
          } else {
            sendInitialQuery(q, files);
          }
          dispatch(clearFiles()); // reset selected files
        }
      }
    }
  };

  /*
  const startSocketConnection = React.useCallback(() => {
    start({
      sessionToken: token,
      // onOpen: handleOpen,
      // onMessage: handleMessage,
    });
  }, [token, handleOpen, handleMessage]);
  */

  useEffectOnce(() => {
    // clear and restart the socket connection
    dispatch(clearMessages());
    dispatch(clearTerminal());
    dispatch(clearJupyter());
    dispatch(clearInitialQuery()); // Clear initial query when navigating to /app
    webSocketClient.addMessageListener(handleMessage);
    webSocketClient.addStatusChangeListener(handleStatusChange);
    webSocketClient.start({
      sessionToken: token,
      ghToken,
    });
  });

  React.useEffect(() => {
    if (webSocketClient.isStarted && userId && ghToken) {
      // Export if the user valid, this could happen mid-session so it is handled here
      webSocketClient.send(getGitHubTokenCommand(ghToken));
    }
  }, [userId, ghToken, webSocketClient.isStarted]);

  React.useEffect(() => {
    (async () => {
      if (webSocketClient.isStarted && importedProjectZip) {
        // upload files action
        try {
          const blob = base64ToBlob(importedProjectZip);
          const file = new File([blob], "imported-project.zip", {
            type: blob.type,
          });
          await OpenHands.uploadFiles([file]);
          dispatch(setImportedProjectZip(null));
        } catch (error) {
          toast.error("Failed to upload project files.");
        }
      }
    })();
  }, [webSocketClient.isStarted, importedProjectZip]);

  const {
    isOpen: securityModalIsOpen,
    onOpen: onSecurityModalOpen,
    onOpenChange: onSecurityModalOpenChange,
  } = useDisclosure();

  return (
    <div className="flex flex-col h-full gap-3">
      <div className="flex h-full overflow-auto gap-3">
        <Container className="w-[390px] max-h-full relative">
          <div
            className={cn(
              "w-2 h-2 rounded-full border",
              "absolute left-3 top-3",
              webSocketClient.isStarted
                ? "bg-green-800 border-green-500"
                : "bg-red-800 border-red-500",
            )}
          />
          <ChatInterface />
        </Container>

        <div className="flex flex-col grow gap-3">
          <Container
            className="h-2/3"
            labels={[
              { label: "Workspace", to: "", icon: <CodeIcon /> },
              { label: "Jupyter", to: "jupyter", icon: <ListIcon /> },
              {
                label: "Browser",
                to: "browser",
                icon: <GlobeIcon />,
                isBeta: true,
              },
            ]}
          >
            <FilesProvider>
              <Outlet />
            </FilesProvider>
          </Container>
          {/* Terminal uses some API that is not compatible in a server-environment. For this reason, we lazy load it to ensure
           * that it loads only in the client-side. */}
          <Container className="h-1/3 overflow-scroll" label="Terminal">
            <React.Suspense fallback={<div className="h-full" />}>
              <Terminal secrets={secrets} />
            </React.Suspense>
          </Container>
        </div>
      </div>

      <div className="h-[60px]">
        <Controls
          setSecurityOpen={onSecurityModalOpen}
          showSecurityLock={!!settings.SECURITY_ANALYZER}
          lastCommitData={lastCommit}
        />
      </div>
      <Security
        isOpen={securityModalIsOpen}
        onOpenChange={onSecurityModalOpenChange}
        securityAnalyzer={settings.SECURITY_ANALYZER}
      />
    </div>
  );
}

export default App;
