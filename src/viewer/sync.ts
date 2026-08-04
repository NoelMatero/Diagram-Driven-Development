/**
 * Keeps the browser scene and the .excalidraw file in step.
 *
 * Outbound: local edits are debounced and written to the file.
 * Inbound: the server pushes a revision over SSE whenever the file changes,
 * including when Claude writes it, and the new scene is pulled in.
 *
 * When both happen at once the human wins. A save with a stale revision comes
 * back 409 with the current board attached; we replay our own touched elements
 * over it and retry, so an agent write never silently erases a fresh stroke.
 */
export interface BoardPayload {
  type: string;
  version: number;
  source: string;
  elements: Array<Record<string, unknown>>;
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
}

export type SyncStatus = "connecting" | "live" | "saving" | "offline";

export interface RemoteBoardMeta {
  /** Absolute path of the board being served. */
  file?: string;
  /**
   * True when the incoming scene shares no elements with the previous one --
   * a replaced diagram or a switched file. The viewport should reframe;
   * for ordinary additions it must be left alone.
   */
  wholesale: boolean;
}

export interface SyncHandlers {
  /** A new scene arrived from disk and should replace what is on screen. */
  onRemoteBoard(board: BoardPayload, meta: RemoteBoardMeta): void;
  onStatus(status: SyncStatus, detail?: string): void;
}

const SAVE_DEBOUNCE_MS = 400;

/** Identity plus mutation counter: enough to tell a real edit from a selection. */
function fingerprint(elements: Array<Record<string, unknown>>): string {
  return elements.map((element) => `${element.id}:${element.version ?? 0}`).join(",");
}

function elementMap(elements: Array<Record<string, unknown>>): Map<string, Record<string, unknown>> {
  return new Map(elements.map((element) => [String(element.id), element]));
}

export class BoardSync {
  #revision = "";
  /**
   * The board the server last told us it is serving. Tracked separately from the
   * revision because the revision is a hash of the *content*: pointing the
   * server at a different file that happens to hold the same elements produces
   * the same revision, and the page would keep naming the old file while showing
   * the new one. Measured: switching between two identical copies left the pill
   * on the previous filename, reading `live`.
   */
  #file = "";
  #lastSynced = new Map<string, Record<string, unknown>>();
  #lastSentFingerprint = "";
  #pending?: BoardPayload;
  #pendingGeneration = 0;
  #timer?: number;
  #inFlight = false;
  #events?: EventSource;
  /**
   * Bumped every time a remote board is applied. A queued save carries the
   * generation it was made under; if that no longer matches, the scene it
   * describes has been superseded and writing it would revert whatever arrived
   * in the meantime. The revision check alone cannot catch this, because by the
   * time the stale save fires the viewer has already learned the new revision
   * and the write looks current.
   */
  #generation = 0;

  constructor(private readonly handlers: SyncHandlers) {}

