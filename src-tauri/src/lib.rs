mod commands;
mod err;
mod models;
mod path_util;

use std::sync::Arc;

use commands::{
    analyze_folder, cancel_excel_check, cancel_search, cancel_transfer, check_folder_integrity,
    check_integrity_with_excel, check_keywords, check_path_exists, check_transfer_conflicts,
    connect_smb, connect_system_smb, disconnect_smb, get_disks, get_file_preview, get_home_dir,
    get_path_info, list_folder_contents, list_remote_dir, list_volumes, match_excel_with_folder,
    prepare_excel_check, prepare_search, prepare_transfer, read_excel_info, refresh_disks,
    remote_path_exists, remote_path_info, rename_file, scan_cleanup_suggestions, scan_directory,
    scan_folder_tree, search_files, transfer_files, transfer_files_remote, SmbSessionStore,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(Arc::new(SmbSessionStore::default()))
        .invoke_handler(tauri::generate_handler![
            get_disks,
            refresh_disks,
            scan_directory,
            get_file_preview,
            get_home_dir,
            search_files,
            check_keywords,
            prepare_search,
            cancel_search,
            prepare_excel_check,
            cancel_excel_check,
            check_path_exists,
            list_volumes,
            analyze_folder,
            scan_cleanup_suggestions,
            check_transfer_conflicts,
            transfer_files,
            prepare_transfer,
            cancel_transfer,
            get_path_info,
            list_folder_contents,
            read_excel_info,
            match_excel_with_folder,
            check_folder_integrity,
            check_integrity_with_excel,
            scan_folder_tree,
            rename_file,
            connect_system_smb,
            connect_smb,
            disconnect_smb,
            list_remote_dir,
            remote_path_exists,
            remote_path_info,
            transfer_files_remote,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
