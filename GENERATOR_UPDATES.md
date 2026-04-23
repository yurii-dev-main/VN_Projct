# Python Generator Updates - DFS Pipeline Architecture

## Overview

The `pipeline/generator.py` script has been completely refactored to support the new Plot Architect node architecture. The generator now implements a **proper Depth-First Search (DFS)** that respects the explicit node type separation (Act, Scene, BranchPoint) and state machine semantics.

---

## Key Changes

### 1. **Entry Point Detection** ✅

**Before**: Generator started at arbitrary node (first alphabetically)

**After**: 
- Scans all nodes for `parameters.isStart == True`
- Starts DFS execution **exactly** at the designated start node
- Fallback: if no start node marked, uses first Act node found

```python
def find_start_node(nodes: Dict[str, Dict[str, Any]]) -> Optional[str]:
    """Find the starting node by scanning for isStart == True."""
    for node_id, node in nodes.items():
        params = node.get("parameters", {})
        if params.get("isStart") is True:
            return node_id
```

---

### 2. **Act Node Handling (State Modifiers)** ✅

**Before**: Act nodes were skipped entirely

**After**:
- Act nodes **do NOT** trigger Gemini API calls
- All `parameters.overrides` are read and stored in `ActiveContext`
- These overrides are applied to character bios when generating subsequent Scene prompts
- Creates a memory of state modifications that persist through the narrative

```python
def process_act_node(node_id: str, node: Dict[str, Any], context: ActiveContext) -> None:
    """Process an Act node by storing its overrides in active context."""
    print(f"  [ACT] Processing: {node.get('name', node_id)}")
    
    params = node.get("parameters", {})
    overrides = params.get("overrides", [])
    
    for override in overrides:
        context.apply_override(override)
```

**Context Integration**:
```python
class ActiveContext:
    """Maintains active state during DFS traversal (overrides, decisions, etc)."""
    def __init__(self):
        self.active_overrides: List[Dict[str, Any]] = []
        self.visited_nodes: Set[str] = set()
    
    def get_character_bio_with_overrides(self, char_id: str, lore_db: Dict[str, str]) -> str:
        """Get character bio and apply any active overrides."""
        base_bio = lore_db.get(char_id, "Био неизвестно")
        
        relevant_overrides = [o for o in self.active_overrides if o.get("targetId") == char_id]
        
        if relevant_overrides:
            override_notes = "\n[АКТИВНЫЕ МОДИФИКАЦИИ]:\n"
            for override in relevant_overrides:
                override_notes += f"- {override.get('property')}: {override.get('newValue')}\n"
            return base_bio + override_notes
        
        return base_bio
```

---

### 3. **Scene Node Handling (Text Generation)** ✅

**Before**: Only scenes were processed; no context handling

**After**:
- Calls Gemini API to generate narrative text ✓ (unchanged)
- Extracts Bridge Summary for context propagation ✓ (unchanged)
- **NEW**: Applies `ActiveContext` overrides to character bios before prompt
- **NEW**: Expects single outgoing path (Scene nodes typically have 1 connection)

```python
async def process_scene_node(
    node_id: str,
    node: Dict[str, Any],
    lore_db: Dict[str, str],
    bridge_summary: str,
    context: ActiveContext,  # <-- Receives active state
    export_dir: str
) -> str:
    """Generate text for a Scene node."""
    print(f"  [SCENE] Processing: {node.get('name', node_id)}")
    
    # Prompt building now receives context to apply overrides
    prompt = build_prompt(node, lore_db, bridge_summary, context)
    scene_text = await generate_text(prompt)
    
    # ... save and return bridge
```

---

### 4. **BranchPoint Node Handling (Routing)** ✅

**Before**: BranchPoint nodes were not handled at all

**After**:
- **No text generation** for BranchPoint nodes
- Reads `parameters.choices` array
- **For EACH choice**, spawns recursive DFS execution (parallel path)
- Appends choice text to Bridge Summary so LLM knows player decision
- Returns merged execution result

