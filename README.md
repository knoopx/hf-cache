# hf-cache

A TUI application for browsing and managing Hugging Face cache.

![hf-cache screenshot](./assets/screenshot.png)

## Features

- Browse models and datasets in `~/.cache/huggingface/`
- Sort by repository, size, files, revisions, or last modified time
- Delete cache entries with confirmation

## Usage

```bash
# Run from repository
nix run github:knoopx/hf-cache

# Add to your flake.nix manually:
#   inputs.hf-cache.url = "github:knoopx/hf-cache";
#   outputs = { self, nixpkgs, hf-cache, ... }:
#     {
#       apps.x86_64-linux.default = hf-cache.apps.x86_64-linux.default;
#     };
```

## Keyboard Shortcuts

`q` quit, `r` refresh, `d` delete, `Enter` confirm, `Escape` cancel

## Technical Details

Python 3.13+ with [Textual](https://textual.textualize.io/) and [huggingface_hub](https://github.com/huggingface/huggingface_hub).

## Flake Outputs

This flake provides two outputs:

- **packages.x86_64-linux.default**: Builds the hf-cache Python package with all dependencies (huggingface-hub, rich, textual)
- **apps.x86_64-linux.default**: Defines the hf-cache executable that can be run with `nix run` or installed globally
