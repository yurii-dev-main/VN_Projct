import argparse
import json
import os
import re
import sys
from uuid import uuid4
from typing import Any, Dict, List

from dotenv import load_dotenv
from google import genai
from tenacity import retry, stop_after_attempt, wait_exponential


sys.stdout.reconfigure(encoding="utf-8")

load_dotenv()

client = genai.Client()

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
        "description": "Fill or update an existing node with narrative content, dialogue, or choices.",
        "parameters": {
            "type": "object",
            "properties": {
                "node_id": {"type": "string"},
                "narrative_action": {"type": "string"},
                "tone": {"type": "string"},
                "goal": {"type": "string"},
                "constraints": {"type": "string"},
                "dialogue_text": {"type": "string"},
                "actingCharacters": {
                    "type": "array",
                    "items": {"type": "string"},
                },
                "locationId": {"type": "string"},
                "choices": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {"id": {"type": "string"}, "text": {"type": "string"}},
                        "required": ["id", "text"],
                    },
                },
            },
            "required": ["node_id"],
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
    return (
        "You are the Planner layer for Plot Architect Phase 4. "
        "Break the user's request into a short, ordered TODO list for execution by an IDE agent. "
        "Focus on editor operations only; do not modify the graph yourself. "
        "Return STRICT JSON only with the exact shape: "
        '{"tasks": [{"id": 1, "desc": "...", "status": "pending"}]}. '
        "No markdown, no code fences, no commentary. "
        "Keep task descriptions concise, actionable, and sequential.\n\n"
        "When creating a story branch, first use create_node, then use connect_nodes, and finally use update_node to fill the newly created nodes with rich narrative text, tone, and character dialogue based on the user's prompt.\n\n"
        f"USER PROMPT:\n{user_prompt}\n\n"
        f"CONTEXT JSON:\n{context_json}\n"
    )


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
    return (
        "You are the Executor layer for Plot Architect. Execute exactly ONE tool call for the current TODO item if needed. "
        "You are provided with a `lore` dictionary containing characters and locations (ids -> content). When using the `update_node` tool, for `actingCharacters` and `locationId`, you MUST use the exact string id from the provided lore, NEVER the character's or location's name. If a requested character or location is not present in the lore, do not include it. "
        "When creating a story branch, first use create_node, then use connect_nodes, and finally use update_node to fill the newly created nodes with rich narrative text, tone, and character dialogue. "
        "Do not modify files. Emit STRICT JSON only. Available tools are create_node, connect_nodes and update_node. "
        "Return one of these shapes exactly:\n"
        '{"type":"tool_call","name":"create_node","arguments":{...}}\n'
        '{"type":"tool_call","name":"connect_nodes","arguments":{...}}\n'
        '{"type":"tool_call","name":"update_node","arguments":{...}}\n'
        '{"type":"task_complete","message":"..."}\n'
        "Never include markdown or extra commentary.\n\n"
        f"USER PROMPT:\n{user_prompt}\n\n"
        f"TODO LIST:\n{json.dumps(tasks, ensure_ascii=False, indent=2)}\n\n"
        f"CURRENT TASK:\n{json.dumps(current_task, ensure_ascii=False, indent=2)}\n\n"
        f"EXECUTION STATE:\n{json.dumps(execution_state, ensure_ascii=False, indent=2)}\n\n"
        f"CONTEXT JSON:\n{context_json}\n\n"
        f"TOOL SCHEMAS:\n{json.dumps(TOOL_SCHEMAS, ensure_ascii=False, indent=2)}\n"
    )


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
        if name not in {"create_node", "connect_nodes", "update_node"}:
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
    prompt = build_executor_prompt(user_prompt, context_json, tasks, current_task, execution_state)
    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=prompt,
    )
    raw_text = getattr(response, "text", None) or ""
    return parse_executor_response(raw_text)


def execute_plan(user_prompt: str, context_json: str, tasks: List[Dict[str, Any]]) -> None:
    execution_state: Dict[str, Any] = {
        "created_nodes": {},
        "last_action": None,
        "selected_context": json.loads(context_json) if context_json.strip().startswith("{") else context_json,
    }

    emit({"type": "agent:status", "status": "executing", "message": "Starting executor loop..."})

    for task in tasks:
        task_id = int(task.get("id", 0))
        task_desc = str(task.get("desc", "")).strip()
        emit({"type": "agent:status", "status": "executing", "message": f"Executing task {task_id}: {task_desc}"})

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
                if "dialogue_text" in arguments and arguments.get("dialogue_text") is not None:
                    data["dialogue_text"] = str(arguments.get("dialogue_text"))
                if "choices" in arguments and isinstance(arguments.get("choices"), list):
                    # Pass choices through as-is (list of {id,text})
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
                            # Emit a non-fatal warning so the UI reviewer knows this name was skipped
                            emit({"type": "agent:status", "status": "executing", "message": f"Warning: Could not find character '{candidate}' in lore, skipped."})
                    if resolved:
                        data["actingCharacters"] = resolved

                if "locationId" in arguments and arguments.get("locationId") is not None:
                    loc_cand = str(arguments.get("locationId"))
                    rid = resolve_location(loc_cand)
                    if rid:
                        data["locationId"] = rid
                    else:
                        emit({"type": "agent:status", "status": "executing", "message": f"Warning: Could not find location '{loc_cand}' in lore, skipped."})

                # Only emit fields that were provided
                emit({
                    "type": "agent:mutation",
                    "action": "update_node",
                    "node_id": node_id,
                    "data": data,
                })

                execution_state["last_action"] = {
                    "task_id": task_id,
                    "tool": "update_node",
                    "node_id": node_id,
                    "data": data,
                }
                emit_task_update(task_id, "completed")
                continue
        except Exception as e:
            emit({"type": "agent:status", "status": "error", "message": f"Execution failed: {str(e)}"})
            emit_task_update(task_id, "error")
            break

    emit({"type": "agent:status", "status": "completed", "message": "Done!"})


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=6))
def request_plan(user_prompt: str, context_json: str) -> Dict[str, Any]:
    prompt = build_prompt(user_prompt, context_json)
    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=prompt,
    )
    raw_text = getattr(response, "text", None) or ""
    return validate_plan(extract_json_payload(raw_text))


def main() -> int:
    parser = argparse.ArgumentParser(description="Plot Architect Phase 4 agent planner")
    parser.add_argument("--prompt", required=True, help="User request to plan for")
    parser.add_argument("--context-json", required=True, help="JSON string describing selected nodes and context")
    args = parser.parse_args()

    context_json = normalize_context(args.context_json)

    emit(
        {
            "type": "agent:status",
            "status": "planning",
            "message": "Analyzing request...",
        }
    )

    try:
        plan = request_plan(args.prompt, context_json)
    except Exception as error:
        emit(
            {
                "type": "agent:status",
                "status": "planning",
                "message": f"Planner fallback used: {error}",
            }
        )
        plan = fallback_plan(args.prompt, context_json)

    emit({"type": "agent:todo", "tasks": plan["tasks"]})
    execute_plan(args.prompt, context_json, plan["tasks"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())