import { RouteNode } from "../types/plot";

interface RouteInspectorProps {
  route: RouteNode;
  onChange: (nextRoute: RouteNode) => void;
}

export function RouteInspector({ route, onChange }: RouteInspectorProps) {
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
          className="w-full box-border rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
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
            onClick={() => setConditions((prev) => [...prev, { flag: "", value: false }])}
          >
            +
          </button>
        </div>

        {route.parameters.conditions.map((condition, index) => (
          <div key={`${condition.flag}-${index}`} className="flex flex-col gap-2 rounded-md border border-slate-700 bg-slate-900/70 p-2">
            <input
              className="w-full box-border rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
              placeholder="Flag"
              value={condition.flag}
              onChange={(event) =>
                setConditions((prev) => {
                  const next = [...prev];
                  next[index] = { ...next[index], flag: event.target.value };
                  return next;
                })
              }
            />

            <label className="flex w-full items-center gap-2 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={condition.value}
                onChange={(event) =>
                  setConditions((prev) => {
                    const next = [...prev];
                    next[index] = { ...next[index], value: event.target.checked };
                    return next;
                  })
                }
              />
              Required value
            </label>

            <button
              className="w-full box-border rounded bg-rose-700 px-2 py-1 text-xs"
              onClick={() => setConditions((prev) => prev.filter((_entry, i) => i !== index))}
            >
              Remove condition
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
