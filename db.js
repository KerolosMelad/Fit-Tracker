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

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function clampWeekday(v, fallback = null) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const r = Math.round(n);
  return r >= 0 && r <= 6 ? r : fallback;
}

function weekdayOfISO(dateISO) {
  if (!dateISO) return null;
  const d = new Date(`${dateISO}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.getDay();
}

function sessionMatchKey(session) {
  return `${session?.id || ""} ${session?.name || ""}`.toLowerCase();
}

function inferRecommendedWeekday(session, index, total) {
  const k = sessionMatchKey(session);
  if (/upper[_\s-]*a/.test(k)) return 0;
  if (/lower[_\s-]*a/.test(k)) return 1;
  if (/upper[_\s-]*b/.test(k)) return 3;
  if (/lower[_\s-]*b/.test(k)) return 5;
  const fallback = total === 2 ? [0, 3] : total === 4 ? [0, 1, 3, 5] : [0, 1, 2, 3, 4, 5, 6];
  return fallback[index] ?? null;
}

function defaultProposedTime(weekday) {
  const t = { 0: "19:30–20:40", 1: "19:30–20:40", 3: "18:20–19:30", 5: "09:30–10:45" };
  return t[weekday] || "";
}

function uniquifyRecommendedWeekdays(sessions) {
  const used = new Set();
  const prefer = [0, 1, 3, 5, 2, 4, 6];
  return (sessions || []).map((s, si, arr) => {
    let day = clampWeekday(s.recommendedWeekday);
    if (day == null || used.has(day)) day = inferRecommendedWeekday(s, si, arr.length);
    if (day == null || used.has(day)) day = prefer.find((d) => !used.has(d)) ?? null;
    if (day != null) used.add(day);
    const time = String(s.proposedTime || "").trim() || defaultProposedTime(day);
    return { ...s, recommendedWeekday: day, proposedTime: time };
  });
}

function normalizeScheduleOverrides(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  Object.entries(raw).forEach(([date, sid]) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    out[date] = sid == null || sid === false ? "" : String(sid);
  });
  return out;
}

function recommendedSessionId(plan, dateISO) {
  const dow = weekdayOfISO(dateISO);
  if (dow == null) return "";
  const hit = (plan?.sessions || []).find((s) => clampWeekday(s.recommendedWeekday) === dow);
  return hit?.id ? String(hit.id) : "";
}

function plannedSessionId(plan, dateISO) {
  if (!plan || !dateISO) return "";
  const overrides = plan.scheduleOverrides || {};
  if (Object.prototype.hasOwnProperty.call(overrides, dateISO)) {
    return overrides[dateISO] ? String(overrides[dateISO]) : "";
  }
  return recommendedSessionId(plan, dateISO);
}

function findSessionByHint(plan, ...hints) {
  const sessions = plan?.sessions || [];
  for (const hint of hints) {
    const re = hint instanceof RegExp ? hint : null;
    const hit = sessions.find((s) => (re ? re.test(sessionMatchKey(s)) : s.id === hint));
    if (hit) return hit;
  }
  return null;
}

/** Friday that starts the current shopping week (local). On Friday = today. */
function shoppingWeekFriday(dateISO = todayISO()) {
  const d = new Date(`${dateISO}T12:00:00`);
  if (Number.isNaN(d.getTime())) return dateISO;
  const day = d.getDay(); // 0 Sun … 5 Fri
  const sinceFri = (day - 5 + 7) % 7;
  d.setDate(d.getDate() - sinceFri);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
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

/** System prompts for in-app OpenRouter calls. Always demand JSON-only where a type is specified. */
const AI_PROMPTS = {
  day: `You fill a KeJu Fit Tracker day-log JSON from user notes and any existing fields.

Output rules:
- Return ONLY one JSON object. No markdown fences, no commentary.
- Keep "type":"cut-tracker-day-template" and the given version.
- Never invent weigh-ins, measurements, meal checks, or workout sets the user did not provide.
- Unknown → null, "", {}, or [] as appropriate for that field.

Field rules:
- date: YYYY-MM-DD or "" (app may override on import).
- weight: kg number or null.
- trained: true = training day, false = rest day.
- coffees: cup count (integer) or null — never put coffee inside meals.
- measurements: only keys present in the template; numbers or null. Composition may include bodyFatPct (%), fatMass, muscleMass, skeletalMuscle, fatFreeMass, visceralFat (rating), bmi, bmr (kcal), bodyWaterKg, bodyWaterPct, proteinKg, boneMass, bodyScore, bodyAge, heartRate, waistHipRatio. Tape cm: waist, hips, chest, neck, shoulders, armRight, armLeft, thighRight, thighLeft, calfRight, calfLeft.
- mealChecks: mealId → true/false only for ids the user/diet provides.
- swapPicks: foodSwapId → chosen option string (what they used today).
- workout: null when trained is false. When trained is true: sessionId, sessionName, exercises[].sets[{weight,reps,restAfterSec}].
- hunger/energy: 1–5 or null. steps: integer or null. sleep: hours or null. notes: string.`,

  diet: `You produce KeJu Fit Tracker diet JSON for a fat-loss cut.

Output rules:
- Return ONLY one JSON object. No markdown fences, no commentary.
- type must be "cut-tracker-diet-template", version 3.
- Prefer the user's exact food wording and amounts.
- If unsure about a food, amount, meal, target, or swap → OMIT it (null / [] / skip). Never invent or guess.
- Do not keep leftover template meals absent from the user's text.
- Coffee / milk / sugar for coffee → notes only (e.g. "Coffee ×3; skimmed milk 100 g ×3"). Never meal items.

Required shape:
{
  "type": "cut-tracker-diet-template",
  "version": 3,
  "name": "string",
  "notes": "string",
  "training": {
    "label": "Training day",
    "targets": { "kcal": number|null, "protein": number|null, "carbs": number|null, "fat": number|null },
    "meals": [ { "id": "string", "name": "string", "when": "string", "items": ["food amount"], "kcal": number, "protein": number, "carbs": number, "fat": number, "swaps": ["swap_id"], "recipes": [] } ]
  },
  "rest": { "label": "Rest day", "targets": { "kcal": number|null, "protein": number|null, "carbs": number|null, "fat": number|null }, "meals": [] },
  "foodSwaps": [ { "id": "string", "label": "Protein", "options": ["chicken breast 220 g", "turkey 220 g"] } ],
  "prep": { "cookDays": ["fri"], "eatDays": ["sun", "mon", "tue", "wed", "thu"], "notes": "string" }
}

Parsing plain text:
- Rest / no-training sections → rest. Training sections → training.
- One day type only → fill that side; other meals: [] and null targets unless text says both days are identical — then copy.
- Meal headers → meals in order. Every food line → one items[] string with amount.
- Stable meal ids: breakfast, snack1, lunch, snack2, dinner, preGym, afterGym, supper.
- targets: estimate only when enough foods exist; else null. Plausible cut ranges only (kcal ~1200–3500, protein ~80–250 g).
- foodSwaps: only clear alternatives from the text (or / "or" / listed options / train-vs-rest same slot). Each group ≥2 real options with amounts. If doubtful → [].

When filling from goals (no plain text): practical high-protein cut; concrete amounts; 2–4 realistic swaps only.`,

  training: `You produce KeJu Fit Tracker training-plan JSON.

Output rules:
- Return ONLY one JSON object. No markdown fences, no commentary.
- type must be "cut-tracker-training-template", version 2.
- Prefer the user's exact exercise (lift) names. Do not invent lifts.
- Session names: use the user's labels when present (Legs, Arms, Push, Pull, Upper, Day A, etc.). If only Day 1/2, keep "Day 1" or a clear label — never invent body-part names.
- Plan-level restBetweenSetsSec / restBetweenExercisesSec are DEFAULTS only.
- Per exercise: set restBetweenSetsSec and restAfterExerciseSec when the text gives rest for that lift; else null (app uses plan defaults).
- youtubeUrl: REQUIRED whenever a YouTube / youtu.be / m.youtube.com link appears for that lift (same line, next line, or notes). Accept with or without https://. Never invent links. Put the URL in youtubeUrl, not only in notes.
- Do not keep leftover template sessions/exercises absent from the input.
- Preserve session and exercise order.

Required shape:
{
  "type": "cut-tracker-training-template",
  "version": 2,
  "name": "string",
  "notes": "string",
  "restBetweenSetsSec": number,
  "restBetweenExercisesSec": number,
  "sessions": [
    {
      "id": "string",
      "name": "Legs",
      "exercises": [
        {
          "id": "string",
          "name": "Squat",
          "youtubeUrl": "https://youtu.be/…",
          "targetSets": number,
          "targetReps": "string",
          "restBetweenSetsSec": number|null,
          "restAfterExerciseSec": number|null,
          "notes": "string"
        }
      ]
    }
  ]
}

Parsing:
- Prefer structured dumps: workout / workout_name / exercise / name / sets_reps / rest_between_sets_sec / rest_between_exercises_sec / youtube_url.
- Day / session headers (Legs, Arms, Push, "Day 1 — Upper") → sessions with that name.
- Lines under → exercises. "3x8" / "3×8-10" / "2-3x12-15" → targetSets + targetReps.
- Rest cues on a lift → that exercise's rest fields.
- Plan-wide "Rest between sets: 90s" → plan defaults.
- Every URL → that exercise's youtubeUrl.`,

  analysis: `You are an evidence-based cut coach for KeJu Fit Tracker.

Rules:
- Use ONLY logged numbers. Never invent calories, weights, or body-comp.
- If data is too thin for a claim → say so; do not invent trends.
- Concrete actions for the next 1–2 weeks. Skip fluff.
- Cover only what the pack supports: weight/comp trends, adherence, whether diet/training need change.

Return ONLY:
{ "type": "cut-tracker-analysis", "title": "short title", "timestamp": "ISO-8601", "content": "plain text review" }`,

  dailyInsight: `Concise cut coach for KeJu Fit Tracker (today + ~7 recent days).

Rules:
- ONLY logged numbers. No invented calories/weights.
- 4–8 lines max. If little was logged, say that and give 1–2 generic next steps — do not fabricate adherence stats.
- 2–4 concrete recommendations for tomorrow.

Return ONLY:
{ "type": "cut-tracker-analysis", "title": "Daily · YYYY-MM-DD", "timestamp": "ISO-8601", "content": "Summary:\\n…\\n\\nRecommendations:\\n- …" }`,

  phaseInsight: `Concise cut coach: one finished 2-week phase → next-phase advice.

Rules:
- ONLY logged numbers. No invented calories.
- Short phase summary + 3–5 next-phase bullets. If data is sparse, say so and keep advice conservative.

Return ONLY:
{ "type": "cut-tracker-analysis", "title": "Phase · {name}", "timestamp": "ISO-8601", "content": "Phase summary:\\n…\\n\\nNext phase:\\n- …" }`,

  scaleOcr: `Extract ONLY clearly readable measured weight + body-composition numbers from a scale/InBody screenshot.

Ignore tape, clothing, Ideal/Target/Control/Standard Weight, goals, decorative charts.

Return ONLY:
{
  "weight": number|null,
  "measurements": {
    "bodyFatPct": number|null, "fatMass": number|null, "muscleMass": number|null, "skeletalMuscle": number|null,
    "fatFreeMass": number|null, "visceralFat": number|null, "bmi": number|null, "bmr": number|null,
    "bodyWaterKg": number|null, "bodyWaterPct": number|null, "proteinKg": number|null, "boneMass": number|null,
    "bodyScore": number|null, "bodyAge": number|null, "heartRate": number|null, "waistHipRatio": number|null
  }
}

Rules:
- Digits exactly as shown. Unclear / blurry / conflicting → null (never guess).
- weight = measured Weight kg only (not Ideal/Target).
- bodyFatPct = Body Fat %; fatMass = Fat Mass kg — never swap.
- muscleMass ≠ SMM; skeletalMuscle = SMM only when labeled.
- Plausible adult ranges only; if a number is absurd for that field → null.
- No tape cm fields.`,

  foodRescue: `KeJu Fit Tracker on-cut food coach. Plain text only (not JSON), under 14 lines.

The user may lock the situation to ONE meal (focusMeal). You must still use the full day.

Answer in this order:
1) THIS MEAL — what to eat (or skip) now, with amounts. Use that meal's foodSwaps first.
2) REST OF TODAY — what to change on later / remaining meals so the day still fits. Name those meals. If no change, say "no change".
3) DAY TOTAL — roughly how leftover kcal / P / C / F land vs targets after the fix.

Rules:
- Do not invent weigh-ins or logged calories.
- Prefer listed foodSwaps; otherwise close equivalents with amounts.
- Do not rewrite meals already marked eaten unless the user said they messed those up too.
- Stay high-protein, controlled carbs/fat.
- If a key fact is missing (what they actually ate), ask one short question instead of guessing.`,

  shoppingList: `Weekly grocery list from diet meals (ignore food swaps). Return ONLY JSON.
Consolidate duplicates; scale by trainingDays × train meals + restDays × rest meals.
Supermarket units (eggs as pieces/dozen, meat as kg, milk as L). Omit unclear lines.
{ "type": "cut-tracker-shopping-list", "version": 2, "items": [ { "id": "string", "name": "eggs", "amount": "2 dozen", "category": "Eggs" } ] }`,
};
const MEASURE_FIELDS = [
  { key: "bodyFatPct", label: "Body fat", unit: "%", group: "comp" },
  { key: "fatMass", label: "Fat mass", unit: "kg", group: "comp" },
  { key: "muscleMass", label: "Muscle mass", unit: "kg", group: "comp" },
  { key: "skeletalMuscle", label: "Skeletal muscle", unit: "kg", group: "comp" },
  { key: "fatFreeMass", label: "Fat-free mass", unit: "kg", group: "comp" },
  { key: "visceralFat", label: "Visceral fat", unit: "rating", group: "comp", step: "1" },
  { key: "bmi", label: "BMI", unit: "", group: "comp" },
  { key: "bmr", label: "BMR", unit: "kcal", group: "comp", step: "1" },
  { key: "bodyWaterKg", label: "Body water", unit: "kg", group: "comp" },
  { key: "bodyWaterPct", label: "Body water", unit: "%", group: "comp" },
  { key: "proteinKg", label: "Protein", unit: "kg", group: "comp" },
  { key: "boneMass", label: "Bone mass", unit: "kg", group: "comp" },
  { key: "bodyScore", label: "Body score", unit: "pts", group: "comp", step: "1" },
  { key: "bodyAge", label: "Body age", unit: "yr", group: "comp", step: "1" },
  { key: "heartRate", label: "Heart rate", unit: "bpm", group: "comp", step: "1" },
  { key: "waistHipRatio", label: "Waist–hip ratio", unit: "", group: "comp", step: "0.01" },
  { key: "waist", label: "Waist", unit: "cm", group: "tape" },
  { key: "hips", label: "Hips", unit: "cm", group: "tape" },
  { key: "chest", label: "Chest", unit: "cm", group: "tape" },
  { key: "neck", label: "Neck", unit: "cm", group: "tape" },
  { key: "shoulders", label: "Shoulders", unit: "cm", group: "tape" },
  { key: "armRight", label: "Arm (R)", unit: "cm", group: "tape" },
  { key: "armLeft", label: "Arm (L)", unit: "cm", group: "tape" },
  { key: "thighRight", label: "Thigh (R)", unit: "cm", group: "tape" },
  { key: "thighLeft", label: "Thigh (L)", unit: "cm", group: "tape" },
  { key: "calfRight", label: "Calf (R)", unit: "cm", group: "tape" },
  { key: "calfLeft", label: "Calf (L)", unit: "cm", group: "tape" },
];

function defaultPrepMeta() {
  return {
    cookDays: ["fri"],
    eatDays: ["sun", "mon", "tue", "wed", "thu"],
    notes: "",
  };
}

function emptyDietContent() {
  return {
    notes: "",
    prep: defaultPrepMeta(),
    training: {
      label: "Training day",
      targets: { kcal: null, protein: null, carbs: null, fat: null },
      meals: [],
    },
    rest: {
      label: "Rest day",
      targets: { kcal: null, protein: null, carbs: null, fat: null },
      meals: [],
    },
  };
}

function emptyTrainingContent() {
  return {
    notes: "",
    restBetweenSetsSec: 90,
    restBetweenExercisesSec: 120,
    sessions: [],
  };
}

/** @deprecated alias — kept empty (no sample meals) */
function defaultDietContent() {
  return emptyDietContent();
}

/** @deprecated alias — kept empty (no sample sessions) */
function defaultTrainingContent() {
  return emptyTrainingContent();
}

function createPhaseBundle(startDate = todayISO(), { phaseNumber = 1 } = {}) {
  const ranged = ensureTwoWeekRange(startDate);
  const phaseId = uid("phase");
  const dietId = uid("diet");
  const trainId = uid("train");
  const dietBody = emptyDietContent();
  const trainBody = emptyTrainingContent();
  const label = String(phaseNumber);
  return {
    phase: {
      id: phaseId,
      name: label,
      startDate: ranged.startDate,
      endDate: ranged.endDate,
      active: true,
      createdAt: new Date().toISOString(),
      archivedAt: null,
      notes: "",
      goalLossPctPerWeek: Number(window.KEJU_CONFIG?.goalLossPctPerWeek) || 0.75,
      trainingDaysPerWeek: 4,
      dietPlanId: dietId,
      trainingPlanId: trainId,
    },
    dietPlan: {
      id: dietId,
      phaseId,
      name: label,
      createdAt: new Date().toISOString(),
      foodSwaps: [],
      foodRescueChat: [],
      ...dietBody,
    },
    trainingPlan: {
      id: trainId,
      phaseId,
      name: label,
      createdAt: new Date().toISOString(),
      ...trainBody,
    },
  };
}

function blankDietTemplate() {
  return {
    type: "cut-tracker-diet-template",
    version: 3,
    name: "",
    notes: "",
    prep: defaultPrepMeta(),
    foodSwaps: [],
    training: emptyDietContent().training,
    rest: emptyDietContent().rest,
  };
}

function blankTrainingTemplate() {
  return {
    type: "cut-tracker-training-template",
    version: 2,
    name: "",
    notes: "",
    restBetweenSetsSec: 90,
    restBetweenExercisesSec: 120,
    sessions: [],
  };
}

function blankPhaseTemplate() {
  return {
    type: "cut-tracker-phase-template",
    version: 1,
    goalLossPctPerWeek: Number(window.KEJU_CONFIG?.goalLossPctPerWeek) || 0.75,
    trainingDaysPerWeek: 4,
    notes: "",
    diet: blankDietTemplate(),
    training: blankTrainingTemplate(),
    shoppingList: { items: [] },
  };
}

/** Hand-authored shopping rows for a phase pack (stored on diet.shoppingList). */
function cleanShoppingListItems(raw) {
  const src = Array.isArray(raw) ? raw : raw?.items;
  if (!Array.isArray(src)) return [];
  return src
    .map((it, i) => {
      const name = String(it?.name || "").trim();
      if (!name || name.length < 2) return null;
      return {
        id: String(it?.id || `shop_${i + 1}`),
        name,
        amount: String(it?.amount || "").trim(),
        hint: String(it?.hint || "").trim(),
        category: String(it?.category || "Other").trim() || "Other",
        done: !!it?.done,
        custom: !!it?.custom,
      };
    })
    .filter(Boolean);
}

/**
 * Normalize a full phase pack (goal + diet + swaps + shopping + training).
 * Nested diet/training use the same validators as standalone templates.
 */
function normalizePhaseTemplate(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid phase pack (need a JSON object)");
  }
  if (payload.type && payload.type !== "cut-tracker-phase-template") {
    throw new Error(`That JSON is a "${payload.type}" — need cut-tracker-phase-template.`);
  }

  let goalLossPctPerWeek = Number(payload.goalLossPctPerWeek);
  if (!Number.isFinite(goalLossPctPerWeek) || goalLossPctPerWeek <= 0) {
    goalLossPctPerWeek = Number(window.KEJU_CONFIG?.goalLossPctPerWeek) || 0.75;
  }
  goalLossPctPerWeek = Math.max(0.3, Math.min(1.5, goalLossPctPerWeek));

  let trainingDaysPerWeek = Number(payload.trainingDaysPerWeek);
  if (!Number.isFinite(trainingDaysPerWeek)) trainingDaysPerWeek = 4;
  trainingDaysPerWeek = Math.max(0, Math.min(7, Math.round(trainingDaysPerWeek)));

  const dietPayload = payload.diet || payload.dietPlan;
  if (!dietPayload) throw new Error("Phase pack needs a diet object.");
  const diet = normalizeDietTemplate(
    {
      type: "cut-tracker-diet-template",
      version: 3,
      ...dietPayload,
      foodSwaps: dietPayload.foodSwaps ?? payload.foodSwaps,
    },
    {}
  );

  const trainPayload = payload.training || payload.trainingPlan;
  if (!trainPayload) throw new Error("Phase pack needs a training object.");
  const training = normalizeTrainingTemplate({
    type: "cut-tracker-training-template",
    version: 2,
    ...trainPayload,
  });

  const shopRaw = payload.shoppingList ?? payload.shopping ?? dietPayload.shoppingList;
  const shopItems = cleanShoppingListItems(shopRaw);
  const shoppingList = shopItems.length
    ? {
        weekKey: shoppingWeekFriday(),
        generatedAt: new Date().toISOString(),
        version: 3,
        trainingDaysPerWeek,
        restDaysPerWeek: Math.max(0, 7 - trainingDaysPerWeek),
        mode: "pack",
        status: "ready",
        needsRefresh: false,
        items: shopItems,
        error: null,
      }
    : null;

  return {
    goalLossPctPerWeek,
    trainingDaysPerWeek,
    notes: String(payload.notes || "").trim(),
    diet,
    training,
    shoppingList,
  };
}

