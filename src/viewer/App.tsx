import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BoardSync, type BoardPayload, type SyncStatus } from "./sync";

const STATUS_LABEL: Record<SyncStatus, string> = {
  connecting: "connecting",
  live: "live",
  saving: "saving",
  offline: "offline",
};

function StatusPill({
  status,
  detail,
  file,
}: {
  status: SyncStatus;
  detail?: string;
  file?: string;
}) {
  return (
    <div className={`status status-${status}`} title={detail ?? file ?? ""}>
      <span className="status-dot" />
      {/* Which board this is showing. Without it, a page pointed at another
          file looks identical to one that simply is not updating. */}
      {file ? <span className="status-file">{file.split("/").pop()}</span> : null}
      {STATUS_LABEL[status]}
    </div>
  );
}

export default function App() {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [status, setStatus] = useState<SyncStatus>("connecting");
  const [detail, setDetail] = useState<string>();
  const [file, setFile] = useState<string>();

  // Suppresses the onChange that our own updateScene triggers, so applying a
  // remote board does not immediately bounce back as a local save.
  const applyingRemote = useRef(false);
  // Frame the board once on open. Re-fitting on every remote update would
  // yank the viewport out from under someone who has scrolled somewhere.
  const framed = useRef(false);

  const sync = useMemo(
    () =>
      new BoardSync({
        onRemoteBoard: (board, meta) => {
          const api = apiRef.current;
          if (!api) return;
          if (meta.file) setFile(meta.file);
          applyingRemote.current = true;
          try {
            const files = Object.values(board.files ?? {});
            if (files.length) api.addFiles(files as Parameters<ExcalidrawImperativeAPI["addFiles"]>[0]);
            const elements = board.elements as unknown as NonNullable<
              Parameters<ExcalidrawImperativeAPI["updateScene"]>[0]["elements"]
            >;
            api.updateScene({ elements });
            // Read the scene back: updateScene re-stamps versions, so the file's
            // own numbers are not what the canvas now holds.
            sync.markApplied(
              api.getSceneElements() as unknown as Array<Record<string, unknown>>,
            );
            // Reframe on first load, and whenever the scene is replaced
            // outright -- the old viewport says nothing about where the new
            // content sits. Ordinary additions leave the view untouched.
            if (elements.length > 0 && (!framed.current || meta.wholesale)) {
              framed.current = true;
              api.scrollToContent(elements, { fitToContent: true, animate: false });
            }
          } finally {
            // updateScene notifies listeners synchronously; release on the
            // next tick so the resulting onChange is the one we skip.
            setTimeout(() => {
              applyingRemote.current = false;
            }, 0);
          }
        },
        onStatus: (next, why) => {
          setStatus(next);
          setDetail(why);
        },
      }),
    [],
  );

  useEffect(() => {
    void sync.start();
    return () => sync.stop();
  }, [sync]);

  const onChange = useCallback(
    (
      elements: readonly unknown[],
      _appState: unknown,
      files: Record<string, unknown>,
    ) => {
      if (applyingRemote.current) return;
      sync.push({
        type: "excalidraw",
        version: 2,
        source: "board-viewer",
        elements: elements as Array<Record<string, unknown>>,
        appState: {},
        files: files ?? {},
      } satisfies BoardPayload);
    },
    [sync],
  );

  return (
    <div className="board-root">
      <StatusPill status={status} detail={detail} file={file} />
      <Excalidraw
        excalidrawAPI={(api) => {
          apiRef.current = api;
          // Test affordance: end-to-end checks must assert against the scene
          // the canvas is actually showing, not against what the API returns.
          (window as unknown as { __boardScene?: () => unknown }).__boardScene = () => {
            const elements = api.getSceneElements();
            return {
              count: elements.length,
              ids: elements.map((element) => element.id),
            };
          };
        }}
        onChange={onChange}
        initialData={{ appState: { viewBackgroundColor: "#ffffff" } }}
        // Open stays available: it is a useful escape hatch for inspecting
        // another board. Saving an unrelated scene over this one is prevented in
        // BoardSync.push, which refuses a scene sharing no element ids with the
        // one it loaded, rather than by removing the menu item.
      />
    </div>
  );
}
