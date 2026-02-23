//! Codebase index for intelligent context selection.
//!
//! Scans a project directory and builds a searchable index of symbols (functions, types, imports)
//! mapped to their file:line locations. The agent uses this index to find relevant code context
//! instead of relying solely on grep/find.

use ignore::WalkBuilder;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

// ============================================================================
// Types
// ============================================================================

/// Kind of symbol found in source code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SymbolKind {
    Function,
    Method,
    Struct,
    Enum,
    Trait,
    Interface,
    Class,
    Type,
    Constant,
    Import,
    Module,
}

impl SymbolKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Function => "function",
            Self::Method => "method",
            Self::Struct => "struct",
            Self::Enum => "enum",
            Self::Trait => "trait",
            Self::Interface => "interface",
            Self::Class => "class",
            Self::Type => "type",
            Self::Constant => "constant",
            Self::Import => "import",
            Self::Module => "module",
        }
    }
}

/// A symbol extracted from source code.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Symbol {
    pub kind: SymbolKind,
    pub name: String,
    pub file: PathBuf,
    pub line: usize,
    /// Optional signature or contextual snippet (e.g. `fn foo(x: i32) -> bool`).
    pub signature: Option<String>,
}

/// Summary of a single indexed file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSummary {
    pub path: PathBuf,
    pub language: Option<String>,
    pub line_count: usize,
    pub symbol_count: usize,
}

/// The codebase index: a collection of symbols and file summaries.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodebaseIndex {
    pub root: PathBuf,
    pub files: Vec<FileSummary>,
    pub symbols: Vec<Symbol>,
}

// ============================================================================
// Index building
// ============================================================================

/// Maximum file size to index (256 KB). Larger files are skipped.
const MAX_FILE_SIZE: u64 = 256 * 1024;

/// File extensions that are never indexed.
const SKIP_EXTENSIONS: &[&str] = &[
    "lock", "min.js", "min.css", "map", "wasm", "png", "jpg", "jpeg", "gif", "svg", "ico",
    "webp", "mp3", "mp4", "zip", "tar", "gz", "bin", "exe", "dll", "so", "dylib", "o", "a",
    "pdf", "ttf", "woff", "woff2", "eot",
];

impl CodebaseIndex {
    /// Build an index by walking `root`, respecting `.gitignore`.
    pub fn build(root: &Path) -> Self {
        let mut files = Vec::new();
        let mut symbols = Vec::new();

        let walker = WalkBuilder::new(root)
            .hidden(false)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .max_depth(Some(20))
            .build();

        for entry in walker.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }

            // Skip binary / non-text extensions.
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if SKIP_EXTENSIONS.iter().any(|s| ext.eq_ignore_ascii_case(s)) {
                    continue;
                }
            }

            // Skip files that are too large.
            if let Ok(meta) = path.metadata() {
                if meta.len() > MAX_FILE_SIZE {
                    continue;
                }
            }

            let Ok(content) = std::fs::read_to_string(path) else {
                continue; // skip binary files that can't be read as UTF-8
            };

            let lang = detect_language(path);
            let file_symbols = extract_symbols(path, &content, lang.as_deref());
            let line_count = content.lines().count();

            files.push(FileSummary {
                path: path.to_path_buf(),
                language: lang,
                line_count,
                symbol_count: file_symbols.len(),
            });

            symbols.extend(file_symbols);
        }

        Self {
            root: root.to_path_buf(),
            files,
            symbols,
        }
    }

    /// Search symbols by name (case-insensitive substring match).
    pub fn search(&self, query: &str) -> Vec<&Symbol> {
        let query_lower = query.to_lowercase();
        self.symbols
            .iter()
            .filter(|s| s.name.to_lowercase().contains(&query_lower))
            .collect()
    }

    /// Search symbols by name and kind.
    pub fn search_by_kind(&self, query: &str, kind: SymbolKind) -> Vec<&Symbol> {
        let query_lower = query.to_lowercase();
        self.symbols
            .iter()
            .filter(|s| s.kind == kind && s.name.to_lowercase().contains(&query_lower))
            .collect()
    }

    /// Get all symbols in a specific file.
    pub fn symbols_in_file(&self, path: &Path) -> Vec<&Symbol> {
        self.symbols.iter().filter(|s| s.file == path).collect()
    }

    /// Get a file summary by path.
    pub fn file_summary(&self, path: &Path) -> Option<&FileSummary> {
        self.files.iter().find(|f| f.path == path)
    }

    /// Format search results as a human-readable string.
    pub fn format_results(&self, results: &[&Symbol], root: &Path) -> String {
        let mut out = String::new();
        for sym in results {
            let rel = sym.file.strip_prefix(root).unwrap_or(&sym.file);
            let sig = sym
                .signature
                .as_deref()
                .map(|s| format!("  {s}"))
                .unwrap_or_default();
            out.push_str(&format!(
                "{} {} — {}:{}{}\n",
                sym.kind.as_str(),
                sym.name,
                rel.display(),
                sym.line,
                sig,
            ));
        }
        if out.is_empty() {
            out.push_str("No symbols found.\n");
        }
        out
    }

    /// Total number of indexed symbols.
    pub fn symbol_count(&self) -> usize {
        self.symbols.len()
    }

    /// Total number of indexed files.
    pub fn file_count(&self) -> usize {
        self.files.len()
    }
}

