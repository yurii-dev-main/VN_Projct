import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import { isTauriAvailable } from "../utils/tauri";

// ─────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────

// Removed ProjectEntry because we use RecentProject exclusively.

interface ProjectSelectorProps {
  onOpen: (projectPath: string, projectName: string) => void;
}

// ─────────────────────────────────────────────
//  Slugify — strips characters invalid on Windows/Linux
// ─────────────────────────────────────────────

export function slugify(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "") // strip invalid chars
    .replace(/\s+/g, "_")                   // spaces → underscores
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")               // trim leading/trailing underscores
    .slice(0, 64);                           // cap length
}

// ─────────────────────────────────────────────
//  Date formatter
// ─────────────────────────────────────────────

function formatDate(unixSeconds: number): string {
  if (unixSeconds === 0) return "Unknown";
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ─────────────────────────────────────────────
//  Recent projects storage
// ─────────────────────────────────────────────

interface RecentProject {
  path: string;
  name: string;
  timestamp: number;
}

const RECENT_PROJECTS_KEY = "plot-architect:recentProjects";
const MAX_RECENT = 10;

function getRecentProjects(): RecentProject[] {
  try {
    const stored = localStorage.getItem(RECENT_PROJECTS_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function saveRecentProject(path: string, name: string): void {
  try {
    const recent = getRecentProjects();
    // Remove if already exists
    const filtered = recent.filter((p) => p.path !== path);
    // Add to beginning with current timestamp
    const updated = [
      { path, name, timestamp: Date.now() },
      ...filtered,
    ].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(updated));
  } catch {
    // Silently fail
  }
}

function removeRecentProject(path: string): void {
  try {
    const recent = getRecentProjects();
    const filtered = recent.filter((p) => p.path !== path);
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(filtered));
  } catch {
    // Silently fail
  }
}

// ─────────────────────────────────────────────
//  Component
// ─────────────────────────────────────────────

export function ProjectSelector({ onOpen }: ProjectSelectorProps) {
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<RecentProject | null>(null);
  const [busy, setBusy] = useState(false);

  // ── Load list ──────────────────────────────
  const reload = async () => {
    setError(null);
    try {
      setRecentProjects(getRecentProjects());
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    reload();
    // Also load recent projects on mount
    setRecentProjects(getRecentProjects());
  }, []);

  // ── Create project ─────────────────────────
  const handleCreate = async () => {
    if (!isTauriAvailable()) {
      setError("Cannot create projects in web mode. Please use desktop app.");
      return;
    }
    const slug = slugify(newName);
    if (!slug) {
      setError("Project name must contain at least one valid character.");
      return;
    }

    const emptyProject = JSON.stringify({
      acts: [],
      routes: [],
      nodes: {},
      layerPresets: [],
      characters: [],
      locations: [],
      lore: {},
    }, null, 2);

    setCreating(true);
    setError(null);
    try {
      const selectedDir = await dialogOpen({
        directory: true,
        multiple: false,
        title: "Select Directory to Create Project",
      });

      if (!selectedDir || typeof selectedDir !== "string") {
        return;
      }

      const path = await join(selectedDir, `${slug}.plot.json`);

      await invoke("save_project_json", { path, payload: emptyProject });
      // path from dialog is already absolute
      saveRecentProject(path, slug);
      setRecentProjects(getRecentProjects());
      setNewName("");
      onOpen(path, slug);
    } catch (err) {
      setError(String(err));
    } finally {
      setCreating(false);
    }
  };

  const handleOpenProject = async () => {
    if (!isTauriAvailable()) {
      setError("Cannot open projects in web mode. Please use desktop app.");
      return;
    }
    setError(null);
    try {
      const selected = await dialogOpen({
        multiple: false,
        directory: false,
        filters: [{ name: "Plot Project", extensions: ["json"] }],
      });

      if (typeof selected !== "string" || !selected) {
        return;
      }

      const fileName = selected.split(/[\\/]/).pop() || selected;
      const projectName = fileName.replace(/\.plot\.json$/i, "").replace(/\.json$/i, "");
      // Save to recent projects
      saveRecentProject(selected, projectName);
      setRecentProjects(getRecentProjects());
      onOpen(selected, projectName);
    } catch (err) {
      setError(String(err));
    }
  };

  // ── Delete project ─────────────────────────
  const confirmDelete = async () => {
    if (!deleteTarget || !isTauriAvailable()) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("delete_project", { path: deleteTarget.path });
      removeRecentProject(deleteTarget.path);
      setDeleteTarget(null);
      await reload();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  // ── Display name for a project entry ───────
  const displayName = (p: RecentProject) =>
    p.name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  // ─────────────────────────────────────────────
  //  Render
  // ─────────────────────────────────────────────

  return (
    <div
      className="relative flex h-screen w-screen flex-col overflow-hidden"
      style={{
        background:
          "radial-gradient(ellipse at 20% 10%, #1e293b 0%, #0f172a 50%, #020617 100%)",
        fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
      }}
    >
      {/* Ambient glow blobs */}
      <div
        style={{
          position: "absolute",
          top: "-10%",
          left: "-5%",
          width: "40%",
          height: "40%",
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(99,102,241,0.12) 0%, transparent 70%)",
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          bottom: "-10%",
          right: "-5%",
          width: "35%",
          height: "35%",
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(6,182,212,0.10) 0%, transparent 70%)",
          pointerEvents: "none",
        }}
      />

      {/* ── Header ── */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "20px 48px",
          borderBottom: "1px solid rgba(148,163,184,0.1)",
          backdropFilter: "blur(12px)",
          background: "rgba(2,6,23,0.6)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {/* Logo mark */}
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              background: "linear-gradient(135deg, #6366f1 0%, #06b6d4 100%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 18,
              fontWeight: 800,
              color: "#fff",
              letterSpacing: "-1px",
              boxShadow: "0 0 18px rgba(99,102,241,0.45)",
            }}
          >
            PA
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: "#f1f5f9", letterSpacing: "-0.3px" }}>
              Plot Architect
            </h1>
            <p style={{ margin: 0, fontSize: 11, color: "#64748b", letterSpacing: "0.05em" }}>
              PROJECT MANAGER
            </p>
          </div>
        </div>

        {/* Create new project */}
        <div style={{ display: "flex", gap: 8 }}>
          <button
            id="open-project-btn"
            onClick={handleOpenProject}
            style={{
              background: "rgba(15,23,42,0.8)",
              border: "1px solid rgba(100,116,139,0.4)",
              borderRadius: 8,
              padding: "8px 18px",
              fontSize: 13,
              fontWeight: 600,
              color: "#e2e8f0",
              cursor: "pointer",
            }}
          >
            Open Project File
          </button>
          <input
            id="new-project-name"
            type="text"
            placeholder="New project name…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !creating && handleCreate()}
            style={{
              background: "rgba(15,23,42,0.8)",
              border: "1px solid rgba(100,116,139,0.4)",
              borderRadius: 8,
              padding: "8px 14px",
              color: "#e2e8f0",
              fontSize: 13,
              outline: "none",
              width: 220,
              transition: "border-color 0.2s",
            }}
            onFocus={(e) => (e.target.style.borderColor = "#6366f1")}
            onBlur={(e) => (e.target.style.borderColor = "rgba(100,116,139,0.4)")}
          />
          <button
            id="create-project-btn"
            onClick={handleCreate}
            disabled={creating || !newName.trim()}
            style={{
              background: creating || !newName.trim()
                ? "rgba(99,102,241,0.3)"
                : "linear-gradient(135deg, #6366f1, #4f46e5)",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              padding: "8px 18px",
              fontSize: 13,
              fontWeight: 600,
              cursor: creating || !newName.trim() ? "not-allowed" : "pointer",
              transition: "opacity 0.2s, transform 0.1s",
              boxShadow: creating || !newName.trim() ? "none" : "0 0 14px rgba(99,102,241,0.4)",
            }}
            onMouseEnter={(e) => {
              if (!creating && newName.trim()) (e.currentTarget.style.transform = "translateY(-1px)");
            }}
            onMouseLeave={(e) => (e.currentTarget.style.transform = "translateY(0)")}
          >
            {creating ? "Creating…" : "+ Create"}
          </button>
        </div>
      </header>

      {/* ── Body ── */}
      <main
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "36px 48px",
        }}
      >
        {/* Error banner */}
        {error && (
          <div
            style={{
              marginBottom: 24,
              padding: "10px 16px",
              borderRadius: 8,
              background: "rgba(239,68,68,0.15)",
              border: "1px solid rgba(239,68,68,0.4)",
              color: "#fca5a5",
              fontSize: 13,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span>⚠ {error}</span>
            <button
              onClick={() => setError(null)}
              style={{ background: "none", border: "none", color: "#fca5a5", cursor: "pointer", fontSize: 16 }}
            >
              ×
            </button>
          </div>
        )}

        {/* Section label */}
        <div style={{ marginBottom: 20, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h2 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "#64748b", letterSpacing: "0.08em", textTransform: "uppercase" }}>
            Recent Projects
          </h2>
          <button
            onClick={reload}
            style={{
              background: "none",
              border: "1px solid rgba(100,116,139,0.3)",
              borderRadius: 6,
              padding: "4px 10px",
              color: "#64748b",
              fontSize: 12,
              cursor: "pointer",
              transition: "border-color 0.2s, color 0.2s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = "#6366f1";
              e.currentTarget.style.color = "#a5b4fc";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "rgba(100,116,139,0.3)";
              e.currentTarget.style.color = "#64748b";
            }}
          >
            ↻ Refresh
          </button>
        </div>

        {/* Removed loading skeleton since localStorage is instant */}
        {recentProjects.length === 0 ? (
          /* Empty state */
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              height: 320,
              color: "#475569",
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 56, marginBottom: 16, opacity: 0.4 }}>📂</div>
            <p style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "#64748b" }}>No projects yet</p>
            <p style={{ margin: "6px 0 0", fontSize: 13, color: "#475569" }}>
              Type a name above and click <strong>+ Create</strong> to start.
            </p>
          </div>
        ) : (
          /* Project grid */
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
            {recentProjects.map((project) => (
              <ProjectCard
                key={project.path}
                project={project}
                displayName={displayName(project)}
                formattedDate={formatDate(project.timestamp / 1000)}
                onOpen={async () => {
                  if (!isTauriAvailable()) {
                    setError("Cannot open projects in web mode. Please use desktop app.");
                    return;
                  }
                  let absolutePath = project.path;
                  try {
                    absolutePath = await invoke<string>("resolve_absolute_path", { path: project.path });
                  } catch {
                    // Fall through
                  }

                  // Graceful Error Handling: check if file exists
                  try {
                    await invoke("load_project_json", { path: absolutePath });
                  } catch (err) {
                    setError(`File not found: ${absolutePath}`);
                    removeRecentProject(project.path);
                    await reload();
                    return;
                  }

                  const projName = displayName(project);
                  saveRecentProject(absolutePath, projName);
                  setRecentProjects(getRecentProjects());
                  onOpen(absolutePath, projName);
                }}
                onDelete={() => setDeleteTarget(project)}
              />
            ))}
          </div>
        )}
      </main>

      {/* ── Delete confirmation modal ── */}
      {deleteTarget && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(2,6,23,0.85)",
            backdropFilter: "blur(6px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 50,
          }}
        >
          <div
            style={{
              background: "linear-gradient(145deg, #1e293b, #0f172a)",
              border: "1px solid rgba(239,68,68,0.35)",
              borderRadius: 16,
              padding: "32px 36px",
              maxWidth: 400,
              width: "90%",
              boxShadow: "0 24px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(239,68,68,0.1)",
            }}
          >
            <div style={{ fontSize: 32, marginBottom: 12, textAlign: "center" }}>🗑</div>
            <h3 style={{ margin: "0 0 8px", fontSize: 16, fontWeight: 700, color: "#f1f5f9", textAlign: "center" }}>
              Delete "{displayName(deleteTarget)}"?
            </h3>
            <p style={{ margin: "0 0 24px", fontSize: 13, color: "#94a3b8", textAlign: "center" }}>
              This action <strong style={{ color: "#fca5a5" }}>cannot be undone</strong>. The file will be permanently removed.
            </p>
            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={busy}
                style={{
                  flex: 1,
                  padding: "10px",
                  borderRadius: 8,
                  border: "1px solid rgba(100,116,139,0.3)",
                  background: "transparent",
                  color: "#94a3b8",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                id="confirm-delete-btn"
                onClick={confirmDelete}
                disabled={busy}
                style={{
                  flex: 1,
                  padding: "10px",
                  borderRadius: 8,
                  border: "none",
                  background: busy ? "rgba(239,68,68,0.3)" : "linear-gradient(135deg, #ef4444, #dc2626)",
                  color: "#fff",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: busy ? "not-allowed" : "pointer",
                  boxShadow: busy ? "none" : "0 0 14px rgba(239,68,68,0.4)",
                }}
              >
                {busy ? "Deleting…" : "Delete permanently"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Keyframe for skeleton pulse */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 0.6; }
          50%       { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}

// ─────────────────────────────────────────────
//  Project card sub-component
// ─────────────────────────────────────────────

interface CardProps {
  project: RecentProject;
  displayName: string;
  formattedDate: string;
  onOpen: () => void;
  onDelete: () => void;
}

function ProjectCard({ project, displayName, formattedDate, onOpen, onDelete }: CardProps) {
  const [hovered, setHovered] = useState(false);

  // Generate a deterministic accent hue from the project name
  let hue = 0;
  for (let i = 0; i < project.name.length; i++) hue = (hue * 31 + project.name.charCodeAt(i)) % 360;

  return (
    <div
      id={`project-card-${project.name}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        borderRadius: 14,
        border: hovered
          ? `1px solid hsla(${hue}, 70%, 60%, 0.5)`
          : "1px solid rgba(100,116,139,0.15)",
        background: hovered
          ? `linear-gradient(145deg, hsla(${hue}, 40%, 15%, 0.8), rgba(15,23,42,0.95))`
          : "linear-gradient(145deg, rgba(30,41,59,0.7), rgba(15,23,42,0.8))",
        padding: "20px 22px",
        transition: "all 0.2s ease",
        boxShadow: hovered
          ? `0 8px 30px rgba(0,0,0,0.4), 0 0 0 1px hsla(${hue}, 70%, 60%, 0.15)`
          : "0 2px 8px rgba(0,0,0,0.2)",
        transform: hovered ? "translateY(-2px)" : "translateY(0)",
        cursor: "default",
      }}
    >
      {/* Accent bar */}
      <div
        style={{
          width: 32,
          height: 3,
          borderRadius: 99,
          background: `linear-gradient(90deg, hsl(${hue}, 70%, 60%), hsl(${(hue + 40) % 360}, 70%, 60%))`,
          marginBottom: 14,
          boxShadow: hovered ? `0 0 10px hsla(${hue}, 70%, 60%, 0.6)` : "none",
          transition: "box-shadow 0.2s",
        }}
      />

      {/* Name */}
      <div
        style={{
          fontSize: 15,
          fontWeight: 700,
          color: "#f1f5f9",
          marginBottom: 4,
          lineHeight: 1.3,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={displayName}
      >
        {displayName}
      </div>

      {/* Modified date */}
      <div style={{ fontSize: 11, color: "#64748b", marginBottom: 18 }}>
        Last modified: {formattedDate}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          id={`open-project-${project.name}`}
          onClick={onOpen}
          style={{
            flex: 1,
            padding: "8px 0",
            borderRadius: 8,
            border: "none",
            background: hovered
              ? `linear-gradient(135deg, hsl(${hue}, 65%, 50%), hsl(${(hue + 30) % 360}, 65%, 45%))`
              : "rgba(99,102,241,0.2)",
            color: "#fff",
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
            transition: "background 0.2s, box-shadow 0.2s",
            boxShadow: hovered ? `0 0 12px hsla(${hue}, 65%, 50%, 0.45)` : "none",
          }}
        >
          Open →
        </button>
        <button
          id={`delete-project-${project.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          style={{
            padding: "8px 14px",
            borderRadius: 8,
            border: "1px solid rgba(239,68,68,0.2)",
            background: "transparent",
            color: "#f87171",
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
            transition: "background 0.2s, border-color 0.2s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(239,68,68,0.15)";
            e.currentTarget.style.borderColor = "rgba(239,68,68,0.5)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.borderColor = "rgba(239,68,68,0.2)";
          }}
        >
          🗑
        </button>
      </div>
    </div>
  );
}
