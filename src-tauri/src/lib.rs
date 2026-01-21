mod commands;
mod models;

use commands::{get_disks, get_file_preview, get_home_dir, refresh_disks, scan_directory, scan_directory_recursive, search_files, check_keywords, check_path_exists, list_volumes, analyze_folder, scan_cleanup_suggestions, check_transfer_conflicts, transfer_files, get_path_info, list_folder_contents, read_excel_info, match_excel_with_folder, check_folder_integrity, scan_folder_tree, rename_file};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            get_disks,
            refresh_disks,
            scan_directory,
            scan_directory_recursive,
            get_file_preview,
            get_home_dir,
            search_files,
            check_keywords,
            check_path_exists,
            list_volumes,
            analyze_folder,
            scan_cleanup_suggestions,
            check_transfer_conflicts,
            transfer_files,
            get_path_info,
            list_folder_contents,
            read_excel_info,
            match_excel_with_folder,
            check_folder_integrity,
            scan_folder_tree,
            rename_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
