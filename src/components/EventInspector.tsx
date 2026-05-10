import { useEffect } from "react";

import { EventNode } from "../types/plot";

interface EventInspectorProps {
  eventNode: EventNode;
  onChange: (nextEventNode: EventNode) => void;
  loreEntities?: { id: string; label: string; type: "character" | "location" | "variable"; variableType?: "number" | "boolean" }[];
}

const CHARACTER_FIELDS = ["role", "aliases", "publicDescription", "hiddenTraits"] as const;
const LOCATION_FIELDS = ["region", "landmarks", "atmosphere", "secrets"] as const;

type EventEffect = EventNode["parameters"]["effects"][number];

interface EventEffectEditorProps {
  effect: EventEffect;
  index: number;
  loreEntities: NonNullable<EventInspectorProps["loreEntities"]>;
  setEffects: (updater: (prev: EventNode["parameters"]["effects"]) => EventNode["parameters"]["effects"]) => void;
}

function EventEffectEditor({ effect, index, loreEntities, setEffects }: EventEffectEditorProps) {
  const getTargetEntity = (targetId: string) => loreEntities.find((entity) => entity.id === targetId);

  const targetEntity = getTargetEntity(effect.target);
  const targetType = targetEntity?.type;
  const isVariable = targetType === "variable";
  const isBooleanVariable = isVariable && (targetEntity?.variableType ?? "boolean") === "boolean";
  const textFields =
    targetType === "character" ? [...CHARACTER_FIELDS] : targetType === "location" ? [...LOCATION_FIELDS] : [];
  const allowedOperators = isVariable
    ? isBooleanVariable
      ? (["set"] as const)
      : (["set", "add", "sub"] as const)
    : (["set", "add"] as const);
  const effectiveField = textFields.find((field) => field === effect.field) ?? textFields[0];
  const normalizedOperator = allowedOperators.find((operator) => operator === effect.operator) ?? allowedOperators[0];

  useEffect(() => {
    if (isBooleanVariable && (effect.operator === "add" || effect.operator === "sub")) {
      setEffects((prev) => {
        const next = [...prev];
        next[index] = { ...next[index], operator: "set" };
        return next;
      });
    }
  }, [effect.operator, index, isBooleanVariable, setEffects]);

  return (
    <div className="flex flex-col gap-2 rounded-md border border-slate-700 bg-slate-900/70 p-2">
      <div>
        <select
          className={`w-full box-border rounded border ${
            isMissingReference(effect.target, loreEntities) ? "border-red-500 bg-red-950" : "border-slate-700 bg-slate-900"
          } px-2 py-1 text-xs`}
          value={effect.target}
          onChange={(event) =>
            setEffects((prev) => {
              const next = [...prev];
              const nextTarget = loreEntities.find((entity) => entity.id === event.target.value);
              if (!nextTarget) {
                next[index] = { ...next[index], target: event.target.value };
                return next;
              }

              if (nextTarget.type === "variable") {
                const nextValue = nextTarget.variableType === "number" ? 0 : false;
                next[index] = {
                  ...next[index],
                  target: nextTarget.id,
                  field: undefined,
                  operator: "set",
                  value: nextValue,
                };
                return next;
              }

              const nextFields = nextTarget.type === "character" ? CHARACTER_FIELDS : LOCATION_FIELDS;
              next[index] = {
                ...next[index],
                target: nextTarget.id,
                field: nextFields[0],
                operator: "set",
                value: "",
              };
              return next;
            })
          }
        >
          <option value="">-- Select Target --</option>
          {loreEntities.map((entity) => (
            <option key={entity.id} value={entity.id}>
              {entity.label}
            </option>
          ))}
        </select>
        {isMissingReference(effect.target, loreEntities) && <div className="mt-1 text-xs text-red-400">⚠ Missing reference: {effect.target}</div>}
      </div>

      {!isVariable && textFields.length > 0 && (
        <div>
          <select
            className="w-full box-border rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
            value={effectiveField ?? ""}
            onChange={(event) =>
              setEffects((prev) => {
                const next = [...prev];
                next[index] = { ...next[index], field: event.target.value || undefined };
                return next;
              })
            }
          >
            {textFields.map((field) => (
              <option key={field} value={field}>
                {field}
              </option>
            ))}
          </select>
        </div>
      )}

      <select
        className="w-full box-border rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
        value={normalizedOperator}
        onChange={(event) =>
          setEffects((prev) => {
            const next = [...prev];
            next[index] = { ...next[index], operator: event.target.value as EventEffect["operator"] };
            return next;
          })
        }
      >
        {allowedOperators.map((operator) => (
          <option key={operator} value={operator}>
            {operator}
          </option>
        ))}
      </select>

      {isVariable ? (
        targetEntity?.variableType === "number" ? (
          <input
            type="number"
            className="w-full box-border rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
            value={typeof effect.value === "number" ? effect.value : Number(effect.value) || 0}
            onChange={(event) =>
              setEffects((prev) => {
                const next = [...prev];
                next[index] = { ...next[index], value: Number(event.target.value) };
                return next;
              })
            }
          />
        ) : (
          <label className="flex items-center gap-2 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200">
            <input
              type="checkbox"
              checked={Boolean(effect.value)}
              onChange={(event) =>
                setEffects((prev) => {
                  const next = [...prev];
                  next[index] = { ...next[index], value: event.target.checked };
                  return next;
                })
              }
            />
            Value
          </label>
        )
      ) : (
        <textarea
          className="w-full box-border rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
          style={{ resize: "none", maxHeight: "120px", overflowY: "auto" }}
          rows={2}
          placeholder="Value"
          value={String(effect.value ?? "")}
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
      )}

      <button
        className="w-full box-border rounded bg-rose-700 px-2 py-1 text-xs"
        onClick={() => setEffects((prev) => prev.filter((_entry, i) => i !== index))}
      >
        Remove effect
      </button>
    </div>
  );
}

const isMissingReference = (targetId: string, entities: { id: string; label: string }[]): boolean => {
  return Boolean(targetId && !entities.find((e) => e.id === targetId));
};

export function EventInspector({ eventNode, onChange, loreEntities = [] }: EventInspectorProps) {
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
          <EventEffectEditor key={`${effect.target}-${index}`} effect={effect} index={index} loreEntities={loreEntities} setEffects={setEffects} />
        ))}
      </div>
    </div>
  );
}
