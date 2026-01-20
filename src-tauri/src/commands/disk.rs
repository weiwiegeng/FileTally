use crate::models::{DiskInfo, DiskOverview};
use sysinfo::Disks;

/// Check if a mount point should be filtered out (macOS system volumes, virtual filesystems)
fn should_filter_mount_point(mount_point: &str) -> bool {
    // Filter out macOS APFS system volumes and virtual filesystems
    let filter_patterns = [
        "/System/Volumes/",     // macOS APFS internal volumes
        "/private/var/vm",      // Virtual memory
        "/dev",                 // Device files
        "/System/Volumes/VM",   // VM volume
        "/System/Volumes/Preboot",
        "/System/Volumes/Update",
        "/System/Volumes/xarts",
        "/System/Volumes/iSCPreboot",
        "/System/Volumes/Hardware",
    ];
    
    for pattern in filter_patterns {
        if mount_point.starts_with(pattern) {
            return true;
        }
    }
    
    false
}

/// Get all disk information
#[tauri::command]
pub fn get_disks() -> Result<DiskOverview, String> {
    let disks = Disks::new_with_refreshed_list();
    
    let mut disk_list: Vec<DiskInfo> = Vec::new();
    let mut total_space: u64 = 0;
    let mut total_used: u64 = 0;
    let mut total_available: u64 = 0;
    let mut seen_names: std::collections::HashSet<String> = std::collections::HashSet::new();

    for disk in disks.iter() {
        let mount_point = disk.mount_point().to_string_lossy().to_string();
        let disk_name = disk.name().to_string_lossy().to_string();
        
        // Filter out system volumes and virtual filesystems
        if should_filter_mount_point(&mount_point) {
            continue;
        }
        
        // Skip if we've already seen a disk with the same name (avoid APFS duplicates)
        // Keep only the root mount point for each physical disk
        if seen_names.contains(&disk_name) && mount_point != "/" {
            continue;
        }
        seen_names.insert(disk_name.clone());
        
        let disk_total = disk.total_space();
        let disk_available = disk.available_space();
        let disk_used = disk_total.saturating_sub(disk_available);
        
        let usage_percent = if disk_total > 0 {
            (disk_used as f64 / disk_total as f64) * 100.0
        } else {
            0.0
        };

        let disk_type = match disk.kind() {
            sysinfo::DiskKind::SSD => "SSD".to_string(),
            sysinfo::DiskKind::HDD => "HDD".to_string(),
            _ => "Unknown".to_string(),
        };

        let disk_info = DiskInfo {
            name: disk_name,
            mount_point,
            total_space: disk_total,
            used_space: disk_used,
            available_space: disk_available,
            file_system: disk.file_system().to_string_lossy().to_string(),
            is_removable: disk.is_removable(),
            disk_type,
            usage_percent,
        };

        total_space += disk_total;
        total_used += disk_used;
        total_available += disk_available;
        disk_list.push(disk_info);
    }

    Ok(DiskOverview {
        total_count: disk_list.len(),
        disks: disk_list,
        total_space,
        total_used,
        total_available,
    })
}

/// Refresh disk information
#[tauri::command]
pub fn refresh_disks() -> Result<DiskOverview, String> {
    get_disks()
}