function blankDayTemplate(date = "") {
  const measurements = {};
  MEASURE_FIELDS.forEach((m) => {
    measurements[m.key] = null;
  });
  return {
    type: "cut-tracker-day-template",
    version: 2,
    date: date || "",
    weight: null,
    trained: false,
    measurements,
    coffees: null,
    swapPicks: {},
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
    swapPicks: { ...(entry.swapPicks || {}) },
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
  const swapPicks = {};
  Object.entries(payload.swapPicks || {}).forEach(([id, v]) => {
    const opt = (v || "").toString().trim();
    if (id && opt) swapPicks[String(id)] = opt;
  });
  return {
    date: (payload.date || "").toString().slice(0, 10),
    weight: numOrNull(payload.weight),
    trained: !!payload.trained,
    waist: measurements.waist ?? null,
    measurements,
    coffees: numOrNull(payload.coffees),
    lunchCarb: lunch === "rice" || lunch === "bread" ? lunch : "",
    fatChoice: fat === "oil" || fat === "mayo" ? fat : "",
    swapPicks,
    mealChecks,
    workout: payload.trained ? workout : null,
    steps: numOrNull(payload.steps),
    sleep: numOrNull(payload.sleep),
    hunger: numOrNull(payload.hunger),
    energy: numOrNull(payload.energy),
    notes: (payload.notes || "").toString(),
  };
}

function cleanHttpUrl(raw) {
  const s = String(raw || "").trim();
  if (!/^https?:\/\//i.test(s)) return "";
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.toString();
  } catch {
    return "";
  }
}

function cleanRecipes(list) {
  return (list || [])
    .map((r, i) => {
      if (!r || typeof r !== "object") return null;
      const name = String(r.name || r.title || "").trim();
      if (name.length < 2) return null;
      const mins = Number(r.prepMinutes ?? r.minutes ?? r.time);
      return {
        id: String(r.id || `recipe_${i + 1}`),
        name,
        prepMinutes: Number.isFinite(mins) && mins > 0 ? Math.min(24 * 60, Math.round(mins)) : null,
        video:
          normalizeYoutubeUrl(r.video || r.videoUrl || r.youtube) ||
          cleanHttpUrl(r.video || r.videoUrl),
        steps: (r.steps || []).map((x) => String(x).trim()).filter((x) => x.length > 1).slice(0, 12),
        makes: String(r.makes || r.yield || "").trim(),
      };
    })
    .filter(Boolean)
    .slice(0, 3);
}

function cleanPrepMeta(raw) {
  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const norm = (list, fallback) => {
    const out = (Array.isArray(list) ? list : [])
      .map((d) => String(d || "").slice(0, 3).toLowerCase())
      .filter((d) => days.includes(d));
    return out.length ? [...new Set(out)] : fallback;
  };
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    cookDays: norm(src.cookDays, ["fri"]),
    eatDays: norm(src.eatDays, ["sun", "mon", "tue", "wed", "thu"]),
    notes: String(src.notes || "").trim(),
  };
}