```python
elif node_type == "BranchPoint":
    # Process BranchPoint: spawn parallel paths for each choice
    print(f"  [BRANCH] Processing: {node.get('name', node_id)}")
    params = node.get("parameters", {})
    choices = params.get("choices", [])
    
    all_results = []
    total_scenes = 0
    
    for choice_idx, choice in enumerate(choices):
        choice_text = choice.get("text", f"Choice {choice_idx + 1}")
        next_node_id = choice.get("nextNode", "")
        
        if not next_node_id:
            continue
        
        # Append choice context to bridge for next scene
        choice_bridge = bridge_summary + f"\nИгрок выбрал: {choice_text}"
        
        # Recursive DFS for this choice branch
        result_bridge, result_scenes = await dfs_execute(
            next_node_id,
            nodes,
            lore_db,
            choice_bridge,  # <-- Choice text is in context
            context,
            export_dir,
            depth + 1,
            branch_label
        )
        
        all_results.append((choice_text, result_bridge, result_scenes))
        total_scenes += result_scenes
```

---

### 5. **Proper DFS Implementation** ✅

**Before**: Linear traversal of alphabetically sorted files (not a graph traversal)

**After**: 
- True DFS that follows `connectedTo` arrays
- Respects node types and their semantics
- Tracks visited nodes to prevent cycles
- Maintains execution depth for logging
- Supports branching paths with choice context

```python
async def dfs_execute(
    node_id: str,
    nodes: Dict[str, Dict[str, Any]],
    lore_db: Dict[str, str],
    bridge_summary: str,
    context: ActiveContext,
    export_dir: str,
    depth: int = 0,
    branch_name: str = "main"
) -> Tuple[str, int]:
    """
    Execute DFS traversal through the narrative graph.
    Returns: (final_bridge_summary, scene_count)
    """
```

---

### 6. **Node Type Routing** ✅

The DFS now implements different logic for each node type:

| Node Type    | Behavior                                                  |
|--------------|-----------------------------------------------------------|
| **Act**      | Store overrides in context; continue to next node        |
| **Scene**    | Generate text with Gemini (using active context); continue to next node |
| **BranchPoint** | Spawn parallel DFS for each choice; append choice text to bridge |
| **Route**    | Pass through (no processing)                              |
| **Event**    | Pass through (no processing)                              |

---

### 7. **Progress State Updates** ✅

**Before**: Stored `last_processed` and `context_bridge`

**After**: Now stores comprehensive state:
```json
{
  "start_node": "node_act_001",
  "context_bridge": "...",
  "scenes_generated": 5,
  "status": "completed"
}
```

---

## Data Flow Example

```
[START: Act_001 (isStart=true)]
├─ Read overrides: [Override for character Anna]
└─ Continue to Scene_001
   ├─ Apply Anna's override to bio
   ├─ Generate scene text
   ├─ Extract bridge summary
   └─ Continue to BranchPoint_001
      ├─ Choice 1: "Confront Anna"
      │  ├─ Append to bridge
      │  └─ Continue to Scene_002
      │     ├─ Scene includes context: "Player decided to: Confront Anna"
      │     └─ ...
      └─ Choice 2: "Hide the truth"
         ├─ Append to bridge
         └─ Continue to Scene_003
            ├─ Scene includes context: "Player decided to: Hide the truth"
            └─ ...
```

---

## Usage

```bash
cd pipeline
python generator.py

# When prompted:
# Export directory to process? (e.g. '../exports/modular-123456789')
# > ../exports/modular-1234567890
```

**Output**:
- Scene text files: `{export_dir}/{node_id}_output.txt`
- Progress state: `{export_dir}/progress_state.json` with final context and scene count

---

## Architecture Summary

The new generator implements a **state machine DFS** that:

1. ✅ Finds explicit start node by `isStart` flag
2. ✅ Accumulates state (overrides) as Act nodes are traversed
3. ✅ Applies accumulated state to Scene generation prompts
4. ✅ Branches at BranchPoint nodes with choice context propagation
5. ✅ Tracks visited nodes to avoid cycles
6. ✅ Maintains bridge summaries for narrative continuity
7. ✅ Respects strict node type separation

This ensures the Python generator now correctly interprets the React frontend's new architecture!
