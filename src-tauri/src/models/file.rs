use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileNode {
    /// Unique identifier
    pub id: String,
    /// File or folder name
    pub name: String,
    /// Full path
    pub path: String,
    /// Is directory
    pub is_dir: bool,
    /// File size in bytes (0 for directories)
    pub size: u64,
    /// Modified timestamp (seconds since epoch)
    pub modified_time: u64,
    /// Created timestamp (seconds since epoch)
    pub created_time: u64,
    /// File extension (empty for directories)
    pub extension: String,
    /// Children nodes (lazy loaded)
    pub children: Option<Vec<FileNode>>,
    /// Whether children are loaded
    pub is_loaded: bool,
    /// Number of children (for display)
    pub children_count: Option<usize>,
    /// Whether this node is hidden
    pub is_hidden: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilePreviewInfo {
    /// Preview type
    pub preview_type: String,
    /// Text content (for text files)
    pub content: Option<String>,
    /// File metadata
    pub metadata: FileMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMetadata {
    /// File name
    pub name: String,
    /// File path
    pub path: String,
    /// Size in bytes
    pub size: u64,
    /// Formatted size
    pub size_formatted: String,
    /// Modified time
    pub modified_time: String,
    /// Created time
    pub created_time: String,
    /// File extension
    pub extension: String,
    /// MIME type
    pub mime_type: String,
}
