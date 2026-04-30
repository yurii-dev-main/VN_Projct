import argparse
import json
import os
import re
import sys
import traceback
from pathlib import Path
from uuid import uuid4
from typing import Any, Dict, List

from dotenv import load_dotenv
from google import genai
from tenacity import retry, stop_after_attempt, wait_exponential
import requests


sys.stdout.reconfigure(encoding="utf-8")

load_dotenv()

client = genai.Client()

# LLM provider selection. Default to cloud (Gemini/OpenAI).
LLM_PROVIDER = "gemini"
LOCAL_MODEL_NAME = "qwen2.5:0.5b"

def generate_text(provider: str, model: str, contents: str) -> str:
    """Generate text using the configured provider.

    For 'gemini' we use the genai client. For 'ollama' we POST to a local OpenAI-compatible endpoint.
    """
    if provider in ("gemini", "openai"):
        response = client.models.generate_content(model=model, contents=contents)
        raw_text = getattr(response, "text", None) or ""
        return raw_text

    if provider == "ollama":
        # Try the local Ollama OpenAI-compatible chat completions endpoint.
        url = "http://localhost:11434/v1/chat/completions"
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": contents}],
        }
        headers = {"Content-Type": "application/json"}
        resp = requests.post(url, json=payload, headers=headers, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        # Try common response shapes
        choices = data.get("choices") if isinstance(data, dict) else None
        if choices and len(choices) > 0:
            first = choices[0]
            # chat-style
            if isinstance(first.get("message"), dict) and isinstance(first["message"].get("content"), str):
                return first["message"]["content"]
            # text-style
            if isinstance(first.get("text"), str):
                return first.get("text")
        # Fallback: try top-level 'text'
        if isinstance(data.get("text"), str):
            return data.get("text")
        return ""


def parse_context_data(context_json: str) -> Dict[str, Any]:
    if not context_json.strip():
        return {}

    try:
        parsed = json.loads(context_json)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def format_user_lore_context(selected_lore_context: Any) -> str:
    if not isinstance(selected_lore_context, list) or not selected_lore_context:
        return ""

    lines = ["[USER PROVIDED LORE CONTEXT]:"]

    for item in selected_lore_context:
        if not isinstance(item, dict):
            continue

        kind = str(item.get("kind", "Lore")).strip() or "Lore"
        name = str(item.get("label") or item.get("name") or item.get("id") or "").strip()
        entity_id = str(item.get("id", "")).strip()
        description = str(item.get("description", "")).strip()

        if not entity_id or not name:
            continue

        if description:
            if kind == "Character":
                lines.append(f"- Character: {name} (ID: {entity_id}) - Bio: {description}")
            else:
                lines.append(f"- {kind}: {name} (ID: {entity_id}) - Description: {description}")
        else:
            lines.append(f"- {kind}: {name} (ID: {entity_id})")

    return "\n".join(lines) if len(lines) > 1 else ""


def build_lore_rules_block() -> str:
    return (
        "LORE RULES:\n"
        "1. DO NOT hardcode character bios, location descriptions, or tag details directly into Scene, Act, or BranchPoint nodes.\n"
        "2. Before creating or referencing an entity, review the [USER PROVIDED LORE CONTEXT] if present.\n"
        "3. If the entity is not in the provided context, you MUST use the get_lore_directory tool to search for existing Lore entities.\n"
        "4. When populating nodes, ONLY use the specific id of the Character, Location, or Tag from the Lore directory.\n"
        "5. If you need to use a character/location/tag that does NOT exist in the lore directory, you MUST first call propose_lore_entity to create it. Use the ID returned by that tool when creating graph nodes in the same plan.\n"
        "6. ALL lore entity names and IDs MUST be in English. If the user prompts in another language, transliterate or translate the name to English for the `name` and `id` fields. Descriptions may be in any language.\n"
        "7. When using update_node, DO NOT modify actingCharacters or locationId unless the user EXPLICITLY asks to add or remove a specific entity. If you must provide them, use ONLY exact IDs from get_lore_directory. NEVER invent, guess, or hallucinate character/location IDs.\n"
        "\n"
        "NODE ARCHITECTURE RULES:\n"
        "8. SCENE nodes contain ONLY a single narrative text block (narrativeAction, tone, goal, constraints). They do NOT have choices, dialogue variants, or branching. A Scene always flows to exactly one next node.\n"
        "9. If you need to present a player choice, you MUST create a BRANCHPOINT node. Only BranchPoint nodes have the `choices` field.\n"
        "10. Do NOT use the `dialogue_text` field. Write all narrative content in the `narrative_action` field instead."
    )


def resolve_project_plot_path(context: Dict[str, Any]) -> Path | None:
    candidates: List[Path] = []

    project_path = context.get("projectPath")
    if isinstance(project_path, str) and project_path.strip():
        project_path_value = Path(project_path.strip())
        candidates.append(project_path_value)

    script_dir = Path(__file__).resolve().parent
    candidates.extend([
        (script_dir / ".." / "src-tauri" / "project.plot.json").resolve(),
        (script_dir / ".." / "project.plot.json").resolve(),
        (script_dir / "project.plot.json").resolve(),
    ])

    if isinstance(project_path, str) and project_path.strip() and not Path(project_path.strip()).is_absolute():
        candidates.append((script_dir / ".." / project_path.strip()).resolve())

    for candidate in candidates:
        try:
            resolved = candidate.resolve()
        except Exception:
            resolved = candidate

        if resolved.exists():
            return resolved

    return None


def build_lore_directory(project_data: Dict[str, Any], entity_type: str | None = None) -> List[Dict[str, str]]:
    lore = project_data.get("lore") if isinstance(project_data.get("lore"), dict) else {}
    characters = project_data.get("characters") if isinstance(project_data.get("characters"), list) else []
    locations = project_data.get("locations") if isinstance(project_data.get("locations"), list) else []
    tags = project_data.get("layerPresets") if isinstance(project_data.get("layerPresets"), list) else []

    normalized_filter = (entity_type or "all").strip().lower()
    entries: List[Dict[str, str]] = []

    if normalized_filter in ("all", "character"):
        for character in characters:
            if not isinstance(character, dict):
                continue
            entity_id = str(character.get("id", "")).strip()
            if not entity_id:
                continue
            entries.append({
                "type": "Character",
                "id": entity_id,
                "name": str(character.get("name") or character.get("displayName") or entity_id),
                "description": str(lore.get(entity_id, "") or "").strip(),
            })

    if normalized_filter in ("all", "location"):
        for location in locations:
            if not isinstance(location, dict):
                continue
            entity_id = str(location.get("id", "")).strip()
            if not entity_id:
                continue
            entries.append({
                "type": "Location",
                "id": entity_id,
                "name": str(location.get("title") or entity_id),
                "description": str(lore.get(entity_id, location.get("preview", "")) or "").strip(),
            })

    if normalized_filter in ("all", "tag"):
        for tag in tags:
            tag_id = str(tag).strip()
            if not tag_id:
                continue
            entries.append({
                "type": "Tag",
                "id": tag_id,
                "name": tag_id,
                "description": str(lore.get(tag_id, "") or "").strip(),
            })

    return entries


def get_lore_directory(entity_type: str | None = None, context: Dict[str, Any] | None = None) -> str:
    project_context = context or {}
    project_file = resolve_project_plot_path(project_context)

    if not project_file:
        return "The lore directory is currently empty."

    try:
        with project_file.open("r", encoding="utf-8") as handle:
            project_data = json.load(handle)
    except Exception as error:
        return f"The lore directory is currently empty. ({error})"

    entries = build_lore_directory(project_data if isinstance(project_data, dict) else {}, entity_type)
    if not entries:
        return "The lore directory is currently empty."

    return json.dumps(entries, ensure_ascii=False, indent=2)


def get_model_name() -> str:
    return LOCAL_MODEL_NAME if LLM_PROVIDER == "ollama" else "gemini-2.5-flash"


def create_lore_entity_id(entity_type: str) -> str:
    prefix_map = {
        "character": "char_new",
        "location": "loc_new",
        "tag": "tag_new",
    }
    prefix = prefix_map.get(entity_type.lower(), "lore_new")
    return f"{prefix}_{uuid4().hex[:8]}"

TOOL_SCHEMAS: List[Dict[str, Any]] = [
    {
        "name": "create_node",
        "description": "Create a new graph node for the current agent task.",
        "parameters": {
            "type": "object",
            "properties": {
                "node_type": {"type": "string", "enum": ["Act", "Scene", "BranchPoint"]},
                "title": {"type": "string"},
                "description": {"type": "string"},
                "x": {"type": "number"},
                "y": {"type": "number"},
            },
            "required": ["node_type", "title", "description", "x", "y"],
            "additionalProperties": False,
        },
    },
    {
        "name": "connect_nodes",
        "description": "Connect two existing graph nodes.",
        "parameters": {
            "type": "object",
            "properties": {
                "source_node_id": {"type": "string"},
                "target_node_id": {"type": "string"},
            },
            "required": ["source_node_id", "target_node_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "update_node",
        "description": "Update an existing node with narrative content. For Scene nodes: set narrative_action, tone, goal, constraints. For BranchPoint nodes: set choices. Do NOT set actingCharacters or locationId unless the user explicitly requested it.",
        "parameters": {
            "type": "object",
            "properties": {
                "node_id": {"type": "string", "description": "The ID of the node to update."},
                "narrative_action": {"type": "string", "description": "The main narrative text for Scene nodes. Write all scene content here."},
                "tone": {"type": "string", "description": "Tone and mood for Scene nodes."},
                "goal": {"type": "string", "description": "What the scene should accomplish."},
                "constraints": {"type": "string", "description": "Hard constraints for the scene."},
                "actingCharacters": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "ONLY provide if the user explicitly asked to set characters. Use exact lore IDs.",
                },
                "locationId": {
                    "type": "string",
                    "description": "ONLY provide if the user explicitly asked to set a location. Use exact lore ID.",
                },
                "choices": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {"id": {"type": "string"}, "text": {"type": "string"}},
                        "required": ["id", "text"],
                    },
                    "description": "ONLY for BranchPoint nodes. Scene nodes MUST NOT have choices.",
                },
            },
            "required": ["node_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_lore_directory",
        "description": "Read the project's lore directory and return available characters, locations, and tags.",
        "parameters": {
            "type": "object",
            "properties": {
                "entity_type": {
                    "type": "string",
                    "enum": ["all", "character", "location", "tag"],
                },
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "propose_lore_entity",
        "description": "Propose a new lore entity for approval. CRITICAL: The `name` field MUST be in English. If the user's prompt is in another language, transliterate or translate the name to English. Descriptions may remain in the user's language.",
        "parameters": {
            "type": "object",
            "properties": {
                "entity_type": {
                    "type": "string",
                    "enum": ["character", "location", "tag"],
                },
                "name": {"type": "string", "description": "Entity name in English only."},
                "description": {"type": "string", "description": "Description of the entity. May be in any language."},
            },
            "required": ["entity_type", "name", "description"],
            "additionalProperties": False,
        },
    },
]


def emit(payload: Dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def normalize_context(context_json: str) -> str:
    if not context_json.strip():
        return "{}"

    try:
        parsed = json.loads(context_json)
        return json.dumps(parsed, ensure_ascii=False, indent=2)
    except Exception:
        return context_json.strip()


def extract_json_payload(text: str) -> Dict[str, Any]:
    candidates = [text.strip()]

    if text.startswith("```"):
        stripped = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.IGNORECASE | re.DOTALL)
        candidates.append(stripped.strip())

    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match:
        candidates.append(match.group(0).strip())

    last_error: Exception | None = None
    for candidate in candidates:
        try:
            loaded = json.loads(candidate)
            if isinstance(loaded, dict):
                return loaded
            raise ValueError("Planner response must be a JSON object.")
        except Exception as error:
            last_error = error

    raise ValueError(f"Failed to parse planner output as JSON: {last_error}")


def validate_plan(plan: Dict[str, Any]) -> Dict[str, Any]:
    tasks = plan.get("tasks")
    if not isinstance(tasks, list):
        raise ValueError("Planner output must contain a 'tasks' array.")

    normalized_tasks: List[Dict[str, Any]] = []
    for index, task in enumerate(tasks, start=1):
        if not isinstance(task, dict):
            continue

        normalized_tasks.append(
            {
                "id": int(task.get("id", index)),
                "desc": str(task.get("desc", "")),
                "status": str(task.get("status", "pending")),
            }
        )

    if not normalized_tasks:
        raise ValueError("Planner output did not contain any usable tasks.")

    return {"tasks": normalized_tasks}


def build_prompt(user_prompt: str, context_json: str) -> str:
    context_data = parse_context_data(context_json)
    user_lore_context = format_user_lore_context(context_data.get("selectedLoreContext"))
    lore_rules = build_lore_rules_block()

    parts = [
        "You are the Planner layer for Plot Architect Phase 4.",
        "Break the user's request into a short, ordered TODO list for execution by an IDE agent.",
        "Focus on editor operations only; do not modify the graph yourself.",
        "Return STRICT JSON only with the exact shape: {\"tasks\": [{\"id\": 1, \"desc\": \"...\", \"status\": \"pending\"}]}.",
        "No markdown, no code fences, no commentary.",
        "Keep task descriptions concise, actionable, and sequential.",
        "When creating a story branch, first use create_node, then use connect_nodes, and finally use update_node to fill the newly created nodes with rich narrative text, tone, and character dialogue based on the user's prompt.",
        "IMPORTANT: Scene nodes hold ONLY a single narrative block — no choices, no dialogue variants. If the story requires a player choice, plan a BranchPoint node instead.",
        "IMPORTANT: All lore entity names and IDs must be in English. Transliterate if the user prompts in another language.",
        lore_rules,
    ]

    if user_lore_context:
        parts.append(user_lore_context)

    parts.extend([
        f"USER PROMPT:\n{user_prompt}",
        f"CONTEXT JSON:\n{context_json}",
    ])

    return "\n\n".join(parts)


def fallback_plan(user_prompt: str, context_json: str) -> Dict[str, Any]:
    context_size = len(context_json)
    return {
        "tasks": [
            {"id": 1, "desc": "Analyze the request and identify the intended editor outcome.", "status": "pending"},
            {"id": 2, "desc": f"Inspect the provided context and narrow relevant nodes (context size: {context_size} chars).", "status": "pending"},
            {"id": 3, "desc": "Prepare an execution plan for safe graph edits without applying changes yet.", "status": "pending"},
        ]
    }


def create_node_id(node_type: str, hint: str = "") -> str:
    suffix = uuid4().hex[:6]
    slug = re.sub(r"[^a-z0-9]+", "_", hint.lower()).strip("_")
    prefix = f"node_{node_type.lower()}"
    if slug:
        return f"{prefix}_{slug}_{suffix}"
    return f"{prefix}_{suffix}"


def emit_task_update(task_id: int, status: str) -> None:
    emit({"type": "agent:task_update", "task_id": task_id, "status": status})


def emit_node_mutation(node_type: str, title: str, description: str, x: float, y: float) -> str:
    node_id = create_node_id(node_type, title)
    emit(
        {
            "type": "agent:mutation",
            "action": "add_node",
            "node": {
                "id": node_id,
                "type": node_type,
                "position": {"x": x, "y": y},
                "data": {
                    "title": title,
                    "description": description,
                },
            },
        }
    )
    return node_id


def emit_edge_mutation(source_node_id: str, target_node_id: str) -> str:
    edge_id = f"{source_node_id}->{target_node_id}"
    emit(
        {
            "type": "agent:mutation",
            "action": "add_edge",
            "edge": {
                "id": edge_id,
                "source": source_node_id,
                "target": target_node_id,
            },
        }
    )
    return edge_id


def build_executor_prompt(
    user_prompt: str,
    context_json: str,
    tasks: List[Dict[str, Any]],
    current_task: Dict[str, Any],
    execution_state: Dict[str, Any],
) -> str:
    context_data = parse_context_data(context_json)
    user_lore_context = format_user_lore_context(context_data.get("selectedLoreContext"))
    lore_rules = build_lore_rules_block()
    lore_directory_block = ""
    if isinstance(execution_state.get("lore_directory"), str) and execution_state.get("lore_directory"):
        lore_directory_block = f"[LORE DIRECTORY RESULT]:\n{execution_state.get('lore_directory')}\n\n"

    parts = [
        "You are the Executor layer for Plot Architect. Execute exactly ONE tool call for the current TODO item if needed.",
        "You are provided with a `lore` dictionary containing characters and locations (ids -> content). When using the `update_node` tool, for `actingCharacters` and `locationId`, you MUST use the exact string id from the provided lore, NEVER the character's or location's name. If a requested character or location is not present in the lore, do not include it.",
        "When creating a story branch, first use create_node, then use connect_nodes, and finally use update_node to fill the newly created nodes with rich narrative text, tone, and character dialogue.",
        "Do not modify files. Emit STRICT JSON only. Available tools are create_node, connect_nodes, update_node, get_lore_directory and propose_lore_entity.",
        "",
        "CRITICAL NODE ARCHITECTURE RULES:",
        "- SCENE nodes contain ONLY a single narrative block. Use `narrative_action` for all Scene text. Scenes do NOT have choices, dialogue variants, or multiple outputs. NEVER put `choices` or `dialogue_text` on a Scene node.",
        "- BRANCHPOINT nodes are the ONLY nodes that can have `choices`. If the story needs a player decision, create a BranchPoint.",
        "- When using update_node, do NOT set `actingCharacters` or `locationId` unless the user EXPLICITLY asked to change them. Omitting these fields preserves the existing data.",
        "- All lore entity names MUST be in English. Transliterate if needed.",
        "",
        "Return one of these shapes exactly:",
        '{"type":"tool_call","name":"create_node","arguments":{...}}',
        '{"type":"tool_call","name":"connect_nodes","arguments":{...}}',
        '{"type":"tool_call","name":"update_node","arguments":{...}}',
        '{"type":"tool_call","name":"get_lore_directory","arguments":{"entity_type":"all"}}',
        '{"type":"tool_call","name":"propose_lore_entity","arguments":{"entity_type":"character","name":"...","description":"..."}}',
        '{"type":"task_complete","message":"..."}',
        "Never include markdown or extra commentary.",
        lore_rules,
    ]

    if user_lore_context:
        parts.append(user_lore_context)

    created_lore_entities = execution_state.get("created_lore_entities")
    if isinstance(created_lore_entities, list) and created_lore_entities:
        parts.append(f"[PROPOSED LORE ENTITIES]:\n{json.dumps(created_lore_entities, ensure_ascii=False, indent=2)}")

    if lore_directory_block:
        parts.append(lore_directory_block.rstrip())

    parts.extend([
        f"USER PROMPT:\n{user_prompt}",
        f"TODO LIST:\n{json.dumps(tasks, ensure_ascii=False, indent=2)}",
        f"CURRENT TASK:\n{json.dumps(current_task, ensure_ascii=False, indent=2)}",
        f"EXECUTION STATE:\n{json.dumps(execution_state, ensure_ascii=False, indent=2)}",
        f"CONTEXT JSON:\n{context_json}",
        f"TOOL SCHEMAS:\n{json.dumps(TOOL_SCHEMAS, ensure_ascii=False, indent=2)}",
    ])

    return "\n\n".join(parts)


def parse_executor_response(text: str) -> Dict[str, Any]:
    payload = extract_json_payload(text)
    if not isinstance(payload, dict):
        raise ValueError("Executor response must be a JSON object.")

    response_type = str(payload.get("type", "")).strip()
    if response_type == "tool_call":
        name = str(payload.get("name", "")).strip()
        arguments = payload.get("arguments", {})
        if not isinstance(arguments, dict):
            raise ValueError("Tool call arguments must be an object.")
        if name not in {"create_node", "connect_nodes", "update_node", "get_lore_directory", "propose_lore_entity"}:
            raise ValueError(f"Unsupported tool call: {name}")
        return {"type": "tool_call", "name": name, "arguments": arguments}

    if response_type == "task_complete":
        return {"type": "task_complete", "message": str(payload.get("message", ""))}

    raise ValueError("Executor response must declare type tool_call or task_complete.")


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=6))
def request_tool_action(
    user_prompt: str,
    context_json: str,
    tasks: List[Dict[str, Any]],
    current_task: Dict[str, Any],
    execution_state: Dict[str, Any],
) -> Dict[str, Any]:
    try:
        prompt = build_executor_prompt(user_prompt, context_json, tasks, current_task, execution_state)
        model = get_model_name()
        raw_text = generate_text(LLM_PROVIDER, model, prompt)
        return parse_executor_response(raw_text)
    except Exception as e:
        # Print full traceback to stderr so Rust backend captures it
        tb = traceback.format_exc()
        print(tb, file=sys.stderr)
        # Emit error status with traceback
        emit({
            "type": "agent:status",
            "status": "error",
            "message": tb,
        })
        # Exit with error code so Rust sees the failure
        sys.exit(1)


def execute_plan(user_prompt: str, context_json: str, tasks: List[Dict[str, Any]]) -> None:
    execution_state: Dict[str, Any] = {
        "created_nodes": {},
        "last_action": None,
        "selected_context": parse_context_data(context_json),
        "created_lore_entities": [],
    }

    emit({"type": "agent:status", "status": "executing", "message": "Starting executor loop..."})

    for task in tasks:
        task_id = int(task.get("id", 0))
        task_desc = str(task.get("desc", "")).strip()
        emit({"type": "agent:status", "status": "executing", "message": f"Executing task {task_id}: {task_desc}"})
        task_warnings: List[str] = []

        try:
            action = request_tool_action(user_prompt, context_json, tasks, task, execution_state)

            if action["type"] == "task_complete":
                emit_task_update(task_id, "completed")
                execution_state["last_action"] = {"task_id": task_id, "type": "task_complete"}
                continue

            tool_name = action["name"]
            arguments = action["arguments"]

            if tool_name == "create_node":
                node_type = str(arguments.get("node_type", "Scene"))
                title = str(arguments.get("title", "Untitled Node"))
                description = str(arguments.get("description", ""))
                x = float(arguments.get("x", 100))
                y = float(arguments.get("y", 100))
                node_id = emit_node_mutation(node_type, title, description, x, y)
                execution_state.setdefault("created_nodes", {})[node_id] = {
                    "id": node_id,
                    "node_type": node_type,
                    "title": title,
                    "description": description,
                    "x": x,
                    "y": y,
                }
                execution_state["last_action"] = {"task_id": task_id, "tool": "create_node", "node_id": node_id}
                emit_task_update(task_id, "completed")
                continue

            if tool_name == "connect_nodes":
                source_node_id = str(arguments.get("source_node_id", "")).strip()
                target_node_id = str(arguments.get("target_node_id", "")).strip()
                if not source_node_id or not target_node_id:
                    raise ValueError("connect_nodes requires source_node_id and target_node_id.")
                emit_edge_mutation(source_node_id, target_node_id)
                execution_state["last_action"] = {
                    "task_id": task_id,
                    "tool": "connect_nodes",
                    "source_node_id": source_node_id,
                    "target_node_id": target_node_id,
                }
                emit_task_update(task_id, "completed")
                continue

            if tool_name == "get_lore_directory":
                entity_type = str(arguments.get("entity_type", "all") or "all").strip().lower()
                lore_directory = get_lore_directory(entity_type, execution_state.get("selected_context"))
                execution_state["lore_directory"] = lore_directory
                execution_state["last_action"] = {
                    "task_id": task_id,
                    "tool": "get_lore_directory",
                    "entity_type": entity_type,
                }
                emit({"type": "agent:status", "status": "executing", "message": lore_directory})
                emit_task_update(task_id, "completed")
                continue

            if tool_name == "propose_lore_entity":
                entity_type = str(arguments.get("entity_type", "")).strip().lower()
                name = str(arguments.get("name", "")).strip()
                description = str(arguments.get("description", "")).strip()

                if entity_type not in {"character", "location", "tag"}:
                    raise ValueError("propose_lore_entity requires entity_type to be character, location, or tag.")
                if not name:
                    raise ValueError("propose_lore_entity requires a name.")

                lore_id = create_lore_entity_id(entity_type)
                lore_payload = {
                    "id": lore_id,
                    "entityType": entity_type,
                    "payload": {
                        "id": lore_id,
                        "name": name,
                        "description": description,
                    },
                }

                emit({
                    "type": "agent:mutation",
                    "action": "ADD_LORE",
                    **lore_payload,
                })

                execution_state.setdefault("created_lore_entities", []).append(lore_payload)
                execution_state["last_action"] = {
                    "task_id": task_id,
                    "tool": "propose_lore_entity",
                    "lore_id": lore_id,
                    "entity_type": entity_type,
                    "name": name,
                }
                emit({"type": "agent:status", "status": "executing", "message": f"Proposed {entity_type} lore entity {name} ({lore_id})"})
                emit_task_update(task_id, "completed")
                continue

            if tool_name == "update_node":
                node_id = str(arguments.get("node_id", "")).strip()
                if not node_id:
                    raise ValueError("update_node requires node_id.")

                data: Dict[str, Any] = {}
                # Map allowed optional fields into camelCase keys expected by the frontend
                if "narrative_action" in arguments and arguments.get("narrative_action") is not None:
                    data["narrativeAction"] = str(arguments.get("narrative_action"))
                if "tone" in arguments and arguments.get("tone") is not None:
                    # frontend stores tone in `toneAndMood` for Scene nodes
                    data["toneAndMood"] = str(arguments.get("tone"))
                if "goal" in arguments and arguments.get("goal") is not None:
                    data["goal"] = str(arguments.get("goal"))
                if "constraints" in arguments and arguments.get("constraints") is not None:
                    data["constraints"] = str(arguments.get("constraints"))
                # dialogue_text is deprecated — ignore it silently
                if "choices" in arguments and isinstance(arguments.get("choices"), list):
                    # choices are ONLY valid for BranchPoint nodes;
                    # the frontend's applyAgentUpdateMutation already enforces this
                    data["choices"] = arguments.get("choices")
                # Accept actingCharacters and locationId if provided — resolve names to lore IDs when possible
                context = execution_state.get("selected_context") if isinstance(execution_state.get("selected_context"), dict) else {}

                def resolve_character(candidate: str) -> str | None:
                    if not candidate:
                        return None
                    cand = str(candidate).strip()
                    if not cand:
                        return None
                    # Direct id match
                    chars = context.get("characters") or []
                    for c in chars:
                        try:
                            if isinstance(c, dict) and str(c.get("id", "")).lower() == cand.lower():
                                return str(c.get("id"))
                        except Exception:
                            continue
                    # Check lore mapping (id -> text) for a mention or title match
                    lore = context.get("lore") or {}
                    for lid, text in (lore.items() if isinstance(lore, dict) else []):
                        try:
                            if isinstance(text, str) and cand.lower() in text.lower():
                                return str(lid)
                        except Exception:
                            continue
                    # fallback: if candidate looks like an id in lore keys
                    for lid in (lore.keys() if isinstance(lore, dict) else []):
                        try:
                            if str(lid).lower() == cand.lower():
                                return str(lid)
                        except Exception:
                            continue
                    return None

                def resolve_location(candidate: str) -> str | None:
                    if not candidate:
                        return None
                    cand = str(candidate).strip()
                    if not cand:
                        return None
                    locs = context.get("locations") or []
                    for l in locs:
                        try:
                            # if locations have title field, match by title or id
                            if isinstance(l, dict):
                                if str(l.get("id", "")).lower() == cand.lower():
                                    return str(l.get("id"))
                                title = str(l.get("title", ""))
                                if title and cand.lower() in title.lower():
                                    return str(l.get("id"))
                        except Exception:
                            continue
                    # fallback to lore search
                    lore = context.get("lore") or {}
                    for lid, text in (lore.items() if isinstance(lore, dict) else []):
                        try:
                            if isinstance(text, str) and cand.lower() in text.lower():
                                return str(lid)
                        except Exception:
                            continue
                    return None

                if "actingCharacters" in arguments and isinstance(arguments.get("actingCharacters"), list):
                    resolved = []
                    for entry in arguments.get("actingCharacters"):
                        try:
                            candidate = str(entry)
                        except Exception:
                            continue
                        rid = resolve_character(candidate)
                        if rid:
                            resolved.append(rid)
                        else:
                            warning = f"Warning: Could not find character '{candidate}' in lore, skipped."
                            task_warnings.append(warning)
                            emit({"type": "agent:status", "status": "executing", "message": warning})
                    if resolved:
                        data["actingCharacters"] = resolved

                if "locationId" in arguments and arguments.get("locationId") is not None:
                    loc_cand = str(arguments.get("locationId"))
                    rid = resolve_location(loc_cand)
                    if rid:
                        data["locationId"] = rid
                    else:
                        warning = f"Warning: Could not find location '{loc_cand}' in lore, skipped."
                        task_warnings.append(warning)
                        emit({"type": "agent:status", "status": "executing", "message": warning})

                # Only emit fields that were provided
                mutation_payload: Dict[str, Any] = {
                    "type": "agent:mutation",
                    "action": "update_node",
                    "node_id": node_id,
                    "data": data,
                }
                if task_warnings:
                    mutation_payload["warnings"] = task_warnings
                emit(mutation_payload)

                execution_state["last_action"] = {
                    "task_id": task_id,
                    "tool": "update_node",
                    "node_id": node_id,
                    "data": data,
                    "warnings": task_warnings,
                }
                emit_task_update(task_id, "completed")
                continue
        except Exception as e:
            tb = traceback.format_exc()
            print(tb, file=sys.stderr)
            emit({"type": "agent:status", "status": "error", "message": tb})
            emit_task_update(task_id, "error")
            sys.exit(1)

    emit({"type": "agent:status", "status": "completed", "message": "Done!"})


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=6))
def request_plan(user_prompt: str, context_json: str) -> Dict[str, Any]:
    try:
        prompt = build_prompt(user_prompt, context_json)
        model = get_model_name()
        raw_text = generate_text(LLM_PROVIDER, model, prompt)
        return validate_plan(extract_json_payload(raw_text))
    except Exception as e:
        # Print full traceback to stderr so Rust backend captures it
        tb = traceback.format_exc()
        print(tb, file=sys.stderr)
        # Emit error status with traceback
        emit({
            "type": "agent:status",
            "status": "error",
            "message": tb,
        })
        # Exit with error code so Rust sees the failure
        sys.exit(1)


