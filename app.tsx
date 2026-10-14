/**
 * GPUIX React "hf-cache" desktop GUI app — Adwaita (GTK4/libadwaita) nightsky.
 *
 * A browser/manager for the Hugging Face cache built exclusively from
 * `adwaita-gpuix` components: a two-pane body — a BoxedList of resource rows
 * (type icon, title, meta, size, symbolic delete Button) left and a details
 * pane for the selected resource right (type, size, files, revisions, last
 * accessed/modified, path, and the per-revision breakdown); a status bar with
 * Kbd key hints; and an AlertDialog delete-confirmation flow with the standing
 * keyboard shortcuts. There is no header bar, no search field and no refresh
 * button — sorting is cycled through with the "/" key and refresh stays on
 * "r".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  render,
  useGpuixRequired,
  useWindowSize,
  type EventPayload,
  type PublicInstance,
} from "@gpuix/react";
import {
  AdwaitaProvider,
  useAdwaita,
  hexToRgba,
  isDarkScheme,
  Button,
  BoxedList,
  Separator,
  StatusPage,
  SectionTitle,
  AlertDialog,
  T,
  Kbd,
  KbdGroup,
  Icon,
  type IconName,
} from "adwaita-gpuix/src";
import {
  scanCacheDir,
  deleteRepo,
  type RepoInfo,
} from "./cache";
import { formatSize, formatTimeSince, formatTimestamp } from "./formatting";

/** Sort labels (index = sortKey). */
const SORT_LABELS = [
  "Resource",
  "Size",
  "Files",
  "Revisions",
  "Last Modified",
] as const;

/** Comparators per sort key (index = sortKey), all descending except id. */
const SORT_COMPARATORS: ReadonlyArray<(a: RepoInfo, b: RepoInfo) => number> =
  [
    (a, b) =>
      a.repo_id.localeCompare(b.repo_id, undefined, { sensitivity: "base" }),
    (a, b) => b.size_on_disk - a.size_on_disk,
    (a, b) => b.nb_files - a.nb_files,
    (a, b) => b.revisions.length - a.revisions.length,
    (a, b) => b.last_modified - a.last_modified,
  ];

/** Actions the root keydown handler can dispatch, by bound key. */
interface KeyActions {
  refresh: () => void;
  cycleSort: () => void;
  requestDelete: () => void;
  moveSelection: (delta: number) => void;
  jumpTo: (index: number) => void;
}

/** Bound keys and their actions (Enter/Escape are handled separately —
 * they act only while a delete is pending). */
const KEY_ACTIONS: Record<string, (actions: KeyActions) => void> = {
  q: () => process.exit(0),
  r: (a) => a.refresh(),
  "/": (a) => a.cycleSort(),
  d: (a) => a.requestDelete(),
  down: (a) => a.moveSelection(1),
  up: (a) => a.moveSelection(-1),
  pagedown: (a) => a.moveSelection(10),
  pageup: (a) => a.moveSelection(-10),
  home: (a) => a.jumpTo(0),
  end: (a) => a.jumpTo(-1),
};

/** Repo type → adwaita-gpuix icon (the library's curated icon set). */
const TYPE_ICONS: Record<string, IconName> = {
  model: "layers",
  dataset: "folder",
  space: "inbox",
};

/** "**{n} entries · {totalSize}" — the reset status form. */
function countStatus(repos: RepoInfo[]): string {
  const total = repos.reduce((s, r) => s + r.size_on_disk, 0);
  return `${repos.length} entries · ${formatSize(total)}`;
}

/**
 * A row's caption line: type, the union of refs across all revisions
 * (usually ["main"]), the short commit hash of the most recently modified
 * revision, the file count, and the last-modified age.
 */
function rowMeta(repo: RepoInfo): string {
  const refs = [...new Set(repo.revisions.flatMap((r) => r.refs))];
  const latest = repo.revisions.reduce<
    (typeof repo.revisions)[number] | undefined
  >(
    (best, r) =>
      best === undefined || r.last_modified > best.last_modified ? r : best,
    undefined,
  );
  const parts = [
    repo.repo_type,
    refs.length > 0 ? refs.join(" ") : undefined,
    latest !== undefined ? latest.commit_hash.slice(0, 7) : undefined,
    `${repo.nb_files} files`,
    formatTimeSince(repo.last_modified),
  ].filter((p): p is string => p !== undefined);
  return parts.join(" · ");
}

