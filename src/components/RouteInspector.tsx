import { RouteNode } from "../types/plot";

interface RouteInspectorProps {
  route: RouteNode;
  onChange: (nextRoute: RouteNode) => void;
  loreEntities?: { id: string; label: string; type: "character" | "location" | "variable"; variableType?: "number" | "boolean" }[];
}

const isMissingReference = (targetId: string, entities: { id: string; label: string }[]): boolean => {
  return Boolean(targetId && !entities.find((e) => e.id === targetId));
};

export function RouteInspector({ route, onChange, loreEntities = [] }: RouteInspectorProps) {
  const variableEntities = loreEntities.filter((entity) => entity.type === "variable");
  const getVariableById = (id: string) => variableEntities.find((entity) => entity.id === id);

  const setConditions = (updater: (prev: RouteNode["parameters"]["conditions"]) => RouteNode["parameters"]["conditions"]) => {
    onChange({
      ...route,
      parameters: {
        ...route.parameters,
        conditions: updater(route.parameters.conditions),
      },
    });
  };

  return (
    <div className="space-y-3 rounded-md border border-cyan-400/30 bg-slate-950/70 p-3">
      <div className="text-sm font-semibold text-cyan-200">Route Settings</div>

      <div className="flex flex-col gap-1">
        <div className="text-xs text-slate-400">Title</div>
        <input
          className="w-full box-border rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
          value={route.parameters.title}
          onChange={(event) =>
            onChange({
              ...route,
              parameters: { ...route.parameters, title: event.target.value },
            })
          }
        />
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs text-slate-400">Divergence Point</div>
        <input
          className="w-full box-border rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
          placeholder="e.g. Act 1 Choice"
          value={route.parameters.divergencePoint}
          onChange={(event) =>
            onChange({
              ...route,
              parameters: { ...route.parameters, divergencePoint: event.target.value },
            })
          }
        />
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs text-slate-400">Color</div>
        <input
          type="color"
          className="h-10 w-full box-border rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm cursor-pointer"
          value={route.parameters.color}
          onChange={(event) =>
            onChange({
              ...route,
              parameters: { ...route.parameters, color: event.target.value },
            })
          }
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-slate-400">
          <span>Conditions</span>
          <button
            className="rounded bg-cyan-700 px-2 py-1 text-xs"
            onClick={() => setConditions((prev) => [...prev, { flag: "", operator: "==", value: false }])}
          >
            +
          </button>
        </div>

        {route.parameters.conditions.map((condition, index) => {
          const variable = getVariableById(condition.flag);
          const variableType = variable?.variableType ?? "boolean";
          const normalizedOperator = condition.operator ?? "==";

          return (
            <div key={`${condition.flag}-${index}`} className="flex flex-col gap-2 rounded-md border border-slate-700 bg-slate-900/70 p-2">
              <div>
                <select
                  className={`w-full box-border rounded border ${
                    isMissingReference(condition.flag, variableEntities)
                      ? "border-red-500 bg-red-950"
                      : "border-slate-700 bg-slate-900"
                  } px-2 py-1 text-xs`}
                  value={condition.flag}
                  onChange={(event) =>
                    setConditions((prev) => {
                      const next = [...prev];
                      const nextVar = getVariableById(event.target.value);
                      next[index] = {
                        ...next[index],
                        flag: event.target.value,
                        operator: "==",
                        value: nextVar?.variableType === "number" ? 0 : false,
                      };
                      return next;
                    })
                  }
                >
                  <option value="">-- Select Variable --</option>
                  {variableEntities.map((entity) => (
                    <option key={entity.id} value={entity.id}>
                      {entity.label}
                    </option>
                  ))}
                </select>
                {isMissingReference(condition.flag, variableEntities) && (
                  <div className="mt-1 text-xs text-red-400">⚠ Missing reference: {condition.flag}</div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <select
                  className="w-full box-border rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
                  value={normalizedOperator}
                  onChange={(event) =>
                    setConditions((prev) => {
                      const next = [...prev];
                      next[index] = { ...next[index], operator: event.target.value as "==" | ">" | "<" };
                      return next;
                    })
                  }
                >
                  <option value="==">==</option>
                  <option value=">">&gt;</option>
                  <option value="<">&lt;</option>
                </select>

                {variableType === "number" ? (
                  <input
                    type="number"
                    className="w-full box-border rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
                    value={typeof condition.value === "number" ? condition.value : Number(condition.value) || 0}
                    onChange={(event) =>
                      setConditions((prev) => {
                        const next = [...prev];
                        next[index] = { ...next[index], value: Number(event.target.value) };
                        return next;
                      })
                    }
                  />
                ) : (
                  <label className="flex items-center gap-2 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300">
                    <input
                      type="checkbox"
                      checked={Boolean(condition.value)}
                      onChange={(event) =>
                        setConditions((prev) => {
                          const next = [...prev];
                          next[index] = { ...next[index], value: event.target.checked };
                          return next;
                        })
                      }
                    />
                    Value
                  </label>
                )}
              </div>

              <div className="text-[11px] text-slate-400" title="Must evaluate to true to unlock this route">
                Required value: Must evaluate to true to unlock this route.
              </div>

              <button
                className="w-full box-border rounded bg-rose-700 px-2 py-1 text-xs"
                onClick={() => setConditions((prev) => prev.filter((_entry, i) => i !== index))}
              >
                Remove condition
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
