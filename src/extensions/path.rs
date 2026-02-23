//! Path canonicalization and Windows UNC prefix utilities.

use std::path::{Path, PathBuf};

/// Canonicalize a path, stripping the `\\?\` verbatim prefix on Windows.
///
/// `std::fs::canonicalize` on Windows returns extended-length paths (`\\?\C:\...`)
/// which break QuickJS module resolution and JS string interpolation. This helper
/// strips that prefix so paths remain compatible with downstream consumers.
///
/// If `canonicalize` fails (e.g. path does not exist), this falls back to logical
/// normalization (`normalize_dot_segments`) of the absolute path to prevent
/// directory traversal exploits in security checks.
pub fn safe_canonicalize(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).map_or_else(
        |_| {
            // Fallback for non-existent paths:
            // 1. Resolve to an absolute logical path.
            let absolute = if path.is_absolute() {
                path.to_path_buf()
            } else {
                std::env::current_dir()
                    .unwrap_or_else(|_| PathBuf::from("."))
                    .join(path)
            };

            // 2. Try to anchor on the longest existing ancestor to respect symlinks.
            //    If we are in `/link/new_file` and `/link` -> `/target`, we want
            //    to resolve to `/target/new_file` to match the root resolution.
            for ancestor in absolute.ancestors().skip(1) {
                if let Ok(canonical_ancestor) = std::fs::canonicalize(ancestor) {
                    if let Ok(suffix) = absolute.strip_prefix(ancestor) {
                        let combined = canonical_ancestor.join(suffix);
                        // Normalize handles any `..` in the suffix.
                        return strip_unc_prefix(normalize_dot_segments(&combined));
                    }
                }
            }

            // 3. Last resort: purely logical normalization.
            strip_unc_prefix(normalize_dot_segments(&absolute))
        },
        strip_unc_prefix,
    )
}

fn normalize_dot_segments(path: &Path) -> PathBuf {
    use std::ffi::{OsStr, OsString};
    use std::path::Component;

    let mut out = PathBuf::new();
    let mut normals: Vec<OsString> = Vec::new();
    let mut has_prefix = false;
    let mut has_root = false;

    for component in path.components() {
        match component {
            Component::Prefix(prefix) => {
                out.push(prefix.as_os_str());
                has_prefix = true;
            }
            Component::RootDir => {
                out.push(component.as_os_str());
                has_root = true;
            }
            Component::CurDir => {}
            Component::ParentDir => match normals.last() {
                Some(last) if last.as_os_str() != OsStr::new("..") => {
                    normals.pop();
                }
                _ => {
                    if !has_root && !has_prefix {
                        normals.push(OsString::from(".."));
                    }
                }
            },
            Component::Normal(part) => normals.push(part.to_os_string()),
        }
    }

    for part in normals {
        out.push(part);
    }

    out
}

/// Strip the `\\?\` or `//?/` verbatim prefix from a path on Windows. No-op on Unix.
#[allow(clippy::missing_const_for_fn)]
pub fn strip_unc_prefix(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let s = path.to_string_lossy();
        if let Some(stripped) = s.strip_prefix(r"\\?\") {
            if let Some(unc) = stripped.strip_prefix("UNC") {
                if unc.starts_with('\\') {
                    return PathBuf::from(format!(r"\{}", unc));
                }
            }
            return PathBuf::from(stripped);
        }
        // fd normalises separators to `/`, producing `//?/` instead of `\\?\`.
        if let Some(stripped) = s.strip_prefix("//?/") {
            if let Some(unc) = stripped.strip_prefix("UNC") {
                if unc.starts_with('/') {
                    return PathBuf::from(format!("/{}", unc));
                }
            }
            return PathBuf::from(stripped);
        }
    }
    path
}
