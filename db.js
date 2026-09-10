/** IndexedDB — phases, diet plans, training plans, daily logs */
const DB_NAME = "cut-tracker-db";
const DB_VERSION = 3;
const LEGACY_KEY = "cut-tracker-v1";
const PHASE_LENGTH_DAYS = 14;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      if (!db.objectStoreNames.contains("days")) db.createObjectStore("days", { keyPath: "date" });
      if (!db.objectStoreNames.contains("photos")) {
        const photos = db.createObjectStore("photos", { keyPath: "id" });
        photos.createIndex("byDate", "date", { unique: false });
      }
      if (!db.objectStoreNames.contains("analyses")) {
        db.createObjectStore("analyses", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("dietPhases")) {
        db.createObjectStore("dietPhases", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("phases")) {
        db.createObjectStore("phases", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("dietPlans")) {
        const d = db.createObjectStore("dietPlans", { keyPath: "id" });
        d.createIndex("byPhaseId", "phaseId", { unique: true });
      }
      if (!db.objectStoreNames.contains("trainingPlans")) {
        const t = db.createObjectStore("trainingPlans", { keyPath: "id" });
        t.createIndex("byPhaseId", "phaseId", { unique: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("aborted"));
  });
}

async function idbGet(store, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, "readonly").objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(store, value) {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).put(value);
  await txDone(tx);
}

async function idbDelete(store, key) {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).delete(key);
  await txDone(tx);
}

async function idbGetAll(store) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, "readonly").objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbClear(store) {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).clear();
  await txDone(tx);
}

function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function addDaysISO(dateISO, days) {
  if (!dateISO) return null;
  const d = new Date(dateISO + "T12:00:00");
  d.setDate(d.getDate() + days);
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
}

function todayISO() {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
}

function twoWeekEnd(startDate) {
  if (!startDate) return null;
  return addDaysISO(startDate, PHASE_LENGTH_DAYS - 1);
}

function ensureTwoWeekRange(startDate) {
  if (!startDate) return { startDate: null, endDate: null };
  return { startDate, endDate: twoWeekEnd(startDate) };
}

function getPhaseWeekInfo(phase, dateISO) {
  if (!phase?.startDate || !dateISO) return null;
  const start = phase.startDate;
  const end = phase.endDate || twoWeekEnd(start);
  if (dateISO < start || dateISO > end) return null;
  const startMs = new Date(start + "T12:00:00").getTime();
  const dateMs = new Date(dateISO + "T12:00:00").getTime();
  const dayIndex = Math.floor((dateMs - startMs) / 86400000);
  if (dayIndex < 0 || dayIndex >= PHASE_LENGTH_DAYS) return null;
  const weekNumber = dayIndex < 7 ? 1 : 2;
  const weekStartOffset = weekNumber === 1 ? 0 : 7;
  const weekStart = addDaysISO(start, weekStartOffset);
  let weekEnd = addDaysISO(start, weekStartOffset + 6);
  if (weekEnd > end) weekEnd = end;
  return { weekNumber, weeksInPhase: 2, weekStart, weekEnd, phaseStart: start, phaseEnd: end, dayInPhase: dayIndex + 1 };
}

function phaseCoversDate(phase, dateISO) {
  if (!dateISO || !phase) return false;
  const start = phase.startDate || null;
  const end = phase.endDate ?? (start ? twoWeekEnd(start) : null);
  if (start && dateISO < start) return false;
  if (end && dateISO > end) return false;
  if (!start && !end) return !!phase.active;
  return true;
}

const MEASURE_FIELDS = [
  { key: "waist", label: "Waist" },
  { key: "hips", label: "Hips" },
  { key: "chest", label: "Chest" },
  { key: "armRight", label: "Arm (right)" },
  { key: "armLeft", label: "Arm (left)" },
  { key: "thighRight", label: "Thigh (right)" },
  { key: "thighLeft", label: "Thigh (left)" },
  { key: "neck", label: "Neck" },
  { key: "shoulders", label: "Shoulders" },
  { key: "calfRight", label: "Calf (right)" },
  { key: "calfLeft", label: "Calf (left)" },
];