function dietRecipeCount(diet) {
  const meals = [...(diet?.training?.meals || []), ...(diet?.rest?.meals || [])];
  return meals.reduce((n, m) => n + (m.recipes || []).length, 0);
}

function normalizeDietTemplate(payload, { plainText, keepRecipes = true } = {}) {
  if (!payload || !(payload.training?.meals && payload.rest?.meals)) {
    throw new Error("Invalid diet template (need training + rest meals)");
  }
  const posMacro = (n) => {
    const x = Number(n);
    return Number.isFinite(x) && x > 0 ? Math.round(x) : null;
  };
  const cleanMealSwaps = (list) => {
    if (!Array.isArray(list)) return undefined;
    return [...new Set(list.map((x) => String(x).trim()).filter(Boolean))];
  };
  const cleanMeals = (meals, prefix) =>
    (meals || [])
      .map((m, i) => {
        const kcal = posMacro(m.kcal);
        const protein = posMacro(m.protein);
        const carbs = posMacro(m.carbs);
        const fat = posMacro(m.fat);
        const swaps = cleanMealSwaps(m.swaps);
        return {
        id: (m.id || `${prefix}${i + 1}`).toString(),
        name: (m.name || `Meal ${i + 1}`).toString().trim(),
        when: (m.when || "").toString().trim(),
        items: (m.items || []).map((x) => String(x).trim()).filter((x) => x.length > 1),
        recipes: keepRecipes ? cleanRecipes(m.recipes) : [],
        ...(kcal != null ? { kcal } : {}),
        ...(protein != null ? { protein } : {}),
        ...(carbs != null ? { carbs } : {}),
        ...(fat != null ? { fat } : {}),
        ...(swaps !== undefined ? { swaps } : {}),
      };
      })
      .filter((m) => m.items.length >= 1 && m.name);
  const cleanTargets = (t = {}) => sanitizeMacroTargets(t);
  let foodSwaps = cleanFoodSwaps(payload.foodSwaps);
  if (plainText) foodSwaps = filterSwapsAgainstSource(foodSwaps, plainText, payload);

  const trainingMeals = cleanMeals(payload.training.meals, "train_");
  const restMeals = cleanMeals(payload.rest.meals, "rest_");
  if (!trainingMeals.length && !restMeals.length) {
    throw new Error("Diet parse produced no usable meals — try again or paste clearer text");
  }

  return {
    name: (payload.name || "Diet plan").toString().trim() || "Diet plan",
    notes: (payload.notes || "").toString(),
    prep: cleanPrepMeta(payload.prep),
    foodSwaps,
    training: {
      label: payload.training?.label || "Training day",
      targets: trainingMeals.length ? cleanTargets(payload.training?.targets) : sanitizeMacroTargets({}),
      meals: trainingMeals,
    },
    rest: {
      label: payload.rest?.label || "Rest day",
      targets: restMeals.length ? cleanTargets(payload.rest?.targets) : sanitizeMacroTargets({}),
      meals: restMeals,
    },
  };
}

function sanitizeMacroTargets(t = {}) {
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  let kcal = num(t.kcal);
  let protein = num(t.protein);
  let carbs = num(t.carbs);
  let fat = num(t.fat);
  // Drop doubted / absurd cut targets
  if (kcal != null && (kcal < 900 || kcal > 4500)) kcal = null;
  if (protein != null && (protein < 40 || protein > 300)) protein = null;
  if (carbs != null && (carbs < 0 || carbs > 600)) carbs = null;
  if (fat != null && (fat < 0 || fat > 200)) fat = null;
  return { kcal, protein, carbs, fat };
}

function cleanFoodSwaps(swaps) {
  return (swaps || [])
    .map((s, i) => ({
      id: (s.id || `swap_${i + 1}`).toString(),
      label: (s.label || `Swap ${i + 1}`).toString(),
      options: (s.options || []).map((x) => String(x).trim()).filter((x) => x.length > 2),
    }))
    .filter((s) => s.options.length >= 2);
}

