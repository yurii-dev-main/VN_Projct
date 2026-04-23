# Plot Architect - Phase 3 (Architecture Refactoring)

Desktop narrative graph editor built with:

- Tauri 2
- React + TypeScript
- React Flow
- Tailwind CSS

## Phase 3 Refactoring Complete ✅

**Node Architecture**: Strict separation of concerns
- **Act nodes**: State modifiers (never generate text, only store overrides in context)
- **Scene nodes**: Narrative text generation (single output path)
- **BranchPoint nodes**: Conditional routing (one handle per choice)
- Removed LayerTag node type and dialogue variant routing

**Entry Point**: Projects now have an explicit start node marked with `isStart: true`

**Python Generator**: Complete DFS implementation
- Finds and starts at designated start node
- Accumulates Act node overrides in active context
- Applies overrides to character bios during Scene generation
- Spawns parallel executions for BranchPoint choices
- Appends player decisions to bridge context for continuity

See [GENERATOR_UPDATES.md](./GENERATOR_UPDATES.md) for detailed architecture documentation.

## Implemented in Phase 1 MVP

- Unity-style layout:
	- Left panel: Hierarchy / Layers Browser
	- Center: infinite node canvas (drag, zoom, pan, connect)
	- Right panel: context Inspector
	- Top toolbar: New Node, Save Project, Export JSON, Validate, Layer switch
- Node types:
	- Act (with overrides)
	- Route
	- Scene (with single default output)
	- Event
	- BranchPoint (with choice handles)
- Layer filtering with multi-tag selection
- Scene inspector support:
	- layer tags
	- acting characters gallery
	- location picker + preview path
	- triggers list
	- dialogue variants with effect presets
	- visual importance toggle
- Connection editing in canvas:
	- drag from source to target
	- Scene default output and BranchPoint choice outputs
- Context action:
	- Copy state from previous act (creates duplicated prefilled node)
- JSON persistence through Rust commands in src-tauri:
	- save_project_json
	- export_project_json
	- load_project_json
	- export_modular_project (with start node tracking)

## Project structure

- src - UI/editor code (canvas, inspector, layers, toolbar)
- src-tauri - Rust backend commands for filesystem operations
- pipeline - Python generator (DFS narrative generation with Gemini)

## Data file

- Primary save target: project.plot.json
- Export target example: exports/project-<timestamp>.plot.json
- Modular export: exports/modular-<timestamp>/ (with progress_state.json)

## Python Generator

### Setup

```bash
cd pipeline
pip install -r requirements.txt
export GEMINI_API_KEY="your-key-here"  # or use .env file
```

### Run

```bash
python generator.py

# When prompted, provide the export directory path:
# Export directory to process? (e.g. '../exports/modular-123456789')
# > ../exports/modular-1234567890
```

The generator will:
1. Find the starting node (`isStart: true`)
2. Execute DFS through the narrative graph
3. Generate Scene text via Gemini API
4. Apply Act node overrides to character context
5. Branch at BranchPoint nodes with choice context
6. Output scene text files and progress state

For detailed architecture: [GENERATOR_UPDATES.md](./GENERATOR_UPDATES.md)

## Run

Install dependencies:

```bash
npm install
```

Run frontend only (for UI iteration):

```bash
npm run dev
```

Run Tauri desktop app:

```bash
npm run tauri dev
```

## Windows prerequisites for Tauri build

Required:

- Rust toolchain (rustup)
- Microsoft Visual C++ Build Tools (MSVC linker: link.exe)

If Rust exists but link.exe is missing, install "Build Tools for Visual Studio" with C++ workload.
