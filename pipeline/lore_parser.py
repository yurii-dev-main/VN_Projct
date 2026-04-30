import argparse
import json
import re
import sys
from typing import Any, Dict

from dotenv import load_dotenv
from google import genai


load_dotenv()
client = genai.Client()


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
            raise ValueError("Response JSON must be an object.")
        except Exception as error:
            last_error = error

    raise ValueError(f"Failed to parse model output as JSON: {last_error}")


def build_prompt(draft: str, entity_type: str) -> str:
    return (
        "You are a strict parser that converts unstructured lore notes into a small JSON object.\n"
        "Output STRICT JSON only (no markdown, no explanation).\n"
        "Fields required: role, aliases, publicDescription, hiddenTraits.\n"
        "Important: If any specific detail is missing from the draft, DO NOT INVENT it. Instead set that field to the exact placeholder string: [Not specified].\n\n"
        f"Entity type: {entity_type}\n\n"
        "User draft follows:\n" + draft + "\n\n"
        "Return example: {\"role\":\"[Not specified]\", \"aliases\":\"[Not specified]\", \"publicDescription\":\"[Not specified]\", \"hiddenTraits\":\"[Not specified]\"}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Parse lore draft into structured JSON")
    parser.add_argument("--draftText", required=True)
    parser.add_argument("--entityType", required=True)
    args = parser.parse_args()

    prompt = build_prompt(args.draftText, args.entityType)

    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=prompt,
    )

    raw_text = getattr(response, "text", "") or ""

    try:
        parsed = extract_json_payload(raw_text)
    except Exception as e:
        # If parsing failed, return placeholders to avoid hallucinations
        parsed = {
            "role": "[Not specified]",
            "aliases": "[Not specified]",
            "publicDescription": "[Not specified]",
            "hiddenTraits": "[Not specified]",
        }

    # Ensure all fields exist and enforce placeholders for missing entries
    result = {
        "role": parsed.get("role") if parsed.get("role") else "[Not specified]",
        "aliases": parsed.get("aliases") if parsed.get("aliases") else "[Not specified]",
        "publicDescription": parsed.get("publicDescription") if parsed.get("publicDescription") else "[Not specified]",
        "hiddenTraits": parsed.get("hiddenTraits") if parsed.get("hiddenTraits") else "[Not specified]",
    }

    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