/** Keep swap options only if they appear (loosely) in source text or meal items — drop inventions. */
function filterSwapsAgainstSource(swaps, plainText, payload) {
  const blob = [
    plainText || "",
    payload?.notes || "",
    ...(payload?.training?.meals || []).flatMap((m) => m.items || []),
    ...(payload?.rest?.meals || []).flatMap((m) => m.items || []),
  ]
    .join("\n")
    .toLowerCase();
  if (!blob.trim()) return swaps;
  const tokenOk = (opt) => {
    const core = String(opt)
      .toLowerCase()
      .replace(/[0-9]+(?:[.,][0-9]+)?\s*(g|kg|ml|l|pcs?|scoop)?/gi, " ")
      .replace(/[^a-z\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (core.length < 3) return false;
    const words = core.split(" ").filter((w) => w.length > 2);
    if (!words.length) return false;
    // require most significant words to appear in source
    const hits = words.filter((w) => blob.includes(w)).length;
    return hits >= Math.ceil(words.length * 0.6);
  };
  return (swaps || [])
    .map((s) => ({ ...s, options: (s.options || []).filter(tokenOk) }))
    .filter((s) => s.options.length >= 2);
}

/** Normalize YouTube / youtu.be links (with or without https). */
function normalizeYoutubeUrl(raw) {
  if (raw == null) return "";
  let text = String(raw).trim();
  if (!text) return "";
  // Markdown [label](url)
  const md = text.match(/\[[^\]]*\]\(([^)]+)\)/);
  if (md) text = md[1].trim();
  // Bare 11-char video id
  if (/^[\w-]{11}$/.test(text)) return `https://youtu.be/${text}`;

  const patterns = [
    /https?:\/\/(?:www\.|m\.|music\.)?youtube\.com\/(?:watch\?[^\s]*\bv=[\w-]{6,}[^\s]*)/i,
    /https?:\/\/(?:www\.)?youtu\.be\/[\w-]{6,}[^\s]*/i,
    /https?:\/\/(?:www\.|m\.)?youtube\.com\/(?:shorts|embed|live)\/[\w-]{6,}[^\s]*/i,
    /(?:www\.|m\.|music\.)?youtube\.com\/(?:watch\?[^\s]*\bv=[\w-]{6,}[^\s]*)/i,
    /(?:www\.)?youtu\.be\/[\w-]{6,}[^\s]*/i,
    /(?:www\.|m\.)?youtube\.com\/(?:shorts|embed|live)\/[\w-]{6,}[^\s]*/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    let url = m[0].replace(/[),.;'"\]]+$/g, "");
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./i, "");
      if (!/(^|\.)youtube\.com$/i.test(host) && !/^youtu\.be$/i.test(host)) continue;
      const id =
        u.searchParams.get("v") ||
        (u.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{6,})/) || [])[1] ||
        (host === "youtu.be" ? u.pathname.replace(/^\//, "").split("/")[0] : "");
      if (id && /^[\w-]{6,}$/.test(id)) return `https://youtu.be/${id}`;
      return u.toString();
    } catch (_) {
      return url;
    }
  }
  return "";
}

function youtubeVideoId(raw) {
  const url = normalizeYoutubeUrl(raw);
  if (!url) return "";
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./i, "");
    if (host === "youtu.be") return u.pathname.replace(/^\//, "").split("/")[0] || "";
    return (
      u.searchParams.get("v") ||
      (u.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{6,})/) || [])[1] ||
      ""
    );
  } catch {
    return "";
  }
}