function HfCache() {
  const t = useAdwaita();
  const { colors } = t;

  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [sortKey, setSortKey] = useState<0 | 1 | 2 | 3 | 4>(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");
  const [deleting, setDeleting] = useState<boolean>(false);

  // Ref to the root div — used to explicitly focus it so keyboard events
  // are dispatched to the root's onKeyDown handler.
  const rootRef = useRef<PublicInstance | null>(null);

  // GPUIX renderer — used to focus the root element.
  const renderer = useGpuixRequired();

  // Auto-collapse: the details pane hides on short windows so the list keeps its space.
  const { height: winHeight } = useWindowSize();
  const detailsCollapsed = winHeight < 560;

  /** Re-scan the cache directory and update the list + status. */
  const refresh = useCallback(async () => {
    const scanned = await scanCacheDir();
    setRepos(scanned);
    setStatus(countStatus(scanned));
  }, []);

  // Load on mount (once) and ensure the root div receives keyboard focus.
  useEffect(() => {
    refresh();
    const id = rootRef.current?.id;
    if (id !== undefined) {
      renderer.focusElement?.(id);
    }
  }, [refresh, renderer]);

  // Select the first item once the list loads (TUI behavior: first row selected).
  useEffect(() => {
    if (repos.length > 0 && selected === null) {
      setSelected(repos[0].repo_id);
    }
  }, [repos, selected]);

  // Sort the list by the active key with fixed directions (no search filter —
  // sorting is cycled through with the "/" key).
  const sorted = useMemo(() => {
    const copy = [...repos];
    copy.sort(SORT_COMPARATORS[sortKey]);
    return copy;
  }, [repos, sortKey]);

  // --- Delete flow -------------------------------------------------------

  const requestDelete = () => {
    if (selected === null) {
      setStatus("No entry selected");
      return;
    }
    setPendingDelete(selected);
    setStatus(`Delete '${selected}'? Enter confirms, Esc cancels`);
  };

  const confirmDelete = async () => {
    if (pendingDelete === null) return;

    const repo = repos.find((r) => r.repo_id === pendingDelete);
    if (repo === undefined) {
      resetDelete();
      return;
    }

    setDeleting(true);
    try {
      await deleteRepo(repo.repo_path);
      const next = repos.filter((r) => r.repo_id !== repo.repo_id);
      setRepos(next);
      setStatus(`Deleted '${repo.repo_id}'`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus(`Error '${pendingDelete}': ${message}`);
    } finally {
      setPendingDelete(null);
      setDeleting(false);
    }
  };

  /** Clear a pending delete and restore the count status. */
  const resetDelete = () => {
    setPendingDelete(null);
    setStatus(countStatus(repos));
  };

  const cancelDelete = resetDelete;

  // --- Keyboard ----------------------------------------------------------

  /**
   * Move the row-cursor selection by `delta` positions through the sorted
   * list. With no selection yet, the first press lands on the top row for
   * forward movement and the bottom row for backward.
   */
  const moveSelection = (delta: number) => {
    const list = sorted;
    if (list.length === 0) return;
    if (selected === null) {
      setSelected((delta > 0 ? list[0] : list[list.length - 1]).repo_id);
      return;
    }
    const current = list.findIndex((r) => r.repo_id === selected);
    const next = Math.min(Math.max(current + delta, 0), list.length - 1);
    setSelected(list[next].repo_id);
  };

  /** Cycle to the next sort key ("/" key). */
  const cycleSort = () =>
    setSortKey(((sortKey + 1) % SORT_LABELS.length) as 0 | 1 | 2 | 3 | 4);

  /** Jump the row cursor to an absolute row (0 = first, -1 = last). */
  const jumpTo = (index: number) => {
    if (sorted.length === 0) return;
    setSelected(
      sorted[index === -1 ? sorted.length - 1 : index].repo_id,
    );
  };

  /** The master keydown handler. Attached to the root div (which holds focus
   * via tabIndex=0). 'q' quits, 'r' refreshes, 'd' opens the delete dialog
   * for the selected row, Enter confirms a pending delete, Escape cancels
   * it, and the arrow/page/home/end keys move the row cursor.
   */
  const handleKeyDown = (event: EventPayload) => {
    if (deleting) return;
    const key = event.key;
    if (key === undefined) return;
    // Enter and Escape act only while a delete is pending.
    if (key === "enter" || key === "escape") {
      if (pendingDelete === null) return;
      if (key === "enter") void confirmDelete();
      else cancelDelete();
      return;
    }
    const action = KEY_ACTIONS[key];
    if (action !== undefined) {
      action({ refresh: () => void refresh(), cycleSort, requestDelete, moveSelection, jumpTo });
    }
  };

  // --- Layout ------------------------------------------------------------

  /**
   * A boxed-list row: type icon + title/meta column + size + symbolic
   * destructive-on-dialog delete button. Hairline separators come from the
   * BoxedList wrapper.
   */
  const renderRow = (repo: RepoInfo) => {
    const isSelected = selected === repo.repo_id;
    const isPending = pendingDelete === repo.repo_id;
    const background = isPending
      ? colors.destructiveTint
      : isSelected
        ? colors.accentTint
        : "transparent";
    return (
      <div
        key={repo.repo_id}
        onClick={() => setSelected(repo.repo_id)}
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          minHeight: 40,
          paddingLeft: 12,
          paddingRight: 12,
          cursor: "pointer",
          backgroundColor: background,
          hover: {
            backgroundColor: isPending
              ? colors.destructiveTint
              : hexToRgba(colors.fg, isDarkScheme(t.scheme) ? 0.06 : 0.04),
          },
        }}
      >
        <Icon
          name={TYPE_ICONS[repo.repo_type] ?? "folder"}
          size={18}
          color={isPending ? colors.destructive : colors.dim_fg}
          style={{ flexShrink: 0 }}
        />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 1,
            flexGrow: 1,
            minWidth: 0,
          }}
        >
          <T
            size="body"
            weight={600}
            color={isPending ? colors.destructive : colors.fg}
            style={{
              whiteSpace: "nowrap",
              textOverflow: "ellipsis",
              overflow: "hidden",
              lineHeight: 14,
            }}
          >
            {repo.repo_id}
          </T>
          <T
            size="caption"
            color={colors.dim_fg}
            style={{ whiteSpace: "nowrap", lineHeight: 12 }}
          >
            {rowMeta(repo)}
          </T>
        </div>
        <T
          size="caption"
          color={colors.dim_fg}
          style={{ minWidth: 90, textAlign: "right", flexShrink: 0 }}
        >
          {formatSize(repo.size_on_disk)}
        </T>
        <Button
          variant="icon"
          icon="trash"
          disabled={!isSelected}
          onClick={() => {
            if (isSelected) requestDelete();
          }}
          style={{ minHeight: 30, minWidth: 30, flexShrink: 0 }}
        />
      </div>
    );
  };

  /** One key-cap + label pair for the status-bar shortcut hints. */
  const keyHint = (key: string, label: string) => (
    <div
      key={key}
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
      }}
    >
      <Kbd>{key}</Kbd>
      <T size="caption" color={colors.dim_fg}>
        {label}
      </T>
    </div>
  );

  /** One key/value field row for the details pane. */
  const detailField = (label: string, value: string) => (
    <div
      key={label}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        paddingTop: 6,
        paddingBottom: 6,
        paddingLeft: 12,
        paddingRight: 12,
      }}
    >
      <T size="caption" color={colors.dim_fg}>
        {label}
      </T>
      <T size="body" color={colors.fg}>
        {value}
      </T>
    </div>
  );

  /**
   * The right-hand details pane: full metadata for the selected resource —
   * type, size, files, revisions, last accessed/modified, path, and the
   * per-revision breakdown. An empty state when nothing is selected.
   */
  const renderDetails = () => {
    const repo = repos.find((r) => r.repo_id === selected) ?? null;
    if (repo === null) {
      return (
        <div
          style={{
            flexGrow: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <T size="caption" color={colors.dim_fg}>
            No resource selected
          </T>
        </div>
      );
    }
    const revisions = [...repo.revisions].sort(
      (a, b) => b.last_modified - a.last_modified,
    );
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flexGrow: 1,
          minHeight: 0,
        }}
      >
        {/* Resource header: type icon + id + type. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            padding: 12,
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
            }}
          >
            <Icon
              name={TYPE_ICONS[repo.repo_type] ?? "folder"}
              size={18}
              color={colors.dim_fg}
              style={{ flexShrink: 0 }}
            />
            <T
              size="body"
              weight={600}
              color={colors.fg}
              style={{
                whiteSpace: "nowrap",
                textOverflow: "ellipsis",
                overflow: "hidden",
              }}
            >
              {repo.repo_id}
            </T>
          </div>
          <T size="caption" color={colors.dim_fg}>
            {repo.repo_type}
          </T>
        </div>
        <Separator />
        {detailField("Size", formatSize(repo.size_on_disk))}
        {/* Files + Revisions: same label/value elements, disposed in one row of cells. */}
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            gap: 8,
            paddingTop: 6,
            paddingBottom: 6,
            paddingLeft: 12,
            paddingRight: 12,
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              flexGrow: 1,
            }}
          >
            <T size="caption" color={colors.dim_fg}>Files</T>
            <T size="body" color={colors.fg}>{repo.nb_files}</T>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              flexGrow: 1,
            }}
          >
            <T size="caption" color={colors.dim_fg}>Revisions</T>
            <T size="body" color={colors.fg}>{repo.revisions.length}</T>
          </div>
        </div>
        {detailField(
          "Last accessed",
          `${formatTimestamp(repo.last_accessed)} (${formatTimeSince(repo.last_accessed)})`,
        )}
        {detailField(
          "Last modified",
          `${formatTimestamp(repo.last_modified)} (${formatTimeSince(repo.last_modified)})`,
        )}
        {detailField("Path", repo.repo_path)}
        <Separator />
        <div style={{ paddingTop: 8, paddingLeft: 12, paddingRight: 12 }}>
          <SectionTitle>Revisions</SectionTitle>
        </div>
        {revisions.map((rev) => (
          <div
            key={rev.commit_hash}
            style={{
              display: "flex",
              flexDirection: "row",
              alignItems: "baseline",
              gap: 6,
              paddingTop: 4,
              paddingLeft: 12,
              paddingRight: 12,
            }}
          >
            <T size="body" color={colors.fg} style={{ flexShrink: 0 }}>
              {rev.commit_hash.slice(0, 7)}
            </T>
            <T size="caption" color={colors.dim_fg} style={{ flexGrow: 1 }}>
              {`· ${rev.refs.join(" ") || "no refs"} · ${rev.nb_files} files · ${formatSize(rev.size_on_disk)} · ${formatTimeSince(rev.last_modified)}`}
            </T>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      autoFocus
      onKeyDown={handleKeyDown}
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: colors.window_bg,
      }}
    >
      {/* Two-pane body: boxed list of resource rows left, details pane right. */}
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          flexGrow: 1,
          minHeight: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flexGrow: 1,
            minWidth: 0,
          }}
        >
          {sorted.length === 0 ? (
            <StatusPage
              icon="inbox"
              title="No resources found"
              description="Nothing is cached. Press r to refresh the cache."
              style={{ flexGrow: 1, minHeight: 0 }}
            />
          ) : (
            <BoxedList
              style={{
                flexGrow: 1,
                minHeight: 0,
                borderWidth: 0,
                borderRadius: 0,
                backgroundColor: "transparent",
              }}
            >
              {sorted.map(renderRow)}
            </BoxedList>
          )}
        </div>
        {!detailsCollapsed && (
          <>
            <Separator orientation="vertical" />
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                width: 320,
                flexShrink: 0,
                minHeight: 0,
                overflow: "hidden",
                backgroundColor: colors.view_bg,
              }}
            >
              {renderDetails()}
            </div>
          </>
        )}
      </div>

      {/* Status bar: status text left, Kbd key-cap hints right, on a hairline */}
      <Separator />
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          padding: 8,
          paddingLeft: 12,
          paddingRight: 12,
          flexShrink: 0,
          backgroundColor: colors.view_bg,
        }}
      >
        <T
          size="caption"
          color={colors.dim_fg}
          style={{ flexGrow: 1, minWidth: 0 }}
        >
          {status}
        </T>
        <KbdGroup style={{ flexShrink: 0, gap: 8 }}>
          {keyHint("d", "delete")}
          {keyHint("/", "sort")}
          {keyHint("r", "refresh")}
          {keyHint("q", "quit")}
        </KbdGroup>
      </div>

      {/* Delete confirmation: an Adwaita alert dialog over a scrim. */}
      {pendingDelete !== null ? (
        <DeleteDialog
          pendingDelete={pendingDelete}
          dark={isDarkScheme(t.scheme)}
          onConfirm={() => void confirmDelete()}
          onCancel={cancelDelete}
        />
      ) : null}
    </div>
  );
}