function defaultDietContent() {
  return {
    notes: "Coffee logged separately as a daily count. Walking 8–10k. Spritz for pan only.",
    training: {
      label: "Training day",
      targets: { kcal: 2050, protein: 220, carbs: 175, fat: 55 },
      meals: [
        { id: "breakfast", name: "Breakfast", when: "Wake / home", items: ["Corn flakes 35 g", "Honey 8 g", "Skim milk 200 ml"] },
        { id: "lunch", name: "Lunch", when: "Work", items: ["Chicken or tuna 200 g", "Rice 100 g cooked OR 2 slices bread", "Veg", "Oil 5 g OR light mayo 15 g"] },
        { id: "snack", name: "Snack", when: "Afternoon", items: ["Banana 120 g + almonds 12 g"] },
        { id: "preGym", name: "Pre-gym", when: "Before gym", items: ["Steak 150 g OR chicken 170 g", "Potato 150 g OR 2 bread", "Veg", "Oil or light mayo"] },
        { id: "supper", name: "After-gym supper", when: "After gym", items: ["Eggs 3", "Egg whites 200 g", "Cottage cheese 250 g"] },
      ],
    },
    rest: {
      label: "Rest day",
      targets: { kcal: 1750, protein: 220, carbs: 110, fat: 55 },
      meals: [
        { id: "breakfast", name: "Breakfast", when: "Wake", items: ["Corn flakes 25 g", "Honey 5 g", "Skim milk 150 ml"] },
        { id: "lunch", name: "Lunch", when: "Work", items: ["Chicken 180 g", "Rice 70 g OR bread", "Veg", "Oil or mayo"] },
        { id: "snack", name: "Snack", when: "Afternoon", items: ["Fruit 100–150 g", "Nuts 10–12 g"] },
        { id: "dinner", name: "Home dinner", when: "Evening", items: ["Chicken 160 g OR steak 130 g", "Potato 100 g OR bread", "Veg"] },
        { id: "supper", name: "Later supper", when: "Later", items: ["Eggs 3", "Egg whites 200 g", "Cottage cheese 250 g"] },
      ],
    },
  };
}

function defaultTrainingContent() {
  return {
    notes: "4 sessions / week. Log every set: weight, reps, rest after set (sec). Rest between exercises in sec. Add YouTube form links.",
    sessions: [
      {
        id: "day_a",
        name: "Day A — Lower",
        exercises: [
          { id: "ex_squat", name: "Back squat", youtubeUrl: "", targetSets: 3, targetReps: "6-8", notes: "" },
          { id: "ex_rdl", name: "Romanian deadlift", youtubeUrl: "", targetSets: 3, targetReps: "8-10", notes: "" },
          { id: "ex_legpress", name: "Leg press", youtubeUrl: "", targetSets: 3, targetReps: "10-12", notes: "" },
          { id: "ex_calf", name: "Calf raise", youtubeUrl: "", targetSets: 3, targetReps: "12-15", notes: "" },
        ],
      },
      {
        id: "day_b",
        name: "Day B — Upper",
        exercises: [
          { id: "ex_bench", name: "Bench press", youtubeUrl: "", targetSets: 3, targetReps: "6-8", notes: "" },
          { id: "ex_row", name: "Barbell row", youtubeUrl: "", targetSets: 3, targetReps: "8-10", notes: "" },
          { id: "ex_ohp", name: "Overhead press", youtubeUrl: "", targetSets: 3, targetReps: "8-10", notes: "" },
          { id: "ex_pulldown", name: "Lat pulldown", youtubeUrl: "", targetSets: 3, targetReps: "10-12", notes: "" },
        ],
      },
      {
        id: "day_c",
        name: "Day C — Lower",
        exercises: [
          { id: "ex_hinge", name: "Deadlift or trap-bar", youtubeUrl: "", targetSets: 3, targetReps: "5-6", notes: "" },
          { id: "ex_lunge", name: "Walking lunge", youtubeUrl: "", targetSets: 3, targetReps: "10/leg", notes: "" },
          { id: "ex_legcurl", name: "Leg curl", youtubeUrl: "", targetSets: 3, targetReps: "10-12", notes: "" },
          { id: "ex_core", name: "Plank / core", youtubeUrl: "", targetSets: 3, targetReps: "30-45s", notes: "" },
        ],
      },
      {
        id: "day_d",
        name: "Day D — Upper",
        exercises: [
          { id: "ex_incline", name: "Incline press", youtubeUrl: "", targetSets: 3, targetReps: "8-10", notes: "" },
          { id: "ex_pullup", name: "Pull-up / assisted", youtubeUrl: "", targetSets: 3, targetReps: "AMRAP", notes: "" },
          { id: "ex_lateral", name: "Lateral raise", youtubeUrl: "", targetSets: 3, targetReps: "12-15", notes: "" },
          { id: "ex_curl", name: "Curl + triceps", youtubeUrl: "", targetSets: 3, targetReps: "10-12", notes: "" },
        ],
      },
    ],
  };
}

