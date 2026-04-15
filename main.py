from textual.app import App, ComposeResult
from textual.widgets import Label, DataTable, Button
from textual.screen import ModalScreen
from textual.containers import Vertical, Horizontal, Center
from huggingface_hub import scan_cache_dir
from huggingface_hub.utils._parsing import format_timesince


class HFModel:
    def __init__(self, repo_info):
        self.repo_id = repo_info.repo_id
        self.repo_type = repo_info.repo_type
        self.repo_path = repo_info.repo_path
        self.size_on_disk = repo_info.size_on_disk
        self.nb_files = repo_info.nb_files
        self.revisions = list(repo_info.revisions)
        self.last_accessed = repo_info.last_accessed
        self.last_modified = repo_info.last_modified

    @property
    def latest_revision(self):
        return self.revisions[0] if self.revisions else None

    @property
    def revision_commit_hash(self):
        return self.latest_revision.commit_hash if self.latest_revision else None

    @property
    def formatted_size(self):
        size_gb = self.size_on_disk / (1024**3)
        if size_gb >= 1:
            return f"{size_gb:.2f} GB"
        size_mb = self.size_on_disk / (1024**2)
        return f"{size_mb:.2f} MB"

    @property
    def revision_count(self):
        return len(self.revisions)

    @property
    def last_accessed_rel(self):
        return format_timesince(self.last_accessed)

    @property
    def last_modified_rel(self):
        return format_timesince(self.last_modified)


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
        self.models = []
        self.pending_delete = None

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
            cache_info = scan_cache_dir()
        except Exception as e:
            self.notify(f"Error scanning cache: {e}", severity="error")
            return

        for repo_info in cache_info.repos:
            self.models.append(HFModel(repo_info))

        if sort_by == 0:
            self.models.sort(key=lambda m: m.repo_id.lower())
        elif sort_by == 1:
            self.models.sort(key=lambda m: m.size_on_disk, reverse=True)
        elif sort_by == 2:
            self.models.sort(key=lambda m: m.nb_files, reverse=True)
        elif sort_by == 3:
            self.models.sort(key=lambda m: len(m.revisions), reverse=True)
        elif sort_by == 4:
            self.models.sort(key=lambda m: m.last_modified, reverse=True)

        for model in self.models:
            self.table.add_row(
                model.repo_id,
                model.formatted_size,
                str(model.nb_files),
                str(model.revision_count),
                model.last_modified_rel,
                key=model.repo_id,
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

        model = next((m for m in self.models if m.repo_id == selected_key), None)
        if not model:
            self.query_one("#status", Label).update(
                "Entry not found | d=delete, r=refresh, q=quit"
            )
            return

        self.pending_delete = selected_key
        self.query_one("#status", Label).update(
            f"Delete '{model.repo_id}'? Press Enter to confirm, Esc to cancel"
        )

    def action_sort_size(self) -> None:
        self._refresh(2)

    def action_confirm_delete(self) -> None:
        if self.pending_delete is None:
            self.query_one("#status", Label).update(
                f"{len(self.models)} entry(ies) | d=delete, r=refresh, q=quit"
            )
            return

        try:
            repo = next(
                (m for m in self.models if m.repo_id == self.pending_delete.value), None
            )
            if not repo:
                self.query_one("#status", Label).update(
                    f"Entry not found | d=delete, r=refresh, q=quit"
                )
                self.pending_delete = None
                return

            cache_info = scan_cache_dir()
            cache_info.delete_revisions(repo.latest_revision.commit_hash).execute()
            self.query_one("#status", Label).update(
                f"Deleted '{repo.repo_id}' | d=delete, r=refresh, q=quit"
            )
            self.pending_delete = None
            self.table.remove_row(repo.repo_id)
            self.models = [m for m in self.models if m.repo_id != repo.repo_id]
            self.query_one("#status", Label).update(
                f"{len(self.models)} entry(ies) | d=delete, r=refresh, q=quit"
            )
        except Exception as e:
            self.query_one("#status", Label).update(
                f"Error '{self.pending_delete.value}': {e} | d=delete, r=refresh, q=quit"
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
        column_index = event.column_index
        if column_index == 0:
            self._refresh(0)
        elif column_index == 1:
            self._refresh(1)
        elif column_index == 2:
            self._refresh(2)
        elif column_index == 3:
            self._refresh(3)
        elif column_index == 4:
            self._refresh(4)

    def on_key(self, event) -> None:
        if event.key == "escape" and self.pending_delete is not None:
            self.action_cancel_delete()
        elif event.key == "enter" and self.pending_delete is not None:
            self.action_confirm_delete()


if __name__ == "__main__":
    app = HuggingFaceCacheApp()
    app.run()


def main():
    app = HuggingFaceCacheApp()
    app.run()