/**
 * Delete confirmation: an Adwaita alert dialog over a scrim. Keyboard:
 * Enter confirms, Escape cancels (handled by the root keydown handler).
 */
function DeleteDialog({
  pendingDelete,
  dark,
  onConfirm,
  onCancel,
}: {
  pendingDelete: string;
  dark: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: dark ? "rgba(0,0,0,0.5)" : "rgba(0,0,0,0.3)",
      }}
    >
      <AlertDialog
        heading="Delete cache entry?"
        body={`Delete '${pendingDelete}'? This permanently removes the cached resource.`}
        actions={[
          {
            label: "Delete",
            variant: "destructive",
            onClick: onConfirm,
          },
          { label: "Cancel", onClick: onCancel },
        ]}
        style={{ width: 360 }}
      />
    </div>
  );
}

function App() {
  return (
    <AdwaitaProvider scheme="nightsky">
      <HfCache />
    </AdwaitaProvider>
  );
}

// Entry-point guard: only open a window when run as the program, not when
// imported by a test.
const isEntryPoint =
  typeof Bun !== "undefined"
    ? Bun.isStandaloneExecutable || Bun.main === import.meta.path
    : typeof window !== "undefined";

if (isEntryPoint) {
  render(<App />, {
    title: "HF Cache",
    width: 1100,
    height: 720,
    focus:
      typeof process === "undefined" || process.env.GPUIX_BACKGROUND !== "1",
  });
}