function createPhaseBundle(startDate = todayISO()) {
  const ranged = ensureTwoWeekRange(startDate);
  const phaseId = uid("phase");
  const dietId = uid("diet");
  const trainId = uid("train");
  const dietBody = defaultDietContent();
  const trainBody = defaultTrainingContent();
  return {
    phase: {
      id: phaseId,
      name: "Phase 1 — Cut toward ~20% BF",
      startDate: ranged.startDate,
      endDate: ranged.endDate,
      active: true,
      createdAt: new Date().toISOString(),
      archivedAt: null,
      notes: "2-week phase. One diet plan + one training plan.",
      dietPlanId: dietId,
      trainingPlanId: trainId,
    },
    dietPlan: {
      id: dietId,
      phaseId,
      name: "Cut diet",
      createdAt: new Date().toISOString(),
      ...dietBody,
    },
    trainingPlan: {
      id: trainId,
      phaseId,
      name: "4-day strength",
      createdAt: new Date().toISOString(),
      ...trainBody,
    },
  };
}

function blankDietTemplate() {
  return {
    type: "cut-tracker-diet-template",
    version: 3,
    howToUseForAI: [
      "Fill training + rest meal plans. No coffee in meals.",
      "Phase dates are managed separately in the app (2-week phases).",
      "Return valid JSON only.",
    ],
    name: "",
    notes: "",
    training: defaultDietContent().training,
    rest: defaultDietContent().rest,
  };
}

function blankTrainingTemplate() {
  return {
    type: "cut-tracker-training-template",
    version: 1,
    howToUseForAI: [
      "Fill a training plan with sessions and exercises.",
      "Each exercise: name, youtubeUrl, targetSets, targetReps, notes.",
      "Return valid JSON only.",
    ],
    name: "",
    notes: "",
    sessions: defaultTrainingContent().sessions,
  };
}

function blankDayTemplate(date = "") {
  const measurements = {};
  MEASURE_FIELDS.forEach((m) => {
    measurements[m.key] = null;
  });
  return {
    type: "cut-tracker-day-template",
    version: 1,
    howToUseForAI: [
      "Fill one day log for the Cut Tracker Today tab.",
      "date: YYYY-MM-DD. Optional on import — the app uses the selected date if empty.",
      "trained: true = training day, false = rest day.",
      "coffees: cups that day (number). Do not put coffee inside meals.",
      "mealChecks: { mealId: true/false }. Use meal ids from the phase diet plan.",
      "lunchCarb: rice | bread | \"\". fatChoice: oil | mayo | \"\".",
      "workout: only needed when trained is true. Prefer sessionId/exerciseId from the phase training plan.",
      "hunger/energy: 1–5. measurements: cm. Return valid JSON only.",
    ],
    date: date || "",
    weight: null,
    trained: false,
    measurements,
    coffees: null,
    lunchCarb: "",
    fatChoice: "",
    mealChecks: {},
    workout: null,
    steps: null,
    sleep: null,
    hunger: null,
    energy: null,
    notes: "",
  };
}

