"""
Lore Parser – Converts free-form draft text into structured JSON
matching the StructuredLore schema: { role, aliases, publicDescription, hiddenTraits }.

Usage:
    python parser.py --draft "..." --entity-type "character"

Prints a single JSON object to stdout. Exits 0 on success, 1 on error.
"""

import argparse
import json
import os
import re
import sys
import traceback

from dotenv import load_dotenv
from google import genai

sys.stdout.reconfigure(encoding="utf-8")

load_dotenv()

client = genai.Client()


SYSTEM_PROMPT = """\
You are a lore-extraction assistant for a visual-novel plot editor.
Given a free-form draft text describing a {entity_type}, extract the following structured fields:

1. **role** – A brief phrase describing the entity's narrative function (e.g. "Main antagonist", "Protagonist's mentor", "Hidden passage to the underworld").
2. **aliases** – Comma-separated alternative names, nicknames, or titles. If none are obvious, write "None".
3. **publicDescription** – A clean, polished summary of everything that is publicly known about this entity. This is the 'external' view.
4. **hiddenTraits** – Secret traits, hidden agendas, concealed abilities, or information only the author/game-master knows. If none, write "None".

Return ONLY a JSON object with exactly these four keys, no markdown fences, no commentary:
{{"role":"...","aliases":"...","publicDescription":"...","hiddenTraits":"..."}}
"""


def extract_json(text: str) -> dict:
    """Try to parse a JSON object from the LLM response."""
    text = text.strip()

    # Strip markdown code fences if present
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.IGNORECASE | re.DOTALL).strip()

    # Try direct parse first
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            return obj
    except json.JSONDecodeError:
        pass

    # Try to find the first {...} block
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match:
        try:
            obj = json.loads(match.group(0))
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            pass

    raise ValueError(f"Could not extract valid JSON from LLM response: {text[:200]}")


def parse_lore(draft: str, entity_type: str) -> dict:
    """Send the draft to the LLM and return structured lore as a dict."""
    prompt = SYSTEM_PROMPT.format(entity_type=entity_type) + f"\n\nDraft text:\n{draft}"

    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=prompt,
    )

    raw_text = getattr(response, "text", None) or ""
    if not raw_text.strip():
        raise ValueError("LLM returned an empty response.")

    result = extract_json(raw_text)

    # Ensure all required keys are present
    return {
        "role": str(result.get("role", "[Not specified]")),
        "aliases": str(result.get("aliases", "None")),
        "publicDescription": str(result.get("publicDescription", "[Not specified]")),
        "hiddenTraits": str(result.get("hiddenTraits", "None")),
    }


def main():
    parser = argparse.ArgumentParser(description="Parse draft lore text into structured JSON")
    parser.add_argument("--draft", required=True, help="The draft text to parse")
    parser.add_argument("--entity-type", required=True, help="Entity type: character, location, or tag")
    args = parser.parse_args()

    try:
        structured = parse_lore(args.draft, args.entity_type)
        print(json.dumps(structured, ensure_ascii=False))
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