// ============================================================================
// Language detection
// ============================================================================

fn detect_language(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_str()?;
    let lang = match ext.to_lowercase().as_str() {
        "rs" => "rust",
        "py" | "pyi" => "python",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "ts" | "tsx" | "mts" | "cts" => "typescript",
        "go" => "go",
        "rb" => "ruby",
        "java" => "java",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" | "hxx" | "hh" => "cpp",
        "cs" => "csharp",
        "swift" => "swift",
        "kt" | "kts" => "kotlin",
        "sh" | "bash" | "zsh" => "bash",
        "lua" => "lua",
        "zig" => "zig",
        "toml" => "toml",
        "yaml" | "yml" => "yaml",
        "json" => "json",
        "md" | "markdown" => "markdown",
        _ => return None,
    };
    Some(lang.to_string())
}

// ============================================================================
// Symbol extraction (regex-based, per-language)
// ============================================================================

fn extract_symbols(path: &Path, content: &str, lang: Option<&str>) -> Vec<Symbol> {
    match lang {
        Some("rust") => extract_rust(path, content),
        Some("python") => extract_python(path, content),
        Some("javascript" | "typescript") => extract_js_ts(path, content),
        Some("go") => extract_go(path, content),
        Some("ruby") => extract_ruby(path, content),
        Some("java") => extract_java(path, content),
        Some("c" | "cpp") => extract_c_cpp(path, content),
        _ => Vec::new(),
    }
}

/// Helper: compile a regex once and return a static reference.
macro_rules! static_regex {
    ($pat:expr) => {{
        static RE: OnceLock<Regex> = OnceLock::new();
        RE.get_or_init(|| Regex::new($pat).unwrap())
    }};
}

/// Helper: extract symbols from content using multiple (regex, kind) pairs.
fn extract_with_patterns(
    path: &Path,
    content: &str,
    patterns: &[(&Regex, SymbolKind)],
) -> Vec<Symbol> {
    let mut symbols = Vec::new();
    for (line_num, line) in content.lines().enumerate() {
        let trimmed = line.trim();
        // Skip comments.
        if trimmed.starts_with("//")
            || trimmed.starts_with('#')
            || trimmed.starts_with("/*")
            || trimmed.starts_with('*')
        {
            continue;
        }
        for (re, kind) in patterns {
            if let Some(caps) = re.captures(line) {
                if let Some(name_match) = caps.get(1) {
                    let name = name_match.as_str().to_string();
                    // Build a signature from the full line (trimmed).
                    let sig = trimmed.to_string();
                    let signature = if sig.len() > 200 {
                        Some(format!("{}…", &sig[..200]))
                    } else {
                        Some(sig)
                    };
                    symbols.push(Symbol {
                        kind: *kind,
                        name,
                        file: path.to_path_buf(),
                        line: line_num + 1,
                        signature,
                    });
                    break; // only match the first pattern per line
                }
            }
        }
    }
    symbols
}

// ---- Rust ----

fn extract_rust(path: &Path, content: &str) -> Vec<Symbol> {
    let patterns: &[(&Regex, SymbolKind)] = &[
        (
            static_regex!(r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)"),
            SymbolKind::Function,
        ),
        (
            static_regex!(r"^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+(\w+)"),
            SymbolKind::Struct,
        ),
        (
            static_regex!(r"^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+(\w+)"),
            SymbolKind::Enum,
        ),
        (
            static_regex!(r"^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+(\w+)"),
            SymbolKind::Trait,
        ),
        (
            static_regex!(r"^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+(\w+)"),
            SymbolKind::Type,
        ),
        (
            static_regex!(r"^\s*(?:pub(?:\([^)]*\))?\s+)?const\s+(\w+)"),
            SymbolKind::Constant,
        ),
        (
            static_regex!(r"^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)"),
            SymbolKind::Module,
        ),
    ];
    extract_with_patterns(path, content, patterns)
}

// ---- Python ----

