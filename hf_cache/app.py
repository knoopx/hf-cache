"""Textual TUI for browsing and managing the HF cache."""

from textual.app import App, ComposeResult
from textual.widgets import Label, DataTable
from textual.containers import Vertical

from hf_cache.cache import scan_cache_dir, delete_repo
from hf_cache.formatting import format_size, format_timesince


class HuggingFaceCacheApp(App):
    CSS = """
    DataTable {
        height: 1fr;
    }
    """

    BINDINGS = [
        ("q", "quit", "Quit"),
        ("d", "delete", "Delete"),
        ("r", "refresh", "Refresh"),
    ]

    def __init__(self):
        super().__init__()
        self.models: list[dict] = []
        self.pending_delete: str | None = None

    def compose(self) -> ComposeResult:
        yield Vertical(
            DataTable(id="models-table"),
            Label(id="status"),
        )

    def on_mount(self) -> None:
        self.table = self.query_one("#models-table", DataTable)
        self.table.add_columns(
            "Repository", "Size", "Files", "Revisions", "Last Modified"
        )
        self.table.cursor_type = "row"
        self._refresh()

    def _refresh(self, sort_by: int = 0):
        self.table.clear()
        self.models = []

        try:
            self.models = scan_cache_dir()
        except Exception as e:
            self.notify(f"Error scanning cache: {e}", severity="error")
            return

        if sort_by == 0:
            self.models.sort(key=lambda m: m["repo_id"].lower())
        elif sort_by == 1:
            self.models.sort(key=lambda m: m["size_on_disk"], reverse=True)
        elif sort_by == 2:
            self.models.sort(key=lambda m: m["nb_files"], reverse=True)
        elif sort_by == 3:
            self.models.sort(key=lambda m: len(m["revisions"]), reverse=True)
        elif sort_by == 4:
            self.models.sort(key=lambda m: m["last_modified"], reverse=True)

        for model in self.models:
            self.table.add_row(
                model["repo_id"],
                format_size(model["size_on_disk"]),
                str(model["nb_files"]),
                str(len(model["revisions"])),
                format_timesince(model["last_modified"]),
                key=model["repo_id"],
            )

        self.query_one("#status", Label).update(
            f"{len(self.models)} entry(ies) | d=delete, r=refresh, q=quit"
        )

    def action_delete(self) -> None:
        row_index, _ = self.table.cursor_coordinate
        if row_index < 0 or row_index >= len(self.table.ordered_rows):
            self.query_one("#status", Label).update(
                "No entry selected | d=delete, r=refresh, q=quit"
            )
            return

        selected_key = self.table.ordered_rows[row_index].key
        if not selected_key:
            self.query_one("#status", Label).update(
                "No entry selected | d=delete, r=refresh, q=quit"
            )
            return

        model = next((m for m in self.models if m["repo_id"] == selected_key), None)
        if not model:
            self.query_one("#status", Label).update(
                "Entry not found | d=delete, r=refresh, q=quit"
            )
            return

        self.pending_delete = selected_key
        self.query_one("#status", Label).update(
            f"Delete '{model['repo_id']}'? Press Enter to confirm, Esc to cancel"
        )

    def action_confirm_delete(self) -> None:
        if self.pending_delete is None:
            self.query_one("#status", Label).update(
                f"{len(self.models)} entry(ies) | d=delete, r=refresh, q=quit"
            )
            return

        repo = next(
            (m for m in self.models if m["repo_id"] == self.pending_delete), None
        )
        if not repo:
            self.query_one("#status", Label).update(
                f"Entry not found | d=delete, r=refresh, q=quit"
            )
            self.pending_delete = None
            return

        try:
            delete_repo(repo["repo_path"])
            self.table.remove_row(repo["repo_id"])
            self.models = [m for m in self.models if m["repo_id"] != repo["repo_id"]]
            self.query_one("#status", Label).update(
                f"Deleted '{repo['repo_id']}' | d=delete, r=refresh, q=quit"
            )
            self.pending_delete = None
            self.query_one("#status", Label).update(
                f"{len(self.models)} entry(ies) | d=delete, r=refresh, q=quit"
            )
        except Exception as e:
            self.query_one("#status", Label).update(
                f"Error '{self.pending_delete}': {e} | d=delete, r=refresh, q=quit"
            )
            self.pending_delete = None

    def action_cancel_delete(self) -> None:
        self.pending_delete = None
        self.query_one("#status", Label).update(
            f"{len(self.models)} entry(ies) | d=delete, r=refresh, q=quit"
        )

    async def action_quit(self) -> None:
        self.exit()

    def action_refresh(self) -> None:
        self._refresh()

    def on_data_table_header_selected(self, event: DataTable.HeaderSelected) -> None:
        self._refresh(event.column_index)

    def on_key(self, event) -> None:
        if event.key == "escape" and self.pending_delete is not None:
            self.action_cancel_delete()
        elif event.key == "enter" and self.pending_delete is not None:
            self.action_confirm_delete()