def main() -> int:
    parser = argparse.ArgumentParser(description="Plot Architect Phase 4 agent planner")
    parser.add_argument("--prompt", required=True, help="User request to plan for")
    parser.add_argument("--context-json", required=True, help="JSON string describing selected nodes and context")
    args = parser.parse_args()

    context_json = normalize_context(args.context_json)

    # Allow the frontend to request a specific LLM provider via context JSON
    try:
        parsed_ctx = json.loads(context_json) if context_json.strip().startswith("{") else {}
        provider = parsed_ctx.get("llmProvider") if isinstance(parsed_ctx, dict) else None
        if provider in ("ollama", "gemini", "openai"):
            global LLM_PROVIDER
            LLM_PROVIDER = provider
        local_model = parsed_ctx.get("localModelName", "qwen2.5:0.5b") if isinstance(parsed_ctx, dict) else "qwen2.5:0.5b"
        if isinstance(local_model, str) and local_model.strip():
            global LOCAL_MODEL_NAME
            LOCAL_MODEL_NAME = local_model.strip()
    except Exception:
        # ignore parsing errors — default provider will be used
        pass

    emit(
        {
            "type": "agent:status",
            "status": "planning",
            "message": "Analyzing request...",
        }
    )

    # request_plan now handles its own errors and exits on failure
    plan = request_plan(args.prompt, context_json)

    emit({"type": "agent:todo", "tasks": plan["tasks"]})
    execute_plan(args.prompt, context_json, plan["tasks"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())