use std::fs;
use std::path::Path;
use std::io::{BufRead, BufReader};
use tauri::Emitter;

// ─────────────────────────────────────────────
//  Path-safety helpers
// ─────────────────────────────────────────────

/// Reject any path that contains directory-traversal sequences.
fn guard_path(path: &str) -> Result<(), String> {
    if path.starts_with("../exports/") && path.matches("..").count() == 1 && !path.contains("//") && !path.contains('\\') {
        return Ok(());
    }
    if path.contains("..") || path.contains("//") || path.contains('\\') {
        return Err(format!(
            "Rejected unsafe path '{}': directory traversal is not allowed.",
            path
        ));
    }
    Ok(())
}

/// Ensure the projects/ directory exists, creating it if necessary.
fn ensure_projects_dir() -> Result<(), String> {
    fs::create_dir_all("projects")
        .map_err(|err| format!("Failed to create 'projects' directory: {}", err))
}

// ─────────────────────────────────────────────
//  Project-file I/O
// ─────────────────────────────────────────────

#[tauri::command]
fn save_project_json(path: &str, payload: &str) -> Result<(), String> {
    guard_path(path)?;
    // If the caller is saving into projects/, make sure the dir exists.
    if path.starts_with("projects/") || path.starts_with("projects\\") {
        ensure_projects_dir()?;
    }
    write_json(path, payload)
}

#[tauri::command]
fn load_project_json(path: &str) -> Result<String, String> {
    guard_path(path)?;
    fs::read_to_string(path).map_err(|err| format!("Failed to read '{}': {}", path, err))
}

#[tauri::command]
fn delete_project(path: &str) -> Result<(), String> {
    guard_path(path)?;
    // Only allow deletion inside the projects/ folder.
    if !path.starts_with("projects/") {
        return Err(format!(
            "Rejected delete for '{}': only files inside 'projects/' may be deleted.",
            path
        ));
    }
    fs::remove_file(path).map_err(|err| format!("Failed to delete '{}': {}", path, err))
}

#[tauri::command]
fn rename_project(old_path: &str, new_path: &str) -> Result<(), String> {
    guard_path(old_path)?;
    guard_path(new_path)?;
    if !old_path.starts_with("projects/") || !new_path.starts_with("projects/") {
        return Err("Rename is only allowed inside the 'projects/' folder.".to_string());
    }
    fs::rename(old_path, new_path)
        .map_err(|err| format!("Failed to rename '{}' → '{}': {}", old_path, new_path, err))
}

// ─────────────────────────────────────────────
//  Project listing
// ─────────────────────────────────────────────

#[derive(serde::Serialize)]
struct ProjectEntry {
    name: String,
    path: String,
    /// Unix timestamp (seconds) of the last modification time, or 0 on error.
    modified_at: u64,
}

#[tauri::command]
fn list_projects() -> Result<Vec<ProjectEntry>, String> {
    // Always ensure the directory exists so the first run never fails.
    ensure_projects_dir()?;

    let entries = fs::read_dir("projects")
        .map_err(|err| format!("Failed to read 'projects' directory: {}", err))?;

    let mut projects: Vec<ProjectEntry> = Vec::new();

    for entry_result in entries {
        let entry = match entry_result {
            Ok(e) => e,
            Err(_) => continue,
        };

        let path = entry.path();

        // Only consider *.plot.json files.
        let is_plot_json = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.ends_with(".plot.json"))
            .unwrap_or(false);

        if !is_plot_json || !path.is_file() {
            continue;
        }

        let file_name = path.file_name().unwrap().to_string_lossy().to_string();
        // Strip .plot.json to get a human-readable project name.
        let name = file_name
            .strip_suffix(".plot.json")
            .unwrap_or(&file_name)
            .replace('_', " ");

        let path_str = format!("projects/{}", file_name);

        let modified_at = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        projects.push(ProjectEntry {
            name,
            path: path_str,
            modified_at,
        });
    }

    // Sort newest first.
    projects.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));

    Ok(projects)
}

// ─────────────────────────────────────────────
//  Export commands
// ─────────────────────────────────────────────

#[tauri::command]
fn export_project_json(path: &str, payload: &str) -> Result<(), String> {
    guard_path(path)?;
    write_json(path, payload)
}

#[tauri::command]
fn export_modular_project(payload: &str) -> Result<(), String> {
    let files: std::collections::HashMap<String, String> = serde_json::from_str(payload)
        .map_err(|err| format!("Failed to parse payload: {}", err))?;

    std::fs::create_dir_all("../exports")
        .map_err(|err| format!("Failed to create '../exports' directory: {}", err))?;

    for (path, content) in files {
        // Only allow exporting to ../exports/ safely
        if !path.starts_with("../exports/") || path.matches("..").count() > 1 || path.contains("//") || path.contains('\\') {
            return Err(format!("Rejected unsafe export path '{}'.", path));
        }
        let target = Path::new(&path);

        if let Some(parent) = target.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)
                    .map_err(|err| format!("Failed to create directory '{}': {}", parent.display(), err))?;
            }
        }

        if path.ends_with(".md") && target.exists() {
            continue;
        }

        fs::write(target, content).map_err(|err| format!("Failed to write '{}': {}", path, err))?;
    }

    Ok(())
}

// ─────────────────────────────────────────────
//  AI pipeline
// ─────────────────────────────────────────────

#[tauri::command]
fn run_ai_pipeline(app: tauri::AppHandle, export_dir: String) -> Result<String, String> {
    std::thread::spawn(move || {
        let mut child = match std::process::Command::new("python")
            .current_dir("../pipeline")
            .arg("generator.py")
            .arg(export_dir)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                app.emit("pipeline-log", format!("__PIPELINE_ERROR__: Failed to start python: {}", e)).ok();
                return;
            }
        };

        if let Some(stdout) = child.stdout.take() {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(line) = line {
                    app.emit("pipeline-log", line).ok();
                }
            }
        }

        if let Some(stderr) = child.stderr.take() {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(line) = line {
                    app.emit("pipeline-log", format!("ERROR: {}", line)).ok();
                }
            }
        }

        match child.wait() {
            Ok(status) => app.emit("pipeline-log", format!("__PIPELINE_COMPLETE__: {}", status)).ok(),
            Err(e) => app.emit("pipeline-log", format!("__PIPELINE_ERROR__: {}", e)).ok(),
        };
    });

    Ok("Started".to_string())
}

// ─────────────────────────────────────────────
//  Internal helpers
// ─────────────────────────────────────────────

fn write_json(path: &str, payload: &str) -> Result<(), String> {
    let target = Path::new(path);

    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("Failed to create directory '{}': {}", parent.display(), err))?;
        }
    }

    fs::write(target, payload).map_err(|err| format!("Failed to write '{}': {}", path, err))
}

// ─────────────────────────────────────────────
//  Entry point
// ─────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            save_project_json,
            load_project_json,
            delete_project,
            rename_project,
            list_projects,
            export_project_json,
            export_modular_project,
            run_ai_pipeline
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
