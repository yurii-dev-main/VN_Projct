import os
import re
import sys
import base64
sys.stdout.reconfigure(encoding='utf-8')
import glob
import json
import asyncio
from typing import Dict, Any, List, Optional, Set, Tuple
from tenacity import retry, stop_after_attempt, wait_exponential
from google import genai
from dotenv import load_dotenv

# Load environment variables (GEMINI_API_KEY)
load_dotenv()

client = genai.Client()


def sanitize_filename(value: str) -> str:
    """Sanitize a string for safe use as a filename on Windows and Unix."""
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", str(value))
    cleaned = re.sub(r"\s+", "_", cleaned)
    cleaned = re.sub(r"_+", "_", cleaned)
    cleaned = cleaned.strip("._ ")
    return cleaned[:120] if cleaned else "untitled"


def sanitize_dirname(value: str) -> str:
    """Sanitize a string for safe use as a directory name on Windows and Unix."""
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", str(value))
    cleaned = re.sub(r"\s+", "_", cleaned)
    cleaned = re.sub(r"_+", "_", cleaned)
    cleaned = cleaned.strip("._ ")
    return cleaned[:80] if cleaned else "Untitled"


PROMPT_TEMPLATE = """Ты — профессиональный сценарист визуальных новелл. Твоя задача: написать текст и диалоги для одной конкретной сцены строго по заданным правилам, не забегая вперед сюжета. Формат вывода: имя персонажа и его реплика/действие.

[ГЛОБАЛЬНЫЕ ПРАВИЛА СТИЛЯ И ФОРМАТИРОВАНИЯ]
{global_style_prompt}

[БАЗА ЗНАНИЙ СЦЕНЫ]
{lore_text}

[УЧАСТНИКИ СЦЕНЫ]
{actors_text}

[ПОСТАНОВКА СЦЕНЫ]
Локация: {location_name}
Время суток: {time_of_day}
Тон и Атмосфера: {tone_and_mood}

[ТЕКУЩИЙ КОНТЕКСТ (ВХОД)]
Что произошло прямо перед этой сценой: {bridge_summary}

[РЕЖИССЕРСКАЯ ЗАДАЧА]
Что происходит (Action): {narrative_action}
Чем должно закончиться (Goal): {scene_goal}

[ЖЕСТКИЕ ОГРАНИЧЕНИЯ (CONSTRAINTS)]
ВНИМАНИЕ! КРИТИЧЕСКИЕ ПРАВИЛА:
{constraints}

Напиши сцену. В самом конце текста, с новой строки, добавь тег <summary>, внутри которого напиши сжатый итог этой сцены в 1-2 предложениях (кто где оказался и как изменились отношения), который будет передан в следующую сцену."""

@retry(stop=stop_after_attempt(5), wait=wait_exponential(multiplier=1, min=4, max=15))
async def generate_text(prompt: str) -> str:
    # Explicit sleep to respect free-tier RPM limits
    await asyncio.sleep(4)
    response = client.models.generate_content(
        model='gemini-2.5-flash',
        contents=prompt
    )
    return response.text

@retry(stop=stop_after_attempt(5), wait=wait_exponential(multiplier=1, min=2, max=10))
async def generate_bridge(scene_text: str) -> str:
    # Attempt to extract `<summary>` tag if the LLM followed instructions
    if "<summary>" in scene_text and "</summary>" in scene_text:
        start_idx = scene_text.find("<summary>") + len("<summary>")
        end_idx = scene_text.find("</summary>")
        return scene_text[start_idx:end_idx].strip()
        
    await asyncio.sleep(2)
    prompt = f"Сделай выжимку из сгенерированного текста в 2 предложениях (кто где оказался и как изменились отношения):\n\n{scene_text}"
    response = client.models.generate_content(
        model='gemini-2.5-flash',
        contents=prompt
    )
    return response.text