  async start(): Promise<void> {
    this.handlers.onStatus("connecting");
    await this.pull();
    this.#events = new EventSource("/api/events");
    this.#events.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as { type?: string; revision?: string; file?: string };
        if (payload.type !== "board" || !payload.revision) return;
        // Our own save echoes back; only a genuinely newer revision matters --
        // or a different file, which can carry an identical revision.
        const sameFile = payload.file === undefined || payload.file === this.#file;
        if (payload.revision === this.#revision && sameFile) return;
        void this.pull();
      } catch {
        // Ignore malformed frames; the next one will be fine.
      }
    };
    this.#events.onopen = () => this.handlers.onStatus("live");
    this.#events.onerror = () => this.handlers.onStatus("offline", "reconnecting");
  }

  stop(): void {
    this.#events?.close();
    if (this.#timer) window.clearTimeout(this.#timer);
  }

  async pull(): Promise<void> {
    try {
      const response = await fetch("/api/board", { cache: "no-store" });
      if (!response.ok) throw new Error(`GET /api/board -> ${response.status}`);
      const payload = (await response.json()) as {
        revision: string;
        board: BoardPayload;
        file?: string;
      };

      const previous = this.#lastSynced;
      const shared = payload.board.elements.filter((element) => previous.has(String(element.id))).length;
      const wholesale = previous.size === 0 || shared === 0;

      // Anything queued describes a scene older than what just arrived.
      this.#generation += 1;
      if (this.#timer) window.clearTimeout(this.#timer);
      this.#timer = undefined;
      this.#pending = undefined;

      this.#revision = payload.revision;
      this.#file = payload.file ?? "";
      this.#lastSynced = elementMap(payload.board.elements);
      this.#lastSentFingerprint = fingerprint(payload.board.elements);
      this.handlers.onRemoteBoard(payload.board, { file: payload.file, wholesale });
      this.handlers.onStatus("live");
    } catch (error) {
      this.handlers.onStatus("offline", error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Records the scene the canvas holds after applying a remote board.
   * Excalidraw re-stamps element versions on updateScene, so without this the
   * very next onChange looks like a local edit and schedules a pointless save.
   */
  markApplied(elements: Array<Record<string, unknown>>): void {
    this.#lastSentFingerprint = fingerprint(elements);
    this.#lastSynced = elementMap(elements);
  }

  /** Called on every Excalidraw change; cheap to call constantly. */
  push(board: BoardPayload): void {
    const next = fingerprint(board.elements);
    if (next === this.#lastSentFingerprint) return;

    // A scene sharing no ids with the one we loaded is a different document,
    // not an edit -- Excalidraw's own File > Open does this. Saving it would
    // overwrite this board with an unrelated one.
    if (this.#lastSynced.size > 0 && board.elements.length > 0) {
      const known = board.elements.filter((element) => this.#lastSynced.has(String(element.id))).length;
      if (known === 0) {
        this.handlers.onStatus("offline", "That looks like a different file; not saving it over this board.");
        return;
      }
    }

    this.#pending = board;
    this.#pendingGeneration = this.#generation;
    if (this.#timer) window.clearTimeout(this.#timer);
    this.#timer = window.setTimeout(() => void this.#flush(), SAVE_DEBOUNCE_MS);
  }

  async #flush(): Promise<void> {
    if (this.#inFlight || !this.#pending) return;
    if (this.#pendingGeneration !== this.#generation) {
      // A remote board landed after this was queued; it is stale now.
      this.#pending = undefined;
      return;
    }
    const board = this.#pending;
    this.#pending = undefined;
    this.#inFlight = true;
    this.handlers.onStatus("saving");
    try {
      const response = await fetch("/api/board", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: this.#revision, board }),
      });

      if (response.status === 409) {
        const conflict = (await response.json()) as { revision: string; board: BoardPayload };
        const merged = this.#merge(conflict.board, board);
        this.#revision = conflict.revision;
        this.#pending = merged;
        this.#pendingGeneration = this.#generation;
        this.handlers.onRemoteBoard(merged, { wholesale: false });
        this.#inFlight = false;
        return void this.#flush();
      }

      if (!response.ok) throw new Error(`POST /api/board -> ${response.status}`);
      const payload = (await response.json()) as { revision: string };
      this.#revision = payload.revision;
      this.#lastSynced = elementMap(board.elements);
      this.#lastSentFingerprint = fingerprint(board.elements);
      this.handlers.onStatus("live");
    } catch (error) {
      this.handlers.onStatus("offline", error instanceof Error ? error.message : String(error));
    } finally {
      this.#inFlight = false;
      if (this.#pending) this.#timer = window.setTimeout(() => void this.#flush(), SAVE_DEBOUNCE_MS);
    }
  }

  /**
   * Remote board as the base, with anything the human touched laid back over
   * it. "Touched" means created locally, or differing from the copy we last
   * agreed on with the server.
   */
  #merge(remote: BoardPayload, local: BoardPayload): BoardPayload {
    const remoteById = elementMap(remote.elements);
    const merged = [...remote.elements];

    for (const element of local.elements) {
      const id = String(element.id);
      const synced = this.#lastSynced.get(id);
      const untouched = synced && JSON.stringify(synced) === JSON.stringify(element);
      if (untouched) continue;

      const index = merged.findIndex((candidate) => String(candidate.id) === id);
      if (index >= 0) merged[index] = element;
      else if (!remoteById.has(id)) merged.push(element);
    }

    return { ...remote, elements: merged, files: { ...remote.files, ...local.files } };
  }
}
