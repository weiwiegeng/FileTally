use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskInfo {
    /// Disk name
    pub name: String,
    /// Mount point path
    pub mount_point: String,
    /// Total space in bytes
    pub total_space: u64,
    /// Used space in bytes
    pub used_space: u64,
    /// Available space in bytes
    pub available_space: u64,
    /// File system type (APFS, NTFS, ext4, etc.)
    pub file_system: String,
    /// Whether the disk is removable
    pub is_removable: bool,
    /// Disk type
    pub disk_type: String,
    /// Usage percentage
    pub usage_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskOverview {
    /// List of all disks
    pub disks: Vec<DiskInfo>,
    /// Total disk count
    pub total_count: usize,
    /// Total space across all disks
    pub total_space: u64,
    /// Total used space
    pub total_used: u64,
    /// Total available space
    pub total_available: u64,
}