def load_project_nodes(export_dir: str) -> Dict[str, Dict[str, Any]]:
    """Load all nodes from the Acts directory into a dictionary by node ID."""
    nodes = {}
    acts_dir = os.path.join(export_dir, 'Acts')
    
    if not os.path.exists(acts_dir):
        return nodes
    
    for node_file in glob.glob(f"{acts_dir}/**/*.json", recursive=True):
        try:
            with open(node_file, 'r', encoding='utf-8') as f:
                node = json.load(f)
                node_id = node.get("id")
                if node_id:
                    nodes[node_id] = node
        except Exception as e:
            print(f"Failed to load node {node_file}: {e}")
    
    return nodes

def load_lore(export_dir: str) -> Dict[str, str]:
    lore = {}
    lore_dir = os.path.join(export_dir, 'Lore')
    if not os.path.exists(lore_dir):
        return lore
        
    for root, _, files in os.walk(lore_dir):
        for f in files:
            if f.endswith('.md'):
                path = os.path.join(root, f)
                try:
                    with open(path, 'r', encoding='utf-8') as file:
                        content = file.read()
                        file_id = f.replace('.md', '')
                        lore[file_id] = content
                except Exception as e:
                    print(f"Failed to read lore {f}: {e}")
    return lore

def load_project_settings(export_dir: str) -> str:
    settings_paths = [
        os.path.join(export_dir, 'project_settings.json'),
        os.path.join(export_dir, 'plot.json'),
    ]

    for settings_path in settings_paths:
        if not os.path.exists(settings_path):
            continue

        try:
            with open(settings_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                if isinstance(data, dict):
                    value = data.get('globalStylePrompt', '')
                    if value:
                        return str(value)
        except Exception as e:
            print(f"Failed to read project settings {settings_path}: {e}")

    return ""

def find_start_node(nodes: Dict[str, Dict[str, Any]]) -> Optional[str]:
    """Find the starting node by scanning for isStart == True."""
    for node_id, node in nodes.items():
        params = node.get("parameters", {})
        if params.get("isStart") is True:
            return node_id
    # Fallback: return first Act node
    for node_id, node in nodes.items():
        if node.get("type") == "Act":
            return node_id
    return None

class ActiveContext:
    """Maintains active state during DFS traversal (overrides, decisions, etc)."""
    def __init__(self):
        self.active_overrides: List[Dict[str, Any]] = []
        self.visited_nodes: Set[str] = set()
        self.execution_paths: List[str] = []  # Track branch paths for logging
    
    def apply_override(self, override: Dict[str, Any]) -> None:
        """Store an override from an Act node."""
        self.active_overrides.append(override)
    
    def get_character_bio_with_overrides(self, char_id: str, lore_db: Dict[str, str]) -> str:
        """Get character bio and apply any active overrides."""
        base_bio = lore_db.get(char_id, "Био неизвестно")
        
        # Check if there are overrides targeting this character
        relevant_overrides = [o for o in self.active_overrides if o.get("targetId") == char_id]
        
        if relevant_overrides:
            # Append override information to the bio
            override_notes = "\n[АКТИВНЫЕ МОДИФИКАЦИИ]:\n"
            for override in relevant_overrides:
                prop = override.get("property", "Unknown")
                val = override.get("newValue", "")
                override_notes += f"- {prop}: {val}\n"
            return base_bio + override_notes
        
        return base_bio

def build_prompt(
    node: Dict[str, Any],
    lore_db: Dict[str, str],
    bridge_summary: str,
    context: ActiveContext,
    global_style_prompt: str,
) -> str:
    """Build a Gemini prompt for Scene generation, applying active context."""
    params = node.get("parameters", {})
    tags = node.get("layerTags", [])
    
    # 1. Lore text
    lore_entries = [lore_db[t] for t in tags if t in lore_db]
    if params.get("locationId") in lore_db:
        lore_entries.append(lore_db[params["locationId"]])
    lore_text = "\n\n".join(lore_entries)
    
    # 2. Actors text (with overrides applied)
    actors = params.get("actingCharacters", [])
    actors_lines = []
    for a in actors:
        char_id = a.get("characterId", "")
        # Get bio with active overrides applied
        bio = context.get_character_bio_with_overrides(char_id, lore_db)
        actors_lines.append(f"{char_id}: {bio}\nТекущее состояние: {a.get('presetState', '')}\nОтношение к другим: {a.get('relationships', '')}")
    actors_text = "\n\n".join(actors_lines)
    
    # 3. Apply template
    return PROMPT_TEMPLATE.format(
        global_style_prompt=global_style_prompt if global_style_prompt else "Не заданы.",
        lore_text=lore_text if lore_text else "Нет дополнительных данных лора.",
        actors_text=actors_text if actors_text else "Нет участников.",
        location_name=params.get("locationId", "Неизвестно"),
        time_of_day=params.get("timeOfDay", "То же время"),
        tone_and_mood=params.get("toneAndMood", "Нейтральный"),
        bridge_summary=bridge_summary if bridge_summary else "Начало истории.",
        narrative_action=params.get("narrativeAction", "Свободное развитие"),
        scene_goal=params.get("goal", "Перейти к следующему событию"),
        constraints=params.get("constraints", "Нет жестких ограничений.")
    )

async def process_scene_node(
    node_id: str,
    node: Dict[str, Any],
    lore_db: Dict[str, str],
    bridge_summary: str,
    context: ActiveContext,
    export_dir: str,
    global_style_prompt: str,
    current_act: str,
    current_route: str,
    scene_counter: int,
) -> Tuple[str, int]:
    """Generate text for a Scene node.
    
    Returns: (new_bridge_summary, updated_scene_counter)
    """
    print(f"  [SCENE] Processing: {node.get('name', node_id)}")
    
    prompt = build_prompt(node, lore_db, bridge_summary, context, global_style_prompt)
    scene_text = await generate_text(prompt)
    
    # Build nested output path: export_dir / Generated / <Act> / <Route> /
    act_dir = sanitize_dirname(current_act)
    route_dir = sanitize_dirname(current_route)
    output_dir = os.path.join(export_dir, "Generated", act_dir, route_dir)
    os.makedirs(output_dir, exist_ok=True)
    
    # Build sequentially numbered filename: 001_SceneName.txt
    display_name = node.get("name") or node.get("parameters", {}).get("title") or node_id
    safe_name = sanitize_filename(display_name)
    numbered_name = f"{scene_counter:03d}_{safe_name}.txt"
    output_path = os.path.join(output_dir, numbered_name)
    
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(scene_text)
    
    print(f"    -> Saved to: {os.path.relpath(output_path, export_dir)}")
    
    # Objective 2: Write-back to JSON
    if project_file and os.path.exists(project_file):
        try:
            with open(project_file, 'r', encoding='utf-8') as f:
                project_data = json.load(f)
            
            proj_node = project_data.get("nodes", {}).get(node_id)
            if proj_node:
                if "data" not in proj_node:
                    proj_node["data"] = {}
                proj_node["data"]["generated_text"] = scene_text
                
                with open(project_file, 'w', encoding='utf-8') as f:
                    json.dump(project_data, f, indent=2, ensure_ascii=False)
                print(f"    -> Injected generated_text into {project_file}")
                
                # Emit to React frontend
                b64_text = base64.b64encode(scene_text.encode('utf-8')).decode('utf-8')
                print(f"__PLOT_NODE_GENERATED__:{node_id}:{b64_text}", flush=True)
        except Exception as e:
            print(f"    -> [ERROR] Failed to update project file: {e}")
    
    new_bridge = await generate_bridge(scene_text)
    print(f"    -> Generated bridge: {new_bridge[:60]}...")
    return new_bridge, scene_counter + 1

def process_act_node(
    node_id: str,
    node: Dict[str, Any],
    context: ActiveContext
) -> str:
    """Process an Act node by storing its overrides in active context.
    
    Returns the sanitized act title for use as a directory name.
    """
    print(f"  [ACT] Processing: {node.get('name', node_id)}")
    
    params = node.get("parameters", {})
    overrides = params.get("overrides", [])
    
    for override in overrides:
        context.apply_override(override)
        print(f"    -> Applied override: {override.get('property')} for {override.get('targetId')}")
    
    # Return the act's title for directory naming
    act_title = params.get("title") or node.get("name") or node_id
    return act_title

async def dfs_execute(
    node_id: str,
    nodes: Dict[str, Dict[str, Any]],
    lore_db: Dict[str, str],
    bridge_summary: str,
    context: ActiveContext,
    export_dir: str,
    global_style_prompt: str,
    depth: int = 0,
    branch_name: str = "main",
    current_act: str = "Uncategorized_Act",
    current_route: str = "Main_Route",
    scene_counter: int = 1,
    project_file: str = "",
) -> Tuple[str, int, int]:
    """
    Execute DFS traversal through the narrative graph.
    Returns: (final_bridge_summary, scenes_generated_in_subtree, updated_scene_counter)
    """
    indent = "  " * depth
    
    if node_id in context.visited_nodes:
        print(f"{indent}[VISITED] Already processed {node_id}, skipping")
        return bridge_summary, 0, scene_counter
    
    node = nodes.get(node_id)
    if not node:
        print(f"{indent}[ERROR] Node {node_id} not found")
        return bridge_summary, 0, scene_counter
    
    context.visited_nodes.add(node_id)
    node_type = node.get("type")
    scenes_generated = 0
    
    print(f"{indent}[{branch_name}] Entering node {node_id} (type: {node_type})")
    print(f"__PLOT_NODE_ACTIVE__:{node_id}", flush=True)
    
    if node_type == "Act":
        # Process Act: store overrides in context, update current_act
        act_title = process_act_node(node_id, node, context)
        next_act = act_title
        
        # Continue to next node
        next_nodes = node.get("connectedTo", [])
        if next_nodes:
            next_id = next_nodes[0]  # Act nodes typically have one outgoing
            return await dfs_execute(
                next_id, nodes, lore_db, bridge_summary, context,
                export_dir, global_style_prompt, depth + 1, branch_name,
                current_act=next_act,
                current_route=current_route,
                scene_counter=scene_counter,
                project_file=project_file,
            )
        else:
            print(f"{indent}[ACT] No outgoing connections, ending this path")
            return bridge_summary, 0, scene_counter
    
    elif node_type == "Scene":
        # Process Scene: generate text with nested directory path
        bridge_summary, scene_counter = await process_scene_node(
            node_id, node, lore_db, bridge_summary, context,
            export_dir, global_style_prompt,
            current_act, current_route, scene_counter,
            project_file,
        )
        scenes_generated = 1
        
        # Continue to next node
        next_nodes = node.get("connectedTo", [])
        if next_nodes:
            next_id = next_nodes[0]
            next_bridge, next_scenes, scene_counter = await dfs_execute(
                next_id, nodes, lore_db, bridge_summary, context,
                export_dir, global_style_prompt, depth + 1, branch_name,
                current_act=current_act,
                current_route=current_route,
                scene_counter=scene_counter,
                project_file=project_file,
            )
            return next_bridge, scenes_generated + next_scenes, scene_counter
        else:
            print(f"{indent}[SCENE] No outgoing connections, ending this path")
            return bridge_summary, scenes_generated, scene_counter
    
    elif node_type == "BranchPoint":
        # Process BranchPoint: spawn parallel paths for each choice
        print(f"  [BRANCH] Processing: {node.get('name', node_id)}")
        params = node.get("parameters", {})
        choices = params.get("choices", [])
        
        if not choices:
            print(f"{indent}[BRANCH] No choices defined, ending this path")
            return bridge_summary, 0, scene_counter
        
        # Append branch context to bridge for next scene
        choice_context = "Игрок выбрал："
        all_results = []
        total_scenes = 0
        
        # Snapshot the visited nodes so each branch explores fully and merges properly
        snapshot_visited = set(context.visited_nodes)
        
        for choice_idx, choice in enumerate(choices):
            # Restore state for this branch
            context.visited_nodes = set(snapshot_visited)
            
            choice_text = choice.get("text", f"Choice {choice_idx + 1}")
            next_node_id = choice.get("nextNode", "")
            
            if not next_node_id:
                print(f"{indent}  [CHOICE] '{choice_text}' has no next node, skipping")
                continue
            
            # Create branch-specific context (decisions are accumulated)
            branch_label = f"{branch_name}_choice{choice_idx}"
            
            # Append this choice to the bridge
            choice_bridge = bridge_summary + f"\n{choice_context} {choice_text}"
            
            print(f"{indent}  [CHOICE] '{choice_text}' -> {next_node_id}")
            
            # Recursive DFS for this choice branch
            result_bridge, result_scenes, scene_counter = await dfs_execute(
                next_node_id,
                nodes,
                lore_db,
                choice_bridge,
                context,
                export_dir,
                global_style_prompt,
                depth + 1,
                branch_label,
                current_act=current_act,
                current_route=current_route,
                scene_counter=scene_counter,
                project_file=project_file,
            )
            
            all_results.append((choice_text, result_bridge, result_scenes))
            total_scenes += result_scenes
        
        # For now, return the last choice's bridge (in a real game, all branches might merge)
        if all_results:
            final_bridge = all_results[-1][1]
            print(f"{indent}[BRANCH] Completed with {total_scenes} scenes generated")
            return final_bridge, total_scenes, scene_counter
        else:
            return bridge_summary, 0, scene_counter
    
    elif node_type == "Route":
        # Route nodes: update current_route and pass through
        params = node.get("parameters", {})
        route_title = params.get("title") or node.get("name") or node_id
        next_route = route_title
        print(f"  [ROUTE] Entering route: {next_route}")
        
        next_nodes = node.get("connectedTo", [])
        if next_nodes:
            next_id = next_nodes[0]
            return await dfs_execute(
                next_id, nodes, lore_db, bridge_summary, context,
                export_dir, global_style_prompt, depth + 1, branch_name,
                current_act=current_act,
                current_route=next_route,
                scene_counter=scene_counter,
                project_file=project_file,
            )
        else:
            return bridge_summary, 0, scene_counter
    
    elif node_type == "Event":
        # Event nodes: pass through
        print(f"  [EVENT] Passing through: {node.get('name', node_id)}")
        next_nodes = node.get("connectedTo", [])
        if next_nodes:
            next_id = next_nodes[0]
            return await dfs_execute(
                next_id, nodes, lore_db, bridge_summary, context,
                export_dir, global_style_prompt, depth + 1, branch_name,
                current_act=current_act,
                current_route=current_route,
                scene_counter=scene_counter,
                project_file=project_file,
            )
        else:
            return bridge_summary, 0, scene_counter
    
    else:
        print(f"{indent}[UNKNOWN] Node type '{node_type}' not handled")
        return bridge_summary, 0, scene_counter


def export_lore(export_dir: str, lore_db: Dict[str, str], nodes: Dict[str, Dict[str, Any]]) -> None:
    """Export all lore data into a structured Lore/ subdirectory in the Generated output."""
    lore_export_dir = os.path.join(export_dir, "Generated", "Lore")
    os.makedirs(lore_export_dir, exist_ok=True)

    # ── Characters ──
    characters_dir = os.path.join(lore_export_dir, "Characters")
    os.makedirs(characters_dir, exist_ok=True)
    char_count = 0
    for entity_id, content in lore_db.items():
        # Heuristic: character IDs typically start with "char_" or match
        # node-adjacent naming. Export all lore entries that aren't obviously
        # locations or tags as character files, and separately handle those.
        # Since lore_db is a flat id->text map, we just export everything.
        safe_id = sanitize_filename(entity_id)
        filepath = os.path.join(characters_dir, f"{safe_id}.md")
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(f"# {entity_id}\n\n{content}\n")
        char_count += 1

    # ── Node summary index ──
    index_entries: List[str] = []
    for node_id, node in sorted(nodes.items(), key=lambda x: x[0]):
        node_type = node.get("type", "Unknown")
        name = node.get("name") or node.get("parameters", {}).get("title", node_id)
        index_entries.append(f"- **{node_type}** `{node_id}`: {name}")

    index_path = os.path.join(lore_export_dir, "node_index.md")
    with open(index_path, 'w', encoding='utf-8') as f:
        f.write("# Node Index\n\n")
        f.write(f"Total nodes: {len(nodes)}\n\n")
        f.write("\n".join(index_entries) + "\n")

    # ── Summary JSON ──
    summary = {
        "lore_entries": len(lore_db),
        "total_nodes": len(nodes),
        "entity_ids": sorted(lore_db.keys()),
    }
    summary_path = os.path.join(lore_export_dir, "lore_summary.json")
    with open(summary_path, 'w', encoding='utf-8') as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)

    print(f"  [LORE EXPORT] Exported {char_count} lore entries + node index to Generated/Lore/")