function dayToTemplate(entry) {
  const blank = blankDayTemplate(entry?.date || "");
  if (!entry) return blank;
  return {
    ...blank,
    date: entry.date || blank.date,
    weight: entry.weight ?? null,
    trained: !!entry.trained,
    measurements: { ...blank.measurements, ...(entry.measurements || {}) },
    coffees: entry.coffees ?? null,
    lunchCarb: entry.lunchCarb || "",
    fatChoice: entry.fatChoice || "",
    mealChecks: { ...(entry.mealChecks || {}) },
    workout: entry.workout || null,
    steps: entry.steps ?? null,
    sleep: entry.sleep ?? null,
    hunger: entry.hunger ?? null,
    energy: entry.energy ?? null,
    notes: entry.notes || "",
  };
}

function numOrNull(v) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeDayTemplate(payload) {
  if (!payload || typeof payload !== "object") throw new Error("Invalid day template");
  if (payload.type && payload.type !== "cut-tracker-day-template") {
    throw new Error("Not a day template (need type cut-tracker-day-template)");
  }
  const measurements = {};
  MEASURE_FIELDS.forEach((m) => {
    const src = payload.measurements || {};
    measurements[m.key] = numOrNull(src[m.key] ?? (m.key === "waist" ? payload.waist : null));
  });
  const mealChecks = {};
  Object.entries(payload.mealChecks || {}).forEach(([id, v]) => {
    mealChecks[String(id)] = !!v;
  });
  let workout = null;
  if (payload.workout && typeof payload.workout === "object") {
    workout = {
      planId: payload.workout.planId || null,
      sessionId: (payload.workout.sessionId || "").toString(),
      sessionName: (payload.workout.sessionName || "").toString(),
      exercises: (payload.workout.exercises || []).map((ex, i) => ({
        exerciseId: (ex.exerciseId || ex.id || `ex_${i + 1}`).toString(),
        name: (ex.name || "").toString(),
        youtubeUrl: (ex.youtubeUrl || "").toString(),
        sets: (ex.sets || []).map((s) => ({
          weight: numOrNull(s.weight),
          reps: numOrNull(s.reps),
          restAfterSec: numOrNull(s.restAfterSec),
        })),
        restAfterExerciseSec: numOrNull(ex.restAfterExerciseSec),
      })),
    };
  }
  const lunch = (payload.lunchCarb || "").toString().toLowerCase();
  const fat = (payload.fatChoice || "").toString().toLowerCase();
  return {
    date: (payload.date || "").toString().slice(0, 10),
    weight: numOrNull(payload.weight),
    trained: !!payload.trained,
    waist: measurements.waist ?? null,
    measurements,
    coffees: numOrNull(payload.coffees),
    lunchCarb: lunch === "rice" || lunch === "bread" ? lunch : "",
    fatChoice: fat === "oil" || fat === "mayo" ? fat : "",
    mealChecks,
    workout: payload.trained ? workout : null,
    steps: numOrNull(payload.steps),
    sleep: numOrNull(payload.sleep),
    hunger: numOrNull(payload.hunger),
    energy: numOrNull(payload.energy),
    notes: (payload.notes || "").toString(),
  };
}

function normalizeDietTemplate(payload) {
  if (!payload || !(payload.training?.meals && payload.rest?.meals)) {
    throw new Error("Invalid diet template (need training + rest meals)");
  }
  const cleanMeals = (meals, prefix) =>
    (meals || [])
      .map((m, i) => ({
        id: (m.id || `${prefix}${i + 1}`).toString(),
        name: (m.name || `Meal ${i + 1}`).toString(),
        when: (m.when || "").toString(),
        items: (m.items || []).map((x) => String(x).trim()).filter(Boolean),
      }))
      .filter((m) => m.items.length || m.name);
  const cleanTargets = (t = {}) => ({
    kcal: t.kcal ?? null,
    protein: t.protein ?? null,
    carbs: t.carbs ?? null,
    fat: t.fat ?? null,
  });
  return {
    name: (payload.name || "Diet plan").toString(),
    notes: (payload.notes || "").toString(),
    training: {
      label: payload.training?.label || "Training day",
      targets: cleanTargets(payload.training?.targets),
      meals: cleanMeals(payload.training.meals, "train_"),
    },
    rest: {
      label: payload.rest?.label || "Rest day",
      targets: cleanTargets(payload.rest?.targets),
      meals: cleanMeals(payload.rest.meals, "rest_"),
    },
  };
}

