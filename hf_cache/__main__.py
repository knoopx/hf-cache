"""Entry point for hf-cache."""

from hf_cache.app import HuggingFaceCacheApp


def main():
    app = HuggingFaceCacheApp()
    app.run()


if __name__ == "__main__":
    main()
