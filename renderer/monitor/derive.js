// Copied from U1 Studio (web/js/derive.js); loaded as a plain script by the Print Monitor (monitor.js).
// Display logic ported from the Home Assistant dashboards (dashboards/desktop.yaml, packages/snapmaker_u1.yaml).
// Input: one printer snapshot from the backend. Output: plain values for the views. No DOM here.

const EXTRUDERS = ["extruder", "extruder1", "extruder2", "extruder3"];
const cToF = (c) => (c * 9) / 5 + 32;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v, d = 0) => (typeof v === "number" && isFinite(v) ? v : d);

function fmtTemp(c, units, digits = 0) {
  if (typeof c !== "number") return "—";
  const v = units === "C" ? c : cToF(c);
  return `${v.toFixed(digits)}°${units}`;
}

function hhmm(seconds) {
  if (seconds == null || !isFinite(seconds)) return "--:--";
  const m = Math.max(0, Math.round(seconds / 60));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function hms(seconds) {
  const s = Math.max(0, Math.round(num(seconds)));
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
}

const jobName = (f) => (f || "").replace(/\.gcode$/i, "").replace(/_/g, " ").split("/").pop();

// ---------------------------------------------------------------- stage banner (desktop.yaml)
const STAGE_STYLE = {
  printing: { bg: "linear-gradient(120deg,#ec4899,#8b5cf6,#3b82f6,#06b6d4,#22c55e,#f59e0b,#ec4899)", glow: "rgba(139,92,246,.45)", anim: true, icon: "flag" },
  paused: { bg: "linear-gradient(120deg,#ec4899,#8b5cf6,#3b82f6,#06b6d4,#22c55e,#f59e0b,#ec4899)", glow: "rgba(139,92,246,.45)", anim: true, icon: "pauseCircle" },
  preparing: { bg: "linear-gradient(120deg,#f59e0b,#f97316,#ef4444)", glow: "rgba(249,115,22,.45)", icon: "nozzleHeat" },
  cooling: { bg: "linear-gradient(120deg,#1d4ed8,#0ea5e9,#06b6d4)", glow: "rgba(14,165,233,.45)", icon: "snowflake" },
  ready: { bg: "linear-gradient(120deg,#16a34a,#22c55e,#10b981)", glow: "rgba(34,197,94,.45)", icon: "check" },
  waiting: { bg: "linear-gradient(120deg,#1e293b,#334155,#3730a3)", glow: "rgba(79,70,229,.35)", icon: "hourglass" },
  error: { bg: "linear-gradient(120deg,#b91c1c,#ef4444)", glow: "rgba(239,68,68,.35)", icon: "alert" },
  cancelled: { bg: "linear-gradient(120deg,#b91c1c,#ef4444)", glow: "rgba(239,68,68,.35)", icon: "cancel" },
  idle: { bg: "linear-gradient(120deg,#334155,#475569)", glow: "rgba(100,116,139,.25)", icon: "printer" },
  offline: { bg: "linear-gradient(120deg,#27272a,#3f3f46)", glow: "rgba(0,0,0,0)", icon: "offline" },
};

function banner(p, units, now = Date.now() / 1000) {
  const stage = p.stage.startsWith("klippy_") ? "offline" : p.stage;
  const st = STAGE_STYLE[stage] || STAGE_STYLE.idle;
  const bed = p.status?.heater_bed?.temperature;
  const safeF = Math.round(cToF(p.safe_bed_c));
  const safeTxt = units === "C" ? `${Math.round(p.safe_bed_c)}°C` : `${safeF}°F (${Math.round(p.safe_bed_c)}°C)`;
  let primary = "No print running", secondary = `${p.name} is idle`;
  const left = p.time?.left;
  if (stage === "printing" || stage === "paused") {
    if (left != null) {
      const t = new Date((now + left) * 1000);
      const dd = Math.round((startOfDay(t) - startOfDay(new Date(now * 1000))) / 86400000);
      const day = dd === 0 ? "Today" : dd === 1 ? "Tomorrow" : "";
      primary = `Estimated completion is ${t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
      secondary = `${day ? day + " · " : ""}${t.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}`
        + (stage === "paused" ? " · PAUSED, estimate will slip" : "");
    } else primary = "Estimating completion time…", secondary = stage === "paused" ? "PAUSED" : "";
  } else if (stage === "preparing") {
    primary = "Preparing · bed warming up";
    secondary = `Bed at ${fmtTemp(bed, units)} · printing starts at layer 1`;
  } else if (stage === "cooling") {
    primary = `Cooling Bed · ${fmtTemp(bed, units)}`;
    secondary = `Print complete · ${bedCooledPct(p)}% cooled · safe to remove at ${safeTxt}`;
  } else if (stage === "ready") {
    primary = "Complete - Ready to remove print";
    secondary = `Bed is ${fmtTemp(bed, units)} (below ${safeTxt})`;
  } else if (stage === "waiting") {
    primary = "Waiting for new print job...";
    secondary = `Last job: ${jobName(p.job?.filename || p.status?.print_stats?.filename)}`;
  } else if (stage === "error") {
    primary = "Printer error"; secondary = p.message || "Check the printer";
  } else if (stage === "cancelled") {
    primary = "Print cancelled"; secondary = "Check the printer";
  } else if (stage === "offline") {
    primary = p.enabled === false ? "Printer disabled" : "Printer offline";
    secondary = p.enabled === false ? "Enable it in Settings" : (p.error ? `Reconnecting… (${p.error})` : "Reconnecting…");
  }
  return { stage, primary, secondary, ...st };
}

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); }

function bedCooledPct(p) {
  const bed = cToF(num(p.status?.heater_bed?.temperature));
  const pk = cToF(num(p.job?.bed_peak_c, p.status?.heater_bed?.temperature));
  const safe = cToF(p.safe_bed_c);
  return Math.round(clamp(pk - bed >= 0 && pk - safe > 5 ? ((pk - bed) / (pk - safe)) * 100 : 100, 0, 100));
}

// ---------------------------------------------------------------- countdown + elapsed
function countdown(p, now = Date.now() / 1000) {
  const stage = p.stage;
  const j = p.job || {};
  let big = "--:--", label = "HOURS : MINUTES REMAINING", sub = "";
  if (stage === "printing" || stage === "paused" || stage === "preparing") {
    big = hhmm(p.time?.left);
    if (j.started_at) sub = `ELAPSED ${hhmm(now - j.started_at)}`;
  } else if (["cooling", "ready", "waiting"].includes(stage)) {
    big = "00:00";
    if (j.started_at && j.ended_at) sub = `PRINT TOOK ${hhmm(j.ended_at - j.started_at)}`;
  } else {
    label = "NO PRINT RUNNING";
  }
  return { big, label, sub };
}

// ---------------------------------------------------------------- filament slots
function filamentSlot(p, i) {
  const c = p.status?.print_task_config || {};
  const at = (k, d) => (Array.isArray(c[k]) ? c[k][i] : undefined) ?? d;
  let raw = at("filament_color_rgba", "");
  let hex = typeof raw === "number" ? raw.toString(16).padStart(8, "0") : String(raw).replace("#", "");
  const type = String(at("filament_type", "NONE") || "NONE");
  const sub = String(at("filament_sub_type", "") || "");
  const vendor = String(at("filament_vendor", "") || "");
  const exists = at("filament_exist", true) !== false;
  const set = !["NONE", ""].includes(type);
  const ok = exists && hex.length >= 6 && !(!set && hex.slice(0, 6).toLowerCase() === "ffffff");
  const color = ok ? "#" + hex.slice(0, 6).toLowerCase() : null;
  const lum = ok ? 0.299 * parseInt(hex.slice(0, 2), 16) + 0.587 * parseInt(hex.slice(2, 4), 16) + 0.114 * parseInt(hex.slice(4, 6), 16) : 0;
  return {
    loaded: ok && set, color, text: lum > 150 ? "#111827" : "#ffffff",
    type: set ? type + (sub && !["NONE", "Basic"].includes(sub) ? " " + sub : "") : "",
    vendor: vendor && vendor !== "NONE" ? vendor : "",
  };
}

// ---------------------------------------------------------------- toolheads (desktop.yaml tool columns)
function toolhead(p, i) {
  const obj = EXTRUDERS[i];
  const e = p.status?.[obj];
  if (!e) return null;
  const v = cToF(num(e.temperature));
  const r = num(p.rates_f_per_min?.[obj]);
  const pw = num(e.power) * 100;
  const all = EXTRUDERS.map((o) => cToF(num(p.status?.[o]?.temperature)));
  const mx = Math.max(...all);
  let st = r > 2 && pw >= 10 ? "heating" : r < -2 && v >= 120 ? "cooling" : v >= 150 ? "holding" : "sleeping";
  const colSt = st === "holding" && v > 350 ? "heating" : st;
  const col = { heating: "#ef4444", cooling: "#3b82f6", holding: v >= mx || v > 350 ? "#ef4444" : "#f59e0b", sleeping: "#22c55e" }[st];
  const printingNow = ["printing", "paused"].includes(p.stage);
  // While printing, the printer says which head is in use; otherwise the HA rule (holding above 350 F).
  const active = printingNow ? p.status?.toolhead?.extruder === obj : st === "holding" && v > 350;
  return {
    i, obj, st, colSt, col, active,
    tempC: e.temperature, targetC: num(e.target), powerPct: Math.round(pw),
    bar: Math.round(clamp(((v - 50) / 550) * 100, 0, 100)),
    icon: { heating: "fire", cooling: "snowflake", holding: "thermoCheck", sleeping: "sleep" }[st],
    label: { heating: "Heating ▲", cooling: "Cooling ▼", holding: "Holding", sleeping: "Sleeping" }[st],
    fan: i === 0 ? p.status?.fan?.speed : p.status?.[`fan_generic e${i}_fan`]?.speed,
    filament: filamentSlot(p, i),
  };
}

function visibleToolheads(p, showEmpty) {
  const out = [];
  for (let i = 0; i < 4; i++) {
    const t = toolhead(p, i);
    if (!t) continue;
    if (!showEmpty && !t.filament.loaded && !t.active && cToF(num(t.tempC)) < 150) continue;
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------- bed / enclosure / layers / memory
function bed(p) {
  const b = p.status?.heater_bed;
  if (!b) return null;
  const v = cToF(num(b.temperature));
  const r = num(p.rates_f_per_min?.heater_bed);
  const safe = cToF(p.safe_bed_c);
  const tgtF = b.target > 0 ? cToF(b.target) : 0;
  const st = tgtF && Math.abs(v - tgtF) <= 5 ? "holding"            // at its set temperature: holding, whatever the noise says
    : r > 0.5 && tgtF ? "heating" : r < -0.5 && v > safe ? "cooling" : tgtF ? "holding" : v > safe ? "cooling" : "cool";
  const col = { heating: "#ef4444", cooling: "#3b82f6", holding: "#f59e0b", cool: "#22c55e" }[st];
  const bar = st === "cooling" ? bedCooledPct(p) : Math.round(clamp(((v - 50) / 200) * 100, 0, 100));
  return { st, col, bar, tempC: b.temperature, targetC: num(b.target),
    label: { heating: "Heating", cooling: `Cooling · ${bedCooledPct(p)}%`, holding: "Holding", cool: "Cool" }[st] };
}

function enclosure(p) {
  const key = Object.keys(p.status || {}).find((k) => k === "temperature_sensor cavity") ||
    Object.keys(p.status || {}).find((k) => k.startsWith("temperature_sensor "));
  const t = key ? p.status[key]?.temperature : null;
  if (typeof t !== "number") return null;
  const f = cToF(t);
  return { tempC: t, col: f >= 90 && f <= 125 ? "#22c55e" : f > 125 ? "#f59e0b" : "#f59e0b", bar: Math.round(clamp(((f - 60) / 80) * 100, 0, 100)) };
}

function layers(p) {
  const info = p.status?.print_stats?.info || {};
  const cur = num(info.current_layer, 0), tot = num(info.total_layer, 0);
  return { cur, tot, bar: tot ? Math.round((cur / tot) * 100) : 0 };
}

function motion(p) {
  const g = p.status?.gcode_move || {};
  const fans = [];
  for (const [k, v] of Object.entries(p.status || {})) {
    if (k === "fan") fans.push({ name: "Part fan", speed: v.speed });
    else if (k === "fan_generic cavity_fan") fans.push({ name: "Cavity fan", speed: v.speed });
  }
  return { speed: g.speed_factor, flow: g.extrude_factor, fans };
}

// ---------------------------------------------------------------- fun comparisons
// Per-print list from automations/print_finished.yaml (metres)
const PRINT_OBJ = [[0.15, "the length of a smartphone"], [0.3, "the length of a school ruler"], [0.55, "the height of a carry-on suitcase"],
  [0.86, "the length of a baseball bat"], [1.0, "the length of an acoustic guitar"], [1.8, "the height of a tall person"],
  [2.0, "the length of a king-size bed"], [2.4, "the height of a giraffe's neck"], [3.05, "the height of a basketball hoop"],
  [4.7, "the length of a family car"], [10.7, "the length of a school bus"], [12.2, "the length of a shipping container"],
  [18.3, "the length of a bowling lane"], [23.8, "the length of a tennis court"], [27.0, "the length of a blue whale"],
  [39.5, "the length of a Boeing 737"], [50.0, "the length of an Olympic swimming pool"], [70.7, "the length of a Boeing 747"],
  [91.4, "a football field, goal line to goal line"], [93.0, "the height of the Statue of Liberty"],
  [109.7, "the length of a football field, end zone to end zone"], [146.6, "the height of the Great Pyramid of Giza"],
  [169.0, "the height of the Washington Monument"], [330.0, "the height of the Eiffel Tower"], [381.0, "the height of the Empire State Building"],
  [508.0, "the height of Taipei 101"], [828.0, "the height of the Burj Khalifa"], [1000.0, "one kilometer"], [1609.0, "one mile"],
  [2737.0, "the length of the Golden Gate Bridge"], [5000.0, "a 5K race"], [8849.0, "the height of Mount Everest"],
  [10000.0, "a 10K race"], [21097.0, "a half marathon"], [42195.0, "a full marathon"]];

function compare(metres, list = PRINT_OBJ) {
  if (!(metres > 0)) return "Nothing extruded yet";
  let best = null;
  for (const o of list) if (metres >= o[0]) best = o;
  if (!best) return `Just getting started, still shorter than ${list[0][1].replace(/^the /, "a ")}`;
  const r = metres / best[0];
  if (r < 1.25) return `≈ ${best[1]}!`;
  return `≈ ${r < 10 ? r.toFixed(1) : Math.round(r)}× ${best[1]}!`;
}