function stripUrlFromText(text) {
  return String(text || "")
    .replace(/https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\/[^\s)\]>"']+/gi, " ")
    .replace(/(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\/[^\s)\]>"']+/gi, " ")
    .replace(/\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clampRestSec(n, fallback = null) {
  if (n == null || n === "") return fallback;
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(600, Math.round(v)));
}

function extractRestFromLine(line) {
  const raw = String(line || "");
  let restBetweenSetsSec = null;
  let restAfterExerciseSec = null;
  const setM =
    raw.match(/rest\s*(?:between\s*)?sets?\s*[:=]?\s*(\d{1,3})\b/i) ||
    raw.match(/\bsets?\s*rest\s*[:=]?\s*(\d{1,3})\b/i) ||
    raw.match(/(\d{1,3})\s*(?:s|sec|secs|seconds)\s*(?:rest\s*)?(?:between\s*)?sets?\b/i);
  const exM =
    raw.match(/\bafter\s*(\d{1,3})\b/i) ||
    raw.match(/rest\s*(?:after|before\s*next|between\s*exercises?)\s*[:=]?\s*(\d{1,3})\b/i) ||
    raw.match(/\bbefore\s*next(?:\s*ex(?:ercise)?)?\s*[:=]?\s*(\d{1,3})\b/i) ||
    raw.match(/(\d{1,3})\s*(?:s|sec|secs|seconds)\s*(?:after|before\s*next|between\s*exercises?)\b/i);
  if (setM) restBetweenSetsSec = clampRestSec(setM[1]);
  if (exM) restAfterExerciseSec = clampRestSec(exM[1]);
  const slash = raw.match(/\b(\d{2,3})\s*\/\s*(\d{2,3})\b/);
  if (slash && restBetweenSetsSec == null && restAfterExerciseSec == null) {
    restBetweenSetsSec = clampRestSec(slash[1]);
    restAfterExerciseSec = clampRestSec(slash[2]);
  }
  return { restBetweenSetsSec, restAfterExerciseSec };
}

function extractRestDefaultsFromText(text) {
  const raw = String(text || "");
  // Prefer explicit plan-default phrasing so per-lift "rest sets 180" does not become the plan default
  const sets =
    raw.match(/(?:^|\n)\s*(?:default\s+)?rest\s+between\s+sets?\s*[:=]?\s*(\d{1,3})\b/i) ||
    raw.match(/(?:^|\n)\s*default\s+rest\s*(?:between\s*)?sets?\s*[:=]?\s*(\d{1,3})\b/i);
  const ex =
    raw.match(/(?:^|\n)\s*(?:default\s+)?rest\s+between\s+exercises?\s*[:=]?\s*(\d{1,3})\b/i) ||
    raw.match(/(?:^|\n)\s*default\s+rest\s*(?:between\s*)?exercises?\s*[:=]?\s*(\d{1,3})\b/i);
  return {
    restBetweenSetsSec: sets ? clampRestSec(sets[1]) : null,
    restBetweenExercisesSec: ex ? clampRestSec(ex[1]) : null,
  };
}

function isTrainingSessionHeader(line) {
  const t = String(line || "").trim();
  if (!t || t.length > 60) return false;
  if (normalizeYoutubeUrl(t) && stripUrlFromText(t).length < 2) return false;
  if (/^(rest\s*between|notes?\b|plan\b)/i.test(t)) return false;
  if (/\d+\s*[x×]\s*\d/i.test(t)) return false;
  return (
    /^(day\s*\d+|session\s*\d+|workout\s*\d+|day\s*[a-d]\b)/i.test(t) ||
    /^(legs?|arms?|push|pull|upper|lower|full\s*body|chest|back|shoulders?|core|glutes?)\b/i.test(t) ||
    /^day\s*\d+\s*[—\-:]\s*.+/i.test(t) ||
    /^(workout|session)\s*[—\-:]/i.test(t)
  );
}

function cleanSessionTitle(line) {
  let t = String(line || "").trim();
  t = t.replace(/^(day|session|workout)\s*\d+\s*[—\-:]\s*/i, "");
  t = t.replace(/^(day|session|workout)\s*/i, "").trim();
  t = t.replace(/^[a-d]\s*[—\-:]\s*/i, "").trim() || t;
  return t || String(line || "").trim();
}

/** Walk pasted plan: session titles + per-lift youtube/rest, in order. */
function parseTrainingPlainTextHints(plainText) {
  const lines = String(plainText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const sessions = [];
  let cur = null;
  let pending = null;

  const pushPending = () => {
    if (!pending || !cur) return;
    cur.exercises.push(pending);
    pending = null;
  };

  const ensureSession = (name) => {
    if (cur) return;
    cur = { name: name || `Session ${sessions.length + 1}`, exercises: [] };
    sessions.push(cur);
  };

  for (const line of lines) {
    if (/^(?:default\s+)?rest\s+between\b/i.test(line)) continue;
    if (/^notes?\b/i.test(line) && line.length < 80 && !/\d+\s*[x×]/i.test(line)) continue;

    if (isTrainingSessionHeader(line)) {
      pushPending();
      cur = { name: cleanSessionTitle(line) || line, exercises: [] };
      sessions.push(cur);
      continue;
    }

    const url = normalizeYoutubeUrl(line);
    const rest = extractRestFromLine(line);
    const withoutUrl = stripUrlFromText(line);
    const pureUrl = !!(url && withoutUrl.length < 2);

    if (pureUrl) {
      if (pending) {
        if (!pending.youtubeUrl) pending.youtubeUrl = url;
        if (pending.restBetweenSetsSec == null && rest.restBetweenSetsSec != null) {
          pending.restBetweenSetsSec = rest.restBetweenSetsSec;
        }
        if (pending.restAfterExerciseSec == null && rest.restAfterExerciseSec != null) {
          pending.restAfterExerciseSec = rest.restAfterExerciseSec;
        }
      }
      continue;
    }

    const looksLift =
      /[a-z]/i.test(withoutUrl) &&
      !/^(rest\s*between|default)/i.test(withoutUrl) &&
      (/\d+\s*[x×]/i.test(withoutUrl) || withoutUrl.split(/\s+/).length <= 8);

    if (looksLift) {
      ensureSession(`Session ${sessions.length + 1}`);
      pushPending();
      let name = withoutUrl
        .replace(/\b\d+\s*[x×]\s*[\d\-–]+/gi, " ")
        .replace(/\b\d{2,3}\s*\/\s*\d{2,3}\b/g, " ")
        .replace(/\b(?:rest|sets?\s*rest|after)\b.*$/i, " ")
        .replace(/\s+/g, " ")
        .trim();
      // Keep a cleaner lift name: drop trailing rest fragments
      name = name
        .replace(/\b\d{2,3}\s*(?:s|sec|secs|seconds)?\s*$/i, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!name || name.length < 2) name = withoutUrl.slice(0, 40);
      // Re-parse rest from full line (name cleaning may have stripped words)
      const restFull = extractRestFromLine(line);
      pending = {
        name,
        youtubeUrl: url || "",
        restBetweenSetsSec: restFull.restBetweenSetsSec,
        restAfterExerciseSec: restFull.restAfterExerciseSec,
      };
    } else if (pending) {
      if (url && !pending.youtubeUrl) pending.youtubeUrl = url;
      if (pending.restBetweenSetsSec == null && rest.restBetweenSetsSec != null) {
        pending.restBetweenSetsSec = rest.restBetweenSetsSec;
      }
      if (pending.restAfterExerciseSec == null && rest.restAfterExerciseSec != null) {
        pending.restAfterExerciseSec = rest.restAfterExerciseSec;
      }
    }
  }
  pushPending();
  return sessions.filter((s) => s.exercises.length > 0);
}

function liftKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickHintExercise(hintEx, e, ei) {
  if (!hintEx?.length) return null;
  const b = liftKey(e.name);
  const byName = hintEx.find((h) => {
    const a = liftKey(h.name);
    return a && b && (a === b || a.includes(b) || b.includes(a));
  });
  if (byName) return byName;
  return hintEx[ei] || null;
}

/** Merge plain-text youtube/rest/session names onto AI sessions (name-first, then order). */
function mergePlainTextHintsIntoSessions(sessions, plainText) {
  if (!sessions?.length) return sessions;
  const hints = parseTrainingPlainTextHints(plainText);
  if (!hints.length) {
    return enrichTrainingYoutubeFromPlainText(sessions, plainText);
  }

  const usedHint = new Set();
  return sessions.map((s, si) => {
    let hintS =
      hints.find((h, hi) => !usedHint.has(hi) && liftKey(h.name) && liftKey(h.name) === liftKey(s.name)) ||
      null;
    if (!hintS && hints.length === sessions.length) hintS = hints[si];
    if (!hintS) {
      const hi = hints.findIndex((h, idx) => !usedHint.has(idx));
      hintS = hi >= 0 ? hints[hi] : null;
      if (hi >= 0) usedHint.add(hi);
    } else {
      const hi = hints.indexOf(hintS);
      if (hi >= 0) usedHint.add(hi);
    }

    const genericAiName = !s.name || /^(session\s*)?\d+$/i.test(String(s.name));
    const sessionName = (!genericAiName ? s.name : null) || hintS?.name || s.name || `Session ${si + 1}`;

    const hintEx = hintS?.exercises || [];
    const exercises = (s.exercises || []).map((e, ei) => {
      const hit = pickHintExercise(hintEx, e, ei);
      let youtubeUrl =
        normalizeYoutubeUrl(e.youtubeUrl) || normalizeYoutubeUrl(e.notes) || normalizeYoutubeUrl(e.name);
      if (!youtubeUrl && hit?.youtubeUrl) youtubeUrl = normalizeYoutubeUrl(hit.youtubeUrl) || hit.youtubeUrl;
      const restBetweenSetsSec = clampRestSec(e.restBetweenSetsSec) ?? hit?.restBetweenSetsSec ?? null;
      const restAfterExerciseSec = clampRestSec(e.restAfterExerciseSec) ?? hit?.restAfterExerciseSec ?? null;
      const name = stripUrlFromText(e.name) || e.name;
      const notes = stripUrlFromText(e.notes || "");
      return {
        ...e,
        name,
        notes,
        youtubeUrl: youtubeUrl || "",
        restBetweenSetsSec,
        restAfterExerciseSec,
      };
    });
    return { ...s, name: sessionName, exercises };
  });
}

function parseSetsRepsField(raw) {
  const s = String(raw || "").trim();
  if (!s) return { targetSets: 3, targetReps: "8-12", notes: "" };
  const m = s.match(/^(\d+)\s*[-–]\s*(\d+)\s*[x×]\s*(.+)$/i);
  if (m) {
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    return {
      targetSets: Math.max(1, Math.min(12, Math.max(lo, hi))),
      targetReps: m[3].trim(),
      notes: `Sets range ${lo}-${hi}`,
    };
  }
  const m2 = s.match(/^(\d+)\s*[x×]\s*(.+)$/i);
  if (m2) {
    return {
      targetSets: Math.max(1, Math.min(12, Number(m2[1]) || 3)),
      targetReps: m2[2].trim(),
      notes: "",
    };
  }
  if (/min|walk|cardio|easy/i.test(s)) {
    return { targetSets: 1, targetReps: s, notes: "" };
  }
  return { targetSets: 3, targetReps: s, notes: "" };
}

function looksLikeStructuredTraining(text) {
  const t = String(text || "");
  return (
    /workout\s*:\s*\d+/i.test(t) &&
    /(youtube_url|sets_reps|workout_name|rest_between_sets_sec)\s*:/i.test(t)
  );
}

/**
 * Deterministic parse for key-value training dumps, e.g.
 * workout: 1
 * workout_name: Glute Shape
 * exercise: 1
 * name: Leg press
 * sets_reps: 2-3x12-15
 * rest_between_sets_sec: 90
 * rest_between_exercises_sec: 120
 * youtube_url: https://www.youtube.com/watch?v=…
 */
function parseStructuredTrainingPlan(plainText) {
  const lines = String(plainText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!looksLikeStructuredTraining(lines.join("\n"))) return null;

  const sessions = [];
  const planNotes = [];
  let curSession = null;
  let curEx = null;
  let workoutOrdinal = 0;

  const flushEx = () => {
    if (!curEx || !curSession) {
      curEx = null;
      return;
    }
    if (String(curEx.name || "").trim().length >= 2) {
      curSession.exercises.push(curEx);
    }
    curEx = null;
  };
  const flushSession = () => {
    flushEx();
    if (curSession?.exercises?.length) sessions.push(curSession);
    curSession = null;
  };

  for (const line of lines) {
    const kv = line.match(/^([a-z0-9_]+)\s*:\s*(.*)$/i);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const val = kv[2].trim();

    if (key === "workout" || key === "workout_id" || key === "session") {
      flushSession();
      workoutOrdinal += 1;
      const n = val.replace(/\D+/g, "") || String(workoutOrdinal);
      curSession = {
        id: `session_${n}`,
        name: `Workout ${n}`,
        exercises: [],
      };
      continue;
    }
    if (key === "workout_name" || key === "session_name") {
      if (!curSession) {
        workoutOrdinal += 1;
        curSession = { id: `session_${workoutOrdinal}`, name: val || `Workout ${workoutOrdinal}`, exercises: [] };
      } else {
        curSession.name = val || curSession.name;
      }
      continue;
    }
    if (key === "exercise" || key === "exercise_id") {
      flushEx();
      if (!curSession) {
        workoutOrdinal += 1;
        curSession = { id: `session_${workoutOrdinal}`, name: `Workout ${workoutOrdinal}`, exercises: [] };
      }
      const n = val.replace(/\D+/g, "") || String((curSession.exercises.length || 0) + 1);
      curEx = {
        id: `ex_${workoutOrdinal}_${n}`,
        name: "",
        youtubeUrl: "",
        targetSets: 3,
        targetReps: "8-12",
        restBetweenSetsSec: null,
        restAfterExerciseSec: null,
        notes: "",
      };
      continue;
    }
    if (key === "phase" || key === "type") {
      flushSession();
      planNotes.push(`${key}: ${val}`);
      continue;
    }
    if ((key === "note" || key === "notes") && !curEx) {
      planNotes.push(val);
      continue;
    }

    if (!curEx) continue;

    if (key === "name" || key === "exercise_name" || key === "lift") {
      curEx.name = val;
    } else if (key === "sets_reps" || key === "setsreps" || key === "scheme") {
      const p = parseSetsRepsField(val);
      curEx.targetSets = p.targetSets;
      curEx.targetReps = p.targetReps;
      if (p.notes) curEx.notes = [curEx.notes, p.notes].filter(Boolean).join("; ");
    } else if (
      key === "rest_between_sets_sec" ||
      key === "rest_sets_sec" ||
      key === "rest_between_sets" ||
      key === "sets_rest_sec"
    ) {
      curEx.restBetweenSetsSec = clampRestSec(val);
    } else if (
      key === "rest_between_exercises_sec" ||
      key === "rest_after_exercise_sec" ||
      key === "rest_exercises_sec" ||
      key === "rest_between_exercises" ||
      key === "exercise_rest_sec"
    ) {
      curEx.restAfterExerciseSec = clampRestSec(val);
    } else if (key === "youtube_url" || key === "youtube" || key === "url" || key === "video" || key === "link") {
      curEx.youtubeUrl = normalizeYoutubeUrl(val) || val;
    } else if (key === "notes" || key === "note" || key === "cue") {
      curEx.notes = [curEx.notes, val].filter(Boolean).join("; ");
    } else if (key === "target_sets" || key === "sets") {
      const n = Number(val);
      if (Number.isFinite(n)) curEx.targetSets = Math.max(1, Math.min(12, Math.round(n)));
    } else if (key === "target_reps" || key === "reps") {
      curEx.targetReps = val;
    }
  }
  flushSession();

  if (!sessions.length) return null;

  return {
    type: "cut-tracker-training-template",
    version: 2,
    name: "",
    notes: planNotes.join("\n"),
    restBetweenSetsSec: 90,
    restBetweenExercisesSec: 120,
    sessions: uniquifyRecommendedWeekdays(
      sessions.map((s, si) => ({
      id: s.id || `session_${si + 1}`,
      name: s.name || `Workout ${si + 1}`,
      recommendedWeekday: clampWeekday(s.recommendedWeekday) ?? inferRecommendedWeekday(s, si, sessions.length),
      proposedTime: String(s.proposedTime || "").trim(),
      exercises: (s.exercises || []).map((e, ei) => ({
        id: e.id || `ex_${si + 1}_${ei + 1}`,
        name: e.name,
        youtubeUrl: normalizeYoutubeUrl(e.youtubeUrl) || e.youtubeUrl || "",
        targetSets: e.targetSets || 3,
        targetReps: e.targetReps || "8-12",
        restBetweenSetsSec: clampRestSec(e.restBetweenSetsSec),
        restAfterExerciseSec: clampRestSec(e.restAfterExerciseSec),
        notes: e.notes || "",
      })),
    }))
    ),
  };
}

/** Prefer structured local parse; otherwise null (caller may use AI). */
function tryParseTrainingFromPlainText(plainText) {
  const structured = parseStructuredTrainingPlan(plainText);
  if (structured?.sessions?.length) return structured;
  return null;
}

/** Attach YouTube URLs found on nearby lines when structured merge misses them. */
function enrichTrainingYoutubeFromPlainText(sessions, plainText) {
  if (!plainText || !sessions?.length) return sessions;
  const lines = String(plainText)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const byName = new Map();
  for (let i = 0; i < lines.length; i++) {
    const url = normalizeYoutubeUrl(lines[i]);
    if (!url) continue;
    const nameHere = stripUrlFromText(lines[i]);
    const prev = i > 0 ? stripUrlFromText(lines[i - 1]) : "";
    const key = liftKey(nameHere || prev);
    if (key) byName.set(key, url);
    const short = key.split(" ").slice(0, 3).join(" ");
    if (short) byName.set(short, url);
  }
  return sessions.map((s) => ({
    ...s,
    exercises: (s.exercises || []).map((e) => {
      if (normalizeYoutubeUrl(e.youtubeUrl)) return { ...e, youtubeUrl: normalizeYoutubeUrl(e.youtubeUrl) };
      const key = liftKey(e.name);
      let hit = byName.get(key);
      if (!hit) {
        for (const [k, url] of byName) {
          if (k && key && (key.includes(k) || k.includes(key))) {
            hit = url;
            break;
          }
        }
      }
      return hit ? { ...e, youtubeUrl: hit } : e;
    }),
  }));
}

function normalizeTrainingTemplate(payload, { plainText } = {}) {
  if (!payload || !Array.isArray(payload.sessions)) {
    throw new Error("Invalid training template (need sessions array)");
  }
  const fromText = extractRestDefaultsFromText(plainText || payload.notes || "");
  let restBetweenSetsSec = Number(payload.restBetweenSetsSec);
  let restBetweenExercisesSec = Number(payload.restBetweenExercisesSec);
  if (!Number.isFinite(restBetweenSetsSec) || restBetweenSetsSec < 0) {
    restBetweenSetsSec = fromText.restBetweenSetsSec ?? 90;
  }
  if (!Number.isFinite(restBetweenExercisesSec) || restBetweenExercisesSec < 0) {
    restBetweenExercisesSec = fromText.restBetweenExercisesSec ?? 120;
  }
  restBetweenSetsSec = clampRestSec(restBetweenSetsSec, 90);
  restBetweenExercisesSec = clampRestSec(restBetweenExercisesSec, 120);

  const sessions = payload.sessions
    .map((s, si) => {
      const exercises = (s.exercises || [])
        .map((e, ei) => {
          let name = (e.name || "").toString().trim();
          let notes = (e.notes || "").toString();
          let youtubeUrl =
            normalizeYoutubeUrl(e.youtubeUrl) ||
            normalizeYoutubeUrl(notes) ||
            normalizeYoutubeUrl(name);
          const lineRest = extractRestFromLine(`${name} ${notes}`);
          if (youtubeUrl) {
            name = stripUrlFromText(name) || name;
            notes = stripUrlFromText(notes);
          }
          name = name.trim();
          if (!name || name.length < 2) return null;
          let sets = Number(e.targetSets);
          if (!Number.isFinite(sets) || sets < 1 || sets > 12) sets = 3;
          const reps = (e.targetReps || "").toString().trim() || "8-12";
          return {
            id: (e.id || `ex_${si + 1}_${ei + 1}`).toString(),
            name,
            youtubeUrl: youtubeUrl || "",
            targetSets: sets,
            targetReps: reps,
            restBetweenSetsSec: clampRestSec(e.restBetweenSetsSec) ?? lineRest.restBetweenSetsSec,
            restAfterExerciseSec: clampRestSec(e.restAfterExerciseSec) ?? lineRest.restAfterExerciseSec,
            notes,
          };
        })
        .filter(Boolean);
      if (!exercises.length) return null;
      const rawName = (s.name || "").toString().trim();
      return {
        id: (s.id || `session_${si + 1}`).toString(),
        name: rawName || `Session ${si + 1}`,
        recommendedWeekday: clampWeekday(s.recommendedWeekday),
        proposedTime: String(s.proposedTime || "").trim(),
        exercises,
      };
    })
    .filter(Boolean);

  const enriched = plainText ? mergePlainTextHintsIntoSessions(sessions, plainText) : sessions;
  if (!enriched.length) {
    throw new Error("Training parse produced no usable sessions — try again or paste clearer text");
  }
  return {
    name: (payload.name || "").toString().trim() || "1",
    notes: (payload.notes || "").toString(),
    restBetweenSetsSec,
    restBetweenExercisesSec,
    sessions: uniquifyRecommendedWeekdays(enriched),
  };
}

/** Drop out-of-range / inconsistent scale OCR values instead of saving junk. */
function sanitizeScaleOcrResult(parsed) {
  if (!parsed || typeof parsed !== "object") return { weight: null, measurements: {} };
  const inRange = (n, lo, hi) => Number.isFinite(n) && n >= lo && n <= hi;
  const num = (v) => {
    const n = typeof v === "string" ? parseFloat(v.replace(",", ".")) : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  let weight = num(parsed.weight);
  if (weight != null && !inRange(weight, 35, 250)) weight = null;
  const mIn = parsed.measurements || {};
  const out = {};
  const rules = {
    bodyFatPct: [4, 55],
    fatMass: [2, 120],
    muscleMass: [15, 120],
    skeletalMuscle: [10, 80],
    fatFreeMass: [25, 150],
    visceralFat: [1, 40],
    bmi: [14, 50],
    bmr: [800, 3500],
    bodyWaterKg: [15, 80],
    bodyWaterPct: [30, 75],
    proteinKg: [5, 30],
    boneMass: [1, 8],
    bodyScore: [1, 100],
    bodyAge: [10, 100],
    heartRate: [35, 200],
    waistHipRatio: [0.5, 1.5],
  };
  for (const [k, [lo, hi]] of Object.entries(rules)) {
    const v = num(mIn[k]);
    out[k] = v != null && inRange(v, lo, hi) ? v : null;
  }
  // Consistency: fatMass ≈ weight * bf% — if wildly off, drop the doubted one
  if (weight != null && out.bodyFatPct != null && out.fatMass != null) {
    const expect = (weight * out.bodyFatPct) / 100;
    if (Math.abs(out.fatMass - expect) > Math.max(4, expect * 0.35)) {
      out.fatMass = null; // keep % which is usually clearer on screens
    }
  }
  return { weight, measurements: out };
}

function sanitizeInsightContent(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const content = String(parsed.content || "").trim();
  const title = String(parsed.title || "").trim();
  if (content.length < 40) return null;
  // Drop low-value / invented fluff
  if (
    /as an ai|i cannot|insufficient data to invent|i don't have (enough|access)|hallucin/i.test(content) &&
    content.length < 120
  ) {
    return null;
  }
  // Reject content that claims specific numbers without looking like real review text
  const fakeStats =
    /\b(adherence|compliance)\s*[:=]?\s*\d{2,3}%\b/i.test(content) &&
    !/\blog|weigh|kcal|protein|steps|sleep/i.test(content);
  if (fakeStats) return null;
  return {
    title: title || "Insight",
    content,
    timestamp: parsed.timestamp || new Date().toISOString(),
  };
}

/** Pull swap groups from plain text + meal "A or B" / "A / B" lines when AI misses them. */
function inferFoodSwapsFromPlainText(text, mealsTrain = [], mealsRest = []) {
  const found = [];
  const pushGroup = (label, options) => {
    const opts = [...new Set((options || []).map((o) => String(o).trim()).filter(Boolean))];
    if (opts.length < 2) return;
    found.push({ id: `swap_inf_${found.length + 1}`, label: label || `Swap ${found.length + 1}`, options: opts });
  };

  const raw = (text || "").toString();
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // Explicit section: "Swaps" / "Alternatives" / "Options" followed by labeled lines
  let inSwapSection = false;
  for (const line of lines) {
    if (/^(food\s*)?swaps?\b|alternatives?\b|options?\b|substitutions?\b/i.test(line) && !/\d+\s*g\b/i.test(line)) {
      inSwapSection = true;
      continue;
    }
    if (inSwapSection && /^(training|rest|day\s*\d|breakfast|lunch|dinner|snack)/i.test(line)) {
      inSwapSection = false;
    }
    if (inSwapSection) {
      const m = line.match(/^([^:]+):\s*(.+)$/);
      if (m) {
        const opts = m[2].split(/\s*(?:\/|\bor\b|,|;)\s*/i).map((x) => x.trim()).filter(Boolean);
        pushGroup(m[1].trim(), opts);
      } else {
        const opts = line.split(/\s*(?:\/|\bor\b)\s*/i).map((x) => x.trim()).filter(Boolean);
        if (opts.length >= 2) pushGroup("Swap", opts);
      }
    }
  }

  const itemLines = [
    ...lines,
    ...(mealsTrain || []).flatMap((m) => m.items || []),
    ...(mealsRest || []).flatMap((m) => m.items || []),
  ];
  for (const line of itemLines) {
    if (!/\bor\b|\//i.test(line)) continue;
    // Skip huge slash lists that look like paths
    if (line.includes("http") || line.includes("\\")) continue;
    const opts = line
      .split(/\s*(?:\bor\b|\/)\s*/i)
      .map((x) => x.trim())
      .filter((x) => x && x.length < 80);
    if (opts.length >= 2 && opts.length <= 5) pushGroup("Swap", opts);
  }

  // Same meal slot, different protein/carb between train vs rest
  const byName = (meals) => {
    const map = {};
    for (const m of meals || []) {
      const key = (m.name || "").toLowerCase().trim();
      if (key) map[key] = m.items || [];
    }
    return map;
  };
  const tMap = byName(mealsTrain);
  const rMap = byName(mealsRest);
  for (const name of Object.keys(tMap)) {
    if (!rMap[name]) continue;
    const a = tMap[name];
    const b = rMap[name];
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] && b[i] && a[i].toLowerCase() !== b[i].toLowerCase()) {
        const alike =
          /\b(chicken|turkey|beef|fish|tuna|salmon|egg|whey|protein|rice|potato|oat|pasta|bread|yogurt|cottage)\b/i.test(
            a[i] + " " + b[i]
          );
        if (alike) pushGroup(name || "Meal swap", [a[i], b[i]]);
      }
    }
  }

  return cleanFoodSwaps(found);
}

function mergeFoodSwaps(primary, secondary) {
  const out = [];
  const seen = new Set();
  const keyOf = (s) =>
    (s.options || [])
      .map((o) => o.toLowerCase())
      .sort()
      .join("|");
  for (const s of [...(primary || []), ...(secondary || [])]) {
    const cleaned = cleanFoodSwaps([s])[0];
    if (!cleaned) continue;
    const k = keyOf(cleaned);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(cleaned);
  }
  return out;
}

function canvasToJpegBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) reject(new Error("compress failed"));
        else resolve(blob);
      },
      "image/jpeg",
      quality
    );
  });
}