async def run_dfs(export_dir: str, project_file: str = ""):
    
    if not os.path.exists(export_dir):
        print("Directory not found!")
        return
    
    print("\n[LOADING] Scanning project...")
    nodes = load_project_nodes(export_dir)
    lore_db = load_lore(export_dir)
    global_style_prompt = load_project_settings(export_dir)
    
    print(f"  Loaded {len(nodes)} nodes")
    print(f"  Loaded {len(lore_db)} lore entries")
    
    # ── Objective 4: Export Lore before generation ──
    export_lore(export_dir, lore_db, nodes)
    
    # Find starting node
    start_node_id = find_start_node(nodes)
    if not start_node_id:
        print("[ERROR] No starting node found (isStart == True)")
        return
    
    print(f"\n[START] Execution beginning at: {start_node_id}")
    
    # Initialize context and execute DFS
    context = ActiveContext()
    progress_file = os.path.join(export_dir, "progress_state.json")
    initial_bridge = ""
    
    if os.path.exists(progress_file):
        try:
            with open(progress_file, 'r', encoding='utf-8') as f:
                ps = json.load(f)
                initial_bridge = ps.get("context_bridge", "")
        except Exception as e:
            print(f"[WARN] Could not read progress state: {e}")
    
    # Execute DFS from start node with narrative state tracking
    final_bridge, total_scenes, _ = await dfs_execute(
        start_node_id,
        nodes,
        lore_db,
        initial_bridge,
        context,
        export_dir,
        global_style_prompt,
        depth=0,
        branch_name="main",
        current_act="Uncategorized_Act",
        current_route="Main_Route",
        scene_counter=1,
        project_file=project_file,
    )
    
    # Update progress state
    try:
        with open(progress_file, 'w', encoding='utf-8') as f:
            json.dump(
                {
                    "start_node": start_node_id,
                    "context_bridge": final_bridge,
                    "scenes_generated": total_scenes,
                    "status": "completed"
                },
                f,
                indent=2,
                ensure_ascii=False
            )
    except Exception as e:
        print(f"[WARN] Could not write progress state: {e}")
    
    print(f"\n[COMPLETE] Pipeline finished.")
    print(f"  Total scenes generated: {total_scenes}")
    print(f"  Final context: {final_bridge[:80]}...")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python generator.py <export_dir> [project_file]")
        sys.exit(1)
    export_dir_arg = sys.argv[1]
    project_file_arg = sys.argv[2] if len(sys.argv) > 2 else ""
    asyncio.run(run_dfs(export_dir_arg, project_file_arg))