function normalizeTrainingTemplate(payload) {
  if (!payload || !Array.isArray(payload.sessions)) {
    throw new Error("Invalid training template (need sessions array)");
  }
  return {
    name: (payload.name || "Training plan").toString(),
    notes: (payload.notes || "").toString(),
    sessions: payload.sessions.map((s, si) => ({
      id: (s.id || `session_${si + 1}`).toString(),
      name: (s.name || `Session ${si + 1}`).toString(),
      exercises: (s.exercises || []).map((e, ei) => ({
        id: (e.id || `ex_${si + 1}_${ei + 1}`).toString(),
        name: (e.name || `Exercise ${ei + 1}`).toString(),
        youtubeUrl: (e.youtubeUrl || "").toString(),
        targetSets: e.targetSets ?? 3,
        targetReps: (e.targetReps || "").toString(),
        notes: (e.notes || "").toString(),
      })),
    })),
  };
}

function compressImage(file, maxSide = 1400, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => {
          URL.revokeObjectURL(url);
          if (!blob) reject(new Error("compress failed"));
          else resolve(blob);
        },
        "image/jpeg",
        quality
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image load failed"));
    };
    img.src = url;
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  const [header, data] = dataUrl.split(",");
  const mime = header.match(/:(.*?);/)[1];
  const binary = atob(data);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