fn extract_python(path: &Path, content: &str) -> Vec<Symbol> {
    let patterns: &[(&Regex, SymbolKind)] = &[
        (
            static_regex!(r"^\s*(?:async\s+)?def\s+(\w+)"),
            SymbolKind::Function,
        ),
        (
            static_regex!(r"^\s*class\s+(\w+)"),
            SymbolKind::Class,
        ),
    ];
    extract_with_patterns(path, content, patterns)
}

// ---- JavaScript / TypeScript ----

fn extract_js_ts(path: &Path, content: &str) -> Vec<Symbol> {
    let patterns: &[(&Regex, SymbolKind)] = &[
        (
            static_regex!(r"^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)"),
            SymbolKind::Function,
        ),
        (
            static_regex!(r"^\s*(?:export\s+)?class\s+(\w+)"),
            SymbolKind::Class,
        ),
        (
            static_regex!(r"^\s*(?:export\s+)?interface\s+(\w+)"),
            SymbolKind::Interface,
        ),
        (
            static_regex!(r"^\s*(?:export\s+)?type\s+(\w+)\s*="),
            SymbolKind::Type,
        ),
        (
            static_regex!(r"^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>"),
            SymbolKind::Function,
        ),
        (
            static_regex!(r"^\s*(?:export\s+)?enum\s+(\w+)"),
            SymbolKind::Enum,
        ),
    ];
    extract_with_patterns(path, content, patterns)
}

// ---- Go ----

fn extract_go(path: &Path, content: &str) -> Vec<Symbol> {
    let patterns: &[(&Regex, SymbolKind)] = &[
        (
            static_regex!(r"^func\s+(\w+)\s*\("),
            SymbolKind::Function,
        ),
        (
            static_regex!(r"^func\s+\([^)]+\)\s+(\w+)\s*\("),
            SymbolKind::Method,
        ),
        (
            static_regex!(r"^type\s+(\w+)\s+struct\b"),
            SymbolKind::Struct,
        ),
        (
            static_regex!(r"^type\s+(\w+)\s+interface\b"),
            SymbolKind::Interface,
        ),
        (
            static_regex!(r"^type\s+(\w+)\s+"),
            SymbolKind::Type,
        ),
    ];
    extract_with_patterns(path, content, patterns)
}

// ---- Ruby ----

fn extract_ruby(path: &Path, content: &str) -> Vec<Symbol> {
    let patterns: &[(&Regex, SymbolKind)] = &[
        (
            static_regex!(r"^\s*def\s+(\w+)"),
            SymbolKind::Function,
        ),
        (
            static_regex!(r"^\s*class\s+(\w+)"),
            SymbolKind::Class,
        ),
        (
            static_regex!(r"^\s*module\s+(\w+)"),
            SymbolKind::Module,
        ),
    ];
    extract_with_patterns(path, content, patterns)
}

// ---- Java ----

fn extract_java(path: &Path, content: &str) -> Vec<Symbol> {
    let patterns: &[(&Regex, SymbolKind)] = &[
        (
            static_regex!(r"^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?class\s+(\w+)"),
            SymbolKind::Class,
        ),
        (
            static_regex!(r"^\s*(?:public|private|protected)?\s*(?:static\s+)?interface\s+(\w+)"),
            SymbolKind::Interface,
        ),
        (
            static_regex!(r"^\s*(?:public|private|protected)?\s*(?:static\s+)?enum\s+(\w+)"),
            SymbolKind::Enum,
        ),
        (
            static_regex!(r"^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?\w+(?:<[^>]+>)?\s+(\w+)\s*\("),
            SymbolKind::Method,
        ),
    ];
    extract_with_patterns(path, content, patterns)
}

// ---- C / C++ ----

