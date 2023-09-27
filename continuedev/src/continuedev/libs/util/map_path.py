from pathlib import Path


def map_path(path: str, orig_root: str, copy_root: str) -> Path:
    path = Path(path)
    if path.is_relative_to(orig_root):
        return (
            Path(copy_root) / path.relative_to(orig_root)
            if path.is_absolute()
            else path
        )
    return path if path.is_absolute() else Path(orig_root) / path