const Store = {
  async migrateIfNeeded() {
    const phases = await idbGetAll("phases");
    if (phases.length) return;

    const legacy = await idbGetAll("dietPhases");
    if (legacy.length) {
      for (const old of legacy) {
        const ranged = ensureTwoWeekRange(old.startDate || (old.createdAt || "").slice(0, 10) || todayISO());
        const dietId = uid("diet");
        const trainId = uid("train");
        const trainBody = defaultTrainingContent();
        await idbPut("phases", {
          id: old.id,
          name: old.name,
          startDate: ranged.startDate,
          endDate: ranged.endDate,
          active: !!old.active,
          createdAt: old.createdAt || new Date().toISOString(),
          archivedAt: old.archivedAt || null,
          notes: old.notes || "",
          dietPlanId: dietId,
          trainingPlanId: trainId,
        });
        await idbPut("dietPlans", {
          id: dietId,
          phaseId: old.id,
          name: "Diet plan",
          createdAt: new Date().toISOString(),
          notes: old.notes || "",
          training: old.training,
          rest: old.rest,
        });
        await idbPut("trainingPlans", {
          id: trainId,
          phaseId: old.id,
          name: "Training plan",
          createdAt: new Date().toISOString(),
          ...trainBody,
        });
      }
      return;
    }

    const bundle = createPhaseBundle();
    await idbPut("phases", bundle.phase);
    await idbPut("dietPlans", bundle.dietPlan);
    await idbPut("trainingPlans", bundle.trainingPlan);
  },

  async allPhases() {
    await this.migrateIfNeeded();
    return (await idbGetAll("phases")).sort((a, b) =>
      String(b.startDate || "").localeCompare(String(a.startDate || ""))
    );
  },

  async getPhase(id) {
    return idbGet("phases", id);
  },

  async savePhase(phase) {
    if (phase.startDate) {
      const r = ensureTwoWeekRange(phase.startDate);
      phase.startDate = r.startDate;
      phase.endDate = r.endDate;
    }
    await idbPut("phases", phase);
  },

  async deletePhase(phaseId) {
    const phase = await this.getPhase(phaseId);
    if (!phase) return;
    if (phase.dietPlanId) await idbDelete("dietPlans", phase.dietPlanId);
    if (phase.trainingPlanId) await idbDelete("trainingPlans", phase.trainingPlanId);
    // also delete diet/train by phase index scan
    for (const d of await idbGetAll("dietPlans")) {
      if (d.phaseId === phaseId) await idbDelete("dietPlans", d.id);
    }
    for (const t of await idbGetAll("trainingPlans")) {
      if (t.phaseId === phaseId) await idbDelete("trainingPlans", t.id);
    }
    await idbDelete("phases", phaseId);
  },

  async getPhaseForDate(dateISO) {
    const phases = await this.allPhases();
    const covering = phases.filter((p) => phaseCoversDate(p, dateISO));
    if (covering.length) {
      return covering.find((p) => p.active) || covering[0];
    }
    return phases.find((p) => p.active) || phases[0] || null;
  },

  async createPhase({ name, startDate } = {}) {
    const phases = await this.allPhases();
    const active = phases.find((p) => p.active);
    const start =
      startDate ||
      (active?.endDate ? addDaysISO(active.endDate, 1) : todayISO());
    if (active) {
      active.active = false;
      active.archivedAt = new Date().toISOString();
      if (active.startDate) {
        const r = ensureTwoWeekRange(active.startDate);
        active.endDate = r.endDate;
      }
      await this.savePhase(active);
    }
    const bundle = createPhaseBundle(start);
    bundle.phase.name = name || `Phase ${phases.length + 1}`;
    bundle.phase.active = true;
    await idbPut("phases", bundle.phase);
    await idbPut("dietPlans", bundle.dietPlan);
    await idbPut("trainingPlans", bundle.trainingPlan);
    return bundle.phase;
  },

  async getDietForPhase(phaseId) {
    const all = await idbGetAll("dietPlans");
    return all.find((d) => d.phaseId === phaseId) || null;
  },

  async saveDietPlan(plan) {
    // enforce one per phase: remove others
    const all = await idbGetAll("dietPlans");
    for (const d of all) {
      if (d.phaseId === plan.phaseId && d.id !== plan.id) await idbDelete("dietPlans", d.id);
    }
    await idbPut("dietPlans", plan);
    const phase = await this.getPhase(plan.phaseId);
    if (phase) {
      phase.dietPlanId = plan.id;
      await idbPut("phases", phase);
    }
  },

  async deleteDietForPhase(phaseId) {
    const plan = await this.getDietForPhase(phaseId);
    if (plan) await idbDelete("dietPlans", plan.id);
    const phase = await this.getPhase(phaseId);
    if (phase) {
      phase.dietPlanId = null;
      await idbPut("phases", phase);
    }
  },

  async getTrainingForPhase(phaseId) {
    const all = await idbGetAll("trainingPlans");
    return all.find((t) => t.phaseId === phaseId) || null;
  },

  async saveTrainingPlan(plan) {
    const all = await idbGetAll("trainingPlans");
    for (const t of all) {
      if (t.phaseId === plan.phaseId && t.id !== plan.id) await idbDelete("trainingPlans", t.id);
    }
    await idbPut("trainingPlans", plan);
    const phase = await this.getPhase(plan.phaseId);
    if (phase) {
      phase.trainingPlanId = plan.id;
      await idbPut("phases", phase);
    }
  },

  async deleteTrainingForPhase(phaseId) {
    const plan = await this.getTrainingForPhase(phaseId);
    if (plan) await idbDelete("trainingPlans", plan.id);
    const phase = await this.getPhase(phaseId);
    if (phase) {
      phase.trainingPlanId = null;
      await idbPut("phases", phase);
    }
  },

  async importDietTemplate(payload, phaseId) {
    const normalized = normalizeDietTemplate(payload);
    let plan = await this.getDietForPhase(phaseId);
    if (!plan) {
      plan = { id: uid("diet"), phaseId, createdAt: new Date().toISOString() };
    }
    Object.assign(plan, normalized, { phaseId, updatedAt: new Date().toISOString() });
    await this.saveDietPlan(plan);
    return plan;
  },

  async importTrainingTemplate(payload, phaseId) {
    const normalized = normalizeTrainingTemplate(payload);
    let plan = await this.getTrainingForPhase(phaseId);
    if (!plan) {
      plan = { id: uid("train"), phaseId, createdAt: new Date().toISOString() };
    }
    Object.assign(plan, normalized, { phaseId, updatedAt: new Date().toISOString() });
    await this.saveTrainingPlan(plan);
    return plan;
  },

  async importDayTemplate(payload, dateISO) {
    const normalized = normalizeDayTemplate(payload);
    const date = (dateISO || normalized.date || todayISO()).toString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Need a valid date (YYYY-MM-DD)");
    const existing = (await this.getDay(date)) || { date };
    const phase = await this.getPhaseForDate(date);
    const measureOut = { ...(existing.measurements || {}) };
    Object.entries(normalized.measurements || {}).forEach(([k, v]) => {
      if (v != null) measureOut[k] = v;
    });
    const merged = {
      ...existing,
      ...normalized,
      date,
      phaseId: phase?.id || existing.phaseId || null,
      mealChecks: { ...(existing.mealChecks || {}), ...(normalized.mealChecks || {}) },
      measurements: measureOut,
      waist: measureOut.waist ?? existing.waist ?? null,
      updatedAt: new Date().toISOString(),
    };
    // Keep existing values when template left a field empty/null (partial AI fill)
    const keepIfEmpty = ["weight", "coffees", "steps", "sleep", "hunger", "energy", "notes", "lunchCarb", "fatChoice"];
    for (const key of keepIfEmpty) {
      const next = normalized[key];
      const empty = next == null || next === "";
      if (empty && existing[key] != null && existing[key] !== "") merged[key] = existing[key];
    }
    if (!Object.prototype.hasOwnProperty.call(payload, "trained") && existing.trained != null) {
      merged.trained = existing.trained;
    }
    if (!normalized.workout && existing.workout) merged.workout = existing.workout;
    if (!Object.keys(normalized.mealChecks || {}).length && existing.mealChecks) {
      merged.mealChecks = existing.mealChecks;
    }
    await this.saveDay(merged);
    return merged;
  },

  async getDay(date) {
    return (await idbGet("days", date)) || null;
  },
  async saveDay(entry) {
    await idbPut("days", entry);
  },
  async allDays() {
    const rows = await idbGetAll("days");
    const map = {};
    rows.forEach((r) => {
      map[r.date] = r;
    });
    return map;
  },

  async photosForDate(date) {
    return (await idbGetAll("photos"))
      .filter((p) => p.date === date)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },
  async allPhotos() {
    return (await idbGetAll("photos")).sort((a, b) =>
      a.date === b.date ? a.createdAt.localeCompare(b.createdAt) : b.date.localeCompare(a.date)
    );
  },
  async addPhoto(date, file) {
    const blob = await compressImage(file);
    const photo = {
      id: uid("photo"),
      date,
      createdAt: new Date().toISOString(),
      mime: "image/jpeg",
      size: blob.size,
      blob,
    };
    await idbPut("photos", photo);
    return photo;
  },
  async deletePhoto(id) {
    await idbDelete("photos", id);
  },

  async allAnalyses() {
    return (await idbGetAll("analyses")).sort((a, b) => b.importedAt.localeCompare(a.importedAt));
  },
  async saveAnalysis(a) {
    await idbPut("analyses", a);
  },

  async clearAll() {
    for (const s of ["days", "photos", "analyses", "phases", "dietPlans", "trainingPlans", "dietPhases", "meta"]) {
      try {
        await idbClear(s);
      } catch (_) {}
    }
    const bundle = createPhaseBundle();
    await idbPut("phases", bundle.phase);
    await idbPut("dietPlans", bundle.dietPlan);
    await idbPut("trainingPlans", bundle.trainingPlan);
  },

  async migrateLegacyLocalStorage() {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return { migrated: 0 };
    const legacy = JSON.parse(raw);
    let migrated = 0;
    for (const [date, entry] of Object.entries(legacy)) {
      if (!(await this.getDay(date))) {
        await this.saveDay({ ...entry, date });
        migrated++;
      }
    }
    return { migrated };
  },

  async exportFull() {
    await this.migrateIfNeeded();
    const photos = [];
    for (const p of await idbGetAll("photos")) {
      photos.push({
        ...p,
        blob: undefined,
        dataUrl: await blobToDataUrl(p.blob),
      });
    }
    return {
      type: "cut-tracker-full-backup",
      version: 4,
      exportedAt: new Date().toISOString(),
      phases: await idbGetAll("phases"),
      dietPlans: await idbGetAll("dietPlans"),
      trainingPlans: await idbGetAll("trainingPlans"),
      days: await idbGetAll("days"),
      analyses: await idbGetAll("analyses"),
      photos,
    };
  },

  async importFull(payload, { merge = true } = {}) {
    if (payload?.type !== "cut-tracker-full-backup") throw new Error("Not a full backup");
    if (!merge) await this.clearAll();
    for (const p of payload.phases || []) await idbPut("phases", p);
    for (const d of payload.dietPlans || []) await idbPut("dietPlans", d);
    for (const t of payload.trainingPlans || []) await idbPut("trainingPlans", t);
    for (const day of payload.days || []) await idbPut("days", day);
    for (const a of payload.analyses || []) await idbPut("analyses", a);
    for (const p of payload.photos || []) {
      if (!p.dataUrl) continue;
      await idbPut("photos", {
        id: p.id,
        date: p.date,
        createdAt: p.createdAt,
        mime: p.mime || "image/jpeg",
        size: p.size || 0,
        blob: dataUrlToBlob(p.dataUrl),
      });
    }
    await this.migrateIfNeeded();
  },

  async exportAiPack() {
    await this.migrateIfNeeded();
    const daysMap = await this.allDays();
    const days = Object.values(daysMap).sort((a, b) => a.date.localeCompare(b.date));
    const phases = await this.allPhases();
    const dietPlans = await idbGetAll("dietPlans");
    const trainingPlans = await idbGetAll("trainingPlans");
    const photos = await this.allPhotos();
    const analyses = await this.allAnalyses();
    const weights = days
      .filter((d) => typeof d.weight === "number")
      .map((d) => ({
        date: d.date,
        weight: d.weight,
        measurements: d.measurements || null,
        coffees: d.coffees ?? null,
        trained: !!d.trained,
      }));
    return {
      type: "cut-tracker-ai-pack",
      version: 4,
      exportedAt: new Date().toISOString(),
      phases,
      dietPlans,
      trainingPlans,
      summary: {
        dayCount: days.length,
        weighInCount: weights.length,
        photoCount: photos.length,
        analysisCount: analyses.length,
      },
      weights,
      days,
      photoInventory: photos.map((p) => ({ id: p.id, date: p.date, createdAt: p.createdAt })),
      analyses,
    };
  },

  exportBlankDietTemplate: blankDietTemplate,
  exportBlankTrainingTemplate: blankTrainingTemplate,
  exportBlankDayTemplate: blankDayTemplate,
  exportDayTemplate: dayToTemplate,
};

window.CutDB = Store;
window.CutDBHelpers = {
  uid,
  MEASURE_FIELDS,
  PHASE_LENGTH_DAYS,
  todayISO,
  addDaysISO,
  twoWeekEnd,
  ensureTwoWeekRange,
  getPhaseWeekInfo,
  phaseCoversDate,
  blankDietTemplate,
  blankTrainingTemplate,
  blankDayTemplate,
  normalizeDietTemplate,
  normalizeTrainingTemplate,
  normalizeDayTemplate,
  defaultDietContent,
  defaultTrainingContent,
  LEGACY_KEY,
};
