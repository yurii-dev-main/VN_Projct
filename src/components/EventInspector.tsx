import { EventNode } from "../types/plot";

interface EventInspectorProps {
  eventNode: EventNode;
  onChange: (nextEventNode: EventNode) => void;
}

export function EventInspector({ eventNode, onChange }: EventInspectorProps) {
  const setEffects = (updater: (prev: EventNode["parameters"]["effects"]) => EventNode["parameters"]["effects"]) => {
    onChange({
      ...eventNode,
      parameters: {
        ...eventNode.parameters,
        effects: updater(eventNode.parameters.effects),
      },
    });
  };

  return (
    <div className="space-y-3 rounded-md border border-rose-400/30 bg-slate-950/70 p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-rose-200">Event Effects</div>
          <div className="text-xs text-slate-400">Configure effect payload applied by this event node.</div>
        </div>
        <button
          className="rounded-md bg-rose-600 px-3 py-1 text-xs font-semibold text-slate-100"
          onClick={() => setEffects((prev) => [...prev, { target: "", value: "", operator: "set" }])}
        >
          + Add Effect
        </button>
      </div>

      <div className="space-y-2">
        {eventNode.parameters.effects.map((effect, index) => (
          <div key={`${effect.target}-${index}`} className="flex flex-col gap-2 rounded-md border border-slate-700 bg-slate-900/70 p-2">
            <input
              className="w-full box-border rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
              placeholder="Target"
              value={effect.target}
              onChange={(event) =>
                setEffects((prev) => {
                  const next = [...prev];
                  next[index] = { ...next[index], target: event.target.value };
                  return next;
                })
              }
            />

            <input
              className="w-full box-border rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
              placeholder="Field"
              value={effect.field ?? ""}
              onChange={(event) =>
                setEffects((prev) => {
                  const next = [...prev];
                  next[index] = { ...next[index], field: event.target.value };
                  return next;
                })
              }
            />

            <select
              className="w-full box-border rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
              value={effect.operator ?? "set"}
              onChange={(event) =>
                setEffects((prev) => {
                  const next = [...prev];
                  next[index] = { ...next[index], operator: event.target.value as "set" | "add" | "sub" };
                  return next;
                })
              }
            >
              <option value="set">set</option>
              <option value="add">add</option>
              <option value="sub">sub</option>
            </select>

            <textarea
              className="w-full box-border rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
              style={{ resize: "none", maxHeight: "120px", overflowY: "auto" }}
              rows={2}
              placeholder="Value"
              value={String(effect.value)}
              onInput={(e) => {
                e.currentTarget.style.height = "auto";
                e.currentTarget.style.height = e.currentTarget.scrollHeight + "px";
              }}
              onChange={(event) =>
                setEffects((prev) => {
                  const next = [...prev];
                  next[index] = { ...next[index], value: event.target.value };
                  return next;
                })
              }
            />

            <button
              className="w-full box-border rounded bg-rose-700 px-2 py-1 text-xs"
              onClick={() => setEffects((prev) => prev.filter((_entry, i) => i !== index))}
            >
              Remove effect
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
