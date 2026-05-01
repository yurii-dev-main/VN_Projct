use std::fs;
use std::path::{Component, Path, PathBuf};
use std::io::{BufRead, BufReader, Read};
use std::process::Stdio;
use std::thread;
use tauri::Emitter;

// ─────────────────────────────────────────────
//  Path-safety helpers
// ─────────────────────────────────────────────

/// Reject any path that contains directory-traversal sequences.
fn guard_path(path: &str) -> Result<(), String> {
    if Path::new(path).components().any(|component| matches!(component, Component::ParentDir)) {
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
//  Path resolution helpers
// ─────────────────────────────────────────────

/// Resolve a path to its absolute form using the current working directory.
#[tauri::command]
fn resolve_absolute_path(path: &str) -> Result<String, String> {
    let p = Path::new(path);
    if p.is_absolute() {
        return Ok(p.to_string_lossy().to_string());
    }
    let cwd = std::env::current_dir()
        .map_err(|e| format!("Failed to get current directory: {}", e))?;
    let absolute = cwd.join(p);
    // Canonicalize if the file exists, otherwise just use the joined path
    match fs::canonicalize(&absolute) {
        Ok(canonical) => Ok(canonical.to_string_lossy().to_string()),
        Err(_) => Ok(absolute.to_string_lossy().to_string()),
    }
}

/// Return the absolute path to the default `projects/` directory.
#[tauri::command]
fn get_projects_base_dir() -> Result<String, String> {
    ensure_projects_dir()?;
    let cwd = std::env::current_dir()
        .map_err(|e| format!("Failed to get current directory: {}", e))?;
    let projects_dir = cwd.join("projects");
    match fs::canonicalize(&projects_dir) {
        Ok(canonical) => Ok(canonical.to_string_lossy().to_string()),
        Err(_) => Ok(projects_dir.to_string_lossy().to_string()),
    }
}

// ─────────────────────────────────────────────
//  Project-file I/O
// ─────────────────────────────────────────────

#[tauri::command]
fn save_project_json(path: &str, payload: &str) -> Result<(), String> {
    guard_path(path)?;
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

        // Use the absolute path so "recent projects" always resolve correctly
        let path_str = match fs::canonicalize(&path) {
            Ok(canonical) => canonical.to_string_lossy().to_string(),
            Err(_) => format!("projects/{}", file_name),
        };

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
fn export_modular_project(export_dir: &str, payload: &str) -> Result<(), String> {
    let files: std::collections::HashMap<String, String> = serde_json::from_str(payload)
        .map_err(|err| format!("Failed to parse payload: {}", err))?;

    let export_root = Path::new(export_dir);
    if export_root.components().any(|component| matches!(component, Component::ParentDir)) {
        return Err(format!("Rejected unsafe export directory '{}'.", export_dir));
    }

    std::fs::create_dir_all(export_root)
        .map_err(|err| format!("Failed to create export directory '{}': {}", export_root.display(), err))?;

    for (relative_path, content) in files {
        let relative_target = Path::new(&relative_path);
        if relative_target.is_absolute() || relative_target.components().any(|component| matches!(component, Component::ParentDir)) {
            return Err(format!("Rejected unsafe export path '{}'.", relative_path));
        }
        let target: PathBuf = export_root.join(relative_target);

        if let Some(parent) = target.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)
                    .map_err(|err| format!("Failed to create directory '{}': {}", parent.display(), err))?;
            }
        }

        if relative_path.ends_with(".md") && target.exists() {
            continue;
        }

        fs::write(&target, content).map_err(|err| format!("Failed to write '{}': {}", target.display(), err))?;
    }

    Ok(())
}

// ─────────────────────────────────────────────
//  AI pipeline
// ─────────────────────────────────────────────

#[tauri::command]
fn run_ai_pipeline(app: tauri::AppHandle, export_dir: String, project_path: String) -> Result<String, String> {
    std::thread::spawn(move || {
        let mut child = match std::process::Command::new("python")
            .current_dir("../pipeline")
            .arg("generator.py")
            .arg(export_dir)
            .arg(project_path)
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

#[tauri::command]
fn run_agent_planner(app: tauri::AppHandle, prompt: String, context_json: String) -> Result<String, String> {
    thread::spawn(move || {
        let mut child = match std::process::Command::new("python")
            .current_dir("../pipeline")
            .arg("agent.py")
            .arg("--prompt")
            .arg(prompt)
            .arg("--context-json")
            .arg(context_json)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                app.emit(
                    "agent-event",
                    serde_json::json!({
                        "type": "agent:status",
                        "status": "error",
                        "message": format!("Failed to start python: {}", e),
                    }),
                )
                .ok();
                return;
            }
        };

        let stdout_handle = child.stdout.take().map(|stdout| {
            let app = app.clone();
            thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    if let Ok(line) = line {
                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
                            app.emit("agent-event", parsed).ok();
                        }
                    }
                }
            })
        });

        // Read stderr fully so we can emit complete Python tracebacks on failure.
        let mut collected_stderr = String::new();
        if let Some(mut stderr) = child.stderr.take() {
            let _ = stderr.read_to_string(&mut collected_stderr);
            if !collected_stderr.trim().is_empty() {
                app.emit(
                    "agent-event",
                    serde_json::json!({
                        "type": "agent:status",
                        "status": "error",
                        "message": collected_stderr,
                    }),
                )
                .ok();
            }
        }

        if let Some(handle) = stdout_handle {
            let _ = handle.join();
        }

        match child.wait() {
            Ok(status) => {
                if !status.success() {
                    let msg = if !collected_stderr.trim().is_empty() {
                        collected_stderr.clone()
                    } else {
                        format!("Agent planner exited with {}", status)
                    };
                    app.emit(
                        "agent-event",
                        serde_json::json!({
                            "type": "agent:status",
                            "status": "error",
                            "message": msg,
                        }),
                    )
                    .ok();
                }
            }
            Err(e) => {
                app.emit(
                    "agent-event",
                    serde_json::json!({
                        "type": "agent:status",
                        "status": "error",
                        "message": format!("Failed to wait for planner: {}", e),
                    }),
                )
                .ok();
            }
        }
    });

    Ok("Started".to_string())
}

#[tauri::command]
async fn run_lore_parser(draft_text: String, entity_type: String) -> Result<String, String> {
    let output = std::process::Command::new("python")
        .current_dir("../pipeline")
        .arg("parser.py")
        .arg("--draft")
        .arg(&draft_text)
        .arg("--entity-type")
        .arg(&entity_type)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to start lore parser: {}", e))?;

    if !output.status.success() {
        let stderr_text = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Lore parser failed (exit {}): {}", output.status, stderr_text));
    }

    let stdout_text = String::from_utf8_lossy(&output.stdout).to_string();
    if stdout_text.trim().is_empty() {
        return Err("Lore parser returned empty output.".to_string());
    }

    Ok(stdout_text.trim().to_string())
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            save_project_json,
            load_project_json,
            delete_project,
            rename_project,
            list_projects,
            export_project_json,
            export_modular_project,
            run_ai_pipeline,
            run_agent_planner,
            run_lore_parser,
            resolve_absolute_path,
            get_projects_base_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