fn extract_c_cpp(path: &Path, content: &str) -> Vec<Symbol> {
    let patterns: &[(&Regex, SymbolKind)] = &[
        (
            static_regex!(r"^\s*(?:static\s+)?(?:inline\s+)?(?:const\s+)?\w+[\s*]+(\w+)\s*\([^;]*$"),
            SymbolKind::Function,
        ),
        (
            static_regex!(r"^\s*(?:typedef\s+)?struct\s+(\w+)"),
            SymbolKind::Struct,
        ),
        (
            static_regex!(r"^\s*(?:typedef\s+)?enum\s+(\w+)"),
            SymbolKind::Enum,
        ),
        (
            static_regex!(r"^\s*class\s+(\w+)"),
            SymbolKind::Class,
        ),
        (
            static_regex!(r"^\s*namespace\s+(\w+)"),
            SymbolKind::Module,
        ),
    ];
    extract_with_patterns(path, content, patterns)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rust_symbols() {
        let content = r#"
pub fn hello_world(x: i32) -> bool {
    true
}

struct Foo {
    bar: String,
}

pub enum Color {
    Red,
    Green,
    Blue,
}

trait Drawable {
    fn draw(&self);
}

pub(crate) async fn fetch_data() {}

pub const MAX_SIZE: usize = 100;

mod inner {
    pub fn nested() {}
}
"#;
        let path = Path::new("test.rs");
        let symbols = extract_rust(path, content);

        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"hello_world"));
        assert!(names.contains(&"Foo"));
        assert!(names.contains(&"Color"));
        assert!(names.contains(&"Drawable"));
        assert!(names.contains(&"fetch_data"));
        assert!(names.contains(&"MAX_SIZE"));
        assert!(names.contains(&"inner"));
        assert!(names.contains(&"nested"));

        let hello = symbols.iter().find(|s| s.name == "hello_world").unwrap();
        assert_eq!(hello.kind, SymbolKind::Function);
        assert_eq!(hello.line, 2);

        let foo = symbols.iter().find(|s| s.name == "Foo").unwrap();
        assert_eq!(foo.kind, SymbolKind::Struct);
    }

    #[test]
    fn test_python_symbols() {
        let content = r#"
def greet(name):
    print(f"Hello {name}")

class MyClass:
    def method(self):
        pass

async def async_handler():
    pass
"#;
        let path = Path::new("test.py");
        let symbols = extract_python(path, content);

        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"greet"));
        assert!(names.contains(&"MyClass"));
        assert!(names.contains(&"method"));
        assert!(names.contains(&"async_handler"));
    }

    #[test]
    fn test_js_ts_symbols() {
        let content = r#"
export function fetchUser(id) {
    return fetch(`/api/users/${id}`);
}

class UserService {
    constructor() {}
}

export interface UserProps {
    name: string;
}

type UserId = string;

const handleClick = (e) => {
    console.log(e);
};

export enum Status {
    Active,
    Inactive,
}
"#;
        let path = Path::new("test.ts");
        let symbols = extract_js_ts(path, content);

        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"fetchUser"));
        assert!(names.contains(&"UserService"));
        assert!(names.contains(&"UserProps"));
        assert!(names.contains(&"UserId"));
        assert!(names.contains(&"Status"));
    }

    #[test]
    fn test_go_symbols() {
        let content = r#"
func main() {
    fmt.Println("hello")
}

func (s *Server) Start() error {
    return nil
}

type Config struct {
    Port int
}

type Handler interface {
    Handle() error
}
"#;
        let path = Path::new("test.go");
        let symbols = extract_go(path, content);

        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"main"));
        assert!(names.contains(&"Start"));
        assert!(names.contains(&"Config"));
        assert!(names.contains(&"Handler"));

        let start = symbols.iter().find(|s| s.name == "Start").unwrap();
        assert_eq!(start.kind, SymbolKind::Method);
    }

    #[test]
    fn test_search() {
        let index = CodebaseIndex {
            root: PathBuf::from("/project"),
            files: vec![],
            symbols: vec![
                Symbol {
                    kind: SymbolKind::Function,
                    name: "hello_world".to_string(),
                    file: PathBuf::from("/project/src/main.rs"),
                    line: 10,
                    signature: Some("pub fn hello_world()".to_string()),
                },
                Symbol {
                    kind: SymbolKind::Struct,
                    name: "HelloConfig".to_string(),
                    file: PathBuf::from("/project/src/config.rs"),
                    line: 5,
                    signature: Some("pub struct HelloConfig".to_string()),
                },
                Symbol {
                    kind: SymbolKind::Function,
                    name: "goodbye".to_string(),
                    file: PathBuf::from("/project/src/main.rs"),
                    line: 20,
                    signature: Some("fn goodbye()".to_string()),
                },
            ],
        };

        let results = index.search("hello");
        assert_eq!(results.len(), 2);

        let results = index.search_by_kind("hello", SymbolKind::Function);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "hello_world");
    }

    #[test]
    fn test_detect_language() {
        assert_eq!(detect_language(Path::new("foo.rs")).as_deref(), Some("rust"));
        assert_eq!(
            detect_language(Path::new("bar.py")).as_deref(),
            Some("python")
        );
        assert_eq!(
            detect_language(Path::new("baz.tsx")).as_deref(),
            Some("typescript")
        );
        assert_eq!(detect_language(Path::new("qux.go")).as_deref(), Some("go"));
        assert_eq!(detect_language(Path::new("no_ext")).as_deref(), None);
    }

    #[test]
    fn test_comments_skipped() {
        let content = r#"
// fn commented_out() {}
/// fn doc_commented() {}
pub fn real_function() {}
"#;
        let path = Path::new("test.rs");
        let symbols = extract_rust(path, content);

        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(!names.contains(&"commented_out"));
        assert!(!names.contains(&"doc_commented"));
        assert!(names.contains(&"real_function"));
    }
}