function drawScaledToCanvas(source, maxSide) {
  const w = source.width || source.videoWidth || 0;
  const h = source.height || source.videoHeight || 0;
  const scale = Math.min(1, maxSide / Math.max(w, h, 1));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function compressImage(file, maxSide = 1080, quality = 0.58) {
  // Prefer createImageBitmap so EXIF orientation is baked in (iPhone photos).
  if (typeof createImageBitmap === "function") {
    let bitmap = null;
    try {
      try {
        bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      } catch (_) {
        bitmap = await createImageBitmap(file);
      }
      const canvas = drawScaledToCanvas(bitmap, maxSide);
      bitmap.close?.();
      return await canvasToJpegBlob(canvas, quality);
    } catch (_) {
      try {
        bitmap?.close?.();
      } catch (_) {}
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = drawScaledToCanvas(img, maxSide);
        URL.revokeObjectURL(url);
        canvasToJpegBlob(canvas, quality).then(resolve, reject);
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image load failed"));
    };
    img.src = url;
  });
}

function recompressBlob(blob, maxSide = 900, quality = 0.5) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (out) => {
          URL.revokeObjectURL(url);
          if (!out) reject(new Error("recompress failed"));
          else resolve(out);
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
        const trainBody = emptyTrainingContent();
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
          foodSwaps: [],
          training: old.training || emptyDietContent().training,
          rest: old.rest || emptyDietContent().rest,
        });
        await idbPut("trainingPlans", {
          id: trainId,
          phaseId: old.id,
          name: "Training plan",
          createdAt: new Date().toISOString(),
          ...trainBody,
        });
      }
    }
    // Fresh install: no auto-seed — user creates phases / plans in the app.
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
    // Do not attach a day outside every range to the active phase.
    return null;
  },

  async createPhase({ name, startDate, notes, goalLossPctPerWeek, trainingDaysPerWeek } = {}) {
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
    const nums = phases
      .map((p) => Number(String(p.name || "").replace(/\D+/g, "") || NaN))
      .filter((n) => Number.isFinite(n) && n > 0);
    const phaseNumber = nums.length ? Math.max(...nums) + 1 : phases.length + 1;
    const bundle = createPhaseBundle(start, { phaseNumber });
    // Ignore manual names — always auto 1, 2, 3…
    if (name != null && String(name).trim() && /^\d+$/.test(String(name).trim())) {
      bundle.phase.name = String(name).trim();
      bundle.dietPlan.name = bundle.phase.name;
      bundle.trainingPlan.name = bundle.phase.name;
    }
    bundle.phase.active = true;
    if (notes != null) bundle.phase.notes = String(notes);
    const goal = Number(goalLossPctPerWeek);
    if (Number.isFinite(goal) && goal > 0) bundle.phase.goalLossPctPerWeek = goal;
    const td = Number(trainingDaysPerWeek);
    if (Number.isFinite(td)) {
      bundle.phase.trainingDaysPerWeek = Math.max(0, Math.min(7, Math.round(td)));
    }
    await idbPut("phases", bundle.phase);
    await idbPut("dietPlans", bundle.dietPlan);
    await idbPut("trainingPlans", bundle.trainingPlan);
    return bundle.phase;
  },

  /**
   * Create a phase and fill diet (swaps), shopping list, and training from one pack JSON.
   * Phase name stays auto-numbered; startDate comes from the form.
   */
  async createPhaseFromPack(payload, { startDate, packFile } = {}) {
    const pack = normalizePhaseTemplate(payload);
    const phase = await this.createPhase({
      startDate,
      notes: pack.notes,
      goalLossPctPerWeek: pack.goalLossPctPerWeek,
      trainingDaysPerWeek: pack.trainingDaysPerWeek,
    });
    if (packFile) {
      phase.packFile = String(packFile);
      await this.savePhase(phase);
    }
    const dietPayload = {
      type: "cut-tracker-diet-template",
      version: 3,
      name: pack.diet.name,
      notes: pack.diet.notes,
      prep: pack.diet.prep,
      foodSwaps: pack.diet.foodSwaps,
      training: pack.diet.training,
      rest: pack.diet.rest,
    };
    const diet = await this.importDietTemplate(dietPayload, phase.id, { trusted: true });
    if (pack.shoppingList) {
      const now = new Date().toISOString();
      diet.shoppingList = {
        ...pack.shoppingList,
        weekKey: shoppingWeekFriday(),
        generatedAt: now,
        needsRefresh: false,
        status: "ready",
      };
      diet.updatedAt = now;
      await this.saveDietPlan(diet);
    }
    const trainPayload = {
      type: "cut-tracker-training-template",
      version: 2,
      name: pack.training.name,
      notes: pack.training.notes,
      restBetweenSetsSec: pack.training.restBetweenSetsSec,
      restBetweenExercisesSec: pack.training.restBetweenExercisesSec,
      sessions: pack.training.sessions,
    };
    await this.importTrainingTemplate(trainPayload, phase.id);
    return { phase, pack };
  },

  /**
   * Reload a pack onto an existing phase (replaces diet/swaps/shopping/training; updates goal & train days).
   * Keeps phase id, name, dates, and active flag.
   */
  async applyPackToPhase(phaseId, payload, { goalLossPctPerWeek, trainingDaysPerWeek, notes, packFile, packStamp } = {}) {
    if (!phaseId) throw new Error("No phase selected.");
    const phase = await this.getPhase(phaseId);
    if (!phase) throw new Error("Phase not found.");
    const pack = normalizePhaseTemplate(payload);

    const goal =
      goalLossPctPerWeek != null && Number(goalLossPctPerWeek) > 0
        ? Number(goalLossPctPerWeek)
        : pack.goalLossPctPerWeek;
    const td =
      trainingDaysPerWeek != null && Number.isFinite(Number(trainingDaysPerWeek))
        ? Math.max(0, Math.min(7, Math.round(Number(trainingDaysPerWeek))))
        : pack.trainingDaysPerWeek;
    const noteText = notes != null ? String(notes) : pack.notes;

    phase.goalLossPctPerWeek = goal;
    phase.trainingDaysPerWeek = td;
    if (noteText != null) phase.notes = noteText;
    if (packFile) phase.packFile = String(packFile);
    if (packStamp) phase.packStamp = String(packStamp);
    phase.updatedAt = new Date().toISOString();
    await this.savePhase(phase);

    const dietPayload = {
      type: "cut-tracker-diet-template",
      version: 3,
      name: pack.diet.name,
      notes: pack.diet.notes,
      prep: pack.diet.prep,
      foodSwaps: pack.diet.foodSwaps,
      training: pack.diet.training,
      rest: pack.diet.rest,
    };
    const diet = await this.importDietTemplate(dietPayload, phaseId, { trusted: true });
    if (pack.shoppingList) {
      const now = new Date().toISOString();
      diet.shoppingList = {
        ...pack.shoppingList,
        weekKey: shoppingWeekFriday(),
        generatedAt: now,
        needsRefresh: false,
        status: "ready",
      };
      diet.updatedAt = now;
      await this.saveDietPlan(diet);
    }
    const trainPayload = {
      type: "cut-tracker-training-template",
      version: 2,
      name: pack.training.name,
      notes: pack.training.notes,
      restBetweenSetsSec: pack.training.restBetweenSetsSec,
      restBetweenExercisesSec: pack.training.restBetweenExercisesSec,
      sessions: pack.training.sessions,
    };
    await this.importTrainingTemplate(trainPayload, phaseId);
    return { phase, pack };
  },

  /**
   * Current phase → shareable pack JSON (diet, recipes, swaps, shopping, training).
   * Runtime fields (ids on the phone, shopping ticks) are stripped.
   */
  async exportPhaseAsPack(phaseId) {
    const phase = await this.getPhase(phaseId);
    if (!phase) throw new Error("Phase not found.");
    const diet = await this.getDietForPhase(phaseId);
    const training = await this.getTrainingForPhase(phaseId);
    if (!diet) throw new Error("Save a diet on this phase first.");
    if (!training) throw new Error("Save a training plan on this phase first.");

    const dietNorm = normalizeDietTemplate(
      {
        type: "cut-tracker-diet-template",
        version: 3,
        name: diet.name,
        notes: diet.notes,
        prep: diet.prep,
        foodSwaps: diet.foodSwaps,
        training: diet.training,
        rest: diet.rest,
      },
      { keepRecipes: true }
    );
    const trainNorm = normalizeTrainingTemplate({
      type: "cut-tracker-training-template",
      version: 2,
      name: training.name,
      notes: training.notes,
      restBetweenSetsSec: training.restBetweenSetsSec,
      restBetweenExercisesSec: training.restBetweenExercisesSec,
      sessions: training.sessions,
    });

    const slimMeals = (meals) =>
      (meals || []).map((m) => {
        const row = { id: m.id, name: m.name, when: m.when, items: m.items || [] };
        if (m.recipes?.length) row.recipes = m.recipes;
        if (Number(m.kcal) > 0) row.kcal = Math.round(Number(m.kcal));
        if (Number(m.protein) > 0) row.protein = Math.round(Number(m.protein));
        if (Number(m.carbs) > 0) row.carbs = Math.round(Number(m.carbs));
        if (Number(m.fat) > 0) row.fat = Math.round(Number(m.fat));
        if (Array.isArray(m.swaps)) row.swaps = m.swaps.map(String).filter(Boolean);
        return row;
      });

    const shopItems = cleanShoppingListItems(diet.shoppingList).map((it) => {
      const row = { id: it.id, name: it.name, amount: it.amount, category: it.category };
      if (it.hint) row.hint = it.hint;
      return row;
    });

    let goal = Number(phase.goalLossPctPerWeek);
    if (!Number.isFinite(goal) || goal <= 0) goal = Number(window.KEJU_CONFIG?.goalLossPctPerWeek) || 0.75;
    let td = Number(phase.trainingDaysPerWeek);
    if (!Number.isFinite(td)) td = 4;

    return {
      type: "cut-tracker-phase-template",
      version: 1,
      goalLossPctPerWeek: Math.max(0.3, Math.min(1.5, goal)),
      trainingDaysPerWeek: Math.max(0, Math.min(7, Math.round(td))),
      notes: String(phase.notes || "").trim(),
      diet: {
        type: "cut-tracker-diet-template",
        version: 3,
        name: dietNorm.name,
        notes: dietNorm.notes,
        training: { ...dietNorm.training, meals: slimMeals(dietNorm.training.meals) },
        rest: { ...dietNorm.rest, meals: slimMeals(dietNorm.rest.meals) },
        foodSwaps: dietNorm.foodSwaps || [],
        prep: dietNorm.prep,
      },
      training: {
        type: "cut-tracker-training-template",
        version: 2,
        name: trainNorm.name,
        notes: trainNorm.notes,
        restBetweenSetsSec: trainNorm.restBetweenSetsSec,
        restBetweenExercisesSec: trainNorm.restBetweenExercisesSec,
        sessions: trainNorm.sessions,
      },
      shoppingList: { items: shopItems },
    };
  },

  async getDietForPhase(phaseId) {
    if (!phaseId) return null;
    const phase = await this.getPhase(phaseId);
    if (phase?.dietPlanId) {
      const byId = await idbGet("dietPlans", phase.dietPlanId);
      if (byId) return byId;
    }
    const all = await idbGetAll("dietPlans");
    const matches = all.filter((d) => d.phaseId === phaseId);
    if (!matches.length) return null;
    // Prefer newest if orphans remain
    return matches.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0];
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

  /** trusted: hand-authored JSON (bundled template / uploaded file) — keep its swaps verbatim.
   *  Untrusted (AI output) still gets inferred + filtered against the source text. */
  async importDietTemplate(payload, phaseId, { plainText, trusted = false } = {}) {
    const sourceText = plainText || payload?.notes || "";
    const normalized = normalizeDietTemplate(payload, {
      plainText: trusted ? "" : sourceText,
      keepRecipes: !!trusted,
    });
    if (!trusted) {
      const inferred = inferFoodSwapsFromPlainText(
        sourceText,
        normalized.training?.meals,
        normalized.rest?.meals
      );
      normalized.foodSwaps = filterSwapsAgainstSource(
        mergeFoodSwaps(normalized.foodSwaps, inferred),
        sourceText,
        payload
      );
    }
    let plan = await this.getDietForPhase(phaseId);
    if (!plan) {
      plan = { id: uid("diet"), phaseId, createdAt: new Date().toISOString() };
    }
    const phase = await this.getPhase(phaseId);
    if (phase?.name) normalized.name = String(phase.name);
    Object.assign(plan, normalized, { phaseId, updatedAt: new Date().toISOString() });
    await this.saveDietPlan(plan);
    return plan;
  },

  async importTrainingTemplate(payload, phaseId, { plainText } = {}) {
    const normalized = normalizeTrainingTemplate(payload, { plainText });
    let plan = await this.getTrainingForPhase(phaseId);
    if (!plan) {
      plan = { id: uid("train"), phaseId, createdAt: new Date().toISOString() };
    }
    const phase = await this.getPhase(phaseId);
    if (phase?.name) normalized.name = String(phase.name);
    const prevOverrides = plan.scheduleOverrides;
    const prevSeed = plan.weekPlanSeed;
    Object.assign(plan, normalized, { phaseId, updatedAt: new Date().toISOString() });
    const incomingOverrides = normalizeScheduleOverrides(payload.scheduleOverrides);
    plan.scheduleOverrides = { ...(prevOverrides || {}), ...incomingOverrides };
    if (prevSeed && plan.weekPlanSeed == null) plan.weekPlanSeed = prevSeed;
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
  async addPhoto(date, file, opts = {}) {
    const blob = await compressImage(file);
    const photo = {
      id: uid("photo"),
      date,
      phaseId: opts.phaseId || null,
      kind: opts.kind || "phase-start",
      createdAt: new Date().toISOString(),
      mime: "image/jpeg",
      size: blob.size,
      name: file.name || "",
      storage: "embed",
      blob,
    };
    await idbPut("photos", photo);
    return photo;
  },
  async photosForPhase(phaseId) {
    if (!phaseId) return [];
    return (await idbGetAll("photos"))
      .filter((p) => p.phaseId === phaseId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },
  async photosForPhaseStart(phase) {
    if (!phase) return [];
    const byPhase = phase.id ? await this.photosForPhase(phase.id) : [];
    if (byPhase.length) return byPhase;
    if (!phase.startDate) return [];
    return this.photosForDate(phase.startDate);
  },
  async resolvePhotoBlob(photo) {
    if (photo?.blob instanceof Blob) return photo.blob;
    if (photo?.blob instanceof ArrayBuffer) {
      return new Blob([photo.blob], { type: photo.mime || "image/jpeg" });
    }
    if (ArrayBuffer.isView?.(photo?.blob)) {
      return new Blob([photo.blob], { type: photo.mime || "image/jpeg" });
    }
    throw new Error("Photo data missing");
  },
  async deletePhoto(id) {
    await idbDelete("photos", id);
  },
  async savePhoto(photo) {
    await idbPut("photos", photo);
    return photo;
  },
  async purgeAllPhotos() {
    const photos = await this.allPhotos();
    let freed = 0;
    for (const p of photos) {
      freed += p.size || p.blob?.size || 0;
      await idbDelete("photos", p.id);
    }
    return { removed: photos.length, freed };
  },

  async storageReport() {
    const photos = await this.allPhotos();
    const days = await idbGetAll("days");
    const photoBytes = photos.reduce((sum, p) => sum + (p.size || p.blob?.size || 0), 0);
    let usage = null;
    let quota = null;
    try {
      if (navigator.storage?.estimate) {
        const est = await navigator.storage.estimate();
        usage = est.usage ?? null;
        quota = est.quota ?? null;
      }
    } catch (_) {}
    return {
      photoCount: photos.length,
      photoBytes,
      dayCount: days.length,
      usage,
      quota,
    };
  },

  async recompressOlderPhotos({ olderThanDays = 14, maxSide = 900, quality = 0.5 } = {}) {
    const cutoff = addDaysISO(todayISO(), -Math.abs(olderThanDays));
    const photos = await this.allPhotos();
    let saved = 0;
    let touched = 0;
    for (const p of photos) {
      if (p.date > cutoff) continue;
      if (!p.blob) continue;
      const before = p.size || p.blob.size || 0;
      const next = await recompressBlob(p.blob, maxSide, quality);
      if (next.size >= before) continue;
      p.blob = next;
      p.size = next.size;
      p.mime = "image/jpeg";
      p.recompressedAt = new Date().toISOString();
      await idbPut("photos", p);
      saved += before - next.size;
      touched += 1;
    }
    return { touched, savedBytes: saved };
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
    try {
      localStorage.removeItem(LEGACY_KEY);
    } catch (_) {}
    // Drop DB so the next load is a true empty install (no leftover indexes/orphans)
    try {
      if (dbPromise) {
        const db = await dbPromise;
        db.close();
        dbPromise = null;
      }
      await new Promise((resolve) => {
        const req = indexedDB.deleteDatabase(DB_NAME);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });
    } catch (_) {}
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
      if (!p.blob) continue;
      photos.push({
        id: p.id,
        date: p.date,
        phaseId: p.phaseId || null,
        kind: p.kind || "phase-start",
        createdAt: p.createdAt,
        mime: p.mime || "image/jpeg",
        size: p.size || 0,
        name: p.name || "",
        storage: "embed",
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
        phaseId: p.phaseId || null,
        kind: p.kind || "phase-start",
        createdAt: p.createdAt,
        mime: p.mime || "image/jpeg",
        size: p.size || 0,
        name: p.name || "",
        storage: "embed",
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
  exportBlankPhaseTemplate: blankPhaseTemplate,
  exportBlankDayTemplate: blankDayTemplate,
  exportDayTemplate: dayToTemplate,
};

window.CutDB = Store;
window.CutDBHelpers = {
  uid,
  AI_PROMPTS,
  MEASURE_FIELDS,
  PHASE_LENGTH_DAYS,
  todayISO,
  addDaysISO,
  twoWeekEnd,
  ensureTwoWeekRange,
  shoppingWeekFriday,
  WEEKDAY_NAMES,
  WEEKDAY_SHORT,
  clampWeekday,
  weekdayOfISO,
  inferRecommendedWeekday,
  defaultProposedTime,
  uniquifyRecommendedWeekdays,
  normalizeScheduleOverrides,
  recommendedSessionId,
  plannedSessionId,
  findSessionByHint,
  sessionMatchKey,
  phaseCoversDate,
  blankDietTemplate,
  blankTrainingTemplate,
  blankPhaseTemplate,
  blankDayTemplate,
  normalizeDietTemplate,
  normalizeTrainingTemplate,
  normalizePhaseTemplate,
  cleanRecipes,
  cleanPrepMeta,
  dietRecipeCount,
  cleanShoppingListItems,
  tryParseTrainingFromPlainText,
  parseStructuredTrainingPlan,
  looksLikeStructuredTraining,
  normalizeDayTemplate,
  cleanFoodSwaps,
  inferFoodSwapsFromPlainText,
  mergeFoodSwaps,
  sanitizeScaleOcrResult,
  sanitizeInsightContent,
  sanitizeMacroTargets,
  filterSwapsAgainstSource,
  normalizeYoutubeUrl,
  youtubeVideoId,
  extractRestDefaultsFromText,
  defaultDietContent,
  defaultTrainingContent,
  emptyDietContent,
  emptyTrainingContent,
  compressImage,
  blobToDataUrl,
  LEGACY_KEY,
};
