const $ = (id) => document.getElementById(id);
const cfg = () => window.KEJU_CONFIG || {};

function applyBrand() {
  const c = cfg();
  document.title = c.brandName || "KeJu Fit Tracker";
  if ($("brandWordmark")) $("brandWordmark").textContent = c.brandShort || "KeJu";
  if ($("brandProduct")) $("brandProduct").textContent = c.brandProduct || "Fit Tracker";
  if ($("brandTagline")) $("brandTagline").textContent = c.tagline || "";
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  // Quiet registration — no update banner (it was sticking on iOS)
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

const undoStack = [];
const MAX_UNDO = 25;
let undoHideTimer = null;
let undoFadeTimer = null;

function cloneDay(entry) {
  return JSON.parse(JSON.stringify(entry || {}));
}

function hideUndoBar(immediate) {
  const bar = $("undoBar");
  if (!bar) return;
  clearTimeout(undoHideTimer);
  clearTimeout(undoFadeTimer);
  if (immediate) {
    bar.classList.remove("show", "fading");
    bar.hidden = true;
    return;
  }
  bar.classList.add("fading");
  bar.classList.remove("show");
  undoFadeTimer = setTimeout(() => {
    bar.hidden = true;
    bar.classList.remove("fading");
  }, 400);
}

function showUndoBar(label) {
  const bar = $("undoBar");
  if (!bar) return;
  if ($("undoLabel")) $("undoLabel").textContent = label || "Saved — undo?";
  clearTimeout(undoHideTimer);
  clearTimeout(undoFadeTimer);
  bar.hidden = false;
  bar.classList.remove("fading");
  // restart enter animation
  bar.classList.remove("show");
  void bar.offsetWidth;
  bar.classList.add("show");
  undoHideTimer = setTimeout(() => hideUndoBar(false), 5000);
}

async function undoLastSave() {
  const item = undoStack.pop();
  if (!item) {
    showToast("Nothing to undo");
    return;
  }
  await CutDB.saveDay(item.snapshot);
  hideUndoBar(true);
  if (($("logDate")?.value || "") === item.date) {
    await loadContextForDate(item.date);
    fillForm(item.snapshot, item.date);
    await refreshAll({ tab: document.querySelector(".nav-item.active")?.dataset.tab || "today" });
  }
  showToast("Undid: " + (item.label || "change"));
}

function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function refreshStorageHealth() {
  const report = await CutDB.storageReport();
  if ($("storageStatus")) {
    $("storageStatus").textContent = `${report.dayCount} days · ${report.photoCount} photos · photos ${formatBytes(
      report.photoBytes
    )}`;
  }
  if ($("storageHealth")) {
    const used = report.usage != null ? formatBytes(report.usage) : "—";
    const quota = report.quota != null ? formatBytes(report.quota) : "—";
    const pct =
      report.usage != null && report.quota ? Math.round((report.usage / report.quota) * 100) : null;
    let warn = "";
    if (report.photoBytes > 40 * 1024 * 1024) warn = " Photos are getting large — consider recompress.";
    if (pct != null && pct >= 80) warn += ` Browser storage ~${pct}% full.`;
    $("storageHealth").textContent = `App data ~${used} of ${quota} available.${warn}`;
    $("storageHealth").classList.toggle("warn-text", !!(warn && warn.length));
  }
}

function renderProgressFlags(data) {
  const list = $("flagList");
  if (!list) return;
  const flags = [];
  const date = $("logDate")?.value || CutDBHelpers.todayISO();
  const avgNow = mean(lastNWeights(data, 7, date).map((x) => x.weight));
  const avg14 = mean(lastNWeights(data, 7, CutDBHelpers.addDaysISO(date, -14)).map((x) => x.weight));
  const weighCount = lastNWeights(data, 14, date).length;
  if (weighCount >= 8 && avgNow != null && avg14 != null) {
    const delta = avgNow - avg14;
    if (Math.abs(delta) < 0.25) {
      flags.push({
        level: "warn",
        text: `Weight stalled ~14 days (7d avg Δ ${formatDelta(delta)}). Check adherence, sleep, steps.`,
      });
    }
  }

  const { byLift } = collectStrengthData(data);
  Object.entries(byLift).forEach(([name, pts]) => {
    if (pts.length < 3) return;
    const last3 = pts.slice(-3).map((p) => p.volume).filter((v) => v > 0);
    if (last3.length < 3) return;
    const max = Math.max(...last3);
    const min = Math.min(...last3);
    if (max > 0 && (max - min) / max <= 0.05) {
      flags.push({
        level: "info",
        text: `${name}: volume flat last 3 sessions (${Math.round(min)}–${Math.round(max)}). Consider a small load bump or deload week.`,
      });
    }
    const e1s = pts.slice(-3).map((p) => p.bestE1rm).filter((v) => v != null);
    if (e1s.length === 3 && e1s[2] <= e1s[0] && e1s[2] <= e1s[1]) {
      const drop = e1s[0] - e1s[2];
      if (drop >= 2.5) {
        flags.push({
          level: "warn",
          text: `${name}: est. 1RM down ~${drop.toFixed(1)} kg over last 3 logs — possible fatigue.`,
        });
      }
    }
  });

  if (!flags.length) {
    list.innerHTML = `<li class="flag-item ok">No stall flags right now.</li>`;
    return;
  }
  list.innerHTML = flags
    .slice(0, 8)
    .map((f) => `<li class="flag-item ${f.level}">${escapeHtml(f.text)}</li>`)
    .join("");
}

let selectedPhaseId = null;
let phaseCreateMode = false;
let dietViewMode = "training";
let mealEditMode = "training";
let trainViewMode = "schedule";
let openTrainSessionId = "";
let cachedPhase = null;
let cachedDiet = null;
let cachedTrain = null;
let activePhotoId = null;
let activeAnalysis = null;
let workoutState = { sessionId: "", exercises: [] };

const DAY_NAMES = () =>
  CutDBHelpers.WEEKDAY_NAMES ||
  ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const CATCHUP_SEED = "block-2026-09-25";
const CATCHUP_FROM = "2026-09-25";
const CATCHUP_UNTIL = "2026-10-09";

function weekdayOfISO(dateISO) {
  return CutDBHelpers.weekdayOfISO?.(dateISO) ?? new Date(`${dateISO}T12:00:00`).getDay();
}

function plannedSessionId(dateISO, plan = cachedTrain) {
  return CutDBHelpers.plannedSessionId?.(plan, dateISO) || "";
}

function recommendedSessionId(dateISO, plan = cachedTrain) {
  return CutDBHelpers.recommendedSessionId?.(plan, dateISO) || "";
}

function sessionById(id, plan = cachedTrain) {
  if (!id) return null;
  return (plan?.sessions || []).find((s) => s.id === id) || null;
}

function catchupSessionIds(plan) {
  const hint = CutDBHelpers.findSessionByHint;
  const sessions = plan?.sessions || [];
  const ua = hint?.(plan, /upper[_\s-]*a/, "session_upper_a") || sessions[0];
  const la = hint?.(plan, /lower[_\s-]*a/, "session_lower_a") || sessions[1];
  const ub = hint?.(plan, /upper[_\s-]*b/, "session_upper_b") || sessions[2];
  const lb = hint?.(plan, /lower[_\s-]*b/, "session_lower_b") || sessions[3];
  return { ua: ua?.id || "", la: la?.id || "", ub: ub?.id || "", lb: lb?.id || "" };
}

function ensureRecommendedDays(plan) {
  if (!plan) return plan;
  const sessions = plan.sessions || [];
  if (!sessions.length) return plan;
  const missingDays = sessions.some((s) => s.recommendedWeekday == null);
  plan.sessions = missingDays
    ? CutDBHelpers.uniquifyRecommendedWeekdays(sessions)
    : sessions.map((s) => ({
        ...s,
        proposedTime:
          String(s.proposedTime || "").trim() || CutDBHelpers.defaultProposedTime?.(s.recommendedWeekday) || "",
      }));
  plan.scheduleOverrides = CutDBHelpers.normalizeScheduleOverrides(plan.scheduleOverrides);
  return plan;
}

async function seedCatchupWeekIfNeeded(plan) {
  if (!plan?.sessions?.length) return plan;
  if (plan.weekPlanSeed === CATCHUP_SEED) return plan;
  const today = CutDBHelpers.todayISO();
  if (today < CATCHUP_FROM || today > CATCHUP_UNTIL) return plan;
  const ids = catchupSessionIds(plan);
  if (!ids.ua || !ids.lb) return plan;
  const seed = {
    "2026-09-25": ids.ub,
    "2026-09-26": "",
    "2026-09-27": ids.lb,
    "2026-09-28": "",
    "2026-09-30": ids.ua,
    "2026-10-02": ids.la,
    "2026-10-04": ids.ub,
    "2026-10-05": ids.lb,
    "2026-10-07": ids.ua,
    "2026-10-09": ids.la,
  };
  const overrides = { ...(plan.scheduleOverrides || {}) };
  Object.entries(seed).forEach(([date, sid]) => {
    overrides[date] = sid || "";
  });
  plan.scheduleOverrides = overrides;
  plan.weekPlanSeed = CATCHUP_SEED;
  await CutDB.saveTrainingPlan(plan);
  return plan;
}

function dayLooksTouched(entry) {
  if (!entry) return false;
  return (
    entry.trained === true ||
    !!entry.workout ||
    entry.weight != null ||
    entry.sleep != null ||
    entry.steps != null ||
    entry.coffees != null ||
    !!String(entry.notes || "").trim() ||
    Object.values(entry.mealChecks || {}).some(Boolean)
  );
}

function trainedForDate(entry, dateISO) {
  if (entry?.trained) return true;
  if (entry?.workout) return true;
  if (dayLooksTouched(entry) && entry.trained === false) return false;
  return !!plannedSessionId(dateISO);
}

function viewEntry(entry, dateISO) {
  const base = entry ? { ...entry } : { date: dateISO };
  base.trained = trainedForDate(entry, dateISO);
  return base;
}

function defaultGymTime(dow) {
  return CutDBHelpers.defaultProposedTime?.(dow) || "";
}

function sessionOptionsHtml(selectedId) {
  const sessions = cachedTrain?.sessions || [];
  return (
    `<option value="">Rest</option>` +
    sessions
      .map(
        (s) =>
          `<option value="${escapeHtml(s.id)}" ${s.id === selectedId ? "selected" : ""}>${escapeHtml(s.name || "Session")}</option>`
      )
      .join("")
  );
}

function renderTrainSchedule() {
  const root = $("trainSchedule");
  if (!root) return;
  const sessions = cachedTrain?.sessions || [];
  if (!sessions.length) {
    root.innerHTML = `<p class="hint">Add sessions below, then pick a weekday here.</p>`;
    return;
  }
  const names = DAY_NAMES();
  root.innerHTML = names
    .map((name, dow) => {
      const sess = sessions.find((s) => Number(s.recommendedWeekday) === dow);
      const sid = sess?.id || "";
      const time = sess?.proposedTime || defaultGymTime(dow);
      return `<div class="train-sched-row">
        <strong>${escapeHtml(name)}</strong>
        <select data-sched-day="${dow}" aria-label="${escapeHtml(name)} session">${sessionOptionsHtml(sid)}</select>
        <input data-sched-time="${dow}" value="${escapeHtml(sid ? time : "")}" placeholder="—" ${sid ? "" : "disabled"} aria-label="${escapeHtml(name)} time" />
      </div>`;
    })
    .join("");
  if (!root.dataset.bound) {
    root.dataset.bound = "1";
    root.addEventListener("change", (e) => {
      const sel = e.target.closest("[data-sched-day]");
      const time = e.target.closest("[data-sched-time]");
      if (sel) void assignWeekdaySession(+sel.dataset.schedDay, sel.value);
      else if (time) void assignWeekdayTime(+time.dataset.schedTime, time.value);
    });
  }
}

async function assignWeekdaySession(dow, sessionId) {
  if (!cachedTrain) return;
  collectTrainFromEditor();
  const nextId = sessionId || "";
  (cachedTrain.sessions || []).forEach((s) => {
    if (nextId && s.id === nextId) {
      s.recommendedWeekday = dow;
      if (!s.proposedTime) s.proposedTime = defaultGymTime(dow);
    } else if (Number(s.recommendedWeekday) === dow) {
      s.recommendedWeekday = null;
    }
  });
  await CutDB.saveTrainingPlan(cachedTrain);
  renderTrainSchedule();
  showToast("Schedule saved");
}

async function assignWeekdayTime(dow, time) {
  if (!cachedTrain) return;
  collectTrainFromEditor();
  const sess = (cachedTrain.sessions || []).find((s) => Number(s.recommendedWeekday) === dow);
  if (!sess) return;
  sess.proposedTime = String(time || "").trim();
  await CutDB.saveTrainingPlan(cachedTrain);
}

function syncTrainedUI() {
  const trained = $("trainedSelect")?.value === "train";
  if ($("trained")) $("trained").checked = trained;
  const workoutStep = $("step-workout");
  if (workoutStep) workoutStep.style.display = trained ? "" : "none";
}

function setCoffeeDisplay(n) {
  const v = Math.max(0, Number(n) || 0);
  if ($("coffees")) $("coffees").value = String(v);
  if ($("coffeesDisplay")) $("coffeesDisplay").textContent = String(v);
}

async function savePartial(patch, label, opts = {}) {
  const quiet = !!opts.quiet;
  return withActionProgress(
    label || "Saving…",
    async (report) => {
      report(20, label || "Saving…");
      const date = $("logDate").value || CutDBHelpers.todayISO();
      const existing = (await CutDB.getDay(date)) || { date };
      undoStack.push({ date, snapshot: cloneDay(existing), label: label || "Saved" });
      if (undoStack.length > MAX_UNDO) undoStack.shift();
      report(45);
      const merged = {
        ...existing,
        ...patch,
        date,
        phaseId: cachedPhase?.id || existing.phaseId || null,
        updatedAt: new Date().toISOString(),
      };
      if (patch.mealChecks) {
        merged.mealChecks = { ...(existing.mealChecks || {}), ...patch.mealChecks };
      }
      if (patch.swapPicks) {
        merged.swapPicks = { ...(existing.swapPicks || {}), ...patch.swapPicks };
      }
      if (patch.measurements) {
        merged.measurements = { ...(existing.measurements || {}), ...patch.measurements };
      }
      report(70);
      await CutDB.saveDay(merged);
      report(90);
      const data = await CutDB.allDays();
      const backup = backupReminderState(data);
      updateJourneyStatus(merged);
      applyTodayDueOverrides(backup, date);
      renderPhaseRun(data, date);
      await renderPhaseEndCard(date, data, backup);
      renderHabitNudges(merged);
      report(100);
      return merged;
    },
    { doneMessage: label || "Saved", quiet }
  );
}

function isPlateMeal(m) {
  const id = String(m?.id || "");
  return id !== "coffee" && id !== "oilSpray";
}

function posMealMacro(n) {
  const x = Number(n);
  return Number.isFinite(x) && x > 0 ? Math.round(x) : 0;
}

function mealMacroSet(m) {
  return {
    kcal: posMealMacro(m?.kcal),
    protein: posMealMacro(m?.protein),
    carbs: posMealMacro(m?.carbs),
    fat: posMealMacro(m?.fat),
  };
}

function swapPickKey(mealId, swapId) {
  return `${mealId}::${swapId}`;
}

function currentSwapPick(swapPicks, mealId, swapId) {
  const perMeal = (swapPicks[swapPickKey(mealId, swapId)] || "").trim();
  if (perMeal) return perMeal;
  return (swapPicks[swapId] || "").trim();
}

function optionHitsMeal(option, itemsBlob) {
  const core = String(option || "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!core) return false;
  if (itemsBlob.includes(core)) return true;
  const skip = new Set([
    "g",
    "ml",
    "cooked",
    "drained",
    "raw",
    "medium",
    "large",
    "small",
    "in",
    "of",
    "and",
    "with",
  ]);
  const words = core.split(" ").filter((w) => w && !/^\d/.test(w) && !skip.has(w));
  const name = words.slice(0, 2).join(" ");
  return name.length >= 4 && itemsBlob.includes(name);
}

function swapsForMeal(meal, allSwaps) {
  if (!allSwaps.length) return [];
  if (Array.isArray(meal?.swaps)) {
    const listed = meal.swaps.map(String);
    return allSwaps.filter((s) => listed.includes(s.id));
  }
  const blob = (meal?.items || []).join(" ").toLowerCase();
  if (!blob) return [];
  return allSwaps.filter((s) => (s.options || []).some((o) => optionHitsMeal(o, blob)));
}

function mealItemForSwap(meal, swap) {
  const items = (meal?.items || []).map((x) => String(x).trim()).filter(Boolean);
  const opts = swap?.options || [];
  if (!items.length || !opts.length) return "";
  for (const item of items) {
    if (opts.some((o) => String(o).trim() === item)) return item;
  }
  for (const item of items) {
    const blob = item.toLowerCase();
    if (opts.some((o) => optionHitsMeal(o, blob))) return item;
  }
  return "";
}

function mealSwapSelectHtml(meal, swap, swapPicks) {
  const plate = mealItemForSwap(meal, swap);
  const cur = currentSwapPick(swapPicks, meal.id, swap.id);
  const usingPlate = !cur || cur === plate;
  const defaultLabel = plate || "None on this plate";
  const rest = (swap.options || []).filter((o) => String(o).trim() !== plate);
  const opts = [
    `<option value="" ${usingPlate ? "selected" : ""}>${escapeHtml(defaultLabel)}</option>`,
  ]
    .concat(
      rest.map(
        (o) =>
          `<option value="${escapeHtml(o)}" ${!usingPlate && o === cur ? "selected" : ""}>${escapeHtml(o)}</option>`
      )
    )
    .join("");
  return `<label class="meal-swap">
    <span class="meal-swap-label">${escapeHtml(swap.label || "Swap")}</span>
    <select class="meal-swap-select" data-swap-pick="${escapeHtml(swapPickKey(meal.id, swap.id))}">${opts}</select>
  </label>`;
}

function plannedMealsForDiet(entry, diet, trained) {
  if (!diet) return [];
  const isTrain =
    trained != null ? !!trained : !!(entry?.trained ?? ($("trainedSelect")?.value === "train"));
  const block = isTrain ? diet.training : diet.rest;
  return (block?.meals || []).filter(isPlateMeal);
}

function plannedMealsForEntry(entry) {
  return plannedMealsForDiet(entry, cachedDiet);
}

function liftsLogged(entry) {
  return !!(entry?.workout?.exercises || []).some((x) =>
    (x.sets || []).some((s) => s.weight != null || s.reps != null)
  );
}

/** Same rule everywhere: a lift day = weights/reps saved, not the Train toggle. */
function dayHasLoggedWeights(entry) {
  return liftsLogged(entry);
}

function eveningLogged(entry) {
  return entry?.steps != null;
}

function dayIsClosed(entry, diet = cachedDiet) {
  if (!entry) return false;
  const lifted = liftsLogged(entry);
  const trained = !!entry.trained || lifted;
  const planned = plannedMealsForDiet(entry, diet, trained);
  if (!planned.length) return false;
  const mealsOk = planned.every((m) => (entry.mealChecks || {})[m.id]);
  const trainOk = !entry.trained || lifted;
  return entry.weight != null && mealsOk && eveningLogged(entry) && trainOk;
}

let activeJourneyStep = null;
let activeProgressSection = "overview";

function updateJourneyStatus(entry) {
  const e = entry || {};
  const setStatus = (key, ok) => {
    const el = document.querySelector(`[data-status-for="${key}"]`);
    if (!el) return;
    el.textContent = ok ? "Done" : "";
    el.className = "step-status" + (ok ? " ok" : "");
  };
  const plannedMeals = plannedMealsForEntry(e);
  const mealsDone = plannedMeals.filter((m) => (e.mealChecks || {})[m.id]).length;
  const morningDone = e.weight != null && e.sleep != null;
  const coffeeDone = e.coffees != null;
  const mealsOk = plannedMeals.length > 0 && mealsDone >= plannedMeals.length;
  const workoutDone = liftsLogged(e);
  const wrapDone = eveningLogged(e);

  setStatus("morning", morningDone);
  setStatus("coffee", coffeeDone);
  setStatus("meals", mealsOk);
  setStatus("workout", workoutDone);
  setStatus("wrap", wrapDone);

  const steps = [
    { id: "morning", label: "Morning", done: morningDone, title: "Log weight and sleep", cta: "Open morning" },
    { id: "coffee", label: "Coffee", done: coffeeDone, title: "Log coffee", cta: "Open coffee" },
    {
      id: "meals",
      label: plannedMeals.length ? `Meals ${mealsDone}/${plannedMeals.length}` : "Meals",
      done: mealsOk,
      title: plannedMeals.length ? "Check every planned meal" : "Upload a pack for meals",
      cta: "Open meals",
    },
    {
      id: "workout",
      label: "Workout",
      done: workoutDone,
      hide: !e.trained && !liftsLogged(e),
      title: "Log today’s lifts",
      cta: "Open workout",
    },
    { id: "wrap", label: "Evening", done: wrapDone, title: "Steps and evening", cta: "Open evening" },
  ];
  if (!cachedPhase) {
    const nav = $("journeyNav");
    if (nav) nav.innerHTML = "";
    $("panel-today")?.classList.remove("journey-focus");
    return;
  }

  const visible = steps.filter((s) => !s.hide);
  const required = visible.filter((s) => s.id !== "coffee");
  const next = required.find((s) => !s.done) || null;

  document.querySelectorAll(".journey-step").forEach((el) => {
    const id = el.dataset.step;
    const meta = visible.find((s) => s.id === id);
    el.classList.toggle("is-done", !!(meta && meta.done));
    el.classList.toggle("is-next", !!(next && next.id === id));
    if (id === "workout") el.style.display = e.trained || liftsLogged(e) ? "" : "none";
  });

  const label = document.querySelector(".next-label");
  if (label) label.textContent = next ? "Up next" : "Done";
  if ($("nextActionTitle")) {
    $("nextActionTitle").textContent = next ? next.title : "Day closed";
  }
  if ($("nextActionBtn")) {
    $("nextActionBtn").textContent = next ? next.cta : "Review morning";
    $("nextActionBtn").dataset.jump = next ? next.id : "morning";
  }

  const nav = $("journeyNav");
  if (!nav) return;
  nav.innerHTML = visible
    .map(
      (s) =>
        `<button type="button" class="journey-chip ${s.done ? "done" : ""} ${
          next && next.id === s.id ? "next" : ""
        }" data-jump="${s.id}">${escapeHtml(s.label)}</button>`
    )
    .join("");
  nav.querySelectorAll("[data-jump]").forEach((btn) => {
    btn.addEventListener("click", () => jumpToStep(btn.dataset.jump));
  });

  const focusId =
    (activeJourneyStep && visible.some((s) => s.id === activeJourneyStep) && activeJourneyStep) ||
    (next && next.id) ||
    visible[0]?.id ||
    "morning";
  focusJourneyStep(focusId, { scroll: false });
}

function focusJourneyStep(id, opts = {}) {
  const scroll = opts.scroll !== false;
  const panel = $("panel-today");
  if (!panel) return;
  panel.classList.add("journey-focus");
  activeJourneyStep = id;
  document.querySelectorAll(".journey-step").forEach((el) => {
    const match = el.dataset.step === id;
    el.classList.toggle("is-focused", match);
  });
  document.querySelectorAll("#journeyNav .journey-chip").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.jump === id);
  });
  if (scroll) {
    $("journeySticky")?.scrollIntoView({ behavior: "smooth", block: "start" });
    pulseEl(document.getElementById(`step-${id}`));
  }
}

function focusProgressSection(id, opts = {}) {
  const scroll = opts.scroll !== false;
  const panel = $("panel-analysis");
  if (!panel) return;
  const section = id || "overview";
  activeProgressSection = section;
  panel.classList.add("progress-focus");
  panel.querySelectorAll("[data-progress-section]").forEach((el) => {
    el.classList.toggle("is-progress-shown", el.dataset.progressSection === section);
  });
  panel.querySelectorAll("#progressNav .progress-chip").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.progressJump === section);
  });
  if (scroll) {
    $("progressNav")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function pulseEl(el) {
  if (!el) return;
  el.classList.add("pulse-once");
  setTimeout(() => el.classList.remove("pulse-once"), 900);
}

function jumpToInsight() {
  const card = $("insightCard");
  if (!card || card.hidden) return;
  // Insight sits below focused steps — temporarily show full today flow? Keep it scrollable under focus.
  card.hidden = false;
  card.scrollIntoView({ behavior: "smooth", block: "start" });
  pulseEl(card);
  pulseEl($("runDailyInsightBtn"));
}

function jumpToStep(id) {
  if (id === "shopping") {
    void goToTab("shopping");
    return;
  }
  if (id === "prep") {
    void goToTab("prep");
    return;
  }
  if (id === "phases") {
    void goToTab("phases");
    return;
  }
  if (id === "setup") {
    void openPhasesToCreate();
    return;
  }
  if (id === "insight") {
    jumpToInsight();
    return;
  }
  if (id === "photo") {
    void openPhaseStartPhoto();
    return;
  }
  if (id === "backup" || id === "data") {
    void goToTab("data").then(() => {
      const btn = $("exportFullBtn");
      btn?.scrollIntoView({ behavior: "smooth", block: "center" });
      pulseEl(btn);
    });
    return;
  }
  if (!document.getElementById(`step-${id}`)) return;
  void goToTab("today").then(() => {
    focusJourneyStep(id, { scroll: true });
  });
}

const PREFS_KEY = "keju-prefs-v1";

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function savePrefs(patch) {
  const next = { ...loadPrefs(), ...patch };
  localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  return next;
}

const DEFAULT_TEXT_MODEL = "nvidia/nemotron-3-super-120b-a12b:free";
const TEXT_MODELS = [
  DEFAULT_TEXT_MODEL,
  "meta-llama/llama-3.3-70b-instruct:free",
  "google/gemma-3-27b-it:free",
  "mistralai/mistral-small-3.1-24b-instruct:free",
  "liquid/lfm-2.5-2.6b:free",
  "nex-agi/nex-n2.5-mini:free",
  "openrouter/free",
];
const FAST_TEXT_MODEL = DEFAULT_TEXT_MODEL; // alias used by save/test handlers
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_MODELS = [
  DEFAULT_GEMINI_MODEL,
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
  "gemini-2.5-pro",
];
const AI_PROXY_PATH = "/api/ai";
let lastAiWinner = "";

function aiSettings() {
  const p = loadPrefs();
  const visionChoices = [
    "inclusionai/ling-3.0-flash-vl:free",
    "google/gemma-4-26b-a4b-it:free",
    "nex-agi/nex-n2.5-mini:free",
    "google/gemma-4-31b-it:free",
    "openrouter/free",
  ];
  let visionModel = p.openRouterVisionModel || "inclusionai/ling-3.0-flash-vl:free";
  if (!visionChoices.includes(visionModel)) visionModel = "inclusionai/ling-3.0-flash-vl:free";
  let model = p.openRouterModel || DEFAULT_TEXT_MODEL;
  if (!TEXT_MODELS.includes(model)) model = DEFAULT_TEXT_MODEL;
  let geminiModel = p.geminiModel || DEFAULT_GEMINI_MODEL;
  if (!GEMINI_MODELS.includes(geminiModel)) geminiModel = DEFAULT_GEMINI_MODEL;
  const geminiKey = (p.geminiApiKey || "").trim();
  const openRouterKey = (p.openRouterKey || "").trim();
  let provider = ["auto", "gemini", "openrouter"].includes(p.aiProvider) ? p.aiProvider : "";
  if (!provider) {
    provider = geminiKey && openRouterKey ? "auto" : geminiKey ? "gemini" : openRouterKey ? "openrouter" : "auto";
  }
  const hasGemini = !!geminiKey;
  const hasOpenRouter = !!openRouterKey;
  return {
    provider,
    key: hasGemini || hasOpenRouter ? "ok" : "",
    geminiKey,
    openRouterKey,
    hasGemini,
    hasOpenRouter,
    model,
    visionModel,
    geminiModel,
    autoPhaseInsight: p.autoPhaseInsight !== false,
  };
}

/** @deprecated use aiSettings */
function openRouterSettings() {
  const s = aiSettings();
  return {
    key: s.openRouterKey,
    model: s.model,
    visionModel: s.visionModel,
    autoPhaseInsight: s.autoPhaseInsight,
  };
}

function syncAiProviderPanels() {
  // Both key panels stay visible so both keys can be saved together.
  const gemini = $("aiPanelGemini");
  const or = $("aiPanelOpenRouter");
  if (gemini) gemini.hidden = false;
  if (or) or.hidden = false;
}

function extractJsonBlock(text) {
  if (!text) throw new Error("Empty AI reply");
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

function aiProxyUrl() {
  try {
    return new URL(AI_PROXY_PATH, location.href).href;
  } catch (_) {
    return AI_PROXY_PATH;
  }
}

async function fetchAiChat({
  url,
  key,
  useModel,
  system,
  userContent,
  temperature,
  timeoutMs,
  providerLabel,
  extraBody = {},
  signal,
  viaProxy = false,
  provider = "openrouter",
}) {
  const ms = timeoutMs ?? 60000;
  const ownCtrl = signal ? null : new AbortController();
  const usedSignal = signal || ownCtrl.signal;
  if (ownCtrl) activeAiAbort = ownCtrl;
  const timer = ownCtrl ? setTimeout(() => ownCtrl.abort(), ms) : null;
  try {
    const headers = {
      "Content-Type": "application/json",
    };
    if (viaProxy) {
      headers.Authorization = `Bearer ${key}`;
      headers["X-AI-Provider"] = provider;
    } else if (provider === "openrouter") {
      headers.Authorization = `Bearer ${key}`;
      headers["HTTP-Referer"] = location.origin;
      headers["X-Title"] = "KeJu Fit Tracker";
    }
    const res = await fetch(url, {
      method: "POST",
      signal: usedSignal,
      credentials: viaProxy ? "same-origin" : "omit",
      headers,
      body: JSON.stringify({
        model: useModel,
        temperature,
        stream: false,
        ...extraBody,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent },
        ],
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message || data?.message || res.statusText || `${providerLabel} request failed`;
      throw new Error(`${msg} (${useModel})`);
    }
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error(`No content in AI reply (${useModel})`);
    return typeof content === "string" ? content : JSON.stringify(content);
  } catch (err) {
    if (err?.name === "AbortError" || usedSignal.aborted) {
      if (actionCancelledByUser) {
        actionCancelledByUser = false;
        throw new Error("Cancelled");
      }
      if (signal && !ownCtrl) throw new Error("Cancelled");
      throw new Error(
        `${providerLabel} timed out after ${Math.round(ms / 1000)}s (${useModel}). Try Auto mode or a faster model.`
      );
    }
    const raw = String(err?.message || err);
    if (/Failed to fetch|NetworkError|Load failed/i.test(raw)) {
      throw new Error(`${providerLabel} network error (${useModel}). Check the key / try the other provider.`);
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    if (ownCtrl && activeAiAbort === ownCtrl) activeAiAbort = null;
  }
}

function buildAiUserContent(user, imageDataUrl) {
  if (!imageDataUrl) return user;
  return [
    { type: "text", text: user },
    { type: "image_url", image_url: { url: imageDataUrl } },
  ];
}

function geminiPartsFromContent(content) {
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return [{ text: String(content || "") }];
  const parts = [];
  for (const part of content) {
    if (!part) continue;
    if (typeof part === "string") {
      parts.push({ text: part });
      continue;
    }
    if (part.type === "text" && part.text) {
      parts.push({ text: part.text });
      continue;
    }
    if (part.type === "image_url") {
      const url = part.image_url?.url || part.url || "";
      const m = String(url).match(/^data:([^;]+);base64,(.+)$/i);
      if (m) {
        parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
      } else if (url) {
        parts.push({ text: `[image: ${url}]` });
      }
    }
  }
  return parts.length ? parts : [{ text: "" }];
}

async function geminiGenerateContent({ system, user, temperature = 0.2, model, imageDataUrl, timeoutMs, signal } = {}) {
  const settings = aiSettings();
  const key = settings.geminiKey;
  if (!key) throw new Error("Add your Gemini key in More → Backup & AI key");
  const useModel = model || settings.geminiModel;
  const ms = timeoutMs ?? (imageDataUrl ? 45000 : 45000);
  const ownCtrl = signal ? null : new AbortController();
  const usedSignal = signal || ownCtrl.signal;
  if (ownCtrl) activeAiAbort = ownCtrl;
  let timer = ownCtrl ? setTimeout(() => ownCtrl.abort(), ms) : null;
  const userContent = buildAiUserContent(user, imageDataUrl);
  const body = {
    systemInstruction: { parts: [{ text: system || "" }] },
    contents: [{ role: "user", parts: geminiPartsFromContent(userContent) }],
    generationConfig: {
      temperature,
      maxOutputTokens: imageDataUrl ? 2048 : 4096,
    },
  };
  // Native Gemini endpoint supports browser CORS with ?key=
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(useModel)}:generateContent?key=${encodeURIComponent(key)}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: usedSignal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message || data?.message || res.statusText || "Gemini request failed";
      throw new Error(`${msg} (${useModel})`);
    }
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts.map((p) => p?.text || "").join("").trim();
    if (!text) {
      const block = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason || "empty";
      throw new Error(`No content in Gemini reply (${useModel} · ${block})`);
    }
    return text;
  } catch (err) {
    if (err?.name === "AbortError" || usedSignal.aborted) {
      if (actionCancelledByUser) {
        actionCancelledByUser = false;
        throw new Error("Cancelled");
      }
      if (signal && !ownCtrl) throw new Error("Cancelled");
      throw new Error(`Gemini timed out after ${Math.round(ms / 1000)}s (${useModel}).`);
    }
    const raw = String(err?.message || err);
    if (/Failed to fetch|NetworkError|Load failed/i.test(raw)) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // Fallback: Cloudflare Pages proxy (OpenAI-compat)
      try {
        return await fetchAiChat({
          url: aiProxyUrl(),
          key,
          useModel,
          system,
          userContent,
          temperature,
          timeoutMs: Math.min(ms, 40000),
          providerLabel: "Gemini",
          extraBody: /gemini-2\.5|gemini-3/i.test(useModel) ? { reasoning_effort: "none" } : {},
          signal: signal || undefined,
          viaProxy: true,
          provider: "gemini",
        });
      } catch (proxyErr) {
        throw new Error(`Gemini network error (${useModel}). ${proxyErr?.message || proxyErr}`);
      }
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    if (ownCtrl && activeAiAbort === ownCtrl) activeAiAbort = null;
  }
}

async function openRouterChat({ system, user, temperature = 0.2, model, imageDataUrl, timeoutMs, signal } = {}) {
  const settings = aiSettings();
  const key = settings.openRouterKey;
  if (!key) throw new Error("Add your OpenRouter key in More → Backup & AI key");
  const useModel = model || (imageDataUrl ? settings.visionModel : settings.model);
  return fetchAiChat({
    url: "https://openrouter.ai/api/v1/chat/completions",
    key,
    useModel,
    system,
    userContent: buildAiUserContent(user, imageDataUrl),
    temperature,
    timeoutMs: timeoutMs ?? (imageDataUrl ? 55000 : 60000),
    providerLabel: "OpenRouter",
    extraBody: { provider: { sort: "throughput" } },
    signal,
    viaProxy: false,
    provider: "openrouter",
  });
}

async function geminiChat(opts = {}) {
  return geminiGenerateContent(opts);
}

async function raceAiProviders(opts = {}) {
  const settings = aiSettings();
  const runners = [];
  if (settings.hasGemini) {
    runners.push({
      name: "gemini",
      run: (signal) => geminiChat({ ...opts, signal, timeoutMs: opts.timeoutMs ?? 35000 }),
    });
  }
  if (settings.hasOpenRouter) {
    runners.push({
      name: "openrouter",
      run: (signal) => openRouterChat({ ...opts, signal, timeoutMs: opts.timeoutMs ?? 55000 }),
    });
  }
  if (!runners.length) {
    throw new Error("Add a Gemini and/or OpenRouter key in More → Backup & AI key");
  }
  if (runners.length === 1) {
    const only = runners[0];
    const reply = await only.run(undefined);
    lastAiWinner = only.name;
    return reply;
  }

  const controllers = runners.map(() => new AbortController());
  const overallMs = Math.max(opts.timeoutMs || 0, 55000);
  const overallTimer = setTimeout(() => controllers.forEach((c) => c.abort()), overallMs);
  const errors = [];
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      let pending = runners.length;
      runners.forEach((runner, i) => {
        runner
          .run(controllers[i].signal)
          .then((reply) => {
            if (settled) return;
            settled = true;
            lastAiWinner = runner.name;
            controllers.forEach((c, j) => {
              if (j !== i) c.abort();
            });
            resolve(reply);
          })
          .catch((err) => {
            const msg = String(err?.message || err);
            if (!/Cancelled/i.test(msg)) errors.push(`${runner.name}: ${msg}`);
            pending -= 1;
            if (!settled && pending === 0) {
              reject(new Error(`All AI providers failed · ${errors.join(" · ") || "timed out"}`));
            }
          });
      });
    });
  } finally {
    clearTimeout(overallTimer);
  }
}

async function aiChat(opts = {}) {
  const { provider, hasGemini, hasOpenRouter } = aiSettings();
  if (!hasGemini && !hasOpenRouter) {
    throw new Error("Add a Gemini and/or OpenRouter key in More → Backup & AI key");
  }
  if (provider === "auto" && hasGemini && hasOpenRouter) {
    return raceAiProviders(opts);
  }
  if (provider === "gemini" && hasGemini) {
    lastAiWinner = "gemini";
    return geminiChat(opts);
  }
  if (provider === "openrouter" && hasOpenRouter) {
    lastAiWinner = "openrouter";
    return openRouterChat(opts);
  }
  // Mode points at a missing key — use whatever is available (race if both)
  return raceAiProviders(opts);
}

const VISION_MODEL_FALLBACKS = [
  "inclusionai/ling-3.0-flash-vl:free",
  "google/gemma-4-26b-a4b-it:free",
  "nex-agi/nex-n2.5-mini:free",
  "google/gemma-4-31b-it:free",
  "openrouter/free",
];

const GEMINI_VISION_FALLBACKS = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"];

async function aiChatWithVisionFallback(opts) {
  const settings = aiSettings();
  // Auto / dual-key: race providers once (each uses its own vision-capable model)
  if (settings.provider === "auto" && settings.hasGemini && settings.hasOpenRouter) {
    return raceAiProviders({ ...opts, timeoutMs: opts.timeoutMs ?? 45000 });
  }
  const preferred =
    opts.model || (settings.provider === "openrouter" || !settings.hasGemini ? settings.visionModel : settings.geminiModel);
  const useGemini = settings.provider === "gemini" || (settings.hasGemini && settings.provider !== "openrouter");
  const fallbacks = useGemini ? GEMINI_VISION_FALLBACKS : VISION_MODEL_FALLBACKS;
  const tried = [];
  const queue = [preferred, ...fallbacks.filter((m) => m !== preferred)];
  let lastErr = null;
  for (const model of queue) {
    tried.push(model);
    try {
      return await aiChat({ ...opts, model, timeoutMs: opts.timeoutMs ?? 45000 });
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      if (/timed out|no endpoints|not available|404|429|provider|capacity|unavailable|quota|network error/i.test(msg)) {
        continue;
      }
      throw err;
    }
  }
  throw new Error(`${lastErr?.message || "Vision OCR failed"} · tried: ${tried.join(", ")}`);
}

/** @deprecated use aiChatWithVisionFallback */
async function openRouterChatWithVisionFallback(opts) {
  return aiChatWithVisionFallback(opts);
}

async function aiFillFromPrompt(promptKey, payload, extraUser = "", { timeoutMs } = {}) {
  const system = CutDBHelpers.AI_PROMPTS[promptKey];
  if (!system) throw new Error(`Missing AI prompt: ${promptKey}`);
  const slim = slimTemplateForAi(payload);
  const parts = [
    extraUser.trim(),
    "Return ONLY one valid JSON object matching the schema in the system instructions. No markdown fences, no commentary.",
    JSON.stringify(slim, null, 2),
  ].filter(Boolean);
  const raw = await aiChat({
    system,
    user: parts.join("\n\n"),
    timeoutMs: timeoutMs ?? (promptKey === "diet" || promptKey === "training" ? 70000 : undefined),
  });
  try {
    return extractJsonBlock(raw);
  } catch (err) {
    throw new Error(`AI returned invalid JSON — try again or shorten the paste. (${err.message || err})`);
  }
}

function slimTemplateForAi(tpl) {
  if (!tpl || typeof tpl !== "object") return tpl;
  const { aiPrompt, howToUseForAI, ...rest } = tpl;
  return rest;
}

async function ensurePhaseSelected(selectId) {
  const sel = $(selectId);
  if (!sel) return null;
  if (sel.value) return sel.value;
  if (!sel.options.length) {
    await fillPhaseSelects();
  }
  if (!sel.value && sel.options.length) {
    sel.selectedIndex = 0;
    selectedPhaseId = sel.value;
  }
  return sel.value || selectedPhaseId || null;
}

/* ---------------- Phase pack library (shipped with the app) ---------------- */

let templateLibraryCache = null;
/** Pack JSON loaded into the create-phase form (applied on Create). */
let pendingPhasePack = null;
let phasePackButtonsWired = false;
let templateLibraryFillGen = 0;

/** Used if templates/manifest.json fails to load (stale SW / offline). */
const FALLBACK_PHASE_LIBRARY = {
  type: "cut-tracker-template-library",
  version: 2,
  phase: [
    {
      id: "restart-3day",
      name: "Stage 1 quick cut — 20 weeks, 3 gym days, Kayy oats + Dina cottage cheese",
      file: "phase-restart-3day.json",
    },
    {
      id: "cut-12week-julia",
      name: "Julia — yogurt bowl, chicken last, 2× gym",
      file: "phase-cut-12week-julia.json",
    },
    {
      id: "cut-weeks-3-4",
      name: "Weeks 3–4 cut — halloumi dinner, lighter pre-gym",
      file: "phase-cut-weeks-3-4.json",
    },
    {
      id: "cut-10week",
      name: "10-week cut — diet + training + shopping",
      file: "phase-cut-10week.json",
    },
  ],
};

async function parseJsonResponse(res, label) {
  const text = await res.text();
  const trimmed = (text || "").trim();
  if (!trimmed) throw new Error(`${label} was empty.`);
  if (trimmed.startsWith("<")) {
    throw new Error(`${label} returned a web page instead of JSON (check login / cache).`);
  }
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`${label} is not valid JSON — ${err.message}`);
  }
}

async function fetchAppAsset(relPath) {
  const url = new URL(relPath, document.baseURI || location.href).href;
  try {
    const res = await fetch(url, { cache: "reload" });
    if (res.ok) return res;
  } catch (_) {
    /* try cache */
  }
  if (typeof caches !== "undefined") {
    const cached =
      (await caches.match(url)) ||
      (await caches.match(relPath)) ||
      (await caches.match(new URL(relPath, location.origin).href));
    if (cached) return cached;
  }
  throw new Error("Could not reach that file. Upload the JSON from your computer instead.");
}

function embeddedPhaseLibrary() {
  const lib = window.KEJU_PHASE_LIBRARY;
  if (lib?.type === "cut-tracker-template-library") return lib;
  return FALLBACK_PHASE_LIBRARY;
}

function embeddedPhasePack(file, { clone = true } = {}) {
  const packs = window.KEJU_PHASE_PACKS;
  if (!packs || !file || !packs[file]) return null;
  return clone ? JSON.parse(JSON.stringify(packs[file])) : packs[file];
}

async function fetchWithTimeout(url, ms, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchTemplateLibrary() {
  if (templateLibraryCache) return templateLibraryCache;
  templateLibraryCache = embeddedPhaseLibrary();
  return templateLibraryCache;
}

async function fetchBundledTemplate(file) {
  const safe = String(file || "").replace(/[^a-zA-Z0-9._-]/g, "");
  if (!safe || safe !== file) throw new Error("Invalid pack file name.");
  try {
    const res = await fetchWithTimeout(`./templates/${safe}?t=${Date.now()}`, 8000, {
      cache: "reload",
      credentials: "same-origin",
    });
    if (res.ok) {
      const payload = await parseJsonResponse(res, safe);
      if (payload?.type && payload.type !== "cut-tracker-phase-template") {
        throw new Error(`Expected a phase pack, got "${payload.type}".`);
      }
      if (window.KEJU_PHASE_PACKS && typeof window.KEJU_PHASE_PACKS === "object") {
        window.KEJU_PHASE_PACKS[safe] = payload;
      }
      return payload;
    }
  } catch (err) {
    if (err?.message?.includes("Expected a phase pack")) throw err;
  }
  const embedded = embeddedPhasePack(safe);
  if (embedded) {
    if (embedded.type && embedded.type !== "cut-tracker-phase-template") {
      throw new Error(`Expected a phase pack, got "${embedded.type}".`);
    }
    return embedded;
  }
  const res = await fetchAppAsset(`./templates/${safe}`);
  const payload = await parseJsonResponse(res, safe);
  if (payload?.type && payload.type !== "cut-tracker-phase-template") {
    throw new Error(`Expected a phase pack, got "${payload.type}".`);
  }
  return payload;
}

function setPhasePackStatus(msg) {
  const el = $("phaseTplStatus");
  if (el) el.textContent = msg || "";
}

function applyPackToPhaseForm(pack) {
  const n = CutDBHelpers.normalizePhaseTemplate(pack);
  pendingPhasePack = pack;
  if ($("phaseGoalLossPct")) $("phaseGoalLossPct").value = String(n.goalLossPctPerWeek);
  if ($("phaseTrainDays")) $("phaseTrainDays").value = String(n.trainingDaysPerWeek);
  if ($("phaseNotes") && n.notes) $("phaseNotes").value = n.notes;
  const mealN = (n.diet.training?.meals?.length || 0) + (n.diet.rest?.meals?.length || 0);
  const swapN = n.diet.foodSwaps?.length || 0;
  const shopN = n.shoppingList?.items?.length || 0;
  const recipeN = CutDBHelpers.dietRecipeCount(n.diet) || 0;
  const sessN = n.training.sessions?.length || 0;
  const exN = (n.training.sessions || []).reduce((a, s) => a + (s.exercises?.length || 0), 0);
  const creating = phaseCreateMode || !$("editPhaseId")?.value;
  setPhasePackStatus(
    creating
      ? `Ready — ${mealN} meals · ${recipeN} recipes · ${sessN} workouts. Creating this phase…`
      : `Ready — ${mealN} meals · ${recipeN} recipes · ${sessN} workouts. Applying to this phase…`
  );
  return n;
}

async function usePackNow(pack, { packFile } = {}) {
  applyPackToPhaseForm(pack);
  if ($("phasePackText")) $("phasePackText").value = JSON.stringify(pack);
  const creating = phaseCreateMode || !$("editPhaseId")?.value;
  if (creating) {
    const start = $("phaseStart")?.value || (await nextPhaseStartDate());
    await createPhaseFromPackObject(pack, { startDate: start, packFile });
    return;
  }
  await applyPendingPackToCurrentPhase({ packFile });
}

async function applyPendingPackToCurrentPhase({ packFile } = {}) {
  const phaseId = $("editPhaseId")?.value || selectedPhaseId;
  if (!phaseId || phaseCreateMode) {
    setPhasePackStatus("Create the phase first, or load a pack and tap Create phase.");
    showToast("Open an existing phase to reload a pack");
    return;
  }
  let pack;
  try {
    pack = readPhasePackFromForm();
  } catch (err) {
    setPhasePackStatus(err.message);
    showToast(err.message);
    return;
  }
  if (!pack) {
    setPhasePackStatus("Load or paste a phase pack JSON first.");
    showToast("No pack loaded");
    return;
  }
  if (
    !confirm("Replace this phase’s diet, shopping, and training? Dates stay.")
  ) {
    return;
  }
  const goalPct = parseNum($("phaseGoalLossPct")?.value);
  const goalLossPctPerWeek =
    goalPct != null && goalPct > 0 ? goalPct : Number(cfg().goalLossPctPerWeek) || 0.75;
  const tdRaw = Number($("phaseTrainDays")?.value);
  const trainingDaysPerWeek = Number.isFinite(tdRaw)
    ? Math.max(0, Math.min(7, Math.round(tdRaw)))
    : 4;
  const notes = ($("phaseNotes")?.value || "").trim();

  try {
    await withActionProgress(
      "Applying pack…",
      async (report) => {
        report(20);
        await CutDB.applyPackToPhase(phaseId, pack, {
          goalLossPctPerWeek,
          trainingDaysPerWeek,
          notes,
          packFile,
          packStamp: packStamp(pack),
        });
        report(70);
        selectedPhaseId = phaseId;
        pendingPhasePack = null;
        if ($("phasePackText")) $("phasePackText").value = "";
        await refreshAll({ tab: "phases" });
        setPhasePackStatus("Pack applied to this phase.");
        report(100);
      },
      { doneMessage: "Phase pack applied", minVisibleMs: 300 }
    );
  } catch (err) {
    const msg = err?.message || String(err);
    setPhasePackStatus(msg);
    if (!err?.actionProgressHandled) showToast(msg);
  }
}

function clearPendingPhasePack({ toast = false } = {}) {
  templateLibraryFillGen += 1; // ignore in-flight select fill overwriting status
  pendingPhasePack = null;
  if ($("phasePackText")) $("phasePackText").value = "";
  setPhasePackStatus("No pack selected — Create will make an empty phase (diet/training blank).");
  if (toast) showToast("Pack cleared");
}

function parsePhasePackText(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("Pack file is empty.");
  if (raw.startsWith("<")) throw new Error("That file is a web page, not a pack JSON.");
  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Phase pack is not valid JSON — ${err.message}`);
  }
  const payload = Array.isArray(json) ? json[0] : json;
  CutDBHelpers.normalizePhaseTemplate(payload);
  return payload;
}

function readPhasePackFromForm() {
  const text = ($("phasePackText")?.value || "").trim();
  if (text) return parsePhasePackText(text);
  if (pendingPhasePack) return pendingPhasePack;
  return null;
}

async function readPackFromFile(file) {
  if (!file) throw new Error("Pick a pack JSON file.");
  return parsePhasePackText(await file.text());
}

function inferPackFile(phase, diet) {
  const stored = String(phase?.packFile || "").trim();
  if (/^phase-[\w.-]+\.json$/i.test(stored)) return stored;
  const blob = `${diet?.name || ""} ${phase?.notes || ""}`.toLowerCase();
  if (/julia|12-week|12 week/.test(blob)) return "phase-cut-12week-julia.json";
  if (/10-week|10 week/.test(blob)) return "phase-cut-10week.json";
  const picked = ($("phaseTplLibrary")?.value || "").trim();
  if (/^phase-[\w.-]+\.json$/i.test(picked)) return picked;
  if (window.KEJU_PHASE_PACKS?.["phase-cut-10week.json"]) return "phase-cut-10week.json";
  return "";
}

function packDietProof(pack) {
  const meals = pack?.diet?.training?.meals || [];
  const snack = meals.find((m) => m.id === "snack1");
  const last = meals.find((m) => m.id === "afterGym");
  const pre = meals.find((m) => m.id === "preGym");
  const snackBits = (snack?.items || []).join(", ");
  const lastBits = (last?.items || []).join(", ");
  const preBits = (pre?.items || []).slice(0, 2).join(", ");
  return `Pre-gym: ${preBits || "—"} · Snack: ${snackBits || "—"} · After gym: ${lastBits || "—"}`;
}

function fnv1aHex(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function packStamp(pack) {
  try {
    const slimMeals = (meals) =>
      (meals || []).map((m) => [
        m.id,
        m.kcal,
        m.protein,
        m.carbs,
        m.fat,
        m.swaps,
        m.items,
        (m.recipes || []).map((r) => r.id),
      ]);
    return `h:${fnv1aHex(
      JSON.stringify({
        notes: pack?.notes,
        t: slimMeals(pack?.diet?.training?.meals),
        r: slimMeals(pack?.diet?.rest?.meals),
        s: pack?.diet?.foodSwaps,
        shop: (pack?.shoppingList?.items || []).map((i) => [i.id, i.name, i.amount]),
      })
    )}`;
  } catch {
    return "";
  }
}

const shippedPackChecked = new Set();

async function maybeApplyShippedPack(phase) {
  if (!phase?.id || phaseCreateMode) return false;
  if (shippedPackChecked.has(phase.id)) return false;
  shippedPackChecked.add(phase.id);
  const file = String(phase.packFile || "").trim() || inferPackFile(phase, null);
  if (!file) return false;
  const pack = embeddedPhasePack(file);
  if (!pack) return false;
  const stamp = packStamp(pack);
  if (!stamp || phase.packStamp === stamp) return false;
  try {
    await CutDB.applyPackToPhase(phase.id, pack, { packFile: file, packStamp: stamp });
    showToast("Diet updated from shipped pack");
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
}

async function refreshCurrentPhaseFromShippedPack() {
  const phaseId = $("editPhaseId")?.value || selectedPhaseId;
  if (!phaseId || phaseCreateMode) {
    setPhasePackStatus("Open an existing phase to refresh its pack.");
    showToast("Open a phase first");
    return;
  }
  const file = $("phaseTplLibrary")?.value;
  if (!file) {
    setPhasePackStatus("No shipped pack on this install — upload a JSON file instead.");
    showToast("Upload a pack JSON");
    return;
  }
  let pack;
  try {
    setPhasePackStatus(`Loading ${file}…`);
    pack = await fetchBundledTemplate(file);
  } catch (err) {
    const raw = err?.message || String(err);
    const msg =
      /Failed to fetch|web page|504|Could not reach/i.test(raw)
        ? "Shipped pack could not load. Upload the JSON from your templates folder instead."
        : raw;
    setPhasePackStatus(msg);
    showToast(msg);
    return;
  }
  const proof = packDietProof(pack);
  if (
    !confirm(
      `Replace this phase’s diet, recipes, shopping, and training with the updated pack?\n\n${proof}\n\nDates and logs stay.`
    )
  ) {
    return;
  }
  try {
    await withActionProgress(
      "Refreshing pack…",
      async (report) => {
        report(25);
        await CutDB.applyPackToPhase(phaseId, pack, { packFile: file, packStamp: packStamp(pack) });
        selectedPhaseId = phaseId;
        pendingPhasePack = null;
        if ($("phasePackText")) $("phasePackText").value = "";
        report(75);
        await refreshAll({ tab: "phases" });
        const diet = await CutDB.getDietForPhase(phaseId);
        const liveProof = packDietProof({ diet: { training: { meals: diet?.training?.meals || [] } } });
        setPhasePackStatus(`Pack refreshed. ${liveProof}`);
        showToast(liveProof);
        report(100);
      },
      { doneMessage: "Pack refreshed", minVisibleMs: 300 }
    );
  } catch (err) {
    const msg = err?.message || String(err);
    setPhasePackStatus(msg);
    if (!err?.actionProgressHandled) showToast(msg);
  }
}

async function nextPhaseStartDate() {
  const phases = await CutDB.allPhases();
  const latest = phases
    .slice()
    .sort((a, b) => (b.endDate || "").localeCompare(a.endDate || ""))[0];
  if (latest?.endDate) return CutDBHelpers.addDaysISO(latest.endDate, 1);
  return CutDBHelpers.todayISO();
}

function focusPhaseStartPhoto() {
  const block = $("phasePhotosBlock");
  if (block) {
    block.hidden = false;
    block.scrollIntoView({ behavior: "smooth", block: "center" });
    pulseEl(block);
    pulseEl(block.querySelector(".file-btn"));
  }
  showToast("Add the phase-start photo");
}

async function openPhaseStartPhoto() {
  if (cachedPhase?.id) {
    selectedPhaseId = cachedPhase.id;
    phaseCreateMode = false;
  }
  await goToTab("phases");
  focusPhaseStartPhoto();
}

async function createPhaseFromPackObject(pack, { startDate, packFile } = {}) {
  CutDBHelpers.normalizePhaseTemplate(pack);
  const start = startDate || (await nextPhaseStartDate());
  let phase;
  await withActionProgress(
    "Creating phase from pack…",
    async (report) => {
      report(20);
      const result = await CutDB.createPhaseFromPack(pack, { startDate: start, packFile });
      phase = result.phase;
      selectedPhaseId = phase.id;
      phaseCreateMode = false;
      pendingPhasePack = null;
      if ($("phasePackText")) $("phasePackText").value = "";
      report(75);
      await refreshAll({ tab: "phases" });
      report(100);
    },
    { doneMessage: "Phase created — add the start photo", minVisibleMs: 300 }
  );
  focusPhaseStartPhoto();
  return phase;
}

async function fillTemplateLibrarySelects(preferredFile) {
  const gen = ++templateLibraryFillGen;
  let lib;
  try {
    lib = await fetchTemplateLibrary();
  } catch (err) {
    if (gen !== templateLibraryFillGen) return;
    setPhasePackStatus(err.message);
    return;
  }
  if (gen !== templateLibraryFillGen) return;
  const items = lib.phase || [];
  const fillSel = (sel) => {
    if (!sel) return;
    const prev = preferredFile || sel.value;
    sel.innerHTML = items
      .map((t) => `<option value="${escapeHtml(t.file)}">${escapeHtml(t.name)}</option>`)
      .join("");
    sel.disabled = !items.length;
    if (prev && items.some((t) => t.file === prev)) sel.value = prev;
  };
  fillSel($("phaseTplLibrary"));
  if (!pendingPhasePack && !($("phasePackText")?.value || "").trim()) {
    setPhasePackStatus(
      itemsHint(lib) || "Upload a pack JSON from templates/, or load a ready-made one."
    );
  }
}

function itemsHint(lib) {
  const n = (lib.phase || []).length;
  return n
    ? `${n} shipped pack${n === 1 ? "" : "s"} — or upload a JSON file.`
    : "Upload a pack JSON file.";
}

async function loadPhasePackIntoForm() {
  try {
    const file = $("phaseTplLibrary")?.value;
    if (!file) {
      setPhasePackStatus("No ready-made pack available.");
      showToast("No pack in the list");
      return;
    }
    setPhasePackStatus(`Loading ${file}…`);
    const payload = await fetchBundledTemplate(file);
    if ($("phasePackText")) $("phasePackText").value = JSON.stringify(payload, null, 2);
    applyPackToPhaseForm(payload);
    showToast("Pack loaded into form");
  } catch (err) {
    const msg = err?.message || String(err);
    setPhasePackStatus(msg);
    showToast(msg);
  }
}

async function downloadPhasePack() {
  try {
    const file = $("phaseTplLibrary")?.value;
    if (!file) {
      setPhasePackStatus("Pick a ready-made pack first.");
      showToast("No pack selected");
      return;
    }
    setPhasePackStatus(`Preparing ${file}…`);
    const payload = await fetchBundledTemplate(file);
    downloadJson(file, payload);
    setPhasePackStatus(`Downloaded ${file}.`);
    showToast("Download started");
  } catch (err) {
    const msg = err?.message || String(err);
    setPhasePackStatus(msg);
    showToast(msg);
  }
}

function wirePhasePackButtons() {
  if (phasePackButtonsWired) {
    void fillTemplateLibrarySelects();
    return;
  }
  phasePackButtonsWired = true;

  $("phasePackFile")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      setPhasePackStatus(`Reading ${file.name}…`);
      const payload = await readPackFromFile(file);
      await usePackNow(payload, { packFile: file.name });
    } catch (err) {
      const msg = err?.message || String(err);
      setPhasePackStatus(msg);
      showToast(msg);
    }
  });

  $("useReadyPackBtn")?.addEventListener("click", async () => {
    try {
      const file = $("phaseTplLibrary")?.value;
      if (!file) {
        setPhasePackStatus("No shipped pack on this install — upload a JSON file instead.");
        showToast("Upload a pack JSON");
        return;
      }
      setPhasePackStatus(`Loading ${file}…`);
      const payload = await fetchBundledTemplate(file);
      await usePackNow(payload, { packFile: file });
    } catch (err) {
      const raw = err?.message || String(err);
      const msg =
        /Failed to fetch|web page|504|Could not reach/i.test(raw)
          ? "Shipped pack could not load. Upload the JSON from your templates folder instead."
          : raw;
      setPhasePackStatus(msg);
      showToast(msg);
    }
  });
  void fillTemplateLibrarySelects();
}

function fillAiForm() {
  // One-time: move to Nemotron 3 Super (best free accuracy for diet parse)
  const prefs = loadPrefs();
  if (!prefs.accuracyModelV1) {
    savePrefs({
      openRouterModel: DEFAULT_TEXT_MODEL,
      accuracyModelV1: true,
      latencyModelV1: true,
    });
  }
  const s = aiSettings();
  if ($("aiProvider")) $("aiProvider").value = s.provider;
  if ($("geminiApiKey")) $("geminiApiKey").value = s.geminiKey;
  if ($("geminiModel")) {
    $("geminiModel").value = s.geminiModel;
    if ($("geminiModel").value !== s.geminiModel) $("geminiModel").value = DEFAULT_GEMINI_MODEL;
  }
  if ($("openRouterKey")) $("openRouterKey").value = s.openRouterKey;
  if ($("openRouterModel")) {
    $("openRouterModel").value = s.model;
    if ($("openRouterModel").value !== s.model) $("openRouterModel").value = DEFAULT_TEXT_MODEL;
  }
  if ($("openRouterVisionModel")) $("openRouterVisionModel").value = s.visionModel;
  if ($("autoPhaseInsight")) $("autoPhaseInsight").checked = s.autoPhaseInsight;
  if (loadPrefs().openRouterVisionModel && loadPrefs().openRouterVisionModel !== s.visionModel) {
    savePrefs({ openRouterVisionModel: s.visionModel });
  }
  syncAiProviderPanels();
  if ($("openRouterStatus")) {
    const parts = [];
    if (s.hasGemini) parts.push(`Gemini · ${s.geminiModel}`);
    if (s.hasOpenRouter) parts.push(`OpenRouter · ${s.model}`);
    const mode =
      s.provider === "auto" ? "Auto (first good reply wins)" : s.provider === "gemini" ? "Gemini only" : "OpenRouter only";
    $("openRouterStatus").textContent = parts.length
      ? `${mode} · ${parts.join(" + ")}`
      : "Add Gemini and/or OpenRouter keys below.";
  }
}

function fillOpenRouterForm() {
  fillAiForm();
}

function mealAdherenceForDay(entry, diet) {
  if (!entry || !diet) return null;
  const block = entry.trained ? diet.training : diet.rest;
  const planned = (block?.meals || []).length;
  if (!planned) return null;
  const done = (block.meals || []).filter((m) => (entry.mealChecks || {})[m.id]).length;
  return { done, planned, pct: Math.round((done / planned) * 100) };
}

function compactDayRow(date, entry, diet) {
  if (!entry) return { date };
  const m = entry.measurements || {};
  return {
    date,
    weight: entry.weight ?? null,
    trained: !!entry.trained,
    coffees: entry.coffees ?? null,
    steps: entry.steps ?? null,
    sleep: entry.sleep ?? null,
    hunger: entry.hunger ?? null,
    energy: entry.energy ?? null,
    bodyFatPct: m.bodyFatPct ?? null,
    waist: m.waist ?? entry.waist ?? null,
    visceralFat: m.visceralFat ?? null,
    adherence: mealAdherenceForDay(entry, diet),
    workoutSession: entry.workout?.sessionName || null,
    swapPicks: entry.swapPicks || {},
    notes: entry.notes || "",
  };
}

async function buildDailyInsightPayload(date) {
  const data = await CutDB.allDays();
  const phases = await CutDB.allPhases();
  const phase = phases.find((p) => CutDBHelpers.phaseCoversDate(p, date)) || cachedPhase;
  const diet = phase ? await CutDB.getDietForPhase(phase.id) : cachedDiet;
  const recent = [];
  for (let i = 6; i >= 0; i--) {
    const d = CutDBHelpers.addDaysISO(date, -i);
    recent.push(compactDayRow(d, data[d], diet));
  }
  return {
    type: "keju-daily-insight-input",
    date,
    goalLossPctPerWeek: goalLossPct(phase),
    phase: phase
      ? {
          id: phase.id,
          name: phase.name,
          startDate: phase.startDate,
          endDate: phase.endDate,
          goalLossPctPerWeek: goalLossPct(phase),
        }
      : null,
    dietTargets: diet
      ? {
          training: diet.training?.targets || null,
          rest: diet.rest?.targets || null,
        }
      : null,
    recentDays: recent,
    today: compactDayRow(date, data[date], diet),
  };
}

async function buildPhaseInsightPayload(phase) {
  if (!phase?.startDate) return null;
  const data = await CutDB.allDays();
  const diet = await CutDB.getDietForPhase(phase.id);
  const train = await CutDB.getTrainingForPhase(phase.id);
  const end = phase.endDate || CutDBHelpers.twoWeekEnd(phase.startDate);
  const days = [];
  let d = phase.startDate;
  while (d <= end) {
    if (data[d]) days.push(compactDayRow(d, data[d], diet));
    d = CutDBHelpers.addDaysISO(d, 1);
  }
  const weights = days.map((x) => x.weight).filter((n) => typeof n === "number");
  const bfs = days.map((x) => x.bodyFatPct).filter((n) => typeof n === "number");
  return {
    type: "keju-phase-insight-input",
    phase: {
      id: phase.id,
      name: phase.name,
      startDate: phase.startDate,
      endDate: end,
    },
    dietName: diet?.name || null,
    trainingName: train?.name || null,
    dietTargets: diet
      ? { training: diet.training?.targets || null, rest: diet.rest?.targets || null }
      : null,
    stats: {
      weighIns: weights.length,
      weightStart: weights[0] ?? null,
      weightEnd: weights.length ? weights[weights.length - 1] : null,
      weightDelta:
        weights.length >= 2 ? Number((weights[weights.length - 1] - weights[0]).toFixed(2)) : null,
      bodyFatStart: bfs[0] ?? null,
      bodyFatEnd: bfs.length ? bfs[bfs.length - 1] : null,
      trainDays: days.filter((x) => dayHasLoggedWeights(x)).length,
      avgAdherencePct: (() => {
        const pts = days.map((x) => x.adherence?.pct).filter((n) => typeof n === "number");
        if (!pts.length) return null;
        return Math.round(pts.reduce((a, b) => a + b, 0) / pts.length);
      })(),
    },
    days,
  };
}

async function saveInsightAnalysis({ title, content, source, timestamp, phaseId }) {
  const id = CutDBHelpers.uid("analysis");
  await CutDB.saveAnalysis({
    id,
    type: "cut-tracker-analysis",
    title,
    timestamp: timestamp || new Date().toISOString(),
    importedAt: new Date().toISOString(),
    content,
    source,
    phaseId: phaseId || null,
  });
  return id;
}

function parseImportedAnalysis(text, fallbackTitle) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("Paste an AI reply first.");
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    try {
      parsed = extractJsonBlock(raw);
    } catch (_) {
      parsed = null;
    }
  }
  if (Array.isArray(parsed)) parsed = parsed[0];
  const clean = parsed && typeof parsed === "object" ? CutDBHelpers.sanitizeInsightContent?.(parsed) : null;
  const content = clean?.content || (typeof parsed?.content === "string" ? parsed.content.trim() : "") || raw;
  if (!content) throw new Error("That reply has no text to save.");
  return {
    title: clean?.title || parsed?.title || fallbackTitle || "Analysis",
    content,
    timestamp: clean?.timestamp || parsed?.timestamp || new Date().toISOString(),
  };
}

async function analysisById(id) {
  if (!id) return null;
  const all = await CutDB.allAnalyses();
  return all.find((a) => a.id === id) || null;
}

function sourceLabel(source) {
  const map = {
    daily: "In-app",
    imported: "Imported",
    progress: "In-app",
    "auto-phase": "Phase end",
    phase: "Phase",
    openrouter: "In-app",
    gemini: "In-app",
  };
  return map[source] || source || "Insight";
}

async function renderTodayInsightCard(date) {
  const card = $("insightCard");
  if (!card) return;
  card.hidden = false;
  const day = await CutDB.getDay(date);
  const analysis = await analysisById(day?.dailyInsightId);
  card.classList.toggle("has-insight", !!analysis);
  if ($("insightCardTitle")) $("insightCardTitle").textContent = analysis?.title || "Daily insight";
  if ($("insightCardMeta")) {
    $("insightCardMeta").textContent = analysis
      ? `${sourceLabel(analysis.source)} · ${new Date(analysis.importedAt || analysis.timestamp).toLocaleDateString()}`
      : date;
  }
  const body = $("insightCardBody");
  if (body) {
    body.hidden = !analysis;
    body.textContent = analysis?.content || "";
  }
  if (analysis && $("insightImportFold")) $("insightImportFold").open = false;
}

async function attachDailyInsight(date, { title, content, source, timestamp }) {
  const id = await saveInsightAnalysis({
    title: title || `Daily · ${date}`,
    content,
    source,
    timestamp,
  });
  const day = (await CutDB.getDay(date)) || { date };
  await CutDB.saveDay({ ...day, date, dailyInsightId: id, updatedAt: new Date().toISOString() });
  await renderTodayInsightCard(date);
  try {
    await renderAnalyses();
  } catch (_) {}
  return id;
}

async function runDailyInsightForDate(date) {
  const payload = await buildDailyInsightPayload(date);
  const raw = await aiChat({
    system: CutDBHelpers.AI_PROMPTS.dailyInsight,
    user: `Date ${date}. Summarize this payload:\n\n${JSON.stringify(payload)}`,
    temperature: 0.3,
  });
  const parsed = extractJsonBlock(raw);
  const clean = CutDBHelpers.sanitizeInsightContent?.(parsed);
  if (!clean) throw new Error("Insight skipped — not enough reliable content");
  await attachDailyInsight(date, {
    title: clean.title || `Daily · ${date}`,
    content: clean.content,
    source: "daily",
    timestamp: clean.timestamp,
  });
}

async function runPhaseInsight(phase, { source = "auto-phase" } = {}) {
  if (!phase?.id) throw new Error("No phase to analyze.");
  const payload = await buildPhaseInsightPayload(phase);
  const raw = await aiChat({
    system: CutDBHelpers.AI_PROMPTS.phaseInsight,
    user: `Phase ended ${phase.endDate || ""}. Recommend next phase from:\n\n${JSON.stringify(payload)}`,
    temperature: 0.3,
  });
  const parsed = extractJsonBlock(raw);
  const clean = CutDBHelpers.sanitizeInsightContent?.(parsed);
  if (!clean) throw new Error("Phase insight skipped — not enough reliable content");
  const id = await saveInsightAnalysis({
    title: clean.title || `Phase · ${phase.name}`,
    content: clean.content,
    source,
    timestamp: clean.timestamp,
    phaseId: phase.id,
  });
  await CutDB.savePhase({ ...phase, phaseInsightId: id, phaseInsightAttemptedAt: new Date().toISOString() });
  const end = phase.endDate || CutDBHelpers.twoWeekEnd(phase.startDate);
  if (end) {
    const day = (await CutDB.getDay(end)) || { date: end };
    await CutDB.saveDay({ ...day, date: end, phaseInsightId: id, updatedAt: new Date().toISOString() });
  }
  return id;
}

function phaseEndISO(phase) {
  return phase?.endDate || (phase?.startDate ? CutDBHelpers.twoWeekEnd(phase.startDate) : null);
}

function phaseIsComplete(phase, today) {
  const end = phaseEndISO(phase);
  return !!(end && end <= today);
}

async function maybeRunCompletedPhaseInsights() {
  const settings = aiSettings();
  if (!settings.autoPhaseInsight || !settings.key) return;
  const today = CutDBHelpers.todayISO();
  const phases = await CutDB.allPhases();
  const due = phases.filter((p) => phaseIsComplete(p, today) && !p.phaseInsightId && !p.phaseInsightAttemptedAt);
  if (!due.length) return;
  for (const phase of due) {
    try {
      showToast(`Analyzing phase ${phase.name || ""}…`);
      await runPhaseInsight(phase, { source: "auto-phase" });
      showToast(`Phase ${phase.name || ""} analysis ready`);
    } catch (err) {
      console.warn(err);
      try {
        await CutDB.savePhase({
          ...phase,
          phaseInsightAttemptedAt: new Date().toISOString(),
        });
      } catch (_) {}
      showToast(err.message || "Phase analysis skipped");
    }
  }
  try {
    await renderAnalyses();
  } catch (_) {}
}

async function importDailyInsightReply(date, text) {
  const parsed = parseImportedAnalysis(text, `Daily · ${date}`);
  await attachDailyInsight(date, {
    title: parsed.title,
    content: parsed.content,
    source: "imported",
    timestamp: parsed.timestamp,
  });
}

async function applyScaleOcrResult(parsed) {
  const clean = CutDBHelpers.sanitizeScaleOcrResult
    ? CutDBHelpers.sanitizeScaleOcrResult(parsed)
    : parsed;
  if (typeof clean.weight === "number" && $("weight")) {
    $("weight").value = clean.weight;
  }
  const measures = clean.measurements || {};
  const compKeys = new Set(
    CutDBHelpers.MEASURE_FIELDS.filter((m) => m.group === "comp").map((m) => m.key)
  );
  let filled = typeof clean.weight === "number" ? 1 : 0;
  for (const key of compKeys) {
    const el = $(`measure_${key}`);
    if (!el) continue;
    const v = measures[key];
    if (v != null && v !== "" && Number.isFinite(Number(v))) {
      el.value = Number(v);
      filled += 1;
    }
  }
  const details = document.querySelector("details.measures");
  if (details) details.open = true;
  return filled;
}

function goalLossPct(phase = cachedPhase) {
  const fromPhase = Number(phase?.goalLossPctPerWeek);
  if (Number.isFinite(fromPhase) && fromPhase > 0) return fromPhase;
  // Legacy global pref (migrated away — still read as fallback)
  const prefs = loadPrefs();
  if (typeof prefs.goalLossPctPerWeek === "number" && prefs.goalLossPctPerWeek > 0) {
    return prefs.goalLossPctPerWeek;
  }
  return Number(cfg().goalLossPctPerWeek) || 0.75;
}

function localHour() {
  return new Date().getHours();
}

function buildHabitNudges(entry) {
  const e = entry || {};
  const c = cfg();
  const hour = localHour();
  const mealsDone = Object.values(e.mealChecks || {}).filter(Boolean).length;
  const planned = (() => {
    if (!cachedDiet) return 0;
    const block = e.trained ? cachedDiet.training : cachedDiet.rest;
    return (block?.meals || []).filter(isPlateMeal).length;
  })();
  const mealNames = (() => {
    if (!cachedDiet) return [];
    const block = e.trained ? cachedDiet.training : cachedDiet.rest;
    return (block?.meals || []).filter(isPlateMeal);
  })();
  const checks = e.mealChecks || {};
  const nextMeal = mealNames.find((m) => !checks[m.id]);
  const nudges = [];

  const morningH = Number(c.nudgeMorningHour ?? 9);
  const lunchH = Number(c.nudgeLunchHour ?? 13);
  const dinnerH = Number(c.nudgeDinnerHour ?? 19);
  const eveningH = Number(c.nudgeEveningHour ?? 21);

  if (e.weight == null && hour >= morningH) {
    nudges.push({
      id: "morning",
      title: "Weigh-in due",
      detail: "Log morning weight",
      jump: "morning",
      urgent: hour >= morningH + 2,
    });
  }
  if (e.sleep == null && hour >= morningH) {
    nudges.push({
      id: "sleep",
      title: "Sleep last night",
      detail: "Log hours in Morning",
      jump: "morning",
      urgent: hour >= morningH + 2,
    });
  }
  if (hour >= lunchH && planned > 0 && mealsDone === 0) {
    nudges.push({
      id: "lunch",
      title: "Meals not started",
      detail: nextMeal ? `Next: ${nextMeal.name}` : "Check meals as you eat",
      jump: "meals",
      urgent: hour >= lunchH + 2,
    });
  } else if (hour >= dinnerH && planned > 0 && mealsDone < planned) {
    nudges.push({
      id: "dinner",
      title: "Finish meals",
      detail: nextMeal ? `Still open: ${nextMeal.name}` : `${mealsDone}/${planned} checked`,
      jump: "meals",
      urgent: hour >= dinnerH + 1,
    });
  }
  const plannedLift =
    !!e.trained || !!plannedSessionId($("logDate")?.value || CutDBHelpers.todayISO());
  if (plannedLift && !liftsLogged(e)) {
    if (hour >= 15) {
      nudges.push({
        id: "workout",
        title: "No lifts logged yet",
        detail: "Save set weights when you train",
        jump: "workout",
        urgent: hour >= 18,
      });
    }
  }
  if (hour >= eveningH && e.steps == null) {
    nudges.push({
      id: "wrap",
      title: "Evening wrap",
      detail: "Need steps",
      jump: "wrap",
      urgent: hour >= eveningH + 1,
    });
  }
  const todayISO = CutDBHelpers.todayISO();
  const dow = new Date(`${todayISO}T12:00:00`).getDay();
  if (dow === 5 && cachedDiet) {
    if (dietHasRecipes() && !prepSeenThisWeek()) {
      nudges.push({
        id: "prep",
        title: "Friday meal prep",
        detail: "Recipes and cook times from this pack",
        jump: "prep",
        urgent: hour >= 10,
      });
    }
    if (!shoppingSeenThisWeek()) {
      nudges.push({
        id: "shopping",
        title: "Friday shopping",
        detail: "Check this week’s grocery list",
        jump: "shopping",
        urgent: hour >= 10,
      });
    }
  }
  return nudges;
}

function daysBetweenISO(from, to) {
  const a = new Date(`${from}T12:00:00`);
  const b = new Date(`${to}T12:00:00`);
  if (Number.isNaN(+a) || Number.isNaN(+b)) return 0;
  return Math.round((b - a) / 86400000);
}

function dayHasLog(entry) {
  if (!entry || typeof entry !== "object") return false;
  return (
    entry.weight != null ||
    entry.steps != null ||
    entry.sleep != null ||
    Object.values(entry.mealChecks || {}).some(Boolean)
  );
}

let lastBackupState = null;

function backupReminderState(data) {
  const last = String(loadPrefs().lastBackupAt || "").slice(0, 10);
  const today = CutDBHelpers.todayISO();
  const never = !last;
  const age = never ? Infinity : daysBetweenISO(last, today);
  const loggedDays = Object.values(data || {}).filter(dayHasLog).length;
  lastBackupState = {
    last,
    age: Number.isFinite(age) ? age : null,
    never,
    loggedDays,
    due: age >= 45 || (never && loggedDays >= 7),
    nudge: age >= 30 || (never && loggedDays >= 3),
  };
  return lastBackupState;
}

function formatBackupStamp(state) {
  if (!state || state.never) return "No backup timestamp on this phone yet.";
  if (state.age === 0) return "Last backup: today.";
  if (state.age === 1) return "Last backup: yesterday.";
  return `Last backup: ${state.last} · ${state.age} days ago.`;
}

function renderBackupStamp(state) {
  const el = $("backupStamp");
  if (!el) return;
  el.textContent = formatBackupStamp(state);
}

let lastHasStartPhoto = true;

function setNextAction(title, cta, jump, labelText) {
  const label = document.querySelector(".next-label");
  if (label && labelText) label.textContent = labelText;
  if ($("nextActionTitle")) $("nextActionTitle").textContent = title;
  if ($("nextActionBtn")) {
    $("nextActionBtn").textContent = cta;
    $("nextActionBtn").dataset.jump = jump;
  }
}

function isFridayISO(dateISO) {
  return new Date(`${dateISO}T12:00:00`).getDay() === 5;
}

function shoppingSeenThisWeek() {
  return loadPrefs().shoppingSeenWeek === CutDBHelpers.shoppingWeekFriday();
}

function markShoppingSeen() {
  savePrefs({ shoppingSeenWeek: CutDBHelpers.shoppingWeekFriday() });
}

function prepSeenThisWeek() {
  return loadPrefs().prepSeenWeek === CutDBHelpers.shoppingWeekFriday();
}

function markPrepSeen() {
  savePrefs({ prepSeenWeek: CutDBHelpers.shoppingWeekFriday() });
}

function dietHasRecipes(diet = cachedDiet) {
  return (CutDBHelpers.dietRecipeCount(diet) || 0) > 0;
}

function applyTodayDueOverrides(backup, date) {
  const today = CutDBHelpers.todayISO();
  const viewingToday = date === today;
  if (viewingToday && backup?.due) {
    setNextAction("Export a backup", "Backup", "backup", "Due");
    return;
  }
  if (!cachedPhase) return;
  if (!lastHasStartPhoto) {
    setNextAction("Add phase-start photo", "Photo", "photo", "Due");
    return;
  }
  if (viewingToday && isFridayISO(date) && cachedDiet) {
    if (dietHasRecipes() && !prepSeenThisWeek()) {
      setNextAction("Friday meal prep", "Prep", "prep", "Due");
      return;
    }
    if (!shoppingSeenThisWeek()) {
      setNextAction("Friday shopping list", "Shop", "shopping", "Due");
    }
  }
}

function computePhaseRunStats(data, phase, throughDate, diet) {
  const start = phase?.startDate;
  if (!start) return null;
  const end = phase.endDate || CutDBHelpers.addDaysISO(start, 13);
  const last = throughDate < end ? throughDate : end;
  let mornings = 0;
  let closed = 0;
  let eveningRun = 0;
  let bestEvening = 0;
  let cursor = start;
  while (cursor && cursor <= end && cursor <= last) {
    const entry = data[cursor];
    if (typeof entry?.weight === "number") mornings += 1;
    if (dayIsClosed(entry, diet)) closed += 1;
    if (eveningLogged(entry)) {
      eveningRun += 1;
      if (eveningRun > bestEvening) bestEvening = eveningRun;
    } else {
      eveningRun = 0;
    }
    cursor = CutDBHelpers.addDaysISO(cursor, 1);
  }
  let eveningStreak = 0;
  cursor = last;
  while (cursor && cursor >= start) {
    if (eveningLogged(data[cursor])) {
      eveningStreak += 1;
      cursor = CutDBHelpers.addDaysISO(cursor, -1);
    } else {
      break;
    }
  }
  const dayNum = Math.min(14, Math.max(1, daysBetweenISO(start, throughDate) + 1));
  return { start, end, dayNum, mornings, closed, eveningStreak, bestEvening };
}

function formatBackupAge(backup) {
  if (!backup || backup.never) return "never";
  if (backup.age === 0) return "today";
  if (backup.age === 1) return "yesterday";
  return `${backup.age} days ago`;
}

function renderPhaseRun(data, date, diet = cachedDiet) {
  const card = $("phaseRunCard");
  if (!card) return;
  const phase = cachedPhase;
  if (!phase?.startDate) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const stats = computePhaseRunStats(data, phase, date, diet);
  if (!stats) {
    card.hidden = true;
    return;
  }
  if ($("phaseRunTitle")) $("phaseRunTitle").textContent = `Day ${stats.dayNum} of 14`;
  if ($("phaseRunStreak")) {
    $("phaseRunStreak").textContent = stats.bestEvening
      ? `Evening ${stats.eveningStreak || 0} · best ${stats.bestEvening}`
      : "Evening streak —";
  }
  if ($("phaseRunBar")) {
    $("phaseRunBar").style.width = `${Math.round((Math.min(stats.mornings, 14) / 14) * 100)}%`;
  }
  if ($("phaseRunHint")) {
    $("phaseRunHint").textContent = `Closed ${stats.closed} / 14 · ${stats.mornings} morning weigh-in${
      stats.mornings === 1 ? "" : "s"
    }`;
  }
}

function fillPhaseEndScore(stats, hasPhoto, backup) {
  const list = $("phaseEndScore");
  if (!list || !stats) {
    if (list) list.innerHTML = "";
    return;
  }
  const rows = [
    ["Morning weigh-ins", `${stats.mornings} / 14`],
    ["Closed days", `${stats.closed} / 14`],
    ["Best evening streak", String(stats.bestEvening)],
    ["Start photo", hasPhoto ? "Yes" : "No"],
    ["Backup", formatBackupAge(backup)],
  ];
  list.innerHTML = rows
    .map(([k, v]) => `<li><em>${escapeHtml(k)}</em><strong>${escapeHtml(v)}</strong></li>`)
    .join("");
}

async function renderPhaseEndCard(date, data, backup) {
  const banner = $("phaseEndBanner");
  if (!banner) return;
  const phases = await CutDB.allPhases();
  const covering = phases.find((p) => CutDBHelpers.phaseCoversDate(p, date)) || null;
  const latest = phases
    .slice()
    .sort((a, b) => (b.endDate || "").localeCompare(a.endDate || ""))[0];
  const lastDay = !!(covering && covering.endDate === date);
  const ended = !covering && !!(latest?.endDate && latest.endDate < date);
  const scorePhase = lastDay ? covering : ended ? latest : null;
  if (!scorePhase) {
    banner.hidden = true;
    fillPhaseEndScore(null);
    return;
  }
  banner.hidden = false;
  const diet =
    cachedPhase?.id === scorePhase.id
      ? cachedDiet
      : await CutDB.getDietForPhase(scorePhase.id);
  const through = lastDay ? date : scorePhase.endDate || date;
  const stats = computePhaseRunStats(data, scorePhase, through, diet);
  const photos = await CutDB.photosForPhaseStart(scorePhase);
  if ($("phaseEndKicker")) $("phaseEndKicker").textContent = lastDay ? "Last day" : "Phase ended";
  if ($("phaseEndBannerTitle")) {
    $("phaseEndBannerTitle").textContent = lastDay
      ? `Last day of phase ${scorePhase.name}`
      : `Phase ${scorePhase.name} ended`;
  }
  if ($("phaseEndBannerHint")) {
    $("phaseEndBannerHint").textContent = lastDay
      ? "Finish today’s log. Tomorrow this phone will ask for the next pack (upload JSON from templates)."
      : "Upload the next pack JSON from your templates folder.";
  }
  fillPhaseEndScore(stats, photos.length > 0, backup);
}

function renderHabitNudges(entry, backupState = lastBackupState) {
  const card = $("nudgeCard");
  const list = $("nudgeList");
  if (!card || !list) return;
  const prefs = loadPrefs();
  const today = CutDBHelpers.todayISO();
  if (prefs.nudgeDismissDate === today) {
    card.hidden = true;
    return;
  }
  const date = $("logDate")?.value || today;
  // Only nudge for "today" view
  if (date !== today) {
    card.hidden = true;
    return;
  }
  const nudges = cachedPhase ? buildHabitNudges(entry) : [];
  if (backupState?.nudge) {
    nudges.push({
      id: "backup",
      title: backupState.due ? "Backup overdue" : "Monthly backup",
      detail: backupState.never
        ? "Save a JSON copy off this phone"
        : `Last backup ${backupState.age} days ago`,
      jump: "backup",
      urgent: !!backupState.due,
    });
  }
  if (!nudges.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  list.innerHTML = nudges
    .map(
      (n) => `<li class="nudge-item ${n.urgent ? "urgent" : ""}">
        <div><strong>${escapeHtml(n.title)}</strong><span>${escapeHtml(n.detail)}</span></div>
        <button type="button" class="btn tiny" data-nudge-jump="${escapeHtml(n.jump)}">Go</button>
      </li>`
    )
    .join("");
  list.querySelectorAll("[data-nudge-jump]").forEach((btn) => {
    btn.addEventListener("click", () => jumpToStep(btn.dataset.nudgeJump));
  });
  maybeNotifyNudges(nudges);
}

async function ensureNotificationsAllowed() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try {
    return (await Notification.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

async function maybeNotifyNudges(nudges) {
  const urgent = nudges.filter((n) => n.urgent);
  if (!urgent.length) return;
  if (!(await ensureNotificationsAllowed())) return;
  const prefs = loadPrefs();
  const today = CutDBHelpers.todayISO();
  const key = urgent.map((n) => n.id).join(",");
  if (prefs.lastNotifyKey === `${today}:${key}`) return;
  try {
    new Notification("KeJu Fit Tracker", {
      body: urgent.map((n) => n.title).join(" · "),
      tag: "keju-habit",
    });
    savePrefs({ lastNotifyKey: `${today}:${key}` });
  } catch {
    /* ignore */
  }
}

async function renderTargetsVsReality(data) {
  const kpis = $("targetsKpis");
  const detail = $("targetsDetail");
  if (!kpis || !detail) return;
  const date = $("logDate")?.value || CutDBHelpers.todayISO();
  const weighIns = sortedDates(data)
    .filter((d) => typeof data[d].weight === "number")
    .map((d) => ({ date: d, weight: data[d].weight }));
  const avgNow = mean(lastNWeights(data, 7, date).map((x) => x.weight));
  const weekAgo = CutDBHelpers.addDaysISO(date, -7);
  const avgThen = mean(lastNWeights(data, 7, weekAgo).map((x) => x.weight));
  let rateKg = null;
  let ratePct = null;
  if (avgNow != null && avgThen != null) {
    rateKg = avgNow - avgThen;
    ratePct = avgThen ? (rateKg / avgThen) * 100 : null;
  }
  const goalPct = goalLossPct();
  const goalKg = avgNow != null ? -((goalPct / 100) * avgNow) : null;
  let pace = "—";
  let paceClass = "";
  if (ratePct != null && goalPct > 0) {
    // loss is negative ratePct
    const lossPct = -ratePct;
    if (lossPct < goalPct * 0.5) {
      pace = "Slower than goal";
      paceClass = "warn";
    } else if (lossPct > goalPct * 1.35) {
      pace = "Faster than goal";
      paceClass = "warn";
    } else {
      pace = "On track";
      paceClass = "ok";
    }
  }

  const diet = cachedDiet;
  const trainT = diet?.training?.targets || {};
  const restT = diet?.rest?.targets || {};

  // Last 7 days adherence + planned kcal average if we knew train/rest
  let adhereSum = 0;
  let adhereN = 0;
  let plannedKcalSum = 0;
  let plannedKcalN = 0;
  const from = CutDBHelpers.addDaysISO(date, -6);
  sortedDates(data)
    .filter((d) => d >= from && d <= date)
    .forEach((d) => {
      const e = data[d];
      const phase = cachedPhase && CutDBHelpers.phaseCoversDate(cachedPhase, d) ? cachedPhase : null;
      // use cached diet for current phase only (simple, honest)
      if (!diet) return;
      const block = e.trained ? diet.training : diet.rest;
      const planned = (block?.meals || []).length;
      if (planned) {
        const done = (block.meals || []).filter((m) => (e.mealChecks || {})[m.id]).length;
        adhereSum += done / planned;
        adhereN += 1;
      }
      const kcal = block?.targets?.kcal;
      if (typeof kcal === "number") {
        plannedKcalSum += kcal;
        plannedKcalN += 1;
      }
    });
  const adherePct = adhereN ? Math.round((adhereSum / adhereN) * 100) : null;
  const avgPlanKcal = plannedKcalN ? Math.round(plannedKcalSum / plannedKcalN) : null;

  kpis.innerHTML = `
    <div class="chart-kpi"><span>7d weight Δ</span><strong>${rateKg != null ? formatDelta(rateKg) : "—"}</strong></div>
    <div class="chart-kpi"><span>% / week</span><strong>${ratePct != null ? `${ratePct > 0 ? "+" : ""}${ratePct.toFixed(2)}%` : "—"}</strong></div>
    <div class="chart-kpi"><span>Goal % / week</span><strong>−${goalPct.toFixed(2)}%</strong></div>
    <div class="chart-kpi"><span>Pace</span><strong class="${paceClass}">${pace}</strong></div>
    <div class="chart-kpi"><span>Meal adherence 7d</span><strong>${adherePct != null ? adherePct + "%" : "—"}</strong></div>
    <div class="chart-kpi"><span>Avg plan kcal</span><strong>${avgPlanKcal != null ? avgPlanKcal : "—"}</strong></div>`;

  if ($("targetsMeta")) {
    $("targetsMeta").textContent = goalKg != null ? `Goal ≈ ${goalKg.toFixed(2)} kg/week` : "";
  }

  detail.innerHTML = `
    <div class="targets-grid">
      <div>
        <h3>Training day plan</h3>
        <p>${trainT.kcal ?? "—"} kcal · P${trainT.protein ?? "—"} C${trainT.carbs ?? "—"} F${trainT.fat ?? "—"}</p>
      </div>
      <div>
        <h3>Rest day plan</h3>
        <p>${restT.kcal ?? "—"} kcal · P${restT.protein ?? "—"} C${restT.carbs ?? "—"} F${restT.fat ?? "—"}</p>
      </div>
    </div>
    <p class="hint">Adherence = meals checked ÷ meals planned. We don’t invent calories eaten — only what you logged.</p>
    <p class="hint">${
      ratePct == null
        ? "Need ~2 weeks of weigh-ins for a stable rate."
        : `Last 7-day avg vs prior 7-day avg. Aim about −${goalPct}% bodyweight/week.`
    }</p>`;
}

let comparePhotoList = [];
const livePhotoUrls = new Set();

function revokeLivePhotoUrls() {
  for (const url of livePhotoUrls) {
    try {
      URL.revokeObjectURL(url);
    } catch (_) {}
  }
  livePhotoUrls.clear();
}

async function photoObjectUrl(photo) {
  const blob = await CutDB.resolvePhotoBlob(photo);
  const url = URL.createObjectURL(blob);
  livePhotoUrls.add(url);
  return url;
}

function photoTimeLabel(photo) {
  const iso = photo?.createdAt;
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch (_) {
    return "";
  }
}

function photoCompareLabel(photo, phases, index, totalSame) {
  const phaseName = photo.phaseId
    ? phases.find((ph) => ph.id === photo.phaseId)?.name || "Phase"
    : null;
  const base = phaseName ? `${phaseName} · ${photo.date}` : `Start ${photo.date}`;
  const time = photoTimeLabel(photo);
  if (totalSame > 1 && time) return `${base} · ${time}`;
  if (totalSame > 1) return `${base} · #${index + 1}`;
  return base;
}

async function makePhotoThumb(photo) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "photo-thumb";
  const caption = photoTimeLabel(photo);
  try {
    const url = await photoObjectUrl(photo);
    btn.innerHTML = `<img src="${url}" alt="" loading="lazy" />${
      caption ? `<span>${escapeHtml(caption)}</span>` : ""
    }`;
    btn.onclick = () => {
      activePhotoId = photo.id;
      $("photoDialogImg").src = url;
      $("photoDialog").showModal();
    };
  } catch (err) {
    btn.classList.add("is-broken");
    btn.innerHTML = `<span class="hint">Photo unavailable</span>`;
  }
  return btn;
}

async function renderPhotoCompare() {
  const beforeSel = $("compareBefore");
  const afterSel = $("compareAfter");
  const stage = $("compareStage");
  if (!beforeSel || !afterSel || !stage) return;
  const photos = await CutDB.allPhotos();
  comparePhotoList = photos
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  if (comparePhotoList.length < 2) {
    beforeSel.innerHTML = "";
    afterSel.innerHTML = "";
    stage.innerHTML = `<p class="chart-empty">Add phase-start photos on at least two phases.</p>`;
    return;
  }
  const phases = await CutDB.allPhases();
  const sameKeyCount = {};
  comparePhotoList.forEach((p) => {
    const key = `${p.phaseId || ""}|${p.date}`;
    sameKeyCount[key] = (sameKeyCount[key] || 0) + 1;
  });
  const opts = comparePhotoList
    .map((p, i) => {
      const key = `${p.phaseId || ""}|${p.date}`;
      const label = photoCompareLabel(p, phases, i, sameKeyCount[key] || 1);
      return `<option value="${i}">${escapeHtml(label)}</option>`;
    })
    .join("");
  const prevBefore = beforeSel.value;
  const prevAfter = afterSel.value;
  beforeSel.innerHTML = opts;
  afterSel.innerHTML = opts;
  beforeSel.value = prevBefore !== "" && comparePhotoList[prevBefore] ? prevBefore : "0";
  afterSel.value =
    prevAfter !== "" && comparePhotoList[prevAfter] ? prevAfter : String(comparePhotoList.length - 1);
  await paintCompareStage();
}

async function paintCompareStage() {
  const stage = $("compareStage");
  const beforeSel = $("compareBefore");
  const afterSel = $("compareAfter");
  if (!stage || !beforeSel || !afterSel) return;
  const a = comparePhotoList[Number(beforeSel.value)];
  const b = comparePhotoList[Number(afterSel.value)];
  if (!a || !b) {
    stage.innerHTML = `<p class="chart-empty">Pick two photos.</p>`;
    return;
  }
  try {
    const urlA = await photoObjectUrl(a);
    const urlB = await photoObjectUrl(b);
    stage.innerHTML = `
    <div class="compare-grid">
      <figure class="compare-pane">
        <img src="${urlA}" alt="Before" />
        <figcaption>Before · ${escapeHtml(a.date)}${
          photoTimeLabel(a) ? ` · ${escapeHtml(photoTimeLabel(a))}` : ""
        }</figcaption>
      </figure>
      <figure class="compare-pane">
        <img src="${urlB}" alt="After" />
        <figcaption>After · ${escapeHtml(b.date)}${
          photoTimeLabel(b) ? ` · ${escapeHtml(photoTimeLabel(b))}` : ""
        }</figcaption>
      </figure>
    </div>`;
  } catch (err) {
    stage.innerHTML = `<p class="chart-empty">${escapeHtml(err.message || "Could not open photos")}</p>`;
  }
}

function patchFromSection(section) {
  syncTrainedUI();
  if (section === "morning") {
    const measurements = readMeasurements();
    return {
      weight: parseNum($("weight").value),
      sleep: parseNum($("sleep").value),
      waist: measurements.waist ?? null,
      measurements,
      trained: $("trainedSelect").value === "train",
    };
  }
  if (section === "coffee") return { coffees: parseNum($("coffees").value) ?? 0 };
  if (section === "meals") {
    return {
      mealChecks: readMealChecks(),
      trained: $("trainedSelect").value === "train",
    };
  }
  if (section === "workout") return { trained: true, workout: readWorkoutLog() };
  if (section === "wrap") {
    return {
      steps: parseNum($("steps").value),
      hunger: parseNum($("hunger").value),
      energy: parseNum($("energy").value),
      notes: $("notes").value.trim(),
    };
  }
  return {};
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function parseNum(v) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function formatKg(n) {
  return n == null || Number.isNaN(n) ? "—" : `${n.toFixed(1)} kg`;
}
function formatDelta(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(1)} kg`;
}
function formatRange(p) {
  return `${p?.startDate || "—"} → ${p?.endDate || CutDBHelpers.twoWeekEnd(p?.startDate) || "—"}`;
}

function downloadJson(name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name || "download.json";
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function showToast(msg) {
  const el = $("toast");
  if (!el) return;
  el.hidden = false;
  el.textContent = msg;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => (el.hidden = true), 2200);
}

let actionDepth = 0;
let actionTickTimer = null;
let actionShowTimer = null;
let actionPct = 0;
let activeAiAbort = null;
let actionCancelledByUser = false;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function setActionProgress(pct, label) {
  actionPct = Math.max(0, Math.min(100, Math.round(pct)));
  const overlay = $("actionProgress");
  if (!overlay || overlay.hidden) return;
  if (label && $("actionProgressLabel")) $("actionProgressLabel").textContent = label;
  if ($("actionProgressBar")) $("actionProgressBar").style.width = `${actionPct}%`;
  if ($("actionProgressPct")) $("actionProgressPct").textContent = `${actionPct}%`;
}

function openActionProgress(label) {
  const overlay = $("actionProgress");
  if (!overlay) return;
  overlay.hidden = false;
  overlay.classList.remove("is-done");
  if ($("actionProgressDone")) $("actionProgressDone").hidden = true;
  if ($("actionProgressCancel")) $("actionProgressCancel").hidden = false;
  if ($("actionProgressLabel")) $("actionProgressLabel").textContent = label || "Working…";
  setActionProgress(6, label);
  document.body.style.overflow = "hidden";
}

function closeActionProgress() {
  const overlay = $("actionProgress");
  if (!overlay) return;
  overlay.hidden = true;
  overlay.classList.remove("is-done");
  if ($("actionProgressBar")) $("actionProgressBar").style.width = "0%";
  if ($("actionProgressPct")) $("actionProgressPct").textContent = "0%";
  if ($("actionProgressDone")) $("actionProgressDone").hidden = true;
  if ($("actionProgressCancel")) $("actionProgressCancel").hidden = true;
  document.body.style.overflow = "";
}

function cancelActionProgress() {
  actionCancelledByUser = true;
  if (activeAiAbort) {
    try {
      activeAiAbort.abort();
    } catch (_) {}
  }
  clearTimeout(actionShowTimer);
  actionDepth = 0;
  closeActionProgress();
}

/**
 * Show progress overlay while an async action runs.
 * task may be async (report) => {} where report(pct, label?) updates the bar.
 */
async function withActionProgress(label, task, { doneMessage, minVisibleMs = 320, quiet = false } = {}) {
  if (quiet) {
    const result = await task(() => {});
    if (doneMessage !== false) showToast(doneMessage || label || "Done");
    return result;
  }
  actionDepth += 1;
  const isRoot = actionDepth === 1;
  let shown = false;
  let tick = null;
  const finishOverlay = async (ok, message) => {
    if (tick) {
      clearInterval(tick);
      tick = null;
    }
    clearTimeout(actionShowTimer);
    if (!isRoot) return;
    if (!shown && ok && Date.now() - started < 90) {
      if (doneMessage !== false) showToast(message || doneMessage || label || "Done");
      return;
    }
    if (!shown && !ok) {
      closeActionProgress();
      showToast(message || "Failed");
      return;
    }
    if (!shown) openActionProgress(label);
    if (ok) {
      setActionProgress(100, label);
      const overlay = $("actionProgress");
      if (overlay) overlay.classList.add("is-done");
      if ($("actionProgressDone")) {
        $("actionProgressDone").hidden = false;
        $("actionProgressDone").textContent =
          doneMessage === false ? "Done" : doneMessage || message || "Done";
      }
      if ($("actionProgressCancel")) $("actionProgressCancel").hidden = true;
      const wait = Math.max(0, minVisibleMs - (Date.now() - started));
      await sleep(Math.max(280, wait));
      closeActionProgress();
      if (doneMessage !== false) showToast(doneMessage || message || "Done");
    } else {
      closeActionProgress();
      showToast(message || "Failed");
    }
  };

  const started = Date.now();
  try {
    if (isRoot) {
      actionShowTimer = setTimeout(() => {
        shown = true;
        openActionProgress(label);
      }, 90);
      let auto = 10;
      tick = setInterval(() => {
        if (!shown) return;
        auto = Math.min(92, auto + 2 + Math.random() * 3);
        if (actionPct < auto) setActionProgress(auto, label);
      }, 400);
    } else {
      setActionProgress(Math.max(actionPct, 20), label);
    }

    const report = (pct, msg) => {
      if (isRoot && !shown) {
        clearTimeout(actionShowTimer);
        shown = true;
        openActionProgress(msg || label);
      }
      setActionProgress(pct, msg || label);
    };

    const result = await task(report);
    if (isRoot) await finishOverlay(true);
    else setActionProgress(Math.min(95, Math.max(actionPct, 70)), label);
    return result;
  } catch (err) {
    if (isRoot) {
      await finishOverlay(false, err?.message || String(err) || "Failed");
      if (err && typeof err === "object") err.actionProgressHandled = true;
    }
    throw err;
  } finally {
    if (tick) clearInterval(tick);
    clearTimeout(actionShowTimer);
    actionDepth = Math.max(0, actionDepth - 1);
    // Safety: if this was root and overlay somehow still up, force-close
    if (isRoot && $("actionProgress") && !$("actionProgress").hidden) {
      // only if we crashed before finishOverlay — finishOverlay already closes on success/fail
    }
  }
}

function measureFieldHtml(m) {
  const unit = m.unit ? ` ${m.unit}` : "";
  const step = m.step || "0.1";
  return `<label class="field"><span>${m.label}${unit ? `<em>${unit}</em>` : ""}</span><input type="number" id="measure_${m.key}" step="${step}" inputmode="decimal" placeholder="${m.unit || "—"}" /></label>`;
}

function buildMeasureFields() {
  const fields = CutDBHelpers.MEASURE_FIELDS;
  const comp = fields.filter((m) => m.group === "comp");
  const tape = fields.filter((m) => m.group !== "comp");
  $("measureFields").innerHTML = `
    <p class="measure-group-label">Composition</p>
    <div class="grid-2">${comp.map(measureFieldHtml).join("")}</div>
    <p class="measure-group-label">Tape</p>
    <div class="grid-2">${tape.map(measureFieldHtml).join("")}</div>
  `;
}

function readMeasurements() {
  const out = {};
  for (const m of CutDBHelpers.MEASURE_FIELDS) {
    const v = parseNum($(`measure_${m.key}`)?.value);
    if (v != null) out[m.key] = v;
  }
  return out;
}

function fillMeasurements(entry) {
  const src = { ...(entry?.measurements || {}) };
  if (entry?.waist != null && src.waist == null) src.waist = entry.waist;
  for (const m of CutDBHelpers.MEASURE_FIELDS) {
    const el = $(`measure_${m.key}`);
    if (el) el.value = src[m.key] ?? "";
  }
}

function readMealChecks() {
  const checks = {};
  document.querySelectorAll("#mealCards [data-meal-id]").forEach((el) => {
    checks[el.dataset.mealId] = el.checked;
  });
  return checks;
}

function readWorkoutLog() {
  if (!$("trained").checked) return null;
  const sessionId = $("sessionSelect").value;
  const session = cachedTrain?.sessions?.find((s) => s.id === sessionId);
  const defaultSetRest = parseNum(cachedTrain?.restBetweenSetsSec) ?? 90;
  const defaultExRest = parseNum(cachedTrain?.restBetweenExercisesSec) ?? 120;
  const exercises = [];
  document.querySelectorAll("#workoutLog .ex-block").forEach((block) => {
    const exerciseId = block.dataset.exId;
    const name = block.dataset.exName;
    const youtubeUrl = block.dataset.yt || "";
    const restAfterExerciseSec = parseNum(block.dataset.restEx) ?? defaultExRest;
    const setRest = parseNum(block.dataset.restSets) ?? defaultSetRest;
    const sets = [];
    block.querySelectorAll(".set-row").forEach((row) => {
      sets.push({
        weight: parseNum(row.querySelector(".set-w")?.value),
        reps: parseNum(row.querySelector(".set-r")?.value),
        restAfterSec: setRest,
      });
    });
    exercises.push({
      exerciseId,
      name,
      youtubeUrl,
      sets,
      avgRestBetweenSetsSec: setRest,
      restAfterExerciseSec,
    });
  });
  return {
    planId: cachedTrain?.id || null,
    sessionId,
    sessionName: session?.name || "",
    exercises,
  };
}

function readForm() {
  const measurements = readMeasurements();
  syncTrainedUI();
  return {
    date: $("logDate").value,
    weight: parseNum($("weight").value),
    waist: measurements.waist ?? null,
    measurements,
    coffees: parseNum($("coffees").value),
    steps: parseNum($("steps").value),
    sleep: parseNum($("sleep").value),
    hunger: parseNum($("hunger").value),
    energy: parseNum($("energy").value),
    trained: $("trainedSelect")?.value === "train" || !!$("trained")?.checked,
    mealChecks: readMealChecks(),
    workout: ($("trainedSelect")?.value === "train" || $("trained")?.checked) ? readWorkoutLog() : null,
    phaseId: cachedPhase?.id || null,
    notes: $("notes").value.trim(),
    swapPicks: readSwapPicks(),
    updatedAt: new Date().toISOString(),
  };
}

function readSwapPicks() {
  const out = {};
  document.querySelectorAll("[data-swap-pick]").forEach((el) => {
    const id = el.dataset.swapPick;
    const v = (el.value || "").trim();
    if (id && v) out[id] = v;
  });
  return out;
}

function fillForm(entry, date) {
  $("logDate").value = date;
  $("weight").value = entry?.weight ?? "";
  setCoffeeDisplay(entry?.coffees ?? 0);
  fillMeasurements(entry);
  $("steps").value = entry?.steps ?? "";
  $("sleep").value = entry?.sleep ?? "";
  $("hunger").value = entry?.hunger ?? "";
  $("energy").value = entry?.energy ?? "";
  const trained = trainedForDate(entry, date);
  if ($("trainedSelect")) $("trainedSelect").value = trained ? "train" : "rest";
  if ($("trained")) $("trained").checked = trained;
  syncTrainedUI();
  $("notes").value = entry?.notes || "";
  const view = viewEntry(entry, date);
  renderMealCards(entry?.mealChecks || {}, entry?.swapPicks || {});
  void renderWorkoutUI(entry?.workout || null);
  updateJourneyStatus(view);
  renderHabitNudges(view);
}

function formatPrepMinutes(mins) {
  if (mins == null) return "";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function recipeCardsHtml(recipes) {
  const cards = (recipes || [])
    .map((r) => {
      const time = formatPrepMinutes(r.prepMinutes);
      const video = r.video
        ? `<a class="btn tiny recipe-watch" href="${escapeHtml(r.video)}" target="_blank" rel="noopener noreferrer">Watch video</a>`
        : "";
      const steps = (r.steps || []).length
        ? `<ol>${r.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ol>`
        : "";
      const makes = r.makes ? `<p class="recipe-makes">${escapeHtml(r.makes)}</p>` : "";
      return `<article class="recipe-card">
        <div class="recipe-top">
          <strong>${escapeHtml(r.name)}</strong>
          ${time ? `<span class="recipe-time">${escapeHtml(time)}</span>` : ""}
        </div>
        ${makes}${steps}${video}
      </article>`;
    })
    .join("");
  return cards ? `<div class="recipe-list">${cards}</div>` : "";
}

function recipeFoldHtml(recipes) {
  const list = recipes || [];
  if (!list.length) return "";
  const times = list.map((r) => r.prepMinutes).filter((n) => n != null);
  const fastest = times.length ? Math.min(...times) : null;
  const label = `${list.length} recipe${list.length === 1 ? "" : "s"}${
    fastest != null ? ` · from ${formatPrepMinutes(fastest)}` : ""
  }`;
  return `<details class="meal-recipes"><summary>${escapeHtml(label)}</summary>${recipeCardsHtml(list)}</details>`;
}

function renderMealCards(saved = {}, swapPicks = {}) {
  const root = $("mealCards");
  if (!cachedDiet) {
    root.innerHTML = `<p class="hint">No diet on this phase. Upload a pack JSON from your templates folder.</p>`;
    $("mealTargets").textContent = "";
    $("mealCheckCount").textContent = "0/0";
    if ($("mealPackNotes")) $("mealPackNotes").textContent = "";
    if ($("kcalLeftToday")) {
      $("kcalLeftToday").hidden = true;
      $("kcalLeftToday").innerHTML = "";
    }
    return;
  }
  const trained = $("trainedSelect")?.value === "train" || !!$("trained")?.checked;
  const block = trained ? cachedDiet.training : cachedDiet.rest;
  const t = block?.targets || {};
  if ($("mealPlanTitle")) $("mealPlanTitle").textContent = trained ? "Training day meals" : "Rest day meals";
  $("mealTargets").textContent = `${cachedDiet.name || "Diet"} · ${trained ? "training" : "rest"} day`;
  if ($("mealPackNotes")) $("mealPackNotes").textContent = cachedDiet.notes || "";
  const meals = (block?.meals || []).filter(isPlateMeal);
  const allSwaps = (cachedDiet.foodSwaps || []).filter((s) => (s.options || []).length >= 2);
  const paintKcalLeft = (checks) => {
    const el = $("kcalLeftToday");
    if (!el) return;
    const target = Number(t.kcal);
    if (!Number.isFinite(target) || target <= 0) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    const eatenSet = meals.reduce(
      (acc, m) => {
        if (!checks[m.id]) return acc;
        const x = mealMacroSet(m);
        acc.kcal += x.kcal;
        acc.protein += x.protein;
        acc.carbs += x.carbs;
        acc.fat += x.fat;
        return acc;
      },
      { kcal: 0, protein: 0, carbs: 0, fat: 0 }
    );
    const left = Math.max(0, Math.round(target - eatenSet.kcal));
    const leftMacro = (key) => {
      const goal = Number(t[key]);
      if (!Number.isFinite(goal) || goal <= 0) return null;
      return Math.max(0, Math.round(goal - eatenSet[key]));
    };
    const pLeft = leftMacro("protein");
    const cLeft = leftMacro("carbs");
    const fLeft = leftMacro("fat");
    const macrosHtml =
      pLeft != null || cLeft != null || fLeft != null
        ? `<div class="kcal-left-macros">
            ${pLeft != null ? `<span class="macro-chip p"><b>${pLeft}</b> P</span>` : ""}
            ${cLeft != null ? `<span class="macro-chip c"><b>${cLeft}</b> C</span>` : ""}
            ${fLeft != null ? `<span class="macro-chip f"><b>${fLeft}</b> F</span>` : ""}
          </div>`
        : "";
    el.hidden = false;
    el.innerHTML = `<div class="kcal-left-row">
        <div class="kcal-left-main"><strong>${left}</strong><span>kcal left</span></div>
        ${macrosHtml}
      </div>
      <p class="kcal-left-sub">${eatenSet.kcal} eaten · ${Math.round(target)} target</p>`;
  };
  const mealHtml = meals
    .map((m) => {
      const checked = !!saved[m.id];
      const macros = mealMacroSet(m);
      const kcalBadge = macros.kcal
        ? `<div class="meal-kcal-badge" aria-label="${macros.kcal} calories"><strong>${macros.kcal}</strong><span>kcal</span></div>`
        : "";
      const chips = [macros.protein, macros.carbs, macros.fat].some((n) => n > 0)
        ? `<div class="meal-macros" aria-label="Macros">
            ${macros.protein ? `<span class="macro-chip p"><b>${macros.protein}</b> P</span>` : `<span class="macro-chip muted">— P</span>`}
            ${macros.carbs ? `<span class="macro-chip c"><b>${macros.carbs}</b> C</span>` : `<span class="macro-chip muted">— C</span>`}
            ${macros.fat ? `<span class="macro-chip f"><b>${macros.fat}</b> F</span>` : `<span class="macro-chip muted">— F</span>`}
          </div>`
        : "";
      const mealSwaps = swapsForMeal(m, allSwaps);
      const rescueBtn = `<button type="button" class="meal-rescue-btn" data-meal-rescue="${escapeHtml(m.id)}" aria-label="Rescue ${escapeHtml(m.name)}">
            <span class="meal-rescue-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M7 7h7a5 5 0 1 1 0 10H8" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><path d="M10 4 7 7l3 3" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
            <span>Rescue</span>
          </button>`;
      const toolsHtml = mealSwaps.length
        ? `<div class="meal-tools">
            <div class="meal-tools-head">
              <div class="meal-tools-title">
                <span class="meal-tools-kicker">Swaps</span>
                <em>${mealSwaps.length} option${mealSwaps.length === 1 ? "" : "s"}</em>
              </div>
              ${rescueBtn}
            </div>
            <div class="meal-swap-list">${mealSwaps.map((s) => mealSwapSelectHtml(m, s, swapPicks)).join("")}</div>
          </div>`
        : `<div class="meal-tools meal-tools-solo">${rescueBtn}</div>`;
      return `<article class="meal-card ${checked ? "done" : ""}" data-meal-name="${escapeHtml(m.name)}">
        <div class="meal-card-head">
          <label class="meal-check">
            <input type="checkbox" data-meal-id="${escapeHtml(m.id)}" ${checked ? "checked" : ""} />
            <span class="meal-card-titles">
              <strong>${escapeHtml(m.name)}</strong>
              <em>${escapeHtml(m.when || "")}</em>
            </span>
          </label>
          ${kcalBadge}
        </div>
        ${chips}
        <ul class="meal-foods">${(m.items || []).map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>
        ${toolsHtml}
        ${recipeFoldHtml(m.recipes)}
      </article>`;
    })
    .join("");
  root.innerHTML = mealHtml;
  const done = meals.filter((m) => saved[m.id]).length;
  $("mealCheckCount").textContent = `${done}/${meals.length}`;
  paintKcalLeft(saved);
  root.querySelectorAll("input[data-meal-id]").forEach((el) =>
    el.addEventListener("change", async () => {
      el.closest(".meal-card").classList.toggle("done", el.checked);
      const checks = readMealChecks();
      $("mealCheckCount").textContent = `${meals.filter((m) => checks[m.id]).length}/${meals.length}`;
      paintKcalLeft(checks);
      const mealName = el.closest(".meal-card")?.dataset.mealName || "Meal";
      await savePartial(
        {
          mealChecks: { [el.dataset.mealId]: el.checked },
          trained: $("trainedSelect")?.value === "train",
        },
        el.checked ? `${mealName} ✓` : "Meal unchecked",
        { quiet: true }
      );
    })
  );
  root.querySelectorAll("[data-swap-pick]").forEach((el) =>
    el.addEventListener("change", async () => {
      await savePartial(
        { swapPicks: { [el.dataset.swapPick]: el.value } },
        el.value ? `Swap: ${el.value}` : "Swap cleared",
        { quiet: true }
      );
    })
  );
  root.querySelectorAll("[data-meal-rescue]").forEach((el) =>
    el.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openMealRescue(el.dataset.mealRescue);
    })
  );
}

function exerciseHasLoggedSets(ex) {
  return (ex?.sets || []).some((s) => s.weight != null || s.reps != null);
}

function markExerciseBlockDone(block, done) {
  if (!block) return;
  block.classList.toggle("done", !!done);
}

function formatSetsSummary(sets) {
  return (sets || [])
    .filter((s) => s.weight != null || s.reps != null)
    .map((s) => {
      const w = s.weight != null ? String(s.weight) : "—";
      const r = s.reps != null ? String(s.reps) : "—";
      return `${w}×${r}`;
    })
    .join(" · ");
}

function formatShortLogDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso + "T12:00:00");
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  } catch (_) {
    return iso;
  }
}

function findPreviousExerciseLog(data, { exerciseId, name, beforeDate }) {
  const nameKey = String(name || "")
    .trim()
    .toLowerCase();
  const dates = sortedDates(data).slice().reverse();
  for (const d of dates) {
    if (beforeDate && d >= beforeDate) continue;
    const exercises = data[d]?.workout?.exercises || [];
    const match = exercises.find((ex) => {
      if (!exerciseHasLoggedSets(ex)) return false;
      if (exerciseId && ex.exerciseId === exerciseId) return true;
      if (nameKey && String(ex.name || "").trim().toLowerCase() === nameKey) return true;
      return false;
    });
    if (match) return { date: d, exercise: match };
  }
  return null;
}

let workoutFocusIndex = 0;
let restTimerId = null;
let restTimerEndsAt = 0;

function clearWorkoutRestTimer() {
  if (restTimerId) {
    clearInterval(restTimerId);
    restTimerId = null;
  }
  restTimerEndsAt = 0;
  const panel = $("workoutRestTimer");
  if (panel) {
    panel.hidden = true;
    panel.classList.remove("rest-done");
  }
}

function formatRestClock(sec) {
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}:${String(r).padStart(2, "0")}` : `${r}s`;
}

function startWorkoutRestTimer(seconds) {
  const sec = Math.max(15, Number(seconds) || 90);
  clearWorkoutRestTimer();
  const panel = $("workoutRestTimer");
  const label = $("workoutRestSec");
  if (!panel || !label) return;
  panel.hidden = false;
  restTimerEndsAt = Date.now() + sec * 1000;
  const tick = () => {
    const left = (restTimerEndsAt - Date.now()) / 1000;
    label.textContent = formatRestClock(left);
    panel.classList.toggle("rest-done", left <= 0);
    if (left <= 0) {
      clearInterval(restTimerId);
      restTimerId = null;
      label.textContent = "Go";
      try {
        navigator.vibrate?.(120);
      } catch (_) {}
    }
  };
  tick();
  restTimerId = setInterval(tick, 250);
}

function wireWorkoutFocusMode(wrap, exerciseCount) {
  if (!wrap || !exerciseCount) return;
  const blocks = [...wrap.querySelectorAll(".ex-block")];
  if (!blocks.length) return;

  const label = $("workoutFocusLabel");
  const rail = $("workoutLiftRail");
  const applyFocus = (idx) => {
    const i = Math.max(0, Math.min(blocks.length - 1, idx));
    workoutFocusIndex = i;
    blocks.forEach((b, j) => b.classList.toggle("is-focus", j === i));
    const name = blocks[i]?.dataset.exName || `Lift ${i + 1}`;
    if (label) label.textContent = `${i + 1} / ${blocks.length} · ${name}`;
    if (rail) {
      rail.querySelectorAll(".workout-rail-chip").forEach((c, j) => {
        c.classList.toggle("active", j === i);
        c.classList.toggle("done", blocks[j]?.classList.contains("done"));
      });
    }
    blocks[i]?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  const firstOpen = blocks.findIndex((b) => !b.classList.contains("done"));
  applyFocus(firstOpen >= 0 ? firstOpen : 0);

  $("workoutPrevLift")?.addEventListener("click", () => applyFocus(workoutFocusIndex - 1));
  $("workoutNextLift")?.addEventListener("click", () => applyFocus(workoutFocusIndex + 1));
  rail?.querySelectorAll(".workout-rail-chip").forEach((chip) => {
    chip.addEventListener("click", () => applyFocus(Number(chip.dataset.exIndex) || 0));
  });

  $("workoutRestSkip")?.addEventListener("click", () => clearWorkoutRestTimer());
  $("workoutRestAdd")?.addEventListener("click", () => {
    if (!restTimerEndsAt) {
      startWorkoutRestTimer(30);
      return;
    }
    restTimerEndsAt += 15000;
  });

  const maybeStartRest = (row, block) => {
    const w = String(row.querySelector(".set-w")?.value || "").trim();
    const r = String(row.querySelector(".set-r")?.value || "").trim();
    if (!w && !r) return;
    const sec = parseNum(block?.dataset.restSets) ?? 90;
    startWorkoutRestTimer(sec);
  };

  blocks.forEach((block) => {
    block.querySelectorAll(".set-r").forEach((input) => {
      input.addEventListener("change", () => maybeStartRest(input.closest(".set-row"), block));
    });
    block.querySelectorAll(".set-w").forEach((input) => {
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          input.closest(".set-row")?.querySelector(".set-r")?.focus();
        }
      });
    });
    block.querySelectorAll(".set-r").forEach((input) => {
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          maybeStartRest(input.closest(".set-row"), block);
          input.blur();
        }
      });
    });
  });

  wrap._workoutApplyFocus = applyFocus;
  wrap._workoutBlocks = blocks;
}

async function renderWorkoutUI(savedWorkout) {
  const wrap = $("workoutLog");
  const hint = $("workoutHint");
  const select = $("sessionSelect");
  clearWorkoutRestTimer();
  syncTrainedUI();
  if ($("trainedSelect")?.value !== "train" && !$("trained")?.checked) {
    if (hint) hint.textContent = "Set day type to Training in Morning check-in.";
    if (select) select.innerHTML = "";
    if (wrap) wrap.innerHTML = "";
    return;
  }
  if (!cachedTrain?.sessions?.length) {
    if (hint) hint.textContent = "No training plan on this phase. Upload a pack JSON from templates/.";
    if (select) select.innerHTML = "";
    if (wrap) wrap.innerHTML = "";
    return;
  }
  const sessions = cachedTrain.sessions;
  const date = $("logDate")?.value || CutDBHelpers.todayISO();
  const plannedId = plannedSessionId(date);
  const current = String(select?.value || "").trim();
  const preferred =
    (savedWorkout?.sessionId && sessions.some((s) => s.id === savedWorkout.sessionId) && savedWorkout.sessionId) ||
    (current && sessions.some((s) => s.id === current) && current) ||
    (plannedId && sessions.some((s) => s.id === plannedId) && plannedId) ||
    sessions[0].id;
  select.innerHTML = sessions
    .map((s) => {
      const label = (s.name || "").trim() || "Session";
      const plannedMark = s.id === plannedId ? " · plan" : "";
      return `<option value="${escapeHtml(s.id)}" ${s.id === preferred ? "selected" : ""}>${escapeHtml(label)}${plannedMark}</option>`;
    })
    .join("");
  const session = sessions.find((s) => s.id === select.value) || sessions[0];
  if (hint) {
    const planned = sessionById(plannedId);
    if (planned && session && planned.id !== session.id) {
      hint.textContent = `Logging ${session.name} · plan for today was ${planned.name}${
        planned.proposedTime ? ` · ${planned.proposedTime}` : ""
      }`;
    } else if (planned) {
      hint.textContent = `Today’s plan: ${planned.name}${planned.proposedTime ? ` · ${planned.proposedTime}` : ""} · pick any session`;
    } else {
      hint.textContent = "No session planned today — pick any workout below.";
    }
  }
  const savedMap = {};
  (savedWorkout?.exercises || []).forEach((e) => {
    savedMap[e.exerciseId] = e;
  });
  const defSets = Number(cachedTrain.restBetweenSetsSec);
  const defEx = Number(cachedTrain.restBetweenExercisesSec);
  const defSetsN = Number.isFinite(defSets) ? defSets : 90;
  const defExN = Number.isFinite(defEx) ? defEx : 120;

  let allDays = {};
  try {
    allDays = await CutDB.allDays();
  } catch (_) {
    allDays = {};
  }

  const exercises = session.exercises || [];
  const railHtml = exercises
    .map((ex, ei) => {
      const saved = savedMap[ex.id];
      const done = exerciseHasLoggedSets(saved);
      return `<button type="button" class="workout-rail-chip${done ? " done" : ""}" data-ex-index="${ei}">${ei + 1}</button>`;
    })
    .join("");

  wrap.innerHTML =
    `<div class="workout-focus-chrome">
      <div class="workout-focus-bar">
        <button type="button" class="btn tiny ghost" id="workoutPrevLift">Prev</button>
        <strong id="workoutFocusLabel">Lift</strong>
        <button type="button" class="btn tiny" id="workoutNextLift">Next</button>
      </div>
      <div class="workout-lift-rail" id="workoutLiftRail">${railHtml}</div>
      <div class="workout-rest-timer" id="workoutRestTimer" hidden>
        <div class="workout-rest-main">
          <span class="workout-rest-kicker">Rest</span>
          <strong id="workoutRestSec">0</strong>
        </div>
        <div class="workout-rest-actions">
          <button type="button" class="btn tiny ghost" id="workoutRestAdd">+15s</button>
          <button type="button" class="btn tiny" id="workoutRestSkip">Skip</button>
        </div>
      </div>
    </div>
    <p class="hint quiet workout-rest-hint">Focus one lift · rest starts when you finish a set’s reps · ${defSetsN}s between sets default</p>` +
    exercises
      .map((ex, ei) => {
        const saved = savedMap[ex.id];
        const hasSaved = exerciseHasLoggedSets(saved);
        const prev = findPreviousExerciseLog(allDays, {
          exerciseId: ex.id,
          name: ex.name,
          beforeDate: date,
        });
        let sets;
        if (hasSaved) {
          sets = saved.sets;
        } else if (prev?.exercise?.sets?.length) {
          sets = prev.exercise.sets.map((s) => ({
            weight: s.weight ?? null,
            reps: s.reps ?? null,
            restAfterSec: null,
          }));
        } else {
          sets = Array.from({ length: ex.targetSets || 3 }, () => ({
            weight: null,
            reps: null,
            restAfterSec: null,
          }));
        }
        const ytRaw = CutDBHelpers.normalizeYoutubeUrl?.(ex.youtubeUrl) || ex.youtubeUrl || "";
        const ytId = CutDBHelpers.youtubeVideoId?.(ytRaw) || "";
        const restSets = ex.restBetweenSetsSec != null ? Number(ex.restBetweenSetsSec) : defSetsN;
        const restEx = ex.restAfterExerciseSec != null ? Number(ex.restAfterExerciseSec) : defExN;
        const note = String(ex.notes || "").trim();
        const form = ytRaw
          ? `<a class="ex-form" href="${escapeHtml(ytRaw)}" target="_blank" rel="noopener noreferrer">
              ${
                ytId
                  ? `<img class="ex-form-thumb" src="https://i.ytimg.com/vi/${escapeHtml(ytId)}/mqdefault.jpg" alt="" />`
                  : `<span class="ex-form-thumb ex-form-thumb-empty" aria-hidden="true">▶</span>`
              }
              <span class="ex-form-copy">
                <em>Form guide</em>
                <strong>Watch on YouTube</strong>
              </span>
              <span class="ex-form-go" aria-hidden="true">↗</span>
            </a>`
          : "";
        const tip = note ? `<p class="ex-tip">${escapeHtml(note)}</p>` : "";
        const prevSummary = prev ? formatSetsSummary(prev.exercise.sets) : "";
        const lastHtml = prev
          ? `<p class="ex-last"><strong>Last · ${escapeHtml(formatShortLogDate(prev.date))}</strong>${escapeHtml(
              prevSummary || "logged"
            )}${hasSaved ? "" : "<span> · copied below — edit as you go</span>"}</p>`
          : `<p class="ex-last"><strong>Last</strong><span>No previous log for this lift yet</span></p>`;
        const isDone = hasSaved;
        const nextLabel = ei < exercises.length - 1 ? "Save & next lift" : "Save lift";
        return `<div class="ex-block${isDone ? " done" : ""}" data-ex-id="${escapeHtml(ex.id)}" data-ex-name="${escapeHtml(ex.name)}" data-yt="${escapeHtml(ytRaw)}" data-rest-sets="${restSets}" data-rest-ex="${restEx}" data-ex-index="${ei}">
        <div class="ex-head">
          <span class="ex-num">${ei + 1}</span>
          <div>
            <strong>${escapeHtml(ex.name)}</strong>
            <p class="hint">${ex.targetSets || "?"} × ${escapeHtml(ex.targetReps || "")} · ${restSets}s between sets</p>
          </div>
          <span class="ex-saved-tag">Saved</span>
        </div>
        ${lastHtml}
        ${form}
        ${tip}
        <p class="hint quiet ex-rest-line">${restEx}s rest before the next lift</p>
        <div class="set-table">
          <div class="set-head"><span>Set</span><span>Weight</span><span>Reps</span></div>
          ${sets
            .map(
              (s, i) => `<div class="set-row">
              <span>${i + 1}</span>
              <input class="set-w" type="number" step="0.5" inputmode="decimal" value="${s.weight ?? ""}" placeholder="kg" />
              <input class="set-r" type="number" step="1" inputmode="numeric" value="${s.reps ?? ""}" placeholder="reps" />
            </div>`
            )
            .join("")}
        </div>
        <div class="ex-actions">
          <button type="button" class="btn tiny add-set">+ Set</button>
          <button type="button" class="btn tiny ghost rest-now">Start rest</button>
          <button type="button" class="btn primary save-ex">${nextLabel}</button>
        </div>
      </div>`;
      })
      .join("");

  wrap.classList.add("workout-focus-mode");
  wireWorkoutFocusMode(wrap, exercises.length);

  wrap.querySelectorAll(".add-set").forEach((btn) => {
    btn.addEventListener("click", () => {
      const block = btn.closest(".ex-block");
      const n = block.querySelectorAll(".set-row").length + 1;
      const row = document.createElement("div");
      row.className = "set-row";
      row.innerHTML = `<span>${n}</span><input class="set-w" type="number" step="0.5" inputmode="decimal" placeholder="kg" /><input class="set-r" type="number" step="1" inputmode="numeric" placeholder="reps" />`;
      block.querySelector(".set-table").appendChild(row);
      const wInput = row.querySelector(".set-w");
      const rInput = row.querySelector(".set-r");
      const startRest = () => {
        const w = String(wInput?.value || "").trim();
        const r = String(rInput?.value || "").trim();
        if (!w && !r) return;
        startWorkoutRestTimer(parseNum(block.dataset.restSets) ?? 90);
      };
      rInput?.addEventListener("change", startRest);
      rInput?.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          startRest();
          rInput.blur();
        }
      });
      wInput?.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          rInput?.focus();
        }
      });
    });
  });

  wrap.querySelectorAll(".rest-now").forEach((btn) => {
    btn.addEventListener("click", () => {
      const block = btn.closest(".ex-block");
      startWorkoutRestTimer(parseNum(block?.dataset.restSets) ?? 90);
    });
  });

  wrap.querySelectorAll(".save-ex").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const block = btn.closest(".ex-block");
      await savePartial({ trained: true, workout: readWorkoutLog() }, "Exercise saved");
      if (block) {
        const filled = [...block.querySelectorAll(".set-w, .set-r")].some((el) => String(el.value || "").trim());
        markExerciseBlockDone(block, filled);
      }
      clearWorkoutRestTimer();
      const blocks = wrap._workoutBlocks || [...wrap.querySelectorAll(".ex-block")];
      const idx = Number(block?.dataset.exIndex);
      const nextOpen = blocks.findIndex((b, j) => j > idx && !b.classList.contains("done"));
      const fallback = idx + 1 < blocks.length ? idx + 1 : idx;
      wrap._workoutApplyFocus?.(nextOpen >= 0 ? nextOpen : fallback);
      const between = parseNum(block?.dataset.restEx);
      if (nextOpen >= 0 && between) startWorkoutRestTimer(between);
    });
  });
}

async function loadContextForDate(date) {
  cachedPhase = await CutDB.getPhaseForDate(date);
  selectedPhaseId = cachedPhase?.id || selectedPhaseId;
  cachedDiet = cachedPhase ? await CutDB.getDietForPhase(cachedPhase.id) : null;
  cachedTrain = cachedPhase ? await CutDB.getTrainingForPhase(cachedPhase.id) : null;
  if (cachedTrain) {
    const missingDays = (cachedTrain.sessions || []).some((s) => s.recommendedWeekday == null);
    ensureRecommendedDays(cachedTrain);
    const beforeSeed = cachedTrain.weekPlanSeed;
    cachedTrain = await seedCatchupWeekIfNeeded(cachedTrain);
    if (missingDays && cachedTrain.weekPlanSeed === beforeSeed) {
      await CutDB.saveTrainingPlan(cachedTrain);
    }
  }
  $("activePhaseLabel").textContent = cachedPhase
    ? `${cachedPhase.name} · ${formatRange(cachedPhase)}`
    : "No phase";
}

async function openPhasesToCreate() {
  await enterCreatePhaseMode();
  await goToTab("phases");
  $("phasePackBlock")?.scrollIntoView({ behavior: "smooth", block: "start" });
  pulseEl($("phasePackBlock"));
}

async function renderTodaySetup(date) {
  const phases = await CutDB.allPhases();
  const covering = phases.find((p) => CutDBHelpers.phaseCoversDate(p, date)) || null;
  const latest = phases
    .slice()
    .sort((a, b) => (b.endDate || "").localeCompare(a.endDate || ""))[0];
  const hasPhase = !!covering;
  document.querySelectorAll(".journey-step").forEach((el) => {
    el.hidden = !hasPhase;
  });
  const top = document.querySelector(".today-top");
  if (top) top.hidden = !hasPhase;
  if ($("journeySticky")) $("journeySticky").hidden = !hasPhase;
  if ($("insightCard")) $("insightCard").hidden = !hasPhase;
  if ($("phaseRunCard")) $("phaseRunCard").hidden = !hasPhase;
  if (!hasPhase) {
    const ended = latest && latest.endDate && latest.endDate < date;
    setNextAction(ended ? "Create the next phase" : "Create a phase", "Go", "setup", "Due");
  } else {
    const label = document.querySelector(".next-label");
    if (label) label.textContent = "Up next";
  }
}

function sortedDates(data) {
  return Object.keys(data).sort();
}
function weightsInRange(data, from, to) {
  return sortedDates(data)
    .filter((d) => d >= from && d <= to)
    .map((d) => data[d].weight)
    .filter((w) => typeof w === "number");
}
function phaseWeekAvg(data, a, b) {
  const vals = weightsInRange(data, a, b);
  return { start: a, end: b, avg: mean(vals), count: vals.length };
}
function lastNWeights(data, n, on) {
  return sortedDates(data)
    .filter((d) => d <= on)
    .map((d) => ({ date: d, weight: data[d].weight }))
    .filter((x) => typeof x.weight === "number")
    .slice(-n);
}

async function refreshHeader(data, date) {
  const avg7 = mean(lastNWeights(data, 7, date).map((x) => x.weight));
  const text = avg7 != null ? `7-day avg ${avg7.toFixed(2)} kg` : "";
  if ($("dayAvgHint")) {
    $("dayAvgHint").textContent = text || "Log morning weights to build averages.";
  }
  if ($("nextAvgHint")) $("nextAvgHint").textContent = text;
}

async function renderPhaseList() {
  const phases = await CutDB.allPhases();
  if (!phases.length) {
    $("phaseList").innerHTML = `<li class="empty-hint"><div class="meta">No phases yet — fill in Create a phase below.</div></li>`;
  } else {
    $("phaseList").innerHTML = phases
      .map((p) => {
        const sel = p.id === selectedPhaseId && !phaseCreateMode ? "style='outline:2px solid #0f6b5c'" : "";
        return `<li data-id="${p.id}" ${sel}>
        <div class="top"><span>${escapeHtml(p.name)}</span><span>${p.active ? "ACTIVE" : ""}</span></div>
        <div class="meta">${formatRange(p)}${
          p.goalLossPctPerWeek != null && Number(p.goalLossPctPerWeek) > 0
            ? ` · −${Number(p.goalLossPctPerWeek)}%/wk`
            : ""
        }</div>
        <div class="row-actions"><button type="button" class="btn tiny pick" data-id="${p.id}">Edit</button>
        <button type="button" class="btn tiny make-active" data-id="${p.id}">Make active</button></div>
      </li>`;
      })
      .join("");
  }

  $("phaseList").querySelectorAll(".pick").forEach((btn) =>
    btn.addEventListener("click", async () => {
      selectedPhaseId = btn.dataset.id;
      phaseCreateMode = false;
      await fillPhaseEditor();
      await renderPhaseList();
    })
  );
  $("phaseList").querySelectorAll(".make-active").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const phases = await CutDB.allPhases();
      for (const p of phases) {
        p.active = p.id === btn.dataset.id;
        if (p.active) p.archivedAt = null;
        await CutDB.savePhase(p);
      }
      selectedPhaseId = btn.dataset.id;
      phaseCreateMode = false;
      await refreshAll();
      showToast("Active phase updated");
    })
  );
}

function setPhaseEditorMode(mode) {
  phaseCreateMode = mode === "create";
  const title = $("phaseEditorTitle");
  const hint = $("phaseEditorHint");
  const saveBtn = $("savePhaseBtn");
  const cancelBtn = $("cancelPhaseBtn");
  const deleteBtn = $("deletePhaseBtn");
  const photos = $("phasePhotosBlock");
  const packBlock = $("phasePackBlock");
  if ($("phasePackHint")) {
    $("phasePackHint").textContent = phaseCreateMode
      ? "Pick a pack to fill diet, shopping, and training — or Create empty."
      : "After editing templates JSON on the PC: rebuild packs, redeploy, then Reload shipped pack.";
  }
  const editActions = $("phasePackEditActions");
  const createActions = $("phasePackCreateActions");
  if (editActions) editActions.hidden = phaseCreateMode;
  if (createActions) createActions.hidden = !phaseCreateMode;
  if ($("useReadyPackBtn")) $("useReadyPackBtn").hidden = !phaseCreateMode;
  if (phaseCreateMode) {
    if (title) title.textContent = "Create a phase";
    if (hint) {
      hint.textContent = "Set the start date, then pick a pack (or Create empty). Name is auto (1, 2, 3…).";
    }
    if (saveBtn) saveBtn.textContent = "Create empty phase";
    if (cancelBtn) cancelBtn.hidden = true;
    if (deleteBtn) deleteBtn.hidden = true;
    if (photos) photos.hidden = true;
  } else {
    if (title) title.textContent = "Edit phase";
    if (hint) {
      hint.textContent = "Dates and photos here. Meal plan changes: edit the JSON pack on the PC, redeploy, Reload shipped pack.";
    }
    if (saveBtn) saveBtn.textContent = "Save dates & goal";
    if (cancelBtn) cancelBtn.hidden = true;
    if (deleteBtn) deleteBtn.hidden = false;
    if (photos) photos.hidden = false;
  }
  if (packBlock) packBlock.hidden = false;
}

async function enterCreatePhaseMode() {
  phaseCreateMode = true;
  const phases = await CutDB.allPhases();
  const active = phases.find((p) => p.active);
  const start =
    active?.endDate
      ? CutDBHelpers.addDaysISO(active.endDate, 1)
      : CutDBHelpers.todayISO();
  const r = CutDBHelpers.ensureTwoWeekRange(start);
  const nums = phases
    .map((p) => Number(String(p.name || "").replace(/\D+/g, "") || NaN))
    .filter((n) => Number.isFinite(n) && n > 0);
  const nextNum = nums.length ? Math.max(...nums) + 1 : phases.length + 1;
  $("editPhaseId").value = "";
  $("phaseName").value = String(nextNum);
  if ($("phaseAutoName")) $("phaseAutoName").innerHTML = `Phase <strong>${nextNum}</strong>`;
  $("phaseStart").value = r.startDate;
  $("phaseEnd").value = r.endDate;
  if ($("phaseGoalLossPct")) {
    $("phaseGoalLossPct").value = String(Number(cfg().goalLossPctPerWeek) || 0.75);
  }
  if ($("phaseTrainDays")) $("phaseTrainDays").value = "4";
  $("phaseNotes").value = "";
  if ($("phasePhotoGrid")) $("phasePhotoGrid").innerHTML = "";
  clearPendingPhasePack();
  setPhaseEditorMode("create");
  if ($("cancelPhaseBtn")) $("cancelPhaseBtn").hidden = !phases.length;
  await renderPhaseList();
}

async function fillPhaseEditor() {
  if (phaseCreateMode && !$("editPhaseId").value) {
    setPhaseEditorMode("create");
    return;
  }
  const id = selectedPhaseId || (await CutDB.getPhaseForDate($("logDate").value || CutDBHelpers.todayISO()))?.id;
  const p = id ? await CutDB.getPhase(id) : null;
  if (!p) {
    await enterCreatePhaseMode();
    return;
  }
  phaseCreateMode = false;
  selectedPhaseId = p.id;
  $("editPhaseId").value = p.id;
  $("phaseName").value = p.name || "";
  if ($("phaseAutoName")) $("phaseAutoName").innerHTML = `Phase <strong>${escapeHtml(p.name || "?")}</strong>`;
  $("phaseStart").value = p.startDate || "";
  $("phaseEnd").value = p.endDate || "";
  if ($("phaseGoalLossPct")) {
    const g = Number(p.goalLossPctPerWeek);
    $("phaseGoalLossPct").value =
      Number.isFinite(g) && g > 0 ? String(g) : String(Number(cfg().goalLossPctPerWeek) || 0.75);
  }
  if ($("phaseTrainDays")) {
    const td = Number(p.trainingDaysPerWeek);
    $("phaseTrainDays").value = Number.isFinite(td) ? String(Math.max(0, Math.min(7, td))) : "4";
  }
  $("phaseNotes").value = p.notes || "";
  setPhaseEditorMode("edit");
  await fillTemplateLibrarySelects(p.packFile);
  await renderPhasePhotos();
}

async function fillPhaseSelects(opts = {}) {
  const phases = await CutDB.allPhases();
  const date = $("logDate")?.value || CutDBHelpers.todayISO();
  const todayPhase = (await CutDB.getPhaseForDate(date)) || phases.find((p) => p.active) || phases[0] || null;
  const dietByPhase = {};
  await Promise.all(
    phases.map(async (p) => {
      dietByPhase[p.id] = await CutDB.getDietForPhase(p.id);
    })
  );

  const optionHtml = phases
    .map((p) => {
      const diet = dietByPhase[p.id];
      const dietLabel = diet?.name?.trim() || (diet ? "Untitled diet" : "no diet yet");
      const mark = p.active ? " · active" : "";
      const cover = todayPhase && p.id === todayPhase.id ? " · today" : "";
      return `<option value="${p.id}">${escapeHtml(p.name)}${mark}${cover} · ${escapeHtml(dietLabel)} (${formatRange(p)})</option>`;
    })
    .join("");

  const pickFor = (selectId, currentValue) => {
    if (currentValue && phases.some((p) => p.id === currentValue)) return currentValue;
    if (
      selectId === "rescuePhaseSelect" ||
      selectId === "shopPhaseSelect" ||
      selectId === "swapPhaseSelect" ||
      selectId === "prepPhaseSelect"
    ) {
      return todayPhase?.id || selectedPhaseId || "";
    }
    return selectedPhaseId || todayPhase?.id || "";
  };

  ["dietPhaseSelect", "trainPhaseSelect", "rescuePhaseSelect", "shopPhaseSelect", "swapPhaseSelect", "prepPhaseSelect"].forEach((id) => {
    const el = $(id);
    if (!el) return;
    const prev = el.value;
    el.innerHTML = optionHtml || `<option value="">No phases</option>`;
    const next = opts.force?.[id] || pickFor(id, prev);
    if (next) el.value = next;
  });
}

async function loadDietEditor() {
  const phaseId = $("dietPhaseSelect").value || selectedPhaseId;
  if (!phaseId) return;
  selectedPhaseId = phaseId;
  const phase = await CutDB.getPhase(phaseId);
  let diet = await CutDB.getDietForPhase(phaseId);
  $("dietPhaseMeta").textContent = phase ? `${phase.name} · ${formatRange(phase)} · one diet plan only` : "";
  if (!diet) {
    $("dietEditorWrap").style.opacity = "0.6";
    $("dietName").value = phase?.name || "";
    if ($("dietAutoName")) $("dietAutoName").textContent = `Diet ${phase?.name || "—"} (auto)`;
    $("dietNotes").value = "";
    $("dietTargets").innerHTML = `<p class="hint">No diet plan yet. Create a phase with a Phase pack, or Save an empty shell below.</p>`;
    $("mealEditor").innerHTML = "";
    if ($("foodSwapEditor")) $("foodSwapEditor").innerHTML = "";
    cachedDiet = null;
    return;
  }
  $("dietEditorWrap").style.opacity = "1";
  cachedDiet = diet;
  if (!Array.isArray(cachedDiet.foodSwaps)) cachedDiet.foodSwaps = [];
  if (!Array.isArray(cachedDiet.foodRescueChat)) cachedDiet.foodRescueChat = [];
  // Keep diet name locked to phase number
  $("dietName").value = phase?.name || diet.name || "";
  if ($("dietAutoName")) $("dietAutoName").textContent = `Diet ${phase?.name || diet.name || "—"} (auto)`;
  $("dietNotes").value = diet.notes || "";
  renderDietTargetsAndMeals();
}

function swapListMarkup(swaps) {
  const list = Array.isArray(swaps) ? swaps : [];
  if (!list.length) {
    return `<p class="hint">No swap groups yet — tap + Swap group, or parse / Fill with AI on Diet.</p>`;
  }
  return list
    .map((s, gi) => {
      const opts = Array.isArray(s.options) && s.options.length ? s.options : ["", ""];
      return `<li class="swap-cat" data-swap-gi="${gi}">
        <div class="swap-cat-title-row">
          <input type="text" class="swap-cat-label" data-swap-label="${gi}" value="${escapeHtml(s.label || "Swap")}" aria-label="Swap group label" />
          <button type="button" class="swap-group-del" data-swap-del-group="${gi}" title="Remove group" aria-label="Remove swap group">×</button>
        </div>
        <ul>${opts
          .map(
            (o, oi) => `<li class="swap-item">
              <div class="swap-item-row">
                <input type="text" class="swap-opt-input" data-swap-opt="${gi}:${oi}" value="${escapeHtml(o)}" placeholder="e.g. chicken breast 220 g" aria-label="Swap option" />
                <button type="button" class="swap-opt-del" data-swap-del-opt="${gi}:${oi}" title="Remove" aria-label="Remove option">×</button>
              </div>
            </li>`
          )
          .join("")}</ul>
        <button type="button" class="btn tiny ghost swap-add-opt" data-swap-add-opt="${gi}">+ Option</button>
        <input type="hidden" data-swap-id="${gi}" value="${escapeHtml(s.id || "")}" />
      </li>`;
    })
    .join("");
}

function readSwapsFromRoot(root) {
  if (!root) return [];
  const swaps = [];
  root.querySelectorAll(".swap-cat").forEach((node) => {
    const label = node.querySelector("[data-swap-label]")?.value?.trim() || "Swap";
    const id = node.querySelector("[data-swap-id]")?.value || CutDBHelpers.uid("swap");
    const options = [...node.querySelectorAll(".swap-opt-input")]
      .map((el) => el.value.trim())
      .filter(Boolean);
    swaps.push({ id, label, options });
  });
  return swaps;
}

function bindSwapListRoot(root, { getSwaps, setSwaps, persist, onAfterChange } = {}) {
  if (!root) return;

  const refresh = async (next, { focusLastOpt } = {}) => {
    setSwaps(next);
    root.innerHTML = swapListMarkup(next);
    bindSwapListRoot(root, { getSwaps, setSwaps, persist, onAfterChange });
    if (persist) await persist(next);
    onAfterChange?.(next);
    if (focusLastOpt) {
      const inputs = root.querySelectorAll(".swap-opt-input");
      const last = inputs[inputs.length - 1];
      last?.focus();
      last?.select();
    }
  };

  const snapshot = () => {
    const next = readSwapsFromRoot(root);
    setSwaps(next);
    return next;
  };

  root.querySelectorAll("[data-swap-label]").forEach((el) => {
    el.addEventListener("change", async () => {
      const next = snapshot();
      if (persist) await persist(next);
      onAfterChange?.(next);
    });
  });
  root.querySelectorAll(".swap-opt-input").forEach((el) => {
    el.addEventListener("change", async () => {
      const next = snapshot();
      if (persist) await persist(next);
      onAfterChange?.(next);
    });
  });
  root.querySelectorAll("[data-swap-del-opt]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const [gi, oi] = String(btn.dataset.swapDelOpt).split(":").map(Number);
      const cur = snapshot();
      const next = cur.map((s) => ({ ...s, options: [...(s.options || [])] }));
      if (!next[gi]) return;
      next[gi].options.splice(oi, 1);
      if (next[gi].options.length < 1) next[gi].options = [""];
      await refresh(next);
    });
  });
  root.querySelectorAll("[data-swap-del-group]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const gi = Number(btn.dataset.swapDelGroup);
      const cur = snapshot();
      await refresh(cur.filter((_, i) => i !== gi));
    });
  });
  root.querySelectorAll("[data-swap-add-opt]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const gi = Number(btn.dataset.swapAddOpt);
      const cur = snapshot();
      const next = cur.map((s) => ({ ...s, options: [...(s.options || [])] }));
      if (!next[gi]) return;
      next[gi].options.push("");
      await refresh(next, { focusLastOpt: true });
    });
  });
}

async function persistDietFoodSwaps(phaseId, swaps) {
  if (!phaseId) return;
  const diet = await CutDB.getDietForPhase(phaseId);
  if (!diet) return;
  // Keep incomplete groups while editing (panel), but store cleaned options
  diet.foodSwaps = (swaps || []).map((s, i) => ({
    id: s.id || CutDBHelpers.uid("swap"),
    label: (s.label || `Swap ${i + 1}`).toString().trim() || `Swap ${i + 1}`,
    options: (s.options || []).map((o) => String(o).trim()).filter(Boolean),
  }));
  await CutDB.saveDietPlan(diet);
  if (cachedDiet?.id === diet.id) cachedDiet.foodSwaps = diet.foodSwaps.map((s) => ({ ...s, options: [...s.options] }));
  return diet;
}

async function loadSwapsPanel() {
  const meta = $("swapPhaseMeta");
  const status = $("swapStatus");
  const root = $("swapList");
  const phaseId = $("swapPhaseSelect")?.value || selectedPhaseId;
  if (!phaseId) {
    if (meta) meta.textContent = "Create a phase and diet first.";
    if (status) status.textContent = "";
    if (root) root.innerHTML = "";
    return;
  }
  selectedPhaseId = phaseId;
  const phase = await CutDB.getPhase(phaseId);
  const diet = await CutDB.getDietForPhase(phaseId);
  if (!diet) {
    if (meta) meta.textContent = `${phase?.name || "Phase"} — no diet plan yet.`;
    if (status) status.textContent = "";
    if (root) {
      root.innerHTML = `<p class="hint">Create a diet plan (More → Diet plan). Then add swap groups here.</p>`;
    }
    return;
  }
  let swaps = Array.isArray(diet.foodSwaps)
    ? diet.foodSwaps.map((s) => ({
        id: s.id,
        label: s.label || "Swap",
        options: [...(s.options || [])],
      }))
    : [];
  if (meta) {
    meta.textContent = `${phase?.name || "Phase"} · ${diet.name || "Diet"} · ${swaps.length} swap group${swaps.length === 1 ? "" : "s"}`;
  }
  if (status) {
    status.textContent = swaps.length
      ? `${swaps.reduce((n, s) => n + (s.options?.length || 0), 0)} options · edits save automatically`
      : "Tap + Swap group to start.";
  }
  if (!root) return;
  root.innerHTML = swapListMarkup(swaps);
  bindSwapListRoot(root, {
    getSwaps: () => swaps,
    setSwaps: (next) => {
      swaps = next;
    },
    persist: async (next) => {
      await persistDietFoodSwaps(phaseId, next);
      const cleaned = (await CutDB.getDietForPhase(phaseId))?.foodSwaps || [];
      if (meta) {
        meta.textContent = `${phase?.name || "Phase"} · ${diet.name || "Diet"} · ${cleaned.length} swap group${cleaned.length === 1 ? "" : "s"}`;
      }
      if (status) {
        status.textContent = cleaned.length
          ? `${cleaned.reduce((n, s) => n + (s.options?.length || 0), 0)} options · edits save automatically`
          : "Tap + Swap group to start.";
      }
    },
  });
}

async function loadFoodRescuePanel() {
  const meta = $("rescuePhaseMeta");
  const sel = $("rescuePhaseSelect");
  // Refresh options + labels without clobbering a deliberate selection
  await fillPhaseSelects();
  const phaseId = sel?.value || null;
  if (!phaseId) {
    if (meta) meta.textContent = "Create a phase first (More → Phases), then add a diet plan.";
    renderFoodRescueChat([]);
    return;
  }
  const phase = await CutDB.getPhase(phaseId);
  const diet = await CutDB.getDietForPhase(phaseId);
  if (!diet) {
    if (meta) {
      meta.textContent = phase
        ? `${phase.name} (${formatRange(phase)}) — no diet plan yet. Add one under More → Diet plan.`
        : "Phase not found.";
    }
    renderFoodRescueChat([]);
    return;
  }
  const trainMeals = diet.training?.meals?.length || 0;
  const restMeals = diet.rest?.meals?.length || 0;
  const swaps = Array.isArray(diet.foodSwaps) ? diet.foodSwaps.length : 0;
  fillRescueMealSelect(diet, $("rescueMealSelect")?.value || mealRescueFocusId);
  if (meta) {
    meta.textContent = `${phase?.name || "Phase"} · ${diet.name || "Diet"} · train ${trainMeals} meals · rest ${restMeals} meals · ${swaps} swap group${swaps === 1 ? "" : "s"}`;
  }
  renderFoodRescueChat(Array.isArray(diet.foodRescueChat) ? diet.foodRescueChat : []);
}

async function getRescueDietContext() {
  const phaseId = $("rescuePhaseSelect")?.value || cachedPhase?.id || selectedPhaseId;
  if (!phaseId) return { phaseId: null, phase: null, diet: null };
  const phase = await CutDB.getPhase(phaseId);
  const diet = await CutDB.getDietForPhase(phaseId);
  return { phaseId, phase, diet };
}

function todayMealBlock(diet, trained) {
  if (!diet) return null;
  const isTrain =
    trained != null ? !!trained : $("trainedSelect")?.value === "train" || !!$("trained")?.checked;
  return isTrain ? diet.training : diet.rest;
}

function plateMeals(diet, trained) {
  return (todayMealBlock(diet, trained)?.meals || []).filter(isPlateMeal);
}

function leftoverMacros(meals, checks, targets = {}) {
  const eaten = (meals || []).reduce(
    (acc, m) => {
      if (!checks?.[m.id]) return acc;
      const x = mealMacroSet(m);
      acc.kcal += x.kcal;
      acc.protein += x.protein;
      acc.carbs += x.carbs;
      acc.fat += x.fat;
      return acc;
    },
    { kcal: 0, protein: 0, carbs: 0, fat: 0 }
  );
  const left = (key) => {
    const goal = Number(targets[key]);
    if (!Number.isFinite(goal) || goal <= 0) return null;
    return Math.max(0, Math.round(goal - eaten[key]));
  };
  return {
    eaten,
    leftover: {
      kcal: left("kcal"),
      protein: left("protein"),
      carbs: left("carbs"),
      fat: left("fat"),
    },
  };
}

function slimMealForRescue(meal, checks, swapPicks) {
  if (!meal) return null;
  const macros = mealMacroSet(meal);
  const picks = {};
  Object.entries(swapPicks || {}).forEach(([k, v]) => {
    if (k === meal.id || String(k).startsWith(`${meal.id}::`)) picks[k] = v;
  });
  return {
    id: meal.id,
    name: meal.name,
    when: meal.when || "",
    items: meal.items || [],
    macros,
    swaps: meal.swaps || [],
    eaten: !!checks?.[meal.id],
    swapPicks: picks,
  };
}

function buildRescueContext({ diet, phase, day, mealId, trained }) {
  const isTrain =
    trained != null ? !!trained : !!(day?.trained ?? ($("trainedSelect")?.value === "train"));
  const block = todayMealBlock(diet, isTrain);
  const meals = plateMeals(diet, isTrain);
  const checks = day?.mealChecks || {};
  const swapPicks = day?.swapPicks || {};
  const focus = mealId ? meals.find((m) => m.id === mealId) || null : null;
  const remaining = meals.filter((m) => m.id !== mealId && !checks[m.id]);
  const alreadyEaten = meals.filter((m) => checks[m.id]);
  const macros = leftoverMacros(meals, checks, block?.targets || {});
  return {
    date: day?.date || $("logDate")?.value || CutDBHelpers.todayISO(),
    dayType: isTrain ? "training" : "rest",
    phaseId: phase?.id || null,
    phaseName: phase?.name || "",
    dietId: diet?.id || null,
    dietName: diet?.name || "",
    notes: diet?.notes || "",
    targets: block?.targets || null,
    foodSwaps: diet?.foodSwaps || [],
    focusMeal: slimMealForRescue(focus, checks, swapPicks),
    alreadyEaten: alreadyEaten.map((m) => slimMealForRescue(m, checks, swapPicks)),
    remainingMeals: remaining.map((m) => slimMealForRescue(m, checks, swapPicks)),
    leftover: macros.leftover,
    eatenSoFar: macros.eaten,
    mealChecks: checks,
    alreadyLogged: {
      weight: day?.weight ?? null,
      coffees: day?.coffees ?? null,
    },
  };
}

function fillRescueMealSelect(diet, selectedId) {
  const sel = $("rescueMealSelect");
  if (!sel) return;
  const meals = plateMeals(diet);
  const prev = selectedId || sel.value || "";
  sel.innerHTML = [`<option value="">Whole day / not sure</option>`]
    .concat(
      meals.map(
        (m) =>
          `<option value="${escapeHtml(m.id)}" ${m.id === prev ? "selected" : ""}>${escapeHtml(
            m.name || m.id
          )}${m.when ? ` · ${escapeHtml(m.when)}` : ""}</option>`
      )
    )
    .join("");
}

const MEAL_RESCUE_CHIPS = [
  { id: "skip", tone: "c", label: "Skipped it", prompt: "I skipped this meal. What should I do with the rest of today?" },
  { id: "missing", tone: "p", label: "Missing food", prompt: "I'm missing an ingredient on this meal. Suggest a swap and any rest-of-day change." },
  { id: "out", tone: "f", label: "Ate out", prompt: "I ate out instead of this meal. Help me adjust the rest of today." },
  { id: "extra", tone: "c", label: "Ate extra", prompt: "I ate more than planned on this meal. How should later meals change?" },
  { id: "hungry", tone: "p", label: "Not filling", prompt: "This meal isn't filling enough. What can I add or move from later meals?" },
];

let mealRescueFocusId = "";

function openMealRescue(mealId) {
  const meals = plateMeals(cachedDiet);
  const meal = meals.find((m) => m.id === mealId);
  if (!meal) {
    showToast("Meal not found");
    return;
  }
  mealRescueFocusId = meal.id;
  const macros = mealMacroSet(meal);
  const checks = readMealChecks();
  const leftover = leftoverMacros(meals, checks, todayMealBlock(cachedDiet)?.targets || {});
  const later = meals.filter((m) => m.id !== meal.id && !checks[m.id]).map((m) => m.name);
  if ($("mealRescueTitle")) $("mealRescueTitle").textContent = meal.name || "Meal";
  if ($("mealRescueMeta")) {
    const bits = [meal.when, macros.kcal ? `${macros.kcal} kcal` : "", macros.protein ? `${macros.protein}P` : ""]
      .filter(Boolean)
      .join(" · ");
    $("mealRescueMeta").textContent = bits;
  }
  if ($("mealRescueFoods")) $("mealRescueFoods").textContent = (meal.items || []).join(" · ");
  if ($("mealRescueDay")) {
    const left = leftover.leftover;
    const leftBits = [
      left.kcal != null ? `${left.kcal} kcal left` : "",
      left.protein != null ? `${left.protein} P` : "",
      later.length ? `still open: ${later.join(", ")}` : "no other meals left",
    ].filter(Boolean);
    $("mealRescueDay").textContent = leftBits.join(" · ");
  }
  const chips = $("mealRescueChips");
  if (chips) {
    chips.innerHTML = MEAL_RESCUE_CHIPS.map(
      (c) =>
        `<button type="button" class="chip meal-rescue-chip tone-${c.tone}" data-rescue-chip="${c.id}">${escapeHtml(
          c.label
        )}</button>`
    ).join("");
    chips.querySelectorAll("[data-rescue-chip]").forEach((btn) =>
      btn.addEventListener("click", () => {
        chips.querySelectorAll("[data-rescue-chip]").forEach((b) => b.classList.toggle("active", b === btn));
        const chip = MEAL_RESCUE_CHIPS.find((c) => c.id === btn.dataset.rescueChip);
        if (chip && $("mealRescueInput")) $("mealRescueInput").value = chip.prompt;
        $("mealRescueInput")?.focus();
      })
    );
  }
  if ($("mealRescueInput")) $("mealRescueInput").value = "";
  if ($("mealRescueReply")) {
    $("mealRescueReply").hidden = true;
    $("mealRescueReply").textContent = "";
  }
  if ($("mealRescueStatus")) $("mealRescueStatus").textContent = "";
  if (cachedPhase?.id && $("rescuePhaseSelect")) $("rescuePhaseSelect").value = cachedPhase.id;
  fillRescueMealSelect(cachedDiet, meal.id);
  $("mealRescueDialog")?.showModal();
}

async function openFullRescueFromMeal() {
  const question = ($("mealRescueInput")?.value || "").trim();
  const mealId = mealRescueFocusId;
  $("mealRescueDialog")?.close();
  if (cachedPhase?.id && $("rescuePhaseSelect")) $("rescuePhaseSelect").value = cachedPhase.id;
  await goToTab("rescue");
  fillRescueMealSelect(cachedDiet, mealId);
  if ($("rescueMealSelect") && mealId) $("rescueMealSelect").value = mealId;
  if (question && $("foodRescueInput")) $("foodRescueInput").value = question;
  $("foodRescueInput")?.focus();
}

const SHOPPING_LIST_VERSION = 3;

function normalizeShopFoodKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[()]/g, " ")
    .replace(/\bwhole\s+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function categorizeShopFood(name) {
  const n = normalizeShopFoodKey(name);
  if (!n) return null;
  if (/^(water|still water|sparkling water)$/.test(n)) return null;
  if (/\b(chicken|turkey|beef|lamb|pork|fish|tuna|salmon|cod|shrimp|prawn|mince|steak|ham|bacon)\b/.test(n))
    return "Meat/Fish";
  if (/\beggs?\b/.test(n) || /\begg\s*white/.test(n)) return "Eggs";
  if (/\b(milk|yogurt|yoghurt|cottage|cheese|cream|butter|skyr|quark|whey|casein|protein powder)\b/.test(n))
    return "Dairy & protein";
  if (/\b(rice|oat|oats|pasta|bread|tortilla|potato|potatoes|quinoa|couscous|cereal|flour|bagel|wrap)\b/.test(n))
    return "Carbs & grains";
  if (
    /\b(apple|banana|berry|berries|orange|lemon|lettuce|spinach|broccoli|cucumber|tomato|onion|pepper|carrot|avocado|fruit|veg|vegetable|salad|greens|mushroom|zucchini|courgette)\b/.test(
      n
    )
  )
    return "Produce";
  if (/\b(coffee|tea|coke|soda|juice|drink|beverage)\b/.test(n)) return "Drinks";
  if (/\b(oil|olive|sauce|spice|salt|pepper|vinegar|honey|sugar|nut butter|peanut|almond|seed|nuts)\b/.test(n))
    return "Pantry";
  return "Other";
}

function normalizeShopUnit(u) {
  const s = String(u || "").toLowerCase();
  if (s === "kg") return "kg";
  if (s === "g") return "g";
  if (s === "ml") return "ml";
  if (s === "l" || s === "litre" || s === "liter") return "l";
  if (/^pcs?$|^pieces?$|^x$/.test(s)) return "pcs";
  if (/^scoops?$/.test(s)) return "scoop";
  if (s === "tbsp") return "tbsp";
  if (s === "tsp") return "tsp";
  if (/^cups?$/.test(s)) return "cup";
  return s;
}

/** Parse food line → { name, qty, unit } */
function parseFoodLineForShop(line) {
  let raw = String(line || "").trim();
  if (!raw) return null;
  raw = raw.replace(/×/g, "x").replace(/\s+/g, " ");

  let m = raw.match(
    /^(.*?)[\s,]*([0-9]+(?:[.,][0-9]+)?)\s*(kg|g|ml|l|litre|liter|pcs?|pieces?|x|scoop(?:s)?|tbsp|tsp|cup(?:s)?)\s*$/i
  );
  if (m) {
    return {
      name: m[1].replace(/[-–—:]+$/g, "").trim() || raw,
      qty: parseFloat(m[2].replace(",", ".")),
      unit: normalizeShopUnit(m[3]),
    };
  }
  m = raw.match(
    /^([0-9]+(?:[.,][0-9]+)?)\s*(kg|g|ml|l|litre|liter|pcs?|pieces?|x|scoop(?:s)?|tbsp|tsp|cup(?:s)?)\s+(.+)$/i
  );
  if (m) {
    return {
      name: m[3].trim(),
      qty: parseFloat(m[1].replace(",", ".")),
      unit: normalizeShopUnit(m[2]),
    };
  }
  m = raw.match(/^(.*?)[\s,]+([0-9]+(?:[.,][0-9]+)?)\s*$/);
  if (m && m[1].trim().length > 1) {
    const name = m[1].trim();
    const qty = parseFloat(m[2].replace(",", "."));
    // "eggs 3" → pieces; bare numbers on meat stay ambiguous → pcs if eggs else leave as qty with empty unit
    const unit = /\beggs?\b/i.test(name) ? "pcs" : "pcs";
    return { name, qty, unit };
  }
  return { name: raw, qty: null, unit: "" };
}

/**
 * Convert plan units into supermarket-friendly base units before aggregating.
 * Eggs in grams → whole eggs (≈50 g). Egg whites ≈33 g each.
 */
function toShopBase(parsed) {
  if (!parsed?.name) return null;
  const n = normalizeShopFoodKey(parsed.name);
  let qty = parsed.qty;
  let unit = parsed.unit || "";
  let name = parsed.name;

  if (/\begg\s*whites?\b/.test(n)) {
    if (unit === "g" && qty != null) {
      qty = qty / 33;
      unit = "pcs";
      name = "egg whites";
    } else if (unit === "kg" && qty != null) {
      qty = (qty * 1000) / 33;
      unit = "pcs";
      name = "egg whites";
    }
  } else if (/\beggs?\b/.test(n)) {
    name = "eggs";
    if (unit === "g" && qty != null) {
      qty = qty / 50; // large egg ≈ 50 g
      unit = "pcs";
    } else if (unit === "kg" && qty != null) {
      qty = (qty * 1000) / 50;
      unit = "pcs";
    } else if (!unit && qty != null) {
      unit = "pcs";
    }
  }

  if (unit === "kg" && qty != null) {
    qty = qty * 1000;
    unit = "g";
  }
  if (unit === "l" && qty != null) {
    qty = qty * 1000;
    unit = "ml";
  }

  return { name, qty, unit };
}

/** Format weekly totals as something you'd buy in a store */
function formatBuyAmount(name, qty, unit) {
  if (qty == null || !Number.isFinite(qty)) return { buy: "", hint: "" };
  const n = normalizeShopFoodKey(name);
  let q = qty;
  let u = unit || "";

  // Eggs / egg whites → pieces + dozen
  if (/\beggs?\b/.test(n) || /\begg\s*whites?\b/.test(n)) {
    const pieces = Math.max(1, Math.ceil(q - 1e-9));
    const label = /\bwhite/.test(n) ? "whites" : "eggs";
    if (pieces >= 12) {
      const doz = Math.floor(pieces / 12);
      const rem = pieces % 12;
      const buy = rem ? `${doz} dozen + ${rem}` : `${doz} dozen`;
      return { buy, hint: `${pieces} ${label}` };
    }
    return { buy: `${pieces} ${label}`, hint: "" };
  }

  // Banana / apple etc. counted as pieces
  if ((u === "pcs" || u === "") && /\b(banana|apple|orange|avocado|tortilla|wrap|bagel)\b/.test(n)) {
    const pieces = Math.max(1, Math.ceil(q - 1e-9));
    return { buy: `${pieces}`, hint: "pieces" };
  }

  if (u === "g") {
    if (q >= 1000) {
      const kg = Math.ceil((q / 1000) * 10) / 10; // 100 g steps
      return { buy: `${kg} kg`, hint: `${Math.round(q)} g total` };
    }
    const rounded = Math.ceil(q / 10) * 10; // 10 g steps for small
    return { buy: `${rounded} g`, hint: "" };
  }

  if (u === "ml") {
    if (q >= 1000) {
      const litres = Math.ceil((q / 1000) * 2) / 2; // 0.5 L steps
      return { buy: `${litres} L`, hint: `${Math.round(q)} ml total` };
    }
    const rounded = Math.ceil(q / 50) * 50;
    return { buy: `${rounded} ml`, hint: "" };
  }

  if (u === "scoop" || u === "tbsp" || u === "tsp" || u === "cup") {
    const pieces = Math.max(1, Math.ceil(q - 1e-9));
    return { buy: `${pieces} ${u}${pieces === 1 ? "" : "s"}`, hint: "" };
  }

  if (u === "pcs") {
    const pieces = Math.max(1, Math.ceil(q - 1e-9));
    return { buy: `${pieces}`, hint: "pieces" };
  }

  const rounded = q >= 10 ? Math.round(q) : Math.round(q * 10) / 10;
  return { buy: u ? `${rounded} ${u}` : String(rounded), hint: "" };
}

function addShopAgg(agg, parsed, days) {
  const base = toShopBase(parsed);
  if (!base?.name || days <= 0) return;
  const cat = categorizeShopFood(base.name);
  if (cat == null) return;
  // Merge by food identity, not raw unit (eggs g + eggs pcs → same)
  const key = normalizeShopFoodKey(base.name);
  const cur = agg.get(key) || {
    name: base.name,
    unit: base.unit || "",
    qty: 0,
    hasQty: false,
    dayHits: 0,
    category: cat,
  };
  if (base.qty != null && Number.isFinite(base.qty)) {
    // If units conflict (rare), prefer converting already done in toShopBase
    if (cur.hasQty && cur.unit && base.unit && cur.unit !== base.unit) {
      // keep first unit; skip incompatible — still count dayHits as fallback note
      cur.dayHits += days;
    } else {
      cur.unit = base.unit || cur.unit;
      cur.qty += base.qty * days;
      cur.hasQty = true;
    }
  } else {
    cur.dayHits += days;
  }
  if ((base.name || "").length >= (cur.name || "").length) cur.name = base.name;
  agg.set(key, cur);
}

function extractNoteFoodLines(notes) {
  const text = String(notes || "");
  if (!text.trim()) return [];
  const lines = [];
  for (const part of text.split(/[;\n]+/)) {
    const t = part.trim();
    if (!t) continue;
    if (/coffee|milk|sugar|cream|protein/i.test(t)) {
      lines.push(t.replace(/^coffee\s*[x×]\s*(\d+)/i, "coffee $1 pcs"));
    }
  }
  return lines;
}

function resolveShopWeekDays(diet, train, preferredTrainDays, phase) {
  const hasTrain = (diet?.training?.meals || []).some((m) => (m.items || []).length);
  const hasRest = (diet?.rest?.meals || []).some((m) => (m.items || []).length);
  let trainDays;
  if (preferredTrainDays != null && preferredTrainDays !== "") {
    trainDays = Number(preferredTrainDays);
  } else if (phase?.trainingDaysPerWeek != null && Number.isFinite(Number(phase.trainingDaysPerWeek))) {
    trainDays = Number(phase.trainingDaysPerWeek);
  } else if (train?.sessions?.length != null) {
    trainDays = train.sessions.length;
  } else {
    trainDays = 4;
  }
  if (!Number.isFinite(trainDays)) trainDays = 4;
  trainDays = Math.max(0, Math.min(7, Math.round(trainDays)));

  if (hasTrain && !hasRest) return { trainDays: 7, restDays: 0, mode: "train-only" };
  if (hasRest && !hasTrain) return { trainDays: 0, restDays: 7, mode: "rest-only" };
  return { trainDays, restDays: 7 - trainDays, mode: "split" };
}

/**
 * Weekly shopping list: diet foods × 7-day split, supermarket buy units.
 */
function buildShoppingListFromDiet(diet, trainDays, restDays) {
  const agg = new Map();
  const tDays = Math.max(0, Number(trainDays) || 0);
  const rDays = Math.max(0, Number(restDays) || 0);

  for (const meal of diet?.training?.meals || []) {
    for (const line of meal.items || []) {
      addShopAgg(agg, parseFoodLineForShop(line), tDays);
    }
  }
  for (const meal of diet?.rest?.meals || []) {
    for (const line of meal.items || []) {
      addShopAgg(agg, parseFoodLineForShop(line), rDays);
    }
  }
  const weekDays = tDays + rDays || 7;
  for (const line of extractNoteFoodLines(diet?.notes)) {
    addShopAgg(agg, parseFoodLineForShop(line), weekDays);
  }

  const prevDone = new Map();
  for (const it of diet?.shoppingList?.items || []) {
    prevDone.set(normalizeShopFoodKey(it.name), !!it.done);
  }

  const catOrder = [
    "Produce",
    "Meat/Fish",
    "Eggs",
    "Dairy & protein",
    "Carbs & grains",
    "Pantry",
    "Drinks",
    "Frozen",
    "Other",
  ];
  const built = [...agg.values()]
    .map((row, i) => {
      let buy = "";
      let hint = "";
      if (row.hasQty) {
        const fmt = formatBuyAmount(row.name, row.qty, row.unit);
        buy = fmt.buy;
        hint = fmt.hint;
      } else if (row.dayHits > 0) {
        buy = `${row.dayHits} days`;
        hint = "as written in plan";
      }
      return {
        id: `shop_${i + 1}`,
        name: row.name,
        amount: buy,
        hint,
        category: row.category || "Other",
        done: prevDone.get(normalizeShopFoodKey(row.name)) || false,
      };
    })
    .sort((a, b) => {
      const da = catOrder.indexOf(a.category);
      const db = catOrder.indexOf(b.category);
      if ((da < 0 ? 99 : da) !== (db < 0 ? 99 : db)) return (da < 0 ? 99 : da) - (db < 0 ? 99 : db);
      return a.name.localeCompare(b.name);
    });

  // Keep manually added rows across rebuilds
  const custom = (diet?.shoppingList?.items || []).filter((it) => it.custom && String(it.name || "").trim());
  const builtKeys = new Set(built.map((it) => normalizeShopFoodKey(it.name)));
  let extra = 0;
  for (const it of custom) {
    const key = normalizeShopFoodKey(it.name);
    if (builtKeys.has(key)) continue;
    builtKeys.add(key);
    built.push({
      id: it.id || `shop_custom_${++extra}`,
      name: String(it.name).trim(),
      amount: String(it.amount || "").trim(),
      hint: it.hint || "custom",
      category: it.category || "Other",
      done: !!it.done,
      custom: true,
    });
  }
  return built;
}

function shoppingListNeedsBuild(diet) {
  const sl = diet?.shoppingList;
  if (!sl) return true;
  if (sl.version !== SHOPPING_LIST_VERSION) return true;
  if (sl.needsRefresh || sl.status === "stale" || sl.status === "pending") return true;
  if (!sl.items?.length) return true;
  if (diet.updatedAt && sl.generatedAt && diet.updatedAt > sl.generatedAt) return true;
  return false;
}

async function flagShoppingRefresh(diet) {
  if (!diet) return diet;
  diet.updatedAt = new Date().toISOString();
  diet.shoppingList = {
    weekKey: diet.shoppingList?.weekKey || CutDBHelpers.shoppingWeekFriday(),
    generatedAt: diet.shoppingList?.generatedAt || null,
    version: diet.shoppingList?.version || 1,
    status: "stale",
    needsRefresh: true,
    items: diet.shoppingList?.items || [],
    trainingDaysPerWeek: diet.shoppingList?.trainingDaysPerWeek,
    restDaysPerWeek: diet.shoppingList?.restDaysPerWeek,
    error: diet.shoppingList?.error,
  };
  await CutDB.saveDietPlan(diet);
  if (cachedDiet?.id === diet.id) {
    cachedDiet.shoppingList = diet.shoppingList;
    cachedDiet.updatedAt = diet.updatedAt;
  }
  return diet;
}

async function generateShoppingListForDiet(diet, { silent = false, trainDaysOverride } = {}) {
  if (!diet?.phaseId) return diet;
  const setStatus = (msg) => {
    if ($("shopStatus")) $("shopStatus").textContent = msg || "";
  };

  const run = async (report) => {
    report(20);
    const train = await CutDB.getTrainingForPhase(diet.phaseId);
    const phase = await CutDB.getPhase(diet.phaseId);
    const week = resolveShopWeekDays(diet, train, trainDaysOverride, phase);
    report(55, "Building week list…");
    const items = buildShoppingListFromDiet(diet, week.trainDays, week.restDays);
    diet.shoppingList = {
      weekKey: CutDBHelpers.shoppingWeekFriday(),
      generatedAt: new Date().toISOString(),
      version: SHOPPING_LIST_VERSION,
      trainingDaysPerWeek: week.trainDays,
      restDaysPerWeek: week.restDays,
      mode: week.mode,
      status: "ready",
      needsRefresh: false,
      items,
      error: items.length ? null : "No meal foods found — add foods to Diet first.",
    };
    report(90);
    await CutDB.saveDietPlan(diet);
    if (cachedDiet?.id === diet.id) cachedDiet.shoppingList = diet.shoppingList;
    if (!silent) {
      setStatus(
        items.length
          ? `${items.length} items · ${week.trainDays} train + ${week.restDays} rest = 7 days`
          : diet.shoppingList.error
      );
    }
    report(100);
    return diet;
  };

  try {
    if (silent || actionDepth > 0) return await run(() => {});
    return await withActionProgress("Building shopping list…", run, {
      doneMessage: "Shopping list ready",
      minVisibleMs: 220,
    });
  } catch (err) {
    diet.shoppingList = {
      weekKey: CutDBHelpers.shoppingWeekFriday(),
      generatedAt: new Date().toISOString(),
      version: SHOPPING_LIST_VERSION,
      status: "error",
      items: diet.shoppingList?.items || [],
      error: err.message || String(err),
    };
    await CutDB.saveDietPlan(diet);
    if (!silent) setStatus(diet.shoppingList.error);
    return diet;
  }
}

async function maybeResetShoppingListsFriday() {
  const today = CutDBHelpers.todayISO();
  const fri = CutDBHelpers.shoppingWeekFriday(today);
  const now = new Date();
  const isFriday = now.getDay() === 5;
  const morningH = Number(cfg().nudgeMorningHour ?? 9);
  const phases = await CutDB.allPhases();
  for (const p of phases) {
    const diet = await CutDB.getDietForPhase(p.id);
    const list = diet?.shoppingList;
    if (!list?.items?.length) continue;
    if (list.weekKey === fri) continue;
    if (isFriday && now.getHours() < morningH) continue;
    diet.shoppingList = {
      ...list,
      weekKey: fri,
      resetAt: new Date().toISOString(),
      items: list.items.map((it) => ({ ...it, done: false })),
    };
    await CutDB.saveDietPlan(diet);
    if (cachedDiet?.id === diet.id) cachedDiet.shoppingList = diet.shoppingList;
  }
}

async function loadShoppingPanel({ forceRegen = false } = {}) {
  const meta = $("shopMeta");
  const listEl = $("shopList");
  const status = $("shopStatus");
  const phaseId = $("shopPhaseSelect")?.value;
  if (!phaseId) {
    if (meta) meta.textContent = "Create a phase and diet first.";
    if (listEl) listEl.innerHTML = "";
    return;
  }
  const phase = await CutDB.getPhase(phaseId);
  let diet = await CutDB.getDietForPhase(phaseId);
  if (!diet) {
    if (meta) meta.textContent = `${phase?.name || "Phase"} — no diet plan yet.`;
    if (listEl) listEl.innerHTML = `<p class="hint">Save a diet plan first, then open this tab.</p>`;
    return;
  }

  const train = await CutDB.getTrainingForPhase(phaseId);
  const phaseTd = Number(phase?.trainingDaysPerWeek);
  const seedDays = Number.isFinite(phaseTd)
    ? Math.max(0, Math.min(7, Math.round(phaseTd)))
    : diet.shoppingList?.trainingDaysPerWeek != null
      ? diet.shoppingList.trainingDaysPerWeek
      : Math.min(7, Math.max(0, train?.sessions?.length || 4));

  if (forceRegen || shoppingListNeedsBuild(diet)) {
    if (status) status.textContent = "Building shopping list…";
    diet = (await generateShoppingListForDiet(diet, { trainDaysOverride: seedDays })) || diet;
  }

  const sl = diet.shoppingList;
  const fri = CutDBHelpers.shoppingWeekFriday();
  if (meta) {
    meta.textContent = `${phase?.name || "Phase"} · ${diet.name || "Diet"} · week of ${sl?.weekKey || fri}`;
  }
  if (status) {
    if (sl?.status === "error") status.textContent = sl.error || "Build failed.";
    else if (sl?.generatedAt) {
      status.textContent = `${sl.items?.length || 0} items · ${sl.trainingDaysPerWeek ?? "?"} train + ${sl.restDaysPerWeek ?? "?"} rest = 7 days`;
    } else status.textContent = "Tap Rebuild list.";
  }
  const items = sl?.items || [];
  if (!listEl) return;
  if (!items.length) {
    listEl.innerHTML = `<p class="hint">${sl?.error || "No items — add foods to your diet meals first, or tap + Item."}</p>`;
    return;
  }
  const byCat = {};
  items.forEach((it) => {
    const cat = it.category || "Other";
    (byCat[cat] ||= []).push(it);
  });
  listEl.innerHTML = Object.entries(byCat)
    .map(
      ([cat, rows]) =>
        `<li class="shop-cat"><div class="shop-cat-title">${escapeHtml(cat)}</div><ul>${rows
          .map(
            (it) => `<li class="shop-item ${it.done ? "done" : ""}" data-shop-row="${escapeHtml(it.id)}">
              <div class="shop-item-row">
                <input type="checkbox" data-shop-id="${escapeHtml(it.id)}" ${it.done ? "checked" : ""} aria-label="Bought" />
                <input type="text" class="shop-item-name-input" data-shop-name="${escapeHtml(it.id)}" value="${escapeHtml(it.name)}" aria-label="Item name" />
                <input type="text" class="shop-item-buy-input" data-shop-buy="${escapeHtml(it.id)}" value="${escapeHtml(it.amount || "")}" placeholder="amount" title="${escapeHtml(it.hint || "")}" aria-label="Buy amount" />
                <button type="button" class="shop-item-del" data-shop-del="${escapeHtml(it.id)}" title="Remove" aria-label="Remove item">×</button>
              </div>
            </li>`
          )
          .join("")}</ul></li>`
    )
    .join("");

  const persistShopItems = async (mutator) => {
    const fresh = await CutDB.getDietForPhase(phaseId);
    if (!fresh?.shoppingList) return null;
    fresh.shoppingList.items = mutator([...(fresh.shoppingList.items || [])]);
    await CutDB.saveDietPlan(fresh);
    if (cachedDiet?.id === fresh.id) cachedDiet.shoppingList = fresh.shoppingList;
    return fresh;
  };

  listEl.querySelectorAll("input[data-shop-id]").forEach((el) => {
    el.addEventListener("change", async () => {
      const id = el.dataset.shopId;
      await persistShopItems((items) => items.map((it) => (it.id === id ? { ...it, done: el.checked } : it)));
      el.closest(".shop-item")?.classList.toggle("done", el.checked);
    });
  });
  listEl.querySelectorAll("input[data-shop-name]").forEach((el) => {
    el.addEventListener("change", async () => {
      const id = el.dataset.shopName;
      const name = el.value.trim() || "Item";
      el.value = name;
      await persistShopItems((items) =>
        items.map((it) => (it.id === id ? { ...it, name, custom: it.custom || false } : it))
      );
    });
  });
  listEl.querySelectorAll("input[data-shop-buy]").forEach((el) => {
    el.addEventListener("change", async () => {
      const id = el.dataset.shopBuy;
      const amount = el.value.trim();
      await persistShopItems((items) => items.map((it) => (it.id === id ? { ...it, amount } : it)));
    });
  });
  listEl.querySelectorAll("button[data-shop-del]").forEach((el) => {
    el.addEventListener("click", async () => {
      const id = el.dataset.shopDel;
      await persistShopItems((items) => items.filter((it) => it.id !== id));
      await loadShoppingPanel();
    });
  });
}

function formatPrepDays(list) {
  const names = { sun: "Sun", mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat" };
  return (list || []).map((d) => names[d] || d).join(", ");
}

function prepSkeletonFromDiet(diet) {
  const slot = (m) => ({
    id: m.id,
    name: m.name,
    when: m.when,
    items: m.items,
    recipes: (m.recipes || []).length
      ? m.recipes
      : [{ name: "", prepMinutes: null, video: "", steps: [], makes: "" }],
  });
  return {
    type: "cut-tracker-prep-template",
    version: 1,
    prep: diet.prep || CutDBHelpers.cleanPrepMeta(),
    training: { meals: (diet.training?.meals || []).map(slot) },
    rest: { meals: (diet.rest?.meals || []).map(slot) },
  };
}

function extractPrepPayload(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Need a JSON object");
  if (raw.type === "cut-tracker-phase-template") {
    const pack = CutDBHelpers.normalizePhaseTemplate(raw);
    return { prep: pack.diet.prep, training: pack.diet.training, rest: pack.diet.rest };
  }
  if (raw.type === "cut-tracker-diet-template") {
    const diet = CutDBHelpers.normalizeDietTemplate(raw, { keepRecipes: true });
    return { prep: diet.prep, training: diet.training, rest: diet.rest };
  }
  if (raw.type === "cut-tracker-prep-template" || raw.training || raw.rest || raw.prep) {
    return {
      prep: CutDBHelpers.cleanPrepMeta(raw.prep),
      training: raw.training || { meals: raw.trainingMeals || [] },
      rest: raw.rest || { meals: raw.restMeals || [] },
    };
  }
  throw new Error("Need a phase pack, diet pack, or meal-prep JSON");
}

function patchDietRecipes(diet, incoming) {
  diet.prep = CutDBHelpers.cleanPrepMeta(incoming.prep || diet.prep);
  const patch = (block, src) => {
    if (!block) return;
    const byId = Object.fromEntries((src?.meals || []).map((m) => [m.id, m]));
    block.meals = (block.meals || []).map((m) => ({
      ...m,
      recipes: byId[m.id] ? CutDBHelpers.cleanRecipes(byId[m.id].recipes) : m.recipes || [],
    }));
  };
  patch(diet.training, incoming.training);
  patch(diet.rest, incoming.rest);
}

async function loadPrepPanel() {
  const week = $("prepWeek");
  const notes = $("prepNotes");
  const status = $("prepStatus");
  const list = $("prepList");
  const phaseId = $("prepPhaseSelect")?.value || selectedPhaseId;
  if (!phaseId) {
    if (week) {
      week.hidden = true;
      week.innerHTML = "";
    }
    if (notes) {
      notes.textContent = "";
      notes.hidden = true;
    }
    if (status) status.textContent = "Create a phase and upload a pack first.";
    if (list) list.innerHTML = "";
    return;
  }
  selectedPhaseId = phaseId;
  const phase = await CutDB.getPhase(phaseId);
  const diet = await CutDB.getDietForPhase(phaseId);
  if (!diet) {
    if (week) {
      week.hidden = true;
      week.innerHTML = "";
    }
    if (notes) {
      notes.textContent = "";
      notes.hidden = true;
    }
    if (status) status.textContent = `${phase?.name || "Phase"} — no diet plan yet.`;
    if (list) {
      list.innerHTML = `<div class="card"><p class="hint">Refresh the pack JSON after this phase exists — or upload recipes only below.</p></div>`;
    }
    return;
  }
  const prep = diet.prep || CutDBHelpers.cleanPrepMeta();
  const recipeN = CutDBHelpers.dietRecipeCount(diet) || 0;
  if (week) {
    week.hidden = false;
    week.innerHTML = `
      <span><em>Cook</em>${escapeHtml(formatPrepDays(prep.cookDays) || "—")}</span>
      <span><em>Eat</em>${escapeHtml(formatPrepDays(prep.eatDays) || "—")}</span>
      <span><em>Recipes</em>${recipeN}</span>`;
  }
  if (notes) {
    notes.textContent = prep.notes || "";
    notes.hidden = !prep.notes;
  }
  if (status) {
    status.textContent = recipeN
      ? `${recipeN} recipe${recipeN === 1 ? "" : "s"} from the pack`
      : "No recipes on this diet yet. Put recipes on meals in the pack JSON, or upload recipes-only below.";
  }
  if (!list) return;
  const blocks = [
    ["Training days", diet.training],
    ["Rest days", diet.rest],
  ];
  list.innerHTML = blocks
    .map(([label, block]) => {
      const meals = (block?.meals || []).filter(isPlateMeal);
      if (!meals.length) return "";
      const body = meals
        .map((m) => {
          const recipes = m.recipes || [];
          const chips = (m.items || []).length
            ? `<ul class="prep-foods">${m.items.map((it) => `<li>${escapeHtml(it)}</li>`).join("")}</ul>`
            : "";
          const inner = recipes.length
            ? recipeCardsHtml(recipes)
            : `<p class="prep-empty">No cook recipe — eat as written.</p>`;
          return `<article class="card prep-meal">
            <h3>${escapeHtml(m.name)}</h3>
            ${m.when ? `<p class="hint quiet">${escapeHtml(m.when)}</p>` : ""}
            ${chips}
            ${inner}
          </article>`;
        })
        .join("");
      return `<div class="prep-block">
        <h3>${escapeHtml(label)}</h3>
        ${body}
      </div>`;
    })
    .join("");
}

function renderDietTargetsAndMeals() {
  if (!cachedDiet) return;
  const mode = dietViewMode;
  mealEditMode = mode;
  const block = cachedDiet[mode];
  const t = block.targets || {};
  $("dietTargets").innerHTML = `
    <label class="field"><span>${mode} kcal</span><input id="t_kcal" type="number" value="${t.kcal ?? ""}" /></label>
    <label class="field"><span>Protein</span><input id="t_p" type="number" value="${t.protein ?? ""}" /></label>
    <label class="field"><span>Carbs</span><input id="t_c" type="number" value="${t.carbs ?? ""}" /></label>
    <label class="field"><span>Fat</span><input id="t_f" type="number" value="${t.fat ?? ""}" /></label>`;
  const meals = block.meals || [];
  if (!meals.length) {
    $("mealEditor").innerHTML = `<p class="hint">No meals yet for ${mode} day. Parse text, Fill with AI, or add a meal.</p>
      <button type="button" class="btn tiny" id="addMealBtn">+ Meal</button>`;
  } else {
    $("mealEditor").innerHTML =
      meals
        .map(
          (m, idx) => `<div class="editor-meal" data-idx="${idx}">
      <div class="grid-2">
        <label class="field"><span>Name</span><input data-f="name" value="${escapeHtml(m.name)}" /></label>
        <label class="field"><span>When</span><input data-f="when" value="${escapeHtml(m.when || "")}" /></label>
      </div>
      <label class="field"><span>Foods (one per line)</span><textarea data-f="items" rows="4">${escapeHtml((m.items || []).join("\n"))}</textarea></label>
      <div class="row-actions"><button type="button" class="btn tiny danger remove-meal" data-idx="${idx}">Remove meal</button></div>
      <input type="hidden" data-f="id" value="${escapeHtml(m.id)}" />
    </div>`
        )
        .join("") + `<button type="button" class="btn tiny" id="addMealBtn">+ Meal</button>`;
  }
  $("addMealBtn")?.addEventListener("click", () => {
    collectDietFromEditor();
    cachedDiet[mode].meals.push({ id: CutDBHelpers.uid("meal"), name: "New meal", when: "", items: [] });
    renderDietTargetsAndMeals();
  });
  $("mealEditor")
    ?.querySelectorAll(".remove-meal")
    .forEach((btn) =>
      btn.addEventListener("click", () => {
        collectDietFromEditor();
        cachedDiet[mode].meals.splice(Number(btn.dataset.idx), 1);
        renderDietTargetsAndMeals();
      })
    );
  renderFoodSwapEditor();
}

function renderFoodSwapEditor() {
  const root = $("foodSwapEditor");
  if (!root || !cachedDiet) return;
  if (!Array.isArray(cachedDiet.foodSwaps)) cachedDiet.foodSwaps = [];
  root.innerHTML =
    `<ul class="swap-list" id="dietSwapList">${swapListMarkup(cachedDiet.foodSwaps)}</ul>` +
    `<button type="button" class="btn tiny" id="addSwapBtn">+ Swap group</button>`;
  const list = $("dietSwapList");
  bindSwapListRoot(list, {
    getSwaps: () => cachedDiet.foodSwaps,
    setSwaps: (next) => {
      cachedDiet.foodSwaps = next;
    },
  });
  $("addSwapBtn")?.addEventListener("click", () => {
    collectDietFromEditor();
    cachedDiet.foodSwaps.push({
      id: CutDBHelpers.uid("swap"),
      label: "Swap",
      options: ["", ""],
    });
    renderFoodSwapEditor();
    const inputs = $("dietSwapList")?.querySelectorAll(".swap-opt-input");
    const last = inputs?.[inputs.length - 1];
    last?.focus();
  });
}

function collectDietFromEditor() {
  const mode = dietViewMode;
  if ($("t_kcal")) {
    cachedDiet[mode].targets = {
      kcal: parseNum($("t_kcal")?.value),
      protein: parseNum($("t_p")?.value),
      carbs: parseNum($("t_c")?.value),
      fat: parseNum($("t_f")?.value),
    };
  }
  const meals = [];
  const prevById = Object.fromEntries((cachedDiet[mode].meals || []).map((m) => [m.id, m]));
  document.querySelectorAll("#mealEditor .editor-meal").forEach((node) => {
    const id = node.querySelector('[data-f="id"]').value || CutDBHelpers.uid("meal");
    meals.push({
      id,
      name: node.querySelector('[data-f="name"]').value.trim() || "Meal",
      when: node.querySelector('[data-f="when"]').value.trim(),
      items: node
        .querySelector('[data-f="items"]')
        .value.split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      recipes: prevById[id]?.recipes || [],
      ...(Number(prevById[id]?.kcal) > 0 ? { kcal: Math.round(Number(prevById[id].kcal)) } : {}),
      ...(Number(prevById[id]?.protein) > 0 ? { protein: Math.round(Number(prevById[id].protein)) } : {}),
      ...(Number(prevById[id]?.carbs) > 0 ? { carbs: Math.round(Number(prevById[id].carbs)) } : {}),
      ...(Number(prevById[id]?.fat) > 0 ? { fat: Math.round(Number(prevById[id].fat)) } : {}),
      ...(Array.isArray(prevById[id]?.swaps) ? { swaps: prevById[id].swaps } : {}),
    });
  });
  if ($("mealEditor")?.querySelector(".editor-meal") || $("mealEditor")?.querySelector("#addMealBtn")) {
    cachedDiet[mode].meals = meals;
  }
  cachedDiet.name =
    $("dietName").value.trim() ||
    $("dietPhaseSelect")?.selectedOptions?.[0]?.textContent?.match(/^(\d+)/)?.[1] ||
    cachedDiet.name;
  cachedDiet.notes = $("dietNotes").value.trim();
  if ($("foodSwapEditor") || $("dietSwapList")) {
    const fromDom = readSwapsFromRoot($("dietSwapList") || $("foodSwapEditor"));
    cachedDiet.foodSwaps = fromDom
      .map((s) => ({
        id: s.id || CutDBHelpers.uid("swap"),
        label: s.label || "Swap",
        options: (s.options || []).filter(Boolean),
      }))
      .filter((s) => s.options.length >= 2);
  }
}

function renderFoodRescueChat(messages) {
  const root = $("foodRescueChat");
  if (!root) return;
  const list = messages || [];
  if (!list.length) {
    root.innerHTML = `<p class="hint">No rescue chats yet. From Today, tap Rescue on a meal to start with that plate.</p>`;
    return;
  }
  root.innerHTML = list
    .slice(-12)
    .map((m) => {
      const tag = m.mealName
        ? `<span class="rescue-meal-tag">${escapeHtml(m.mealName)}</span>`
        : "";
      return `<div class="food-rescue-msg ${m.role === "user" ? "user" : "assistant"}">${tag}${escapeHtml(
        m.content || ""
      )}</div>`;
    })
    .join("");
  root.scrollTop = root.scrollHeight;
}

async function askFoodRescue(opts = {}) {
  const fromSheet = !!opts.fromSheet;
  const status = fromSheet ? $("mealRescueStatus") : $("foodRescueStatus");
  const setStatus = (msg) => {
    if (status) status.textContent = msg || "";
  };
  const btn = fromSheet ? $("mealRescueAskBtn") : $("foodRescueAskBtn");
  const inputEl = fromSheet ? $("mealRescueInput") : $("foodRescueInput");
  try {
    if (!aiSettings().key) {
      setStatus("Add a Gemini or OpenRouter key in More → Backup & AI key.");
      return;
    }
    await fillPhaseSelects();
    if (cachedPhase?.id && $("rescuePhaseSelect") && !$("rescuePhaseSelect").value) {
      $("rescuePhaseSelect").value = cachedPhase.id;
    }
    const { phaseId, phase, diet } = await getRescueDietContext();
    if (!phaseId || !phase) {
      setStatus("Create/select a phase first.");
      return;
    }
    if (!diet) {
      setStatus("No diet for this phase — add one under More → Diet plan.");
      return;
    }
    const question = (opts.question || inputEl?.value || "").trim();
    if (!question) {
      setStatus("Describe what happened first.");
      return;
    }
    const mealId = opts.mealId || (fromSheet ? mealRescueFocusId : $("rescueMealSelect")?.value) || "";
    const meals = plateMeals(diet);
    const meal = meals.find((m) => m.id === mealId) || null;
    if (btn) btn.disabled = true;
    const mealLabel = meal ? meal.name : "today";
    setStatus(`Asking AI for ${mealLabel} · ${phase.name}…`);
    await withActionProgress(
      meal ? `Rescue ${meal.name}…` : "Food rescue…",
      async (report) => {
        report(15);
        const date = $("logDate")?.value || CutDBHelpers.todayISO();
        const day = await CutDB.getDay(date);
        const context = buildRescueContext({
          diet,
          phase,
          day: { ...(day || {}), date, mealChecks: { ...(day?.mealChecks || {}), ...readMealChecks() }, swapPicks: { ...(day?.swapPicks || {}), ...readSwapPicks() } },
          mealId: meal?.id || "",
        });
        const situation = meal
          ? `Focus meal: ${meal.name} (${meal.when || meal.id}).\nUser situation:\n${question}\n\nTell me how THIS meal changes, then how remaining meals today should change.`
          : `No single meal locked — whole day.\nUser situation:\n${question}`;
        report(30, "Asking AI…");
        const reply = await aiChat({
          system: CutDBHelpers.AI_PROMPTS.foodRescue,
          user: `Diet context JSON:\n${JSON.stringify(context, null, 2)}\n\n${situation}`,
          temperature: 0.4,
        });
        report(80);
        if (!Array.isArray(diet.foodRescueChat)) diet.foodRescueChat = [];
        diet.foodRescueChat.push(
          {
            role: "user",
            content: question,
            mealId: meal?.id || "",
            mealName: meal?.name || "",
            at: new Date().toISOString(),
          },
          {
            role: "assistant",
            content: reply,
            mealId: meal?.id || "",
            mealName: meal?.name || "",
            at: new Date().toISOString(),
          }
        );
        if (diet.foodRescueChat.length > 24) {
          diet.foodRescueChat = diet.foodRescueChat.slice(-24);
        }
        await CutDB.saveDietPlan(diet);
        if (cachedDiet?.id === diet.id) {
          cachedDiet.foodRescueChat = diet.foodRescueChat;
        }
        if (!fromSheet && $("foodRescueInput")) $("foodRescueInput").value = "";
        renderFoodRescueChat(diet.foodRescueChat);
        if (fromSheet && $("mealRescueReply")) {
          $("mealRescueReply").hidden = false;
          $("mealRescueReply").textContent = reply;
        }
        setStatus(`Saved · ${mealLabel} · ${phase.name}.`);
        report(100);
      },
      { doneMessage: "Food rescue ready", minVisibleMs: 400 }
    );
  } catch (err) {
    setStatus(err.message || String(err));
    if (!err?.actionProgressHandled) showToast(err.message || String(err));
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadTrainEditor() {
  const phaseId = $("trainPhaseSelect").value || selectedPhaseId;
  if (!phaseId) return;
  selectedPhaseId = phaseId;
  const phase = await CutDB.getPhase(phaseId);
  let plan = await CutDB.getTrainingForPhase(phaseId);
  if ($("trainPhaseMeta")) {
    $("trainPhaseMeta").textContent = phase ? `${phase.name} · ${formatRange(phase)} · one training plan` : "";
  }
  if (!plan) {
    $("trainName").value = phase?.name || "";
    if ($("trainAutoName")) $("trainAutoName").textContent = "Tap a session to edit its lifts.";
    $("trainNotes").value = "";
    if ($("trainRestSets")) $("trainRestSets").value = "90";
    if ($("trainRestEx")) $("trainRestEx").value = "120";
    $("trainEditor").innerHTML = `<p class="hint">No training plan. Create a phase with a Phase pack, or add sessions below then Save.</p>`;
    cachedTrain = {
      id: CutDBHelpers.uid("train"),
      phaseId,
      name: phase?.name || "1",
      notes: "",
      restBetweenSetsSec: 90,
      restBetweenExercisesSec: 120,
      sessions: [],
      createdAt: new Date().toISOString(),
    };
    renderTrainSchedule();
    applyTrainView();
    return;
  }
  cachedTrain = plan;
  if (cachedTrain.restBetweenSetsSec == null) cachedTrain.restBetweenSetsSec = 90;
  if (cachedTrain.restBetweenExercisesSec == null) cachedTrain.restBetweenExercisesSec = 120;
  $("trainName").value = phase?.name || plan.name || "";
  if ($("trainAutoName")) $("trainAutoName").textContent = "Tap a session to edit its lifts.";
  $("trainNotes").value = plan.notes || "";
  if ($("trainRestSets")) $("trainRestSets").value = String(cachedTrain.restBetweenSetsSec ?? 90);
  if ($("trainRestEx")) $("trainRestEx").value = String(cachedTrain.restBetweenExercisesSec ?? 120);
  renderTrainEditor();
  applyTrainView();
}

function applyTrainView() {
  const schedule = trainViewMode !== "sessions";
  document.querySelectorAll("#trainViewSwitch [data-train-view]").forEach((b) => {
    b.classList.toggle("active", b.dataset.trainView === (schedule ? "schedule" : "sessions"));
  });
  if ($("trainPanelTitle")) $("trainPanelTitle").textContent = schedule ? "Schedule" : "Sessions";
  if ($("trainScheduleCard")) $("trainScheduleCard").hidden = !schedule;
  if ($("trainEditorWrap")) $("trainEditorWrap").hidden = schedule;
}

function sessionDayLabel(s) {
  const d = Number(s?.recommendedWeekday);
  if (!Number.isInteger(d) || d < 0 || d > 6) return "No day";
  return DAY_NAMES()[d];
}

function renderTrainEditor() {
  if (!cachedTrain) return;
  const defSets = cachedTrain.restBetweenSetsSec ?? 90;
  const defEx = cachedTrain.restBetweenExercisesSec ?? 120;
  const sessions = cachedTrain.sessions || [];
  if (!sessions.length) {
    $("trainEditor").innerHTML = `<p class="hint">No sessions yet. Add one below.</p>`;
    renderTrainSchedule();
    return;
  }
  $("trainEditor").innerHTML = sessions
    .map((s, si) => {
      const n = (s.exercises || []).length;
      const open = s.id === openTrainSessionId ? "open" : "";
      return `<details class="editor-meal session-block" data-si="${si}" ${open}>
      <summary>
        <strong>${escapeHtml(s.name || `Session ${si + 1}`)}</strong>
        <span class="hint">${escapeHtml(sessionDayLabel(s))} · ${n} lift${n === 1 ? "" : "s"}</span>
      </summary>
      <div class="session-head-row">
        <label class="field" style="flex:1;margin:0"><span>Session name</span>
          <input data-sf="name" value="${escapeHtml(s.name || `Session ${si + 1}`)}" placeholder="e.g. Legs, Arms, Push" />
        </label>
        <input type="hidden" data-sf="id" value="${escapeHtml(s.id)}" />
        <button type="button" class="btn tiny danger rm-session" style="align-self:end">Remove</button>
      </div>
      ${(s.exercises || [])
        .map(
          (e, ei) => `<div class="ex-edit" data-ei="${ei}">
          <p class="hint quiet" style="margin:0 0 6px">Exercise ${ei + 1}</p>
          <div class="grid-2">
            <label class="field"><span>Lift name</span><input data-ef="name" value="${escapeHtml(e.name)}" /></label>
            <label class="field"><span>YouTube URL</span><input data-ef="youtubeUrl" value="${escapeHtml(e.youtubeUrl || "")}" placeholder="youtu.be/… or full URL" /></label>
            <label class="field"><span>Target sets</span><input data-ef="targetSets" type="number" value="${e.targetSets ?? 3}" /></label>
            <label class="field"><span>Target reps</span><input data-ef="targetReps" value="${escapeHtml(e.targetReps || "")}" /></label>
            <label class="field"><span>Rest between sets (sec)</span><input data-ef="restSets" type="number" min="0" max="600" step="5" value="${e.restBetweenSetsSec ?? ""}" placeholder="default ${defSets}" /></label>
            <label class="field"><span>Rest before next exercise (sec)</span><input data-ef="restEx" type="number" min="0" max="600" step="5" value="${e.restAfterExerciseSec ?? ""}" placeholder="default ${defEx}" /></label>
          </div>
          <label class="field"><span>Notes</span><input data-ef="notes" value="${escapeHtml(e.notes || "")}" /></label>
          <input type="hidden" data-ef="id" value="${escapeHtml(e.id)}" />
          <button type="button" class="btn tiny danger rm-ex">Remove exercise</button>
        </div>`
        )
        .join("")}
      <button type="button" class="btn tiny add-ex">+ Exercise</button>
    </details>`;
    })
    .join("");

  $("trainEditor").querySelectorAll(".add-ex").forEach((btn) => {
    btn.addEventListener("click", () => {
      collectTrainFromEditor();
      const si = +btn.closest(".session-block").dataset.si;
      openTrainSessionId = cachedTrain.sessions[si]?.id || "";
      const n = (cachedTrain.sessions[si].exercises || []).length + 1;
      cachedTrain.sessions[si].exercises.push({
        id: CutDBHelpers.uid("ex"),
        name: `Lift ${n}`,
        youtubeUrl: "",
        targetSets: 3,
        targetReps: "8-10",
        restBetweenSetsSec: null,
        restAfterExerciseSec: null,
        notes: "",
      });
      renderTrainEditor();
    });
  });
  $("trainEditor").querySelectorAll(".rm-ex").forEach((btn) => {
    btn.addEventListener("click", () => {
      collectTrainFromEditor();
      const block = btn.closest(".session-block");
      const si = +block.dataset.si;
      const ei = +btn.closest(".ex-edit").dataset.ei;
      cachedTrain.sessions[si].exercises.splice(ei, 1);
      renderTrainEditor();
    });
  });
  $("trainEditor").querySelectorAll(".rm-session").forEach((btn) => {
    btn.addEventListener("click", () => {
      collectTrainFromEditor();
      const si = +btn.closest(".session-block").dataset.si;
      const sid = cachedTrain.sessions[si]?.id;
      cachedTrain.sessions.splice(si, 1);
      if (openTrainSessionId === sid) openTrainSessionId = "";
      renderTrainEditor();
      renderTrainSchedule();
    });
  });
  $("trainEditor").querySelectorAll("details.session-block").forEach((details) => {
    details.addEventListener("toggle", () => {
      if (!details.open) return;
      openTrainSessionId = cachedTrain.sessions[+details.dataset.si]?.id || "";
      $("trainEditor").querySelectorAll("details.session-block").forEach((el) => {
        if (el !== details && el.open) el.open = false;
      });
    });
  });
  renderTrainSchedule();
}

function collectTrainFromEditor() {
  if (!cachedTrain) return;
  const phaseLabel = $("trainPhaseSelect")?.selectedOptions?.[0]?.textContent?.match(/^(\d+)/)?.[1];
  cachedTrain.name = ($("trainName").value || phaseLabel || cachedTrain.name || "1").toString().trim() || "1";
  cachedTrain.notes = $("trainNotes").value.trim();
  const rs = parseNum($("trainRestSets")?.value);
  const re = parseNum($("trainRestEx")?.value);
  cachedTrain.restBetweenSetsSec = rs != null ? Math.max(0, Math.min(600, rs)) : cachedTrain.restBetweenSetsSec ?? 90;
  cachedTrain.restBetweenExercisesSec =
    re != null ? Math.max(0, Math.min(600, re)) : cachedTrain.restBetweenExercisesSec ?? 120;
  if ($("trainEditorWrap")?.hidden) return;
  const sessions = [];
  document.querySelectorAll("#trainEditor .session-block").forEach((node, si) => {
    const exercises = [];
    node.querySelectorAll(".ex-edit").forEach((ex) => {
      let youtubeUrl = ex.querySelector('[data-ef="youtubeUrl"]').value.trim();
      let name = ex.querySelector('[data-ef="name"]').value.trim() || "Lift";
      let notes = ex.querySelector('[data-ef="notes"]').value.trim();
      youtubeUrl =
        CutDBHelpers.normalizeYoutubeUrl?.(youtubeUrl) ||
        CutDBHelpers.normalizeYoutubeUrl?.(notes) ||
        CutDBHelpers.normalizeYoutubeUrl?.(name) ||
        youtubeUrl ||
        "";
      const restSets = parseNum(ex.querySelector('[data-ef="restSets"]')?.value);
      const restEx = parseNum(ex.querySelector('[data-ef="restEx"]')?.value);
      exercises.push({
        id: ex.querySelector('[data-ef="id"]').value || CutDBHelpers.uid("ex"),
        name,
        youtubeUrl,
        targetSets: parseNum(ex.querySelector('[data-ef="targetSets"]').value) || 3,
        targetReps: ex.querySelector('[data-ef="targetReps"]').value.trim(),
        restBetweenSetsSec: restSets,
        restAfterExerciseSec: restEx,
        notes,
      });
    });
    const sid = node.querySelector('[data-sf="id"]').value || CutDBHelpers.uid("session");
    const prevSession = (cachedTrain.sessions || []).find((s) => s.id === sid);
    sessions.push({
      id: sid,
      name: node.querySelector('[data-sf="name"]').value.trim() || `Session ${si + 1}`,
      recommendedWeekday: prevSession?.recommendedWeekday ?? null,
      proposedTime: prevSession?.proposedTime || "",
      exercises,
    });
  });
  cachedTrain.sessions = sessions;
}

async function renderPhasePhotos() {
  const grid = $("phasePhotoGrid");
  if (!grid) return;
  const phaseId = $("editPhaseId")?.value;
  if (!phaseId) {
    grid.innerHTML = `<p class="hint">Select a phase to add start photos.</p>`;
    return;
  }
  const phase = await CutDB.getPhase(phaseId);
  const photos = await CutDB.photosForPhaseStart(phase);
  grid.innerHTML = photos.length ? "" : `<p class="hint">No phase-start photos yet.</p>`;
  for (const p of photos) {
    grid.appendChild(await makePhotoThumb(p));
  }
}

async function renderPhotos(includeAll = true) {
  revokeLivePhotoUrls();
  await renderPhasePhotos();
  const root = $("allPhotos");
  if (!includeAll || !root) return;
  const phases = await CutDB.allPhases();
  const all = await CutDB.allPhotos();
  if (!all.length) {
    root.innerHTML = `<p class="hint">No phase-start photos yet. Add them under More → Phases.</p>`;
    return;
  }
  const byPhase = {};
  all.forEach((p) => {
    if (p.phaseId) (byPhase[p.phaseId] ||= []).push(p);
  });
  root.innerHTML = "";
  const orderedPhases = phases
    .slice()
    .sort((a, b) => (b.startDate || "").localeCompare(a.startDate || ""));
  const used = new Set();
  for (const phase of orderedPhases) {
    const linked = byPhase[phase.id] || [];
    const legacy =
      phase.startDate && !linked.length
        ? all.filter((p) => !p.phaseId && p.date === phase.startDate)
        : [];
    const list = linked.length ? linked : legacy;
    if (!list.length) continue;
    list.forEach((p) => used.add(p.id));
    const block = document.createElement("div");
    block.className = "photo-day";
    block.innerHTML = `<h3>${escapeHtml(phase.name)} · start ${phase.startDate || "—"}</h3>`;
    const grid = document.createElement("div");
    grid.className = "photo-grid";
    for (const p of list.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      grid.appendChild(await makePhotoThumb(p));
    }
    block.appendChild(grid);
    root.appendChild(block);
  }
  const leftover = all.filter((p) => !used.has(p.id));
  if (leftover.length) {
    const block = document.createElement("div");
    block.className = "photo-day";
    block.innerHTML = `<h3>Other</h3>`;
    const grid = document.createElement("div");
    grid.className = "photo-grid";
    for (const p of leftover.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      grid.appendChild(await makePhotoThumb(p));
    }
    block.appendChild(grid);
    root.appendChild(block);
  }
}

async function renderAnalyses() {
  const list = await CutDB.allAnalyses();
  const phases = await CutDB.allPhases();
  const today = CutDBHelpers.todayISO();
  const newestPhaseInsight = list.find((a) => a.source === "auto-phase" || a.source === "phase") || null;
  const completed = phases
    .filter((p) => phaseIsComplete(p, today))
    .sort((a, b) => (phaseEndISO(b) || "").localeCompare(phaseEndISO(a) || ""));
  const latestDone = completed[0] || null;
  const featured =
    (latestDone?.phaseInsightId && list.find((a) => a.id === latestDone.phaseInsightId)) || newestPhaseInsight;

  const card = $("progressAiCard");
  if (card) card.classList.toggle("has-insight", !!featured);
  if ($("progressAiTitle")) $("progressAiTitle").textContent = featured?.title || "AI analysis";
  if ($("progressAiMeta")) {
    $("progressAiMeta").textContent = featured
      ? `${sourceLabel(featured.source)} · ${new Date(featured.importedAt || featured.timestamp).toLocaleDateString()}`
      : latestDone
        ? `Phase ${latestDone.name || ""} ended`
        : "";
  }
  const preview = $("phaseInsightBody");
  if (preview) {
    preview.hidden = !featured;
    preview.textContent = featured?.content || "";
  }
  if (featured && $("analysisImportFold")) $("analysisImportFold").open = false;

  const el = $("analysisList");
  if (!el) return;
  el.innerHTML = list.length
    ? list
        .map(
          (a) =>
            `<li data-id="${a.id}"><div class="top"><span>${escapeHtml(a.title || "Analysis")}</span><span>${new Date(
              a.importedAt
            ).toLocaleDateString()}</span></div><div class="meta">${escapeHtml(sourceLabel(a.source))}</div></li>`
        )
        .join("")
    : "<li><div class='top'><span>No saved notes yet</span></div></li>";
  el.querySelectorAll("[data-id]").forEach((li) =>
    li.addEventListener("click", async () => {
      const a = (await CutDB.allAnalyses()).find((x) => x.id === li.dataset.id);
      if (!a) return;
      activeAnalysis = a;
      $("analysisDialogTitle").textContent = a.title || "Analysis";
      $("analysisDialogMeta").textContent = `Stamp ${a.timestamp} · imported ${new Date(a.importedAt).toLocaleString()}`;
      $("analysisDialogBody").textContent = a.content || "";
      $("analysisDialog").showModal();
    })
  );
}

function rollingAvg(points, window = 7) {
  return points.map((p, i) => {
    const slice = points.slice(Math.max(0, i - window + 1), i + 1);
    return { date: p.date, value: mean(slice.map((x) => x.value)) };
  });
}

function svgDualLine(daily, avgLine, { yLabel = "", height = 160 } = {}) {
  if (!daily.length) return `<p class="chart-empty">No data yet</p>`;
  const w = Math.max(320, daily.length * 18 + 48);
  const h = height;
  const pad = { t: 16, r: 12, b: 28, l: 40 };
  const vals = [...daily.map((d) => d.value), ...avgLine.map((d) => d.value)].filter((v) => v != null);
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const padY = (max - min) * 0.08 || 0.5;
  min -= padY;
  max += padY;
  const xAt = (i) => pad.l + (i / Math.max(1, daily.length - 1)) * (w - pad.l - pad.r);
  const yAt = (v) => pad.t + (1 - (v - min) / (max - min)) * (h - pad.t - pad.b);
  const dots = daily
    .map(
      (d, i) =>
        `<circle cx="${xAt(i)}" cy="${yAt(d.value)}" r="3.2" fill="#14201c" opacity="0.55"><title>${d.date}: ${d.value}</title></circle>`
    )
    .join("");
  const avgPath = avgLine.map((d, i) => `${i ? "L" : "M"}${xAt(i)},${yAt(d.value)}`).join(" ");
  const yTicks = [min, (min + max) / 2, max]
    .map((v) => {
      const y = yAt(v);
      return `<text x="4" y="${y + 3}" font-size="10" fill="#5c6b64">${v.toFixed(1)}</text>
        <line x1="${pad.l}" y1="${y}" x2="${w - pad.r}" y2="${y}" stroke="#d5ddd8" stroke-dasharray="3 4"/>`;
    })
    .join("");
  const xLabels = [0, Math.floor((daily.length - 1) / 2), daily.length - 1]
    .filter((i, idx, arr) => arr.indexOf(i) === idx && daily[i])
    .map(
      (i) =>
        `<text x="${xAt(i)}" y="${h - 8}" font-size="10" fill="#5c6b64" text-anchor="middle">${daily[i].date.slice(5)}</text>`
    )
    .join("");
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${escapeHtml(yLabel)}">
    ${yTicks}
    <path d="${avgPath}" fill="none" stroke="#0f6b5c" stroke-width="2.5"/>
    ${dots}
    ${xLabels}
  </svg>`;
}

function svgSingleLine(points, { color = "#0f6b5c", height = 140 } = {}) {
  if (!points.length) return `<p class="chart-empty">No data yet</p>`;
  const daily = points.map((p) => ({ date: p.date, value: p.value }));
  return svgDualLine(daily, daily, { height }).replace(/stroke="#0f6b5c"/, `stroke="${color}"`);
}

function weekKey(dateISO) {
  const d = new Date(dateISO + "T12:00:00");
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10);
}

function exerciseVolume(ex) {
  return (ex.sets || []).reduce((sum, s) => {
    if (typeof s.weight === "number" && typeof s.reps === "number") return sum + s.weight * s.reps;
    return sum;
  }, 0);
}

/** Epley estimated 1RM — skip when reps > 12 (less reliable). */
function epley1RM(weight, reps) {
  if (typeof weight !== "number" || typeof reps !== "number" || weight <= 0 || reps < 1) return null;
  if (reps === 1) return weight;
  if (reps > 12) return null;
  return weight * (1 + reps / 30);
}

function sessionLiftStats(ex) {
  let volume = 0;
  let bestWeight = null;
  let bestE1rm = null;
  let bestSetLabel = "";
  for (const s of ex.sets || []) {
    if (typeof s.weight !== "number" || typeof s.reps !== "number") continue;
    volume += s.weight * s.reps;
    if (bestWeight == null || s.weight > bestWeight) {
      bestWeight = s.weight;
      bestSetLabel = `${s.weight}×${s.reps}`;
    }
    const e1 = epley1RM(s.weight, s.reps);
    if (e1 != null && (bestE1rm == null || e1 > bestE1rm)) bestE1rm = e1;
  }
  return { volume, bestWeight, bestE1rm, bestSetLabel };
}

let strengthMetric = "volume";
let strengthCache = null;

function collectStrengthData(data) {
  const byLift = {};
  let sessionDays = 0;
  sortedDates(data).forEach((d) => {
    const workout = data[d].workout;
    if (!workout?.exercises?.length) return;
    let dayHadLift = false;
    workout.exercises.forEach((ex) => {
      const stats = sessionLiftStats(ex);
      if (!stats.volume && stats.bestWeight == null) return;
      dayHadLift = true;
      const key = (ex.name || ex.exerciseId || "Exercise").trim() || "Exercise";
      (byLift[key] ||= []).push({
        date: d,
        volume: stats.volume,
        bestWeight: stats.bestWeight,
        bestE1rm: stats.bestE1rm,
        bestSetLabel: stats.bestSetLabel,
      });
    });
    if (dayHadLift) sessionDays += 1;
  });
  return { byLift, sessionDays };
}

function liftTrendLabel(pts) {
  if (!pts || pts.length < 2) return { key: "new", label: "New", cls: "flat" };
  const first = pts[0];
  const last = pts[pts.length - 1];
  const wDelta = (last.bestWeight ?? 0) - (first.bestWeight ?? 0);
  const eDelta = (last.bestE1rm ?? 0) - (first.bestE1rm ?? 0);
  const vDelta = (last.volume ?? 0) - (first.volume ?? 0);
  if (wDelta > 0.4 || eDelta > 1.5 || (first.volume > 0 && vDelta / first.volume > 0.08)) {
    return { key: "up", label: "Up", cls: "up" };
  }
  if (wDelta < -0.4 || eDelta < -2 || (first.volume > 0 && vDelta / first.volume < -0.08)) {
    return { key: "down", label: "Down", cls: "down" };
  }
  return { key: "flat", label: "Flat", cls: "flat" };
}

function renderProgressBrief(data, extras = {}) {
  const titleEl = $("progressBriefTitle");
  const verdictEl = $("progressBriefVerdict");
  const chipsEl = $("progressBriefChips");
  const pointsEl = $("progressBriefPoints");
  const metaEl = $("progressBriefMeta");
  if (!verdictEl || !chipsEl || !pointsEl) return;

  const date = $("logDate")?.value || CutDBHelpers.todayISO();
  const dates = sortedDates(data);
  const weighIns = dates
    .filter((d) => typeof data[d].weight === "number")
    .map((d) => ({ date: d, value: data[d].weight }));
  const avg7 = mean(lastNWeights(data, 7, date).map((x) => x.weight));
  const avg14ago = mean(lastNWeights(data, 7, CutDBHelpers.addDaysISO(date, -14)).map((x) => x.weight));
  let delta14 = null;
  if (avg7 != null && avg14ago != null) delta14 = avg7 - avg14ago;
  else if (weighIns.length >= 2) {
    const last = weighIns[weighIns.length - 1];
    const target = CutDBHelpers.addDaysISO(last.date, -13);
    let earlier = weighIns[0];
    for (const w of weighIns) if (w.date <= target) earlier = w;
    delta14 = last.value - earlier.value;
  }

  const goal = goalLossPct(cachedPhase);
  const expected14 = goal > 0 ? -((goal / 100) * (avg7 || weighIns.at(-1)?.value || 80) * 2) : null;
  // goal is % per week; over ~2 weeks ≈ 2 * weekly
  let cutTone = "flat";
  let cutLabel = "Need weigh-ins";
  if (delta14 != null && expected14 != null) {
    if (delta14 <= expected14 * 0.55) {
      cutTone = "good";
      cutLabel = "Losing well";
    } else if (delta14 <= expected14 * 0.15) {
      cutTone = "caution";
      cutLabel = "Slow cut";
    } else if (delta14 > 0.35) {
      cutTone = "warn";
      cutLabel = "Gaining";
    } else {
      cutTone = "caution";
      cutLabel = "Near stall";
    }
  } else if (delta14 != null) {
    cutTone = delta14 < -0.3 ? "good" : delta14 > 0.3 ? "warn" : "caution";
    cutLabel = formatDelta(delta14) + " /14d";
  }

  const { byLift, sessionDays } = collectStrengthData(data);
  const lifts = Object.entries(byLift);
  let up = 0;
  let flat = 0;
  let down = 0;
  const movers = [];
  lifts.forEach(([name, pts]) => {
    const t = liftTrendLabel(pts);
    if (t.key === "up") {
      up += 1;
      movers.push({ name, t, last: pts[pts.length - 1] });
    } else if (t.key === "down") {
      down += 1;
      movers.push({ name, t, last: pts[pts.length - 1] });
    } else if (pts.length >= 2) flat += 1;
  });

  let strengthTone = "flat";
  let strengthLabel = lifts.length ? `${lifts.length} lifts` : "No lifts";
  if (lifts.length) {
    if (up >= down && up > 0) {
      strengthTone = "good";
      strengthLabel = `${up} up · ${down} down`;
    } else if (down > up) {
      strengthTone = "warn";
      strengthLabel = `${down} fading`;
    } else {
      strengthTone = "caution";
      strengthLabel = flat ? `${flat} flat` : "Building data";
    }
  }

  const adherencePct = extras.adherencePct ?? null;
  let mealTone = "flat";
  let mealLabel = "—";
  if (adherencePct != null) {
    mealLabel = `${adherencePct}%`;
    mealTone = adherencePct >= 85 ? "good" : adherencePct >= 70 ? "caution" : "warn";
  }

  const last14 = dates.filter((d) => d >= CutDBHelpers.addDaysISO(date, -13) && d <= date);
  const liftDays14 = last14.filter((d) => dayHasLoggedWeights(data[d])).length;
  const liftTone = liftDays14 >= 3 ? "good" : liftDays14 >= 1 ? "caution" : "warn";

  const sleepVals = last14.map((d) => data[d]?.sleep).filter((n) => typeof n === "number");
  const energyVals = last14.map((d) => data[d]?.energy).filter((n) => typeof n === "number");
  const sleepAvg = sleepVals.length ? mean(sleepVals) : null;
  const energyAvg = energyVals.length ? mean(energyVals) : null;
  let sleepTone = "flat";
  if (sleepAvg != null) sleepTone = sleepAvg >= 7 ? "good" : sleepAvg >= 6 ? "caution" : "warn";

  const chips = [
    { label: "Cut", value: cutLabel, tone: cutTone === "flat" ? "caution" : cutTone },
    { label: "Strength", value: strengthLabel, tone: strengthTone === "flat" ? "caution" : strengthTone },
    { label: "Meals", value: mealLabel, tone: mealTone === "flat" ? "caution" : mealTone },
    { label: "Lift days · 14d", value: `${liftDays14}`, tone: liftTone },
  ];
  if (sleepAvg != null) {
    chips.push({
      label: "Sleep",
      value: `${sleepAvg.toFixed(1)} h`,
      tone: sleepTone,
    });
  }

  const points = [];
  if (delta14 != null) {
    const rate =
      expected14 != null
        ? `Goal ≈ ${formatDelta(expected14)} over ~2 weeks at ${goal}%/wk.`
        : "";
    points.push(`Scale: 7-day avg ${avg7 != null ? avg7.toFixed(1) + " kg" : "—"} · ~14d change ${formatDelta(delta14)}. ${rate}`.trim());
  } else {
    points.push("Scale: log morning weight most days to unlock cut pace.");
  }

  if (lifts.length) {
    const upNames = movers.filter((m) => m.t.key === "up").slice(0, 3).map((m) => m.name);
    const downNames = movers.filter((m) => m.t.key === "down").slice(0, 3).map((m) => m.name);
    if (upNames.length) points.push(`Strength wins: ${upNames.join(", ")} trending up.`);
    if (downNames.length) {
      points.push(
        `Softer lifts: ${downNames.join(", ")} — next session keep form, or drop load ~5–10% if sleep/energy are low.`
      );
    }
    if (!upNames.length && !downNames.length) {
      points.push(`Strength: ${sessionDays} sessions with weights logged · trends need 2+ sessions per lift.`);
    }
  } else {
    points.push("Strength: save set weights on Today → Workout (marking Train alone doesn’t count).");
  }

  points.push(
    liftDays14
      ? `Lift days (last 14): ${liftDays14} days with weights logged — not just “Train” selected.`
      : "Lift days (last 14): 0 — log weights on lifts; selecting Train without sets doesn’t count."
  );

  if (adherencePct != null) {
    points.push(
      adherencePct >= 85
        ? `Meals are solid at ${adherencePct}% checked — keep that.`
        : `Meals at ${adherencePct}% checked — on Today, tick every planned meal you actually ate.`
    );
  }

  if (energyAvg != null && energyAvg <= 2.5) {
    points.push(`Energy averaging ${energyAvg.toFixed(1)}/5 — sleep more and skip pushing PRs this week.`);
  } else if (sleepAvg != null && sleepAvg < 6.5) {
    points.push(`Sleep averaging ${sleepAvg.toFixed(1)} h — aim ~7h+ so lifts and the cut don’t stall.`);
  }

  // Explicit fine vs fix (no vague “mixed / nudge”)
  const areaDefs = [
    {
      name: "Cut",
      tone: cutTone === "flat" ? "caution" : cutTone,
      fine: "weight trending down vs goal",
      fix:
        cutTone === "warn"
          ? "Cut: scale is up — lock meal checks and steps for a week"
          : "Cut: loss is slow/flat — review weekend meals and daily steps",
    },
    {
      name: "Strength",
      tone: strengthTone === "flat" ? "caution" : strengthTone,
      fine: "enough lifts holding or climbing",
      fix:
        strengthTone === "warn"
          ? "Strength: some lifts are softer — easier week or sleep first"
          : "Strength: log 2+ sessions per lift so trends are clear",
    },
    {
      name: "Meals",
      tone: mealTone === "flat" ? "caution" : mealTone,
      fine: "meal check-offs look consistent",
      fix: "Meals: check off what you eat on Today so adherence is real",
    },
    {
      name: "Lift days",
      tone: liftTone,
      fine: "weights logged on enough days",
      fix: "Lift days: save weights on workout sets (Train toggle alone doesn’t count)",
    },
  ];
  if (sleepAvg != null) {
    areaDefs.push({
      name: "Sleep",
      tone: sleepTone,
      fine: "sleep average looks workable",
      fix: "Sleep: get closer to 7h so recovery matches training",
    });
  }

  const fineAreas = areaDefs.filter((a) => a.tone === "good");
  const fixAreas = areaDefs.filter((a) => a.tone === "warn" || a.tone === "caution");

  let verdict = "Keep logging weigh-ins and set weights — the brief sharpens with more data.";
  let tone = "caution";
  if (weighIns.length >= 5 || lifts.length >= 2 || liftDays14 >= 1) {
    if (fineAreas.length && !fixAreas.length) {
      tone = "good";
      verdict = `Looking good: ${fineAreas.map((a) => a.name).join(", ")}.`;
    } else if (!fineAreas.length && fixAreas.length) {
      tone = fixAreas.some((a) => a.tone === "warn") ? "warn" : "caution";
      verdict = `Focus next: ${fixAreas
        .slice(0, 2)
        .map((a) => a.fix)
        .join(". ")}.`;
    } else if (fineAreas.length && fixAreas.length) {
      tone = fixAreas.some((a) => a.tone === "warn") ? "warn" : "caution";
      verdict = `Fine: ${fineAreas.map((a) => a.name).join(", ")}. Next: ${fixAreas
        .slice(0, 2)
        .map((a) => a.fix)
        .join(". ")}.`;
    }
  }

  if (titleEl) titleEl.textContent = "How you’re tracking";
  if (metaEl) metaEl.textContent = `${dates.length} days · updated for ${date}`;
  verdictEl.textContent = verdict;
  verdictEl.className = `progress-brief-verdict tone-${tone}`;
  chipsEl.innerHTML = chips
    .map(
      (c) =>
        `<div class="progress-brief-chip tone-${c.tone}"><span>${escapeHtml(c.label)}</span><strong>${escapeHtml(
          c.value
        )}</strong></div>`
    )
    .join("");
  pointsEl.innerHTML = points.map((p) => `<li>${escapeHtml(p)}</li>`).join("");
}

function renderStrengthAnalysis(data) {
  const root = $("chartStrength");
  if (!root) return;
  strengthCache = collectStrengthData(data);
  const { byLift, sessionDays } = strengthCache;
  const lifts = Object.entries(byLift).sort((a, b) => b[1].length - a[1].length);

  let totalVol = 0;
  let prCount = 0;
  lifts.forEach(([, pts]) => {
    pts.forEach((p) => {
      totalVol += p.volume || 0;
    });
    if (liftTrendLabel(pts).key === "up") prCount += 1;
  });

  if ($("strengthKpis")) {
    $("strengthKpis").innerHTML = `
      <div class="chart-kpi"><span>Lift sessions</span><strong>${sessionDays}</strong></div>
      <div class="chart-kpi"><span>Lifts tracked</span><strong>${lifts.length}</strong></div>
      <div class="chart-kpi"><span>Total volume</span><strong>${totalVol ? Math.round(totalVol).toLocaleString() : "—"}</strong></div>
      <div class="chart-kpi"><span>Trending up</span><strong>${prCount}</strong></div>`;
  }
  if ($("strengthMeta")) $("strengthMeta").textContent = lifts.length ? `Charts for all ${lifts.length} lifts` : "";

  const tbody = $("strengthTableBody");
  if (tbody) {
    tbody.innerHTML = lifts.length
      ? lifts
          .map(([name, pts]) => {
            const last = pts[pts.length - 1];
            const trend = liftTrendLabel(pts);
            const bestW = pts.reduce((m, p) => (p.bestWeight != null && (m == null || p.bestWeight > m) ? p.bestWeight : m), null);
            const bestE = pts.reduce((m, p) => (p.bestE1rm != null && (m == null || p.bestE1rm > m) ? p.bestE1rm : m), null);
            const volDelta =
              pts.length >= 2 && pts[0].volume ? pts[pts.length - 1].volume - pts[0].volume : null;
            const deltaTxt =
              volDelta == null ? "—" : `${volDelta > 0 ? "+" : ""}${Math.round(volDelta)}`;
            return `<tr>
              <td>${escapeHtml(name)}</td>
              <td>${
                last?.bestSetLabel
                  ? `${escapeHtml(last.bestSetLabel)}<div class="hint quiet">${escapeHtml(formatShortLogDate(last.date))}</div>`
                  : "—"
              }</td>
              <td>${bestW != null ? bestW.toFixed(1) + " kg" : "—"}</td>
              <td>${bestE != null ? bestE.toFixed(1) + " kg" : "—"}</td>
              <td>${deltaTxt}</td>
              <td><span class="lift-trend ${trend.cls}">${trend.label}</span></td>
            </tr>`;
          })
          .join("")
      : `<tr><td colspan="6">No lift data yet</td></tr>`;
  }

  paintStrengthCharts(lifts);
}

function paintStrengthCharts(allLifts) {
  const root = $("chartStrength");
  if (!root) return;
  const metric = strengthMetric;
  const label =
    metric === "bestWeight" ? "Best set weight (kg)" : metric === "e1rm" ? "Est. 1RM (kg)" : "Session volume (kg×reps)";
  if (!allLifts.length) {
    root.innerHTML = `<p class="chart-empty">Log workout sets with weight and reps to see strength trends.</p>`;
    return;
  }
  root.innerHTML = allLifts
    .map(([name, pts], idx) => {
      const series = pts
        .map((p) => {
          const value =
            metric === "bestWeight" ? p.bestWeight : metric === "e1rm" ? p.bestE1rm : p.volume;
          return value != null ? { date: p.date, value } : null;
        })
        .filter(Boolean);
      const last = pts[pts.length - 1];
      const trend = liftTrendLabel(pts);
      const delta =
        series.length >= 2 ? series[series.length - 1].value - series[0].value : null;
      const meta = [
        `${pts.length} sessions`,
        last?.bestSetLabel ? `last ${last.bestSetLabel}` : null,
        trend.label,
        delta != null ? `Δ ${delta > 0 ? "+" : ""}${delta.toFixed(metric === "volume" ? 0 : 1)}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      const open = idx < 4 || trend.key !== "flat" ? " open" : "";
      return `<details class="lift-block"${open}>
        <summary>
          <h3>${escapeHtml(name)}</h3>
          <p class="hint">${escapeHtml(meta)}</p>
          <span class="lift-open">${open ? "Hide" : "Chart"}</span>
        </summary>
        <p class="hint quiet">${escapeHtml(label)}</p>
        <div class="chart-wrap">${
          series.length
            ? svgSingleLine(series, { color: "#0c5c4f", height: 120 })
            : `<p class="chart-empty">No ${escapeHtml(metric)} points yet</p>`
        }</div>
      </details>`;
    })
    .join("");

  root.querySelectorAll("details.lift-block").forEach((det) => {
    const tag = det.querySelector(".lift-open");
    det.addEventListener("toggle", () => {
      if (tag) tag.textContent = det.open ? "Hide" : "Chart";
    });
  });
}

async function renderProgressCharts(data) {
  const rootKpi = $("chartKpis");
  if (!rootKpi) return;

  const dates = sortedDates(data);
  const weighIns = dates
    .filter((d) => typeof data[d].weight === "number")
    .map((d) => ({ date: d, value: data[d].weight }));
  const avg7Series = rollingAvg(weighIns, 7);
  const avg7 = avg7Series.length ? avg7Series[avg7Series.length - 1].value : null;
  let delta14 = null;
  if (weighIns.length >= 2) {
    const last = weighIns[weighIns.length - 1];
    const target = CutDBHelpers.addDaysISO(last.date, -13);
    let earlier = weighIns[0];
    for (const w of weighIns) {
      if (w.date <= target) earlier = w;
    }
    delta14 = last.value - earlier.value;
  }

  const phases = await CutDB.allPhases();
  const diets = {};
  for (const p of phases) diets[p.id] = await CutDB.getDietForPhase(p.id);

  let mealDays = 0;
  let mealSum = 0;
  dates.forEach((d) => {
    const e = data[d];
    const phase = phases.find((p) => CutDBHelpers.phaseCoversDate(p, d));
    const diet = phase ? diets[phase.id] : null;
    if (!diet) return;
    const block = e.trained ? diet.training : diet.rest;
    const planned = (block?.meals || []).length;
    if (!planned) return;
    const done = (block.meals || []).filter((m) => (e.mealChecks || {})[m.id]).length;
    mealDays += 1;
    mealSum += done / planned;
  });
  const adherencePct = mealDays ? Math.round((mealSum / mealDays) * 100) : null;
  const liftDaysLogged = dates.filter((d) => dayHasLoggedWeights(data[d])).length;

  renderProgressBrief(data, { adherencePct });

  rootKpi.innerHTML = `
    <div class="chart-kpi"><span>Weigh-ins</span><strong>${weighIns.length}</strong></div>
    <div class="chart-kpi"><span>7-day avg</span><strong>${avg7 != null ? avg7.toFixed(1) + " kg" : "—"}</strong></div>
    <div class="chart-kpi"><span>~14d Δ</span><strong>${formatDelta(delta14)}</strong></div>
    <div class="chart-kpi"><span>Meal adherence</span><strong>${adherencePct != null ? adherencePct + "%" : "—"}</strong></div>
    <div class="chart-kpi"><span>Lift days</span><strong>${liftDaysLogged}</strong></div>`;
  if ($("chartsMeta")) $("chartsMeta").textContent = `${dates.length} days logged`;

  await renderTargetsVsReality(data);
  renderProgressFlags(data);

  $("chartWeight").innerHTML = weighIns.length
    ? svgDualLine(weighIns, avg7Series, { yLabel: "Weight kg" })
    : `<p class="chart-empty">Log morning weights to see the trend.</p>`;

  const phaseHtml = phases
    .slice()
    .sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)))
    .map((p) => {
      const w1 = phaseWeekAvg(data, p.startDate, CutDBHelpers.addDaysISO(p.startDate, 6));
      const w2 = phaseWeekAvg(
        data,
        CutDBHelpers.addDaysISO(p.startDate, 7),
        p.endDate || CutDBHelpers.twoWeekEnd(p.startDate)
      );
      const firstLast = weighIns.filter((w) => w.date >= p.startDate && w.date <= (p.endDate || p.startDate));
      let delta = null;
      let label = "";
      if (w1.avg != null && w2.avg != null) {
        delta = w2.avg - w1.avg;
        label = `W1 ${w1.avg.toFixed(1)} → W2 ${w2.avg.toFixed(1)}`;
      } else if (firstLast.length >= 2) {
        delta = firstLast[firstLast.length - 1].value - firstLast[0].value;
        label = `First ${firstLast[0].value.toFixed(1)} → last ${firstLast[firstLast.length - 1].value.toFixed(1)}`;
      } else {
        label = "Not enough weigh-ins";
      }
      const a = w1.avg ?? firstLast[0]?.value;
      const b = w2.avg ?? firstLast[firstLast.length - 1]?.value;
      return `<div class="phase-bar-row">
        <div class="top"><span>${escapeHtml(p.name)}</span><span>${formatDelta(delta)}</span></div>
        <div class="phase-bar-track">
          <div title="Week 1">${a != null ? a.toFixed(1) : "—"}</div>
          <div class="w2" title="Week 2">${b != null ? b.toFixed(1) : "—"}</div>
        </div>
        <div class="meta">${escapeHtml(label)} · ${p.startDate} → ${p.endDate || "—"}</div>
      </div>`;
    })
    .join("");
  $("chartPhases").innerHTML = phaseHtml || `<p class="chart-empty">Create a phase to compare weeks.</p>`;

  const bfPts = dates
    .map((d) => {
      const v = data[d].measurements?.bodyFatPct;
      return typeof v === "number" ? { date: d, value: v } : null;
    })
    .filter(Boolean);
  $("chartBodyFat").innerHTML = bfPts.length
    ? svgSingleLine(bfPts, { color: "#b45309" })
    : `<p class="chart-empty">Log body fat % in morning composition.</p>`;

  const waistPts = dates
    .map((d) => {
      const w = data[d].measurements?.waist ?? data[d].waist;
      return typeof w === "number" ? { date: d, value: w } : null;
    })
    .filter(Boolean);
  $("chartWaist").innerHTML = waistPts.length
    ? svgSingleLine(waistPts, { color: "#9a4c1e" })
    : `<p class="chart-empty">Log waist in morning measurements.</p>`;

  const adherePts = [];
  dates.forEach((d) => {
    const e = data[d];
    const phase = phases.find((p) => CutDBHelpers.phaseCoversDate(p, d));
    const diet = phase ? diets[phase.id] : null;
    if (!diet) return;
    const block = e.trained ? diet.training : diet.rest;
    const planned = (block?.meals || []).length;
    if (!planned) return;
    const done = (block.meals || []).filter((m) => (e.mealChecks || {})[m.id]).length;
    adherePts.push({ date: d, value: Math.round((done / planned) * 100), done, planned });
  });
  const recentAdhere = adherePts.slice(-28);
  if (!recentAdhere.length) {
    $("chartAdherence").innerHTML = `<p class="chart-empty">Check meals on Today to track adherence.</p>`;
    if ($("adherenceLegend")) $("adherenceLegend").textContent = "";
  } else {
    const barW = Math.max(320, recentAdhere.length * 14 + 40);
    const step = (barW - 40) / recentAdhere.length;
    const bars = recentAdhere
      .map((p, i) => {
        const x = 30 + i * step;
        const bw = Math.max(6, step - 3);
        const h = (p.value / 100) * 100;
        return `<rect x="${x}" y="${110 - h}" width="${bw}" height="${h}" rx="3" fill="#0f6b5c" opacity="0.85"><title>${p.date}: ${p.done}/${p.planned} (${p.value}%)</title></rect>`;
      })
      .join("");
    $("chartAdherence").innerHTML = `<svg viewBox="0 0 ${barW} 130" role="img">${bars}
      <text x="4" y="14" font-size="10" fill="#5c6b64">100%</text>
      <text x="4" y="110" font-size="10" fill="#5c6b64">0%</text>
    </svg>`;
    if ($("adherenceLegend")) {
      $("adherenceLegend").textContent =
        adherencePct != null ? `Overall average while logging meals: ${adherencePct}%` : "";
    }
  }

  const today = $("logDate")?.value || CutDBHelpers.todayISO();
  const gridStart = CutDBHelpers.addDaysISO(today, -41);
  const heads = ["M", "T", "W", "T", "F", "S", "S"];
  let grid = heads.map((h) => `<div class="train-cell head">${h}</div>`).join("");
  const startDow = (new Date(gridStart + "T12:00:00").getDay() + 6) % 7;
  for (let i = 0; i < startDow; i++) grid += `<div class="train-cell" style="visibility:hidden"></div>`;
  let liftCount = 0;
  let otherLogCount = 0;
  for (let i = 0; i < 42; i++) {
    const d = CutDBHelpers.addDaysISO(gridStart, i);
    const e = data[d];
    let cls = "train-cell";
    let title = d;
    if (e) {
      if (dayHasLoggedWeights(e)) {
        cls += " train";
        title += " · lifts logged";
        liftCount += 1;
      } else {
        cls += " rest";
        title += " · logged, no lifts";
        otherLogCount += 1;
      }
    } else {
      title += " · no log";
    }
    grid += `<div class="${cls}" title="${title}">${d.slice(8)}</div>`;
  }
  $("chartTrainGrid").innerHTML = grid;
  if ($("trainGridLegend")) {
    $("trainGridLegend").textContent = `${liftCount} lift days · ${otherLogCount} other logged days · in this 42-day window`;
  }

  renderStrengthAnalysis(data);

  const buckets = {};
  dates.forEach((d) => {
    const k = weekKey(d);
    (buckets[k] ||= []).push(data[d]);
  });
  const weekKeys = Object.keys(buckets).sort().slice(-8);
  const metricDefs = [
    { key: "steps", label: "Steps", fmt: (v) => Math.round(v).toLocaleString() },
    { key: "sleep", label: "Sleep (h)", fmt: (v) => v.toFixed(1) },
    { key: "hunger", label: "Hunger", fmt: (v) => v.toFixed(1) },
    { key: "energy", label: "Energy", fmt: (v) => v.toFixed(1) },
    { key: "coffees", label: "Coffee", fmt: (v) => v.toFixed(1) },
  ];
  $("chartWeekly").innerHTML = weekKeys.length
    ? `<div class="weekly-grid">${metricDefs
        .map((m) => {
          const rows = weekKeys.map((k) => {
            const vals = buckets[k].map((e) => e[m.key]).filter((x) => typeof x === "number");
            return { week: k, avg: vals.length ? mean(vals) : null };
          });
          const max = Math.max(...rows.map((r) => r.avg || 0), 0.0001);
          return `<div class="weekly-block"><h3>${m.label}</h3>${rows
            .map((r) => {
              const pct = r.avg != null ? (r.avg / max) * 100 : 0;
              return `<div class="bar-row"><span>${r.week.slice(5)}</span>
                <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
                <span class="bar-val">${r.avg != null ? m.fmt(r.avg) : "—"}</span></div>`;
            })
            .join("")}</div>`;
        })
        .join("")}</div>`
    : `<p class="chart-empty">Log wrap fields to build weekly averages.</p>`;

  const photos = await CutDB.allPhotos();
  const strip = $("chartPhotoStrip");
  if (!strip) return;
  if (!photos.length) {
    strip.innerHTML = `<p class="chart-empty">Add phase-start photos under Phases.</p>`;
  } else {
    strip.innerHTML = "";
    const ordered = photos
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
    for (const p of ordered) {
      try {
        const url = await photoObjectUrl(p);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "photo-strip-item";
        const time = photoTimeLabel(p);
        btn.innerHTML = `<img src="${url}" alt="" /><span>${escapeHtml(p.date)}${
          time ? ` · ${escapeHtml(time)}` : ""
        }</span>`;
        btn.onclick = () => {
          activePhotoId = p.id;
          $("photoDialogImg").src = url;
          $("photoDialog").showModal();
        };
        strip.appendChild(btn);
      } catch (_) {
        /* skip unreadable photos in strip */
      }
    }
  }
}

async function refreshAll(opts = {}) {
  const tab =
    opts.tab ||
    document.querySelector(".nav-item.active")?.dataset.tab ||
    document.querySelector(".tab.active")?.dataset.tab ||
    "today";
  const date = $("logDate").value || CutDBHelpers.todayISO();
  await loadContextForDate(date);
  const data = await CutDB.allDays();
  await refreshHeader(data, date);
  const entry = data[date];
  const backup = backupReminderState(data);
  if (tab === "today") {
    await maybeResetShoppingListsFriday();
    await renderTodaySetup(date);
    const view = viewEntry(entry, date);
    if ($("trainedSelect") && !dayLooksTouched(entry)) {
      $("trainedSelect").value = view.trained ? "train" : "rest";
    }
    renderMealCards(entry?.mealChecks || {}, entry?.swapPicks || {});
    syncTrainedUI();
    await renderWorkoutUI(entry?.workout || null);
    lastHasStartPhoto = cachedPhase
      ? (await CutDB.photosForPhaseStart(cachedPhase)).length > 0
      : true;
    updateJourneyStatus(view);
    applyTodayDueOverrides(backup, date);
    renderPhaseRun(data, date);
    await renderPhaseEndCard(date, data, backup);
    renderHabitNudges(view, backup);
    await renderTodayInsightCard(date);
    if ($("insightCard")) $("insightCard").hidden = !cachedPhase;
  }
  if (tab === "photos") {
    await renderPhotos(true);
    await renderPhotoCompare();
  }
  if (tab === "analysis") {
    await renderProgressCharts(data);
    await renderAnalyses();
    void maybeRunCompletedPhaseInsights();
  }
  if (tab === "data" || tab === "more") {
    renderBackupStamp(backup);
    fillOpenRouterForm();
    await refreshStorageHealth();
  }
  if (tab === "phases" || tab === "more") await renderPhaseList();
  if (tab === "phases") await fillPhaseEditor();
  if (tab === "diet") {
    await fillPhaseSelects();
    await loadDietEditor();
  }
  if (tab === "swaps") {
    await fillPhaseSelects();
    await loadSwapsPanel();
  }
  if (tab === "prep") {
    markPrepSeen();
    await fillPhaseSelects();
    await loadPrepPanel();
  }
  if (tab === "shopping") {
    markShoppingSeen();
    await maybeResetShoppingListsFriday();
    await fillPhaseSelects();
    await loadShoppingPanel();
  }
  if (tab === "rescue") {
    await fillPhaseSelects();
    await loadFoodRescuePanel();
  }
  if (tab === "training") {
    await fillPhaseSelects();
    await loadTrainEditor();
  }
}

function goToTab(tab) {
  const bottomTabs = new Set(["today", "rescue", "analysis", "photos", "more"]);
  const navHighlight = bottomTabs.has(tab) ? tab : "more";
  document.querySelectorAll(".nav-item").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === navHighlight);
  });
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  const panel = $(`panel-${tab}`);
  if (panel) panel.classList.add("active");
  window.scrollTo({ top: 0, behavior: "smooth" });
  const done = refreshAll({ tab });
  if (tab === "analysis") {
    focusProgressSection(activeProgressSection || "overview", { scroll: false });
  }
  return done;
}

function initTabs() {
  document.querySelectorAll(".nav-item, .more-link, .more-back, .tab").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const tab = btn.dataset.tab;
      if (!tab) return;
      if (btn.dataset.trainView) trainViewMode = btn.dataset.trainView;
      await goToTab(tab);
      if (btn.dataset.analysisTools) {
        focusProgressSection("ai", { scroll: true });
      }
    });
  });
  $("nextActionBtn")?.addEventListener("click", () => {
    jumpToStep($("nextActionBtn").dataset.jump || "morning");
  });
  document.querySelectorAll("[data-progress-jump]").forEach((btn) => {
    btn.addEventListener("click", () => {
      focusProgressSection(btn.dataset.progressJump || "overview", { scroll: true });
    });
  });
  document.querySelectorAll("[data-strength-metric]").forEach((btn) => {
    btn.addEventListener("click", () => {
      strengthMetric = btn.dataset.strengthMetric || "volume";
      document.querySelectorAll("[data-strength-metric]").forEach((b) => b.classList.toggle("active", b === btn));
      if (!strengthCache) return;
      const all = Object.entries(strengthCache.byLift).sort((a, b) => b[1].length - a[1].length);
      paintStrengthCharts(all);
    });
  });

  $("nudgeDismissBtn")?.addEventListener("click", () => {
    savePrefs({ nudgeDismissDate: CutDBHelpers.todayISO() });
    if ($("nudgeCard")) $("nudgeCard").hidden = true;
  });
  $("compareBefore")?.addEventListener("change", paintCompareStage);
  $("compareAfter")?.addEventListener("change", paintCompareStage);
  $("refreshStorageBtn")?.addEventListener("click", async () => {
    await refreshStorageHealth();
    showToast("Storage refreshed");
  });
  $("recompressBtn")?.addEventListener("click", async () => {
    if (!confirm("Recompress photos older than 14 days? This shrinks files and cannot be undone except via backup.")) return;
    showToast("Recompressing…");
    const r = await CutDB.recompressOlderPhotos();
    await refreshStorageHealth();
    showToast(`Recompressed ${r.touched} photos · freed ${formatBytes(r.savedBytes)}`);
  });
}

async function initApp() {
  applyBrand();
  buildMeasureFields();
  wirePhasePackButtons();
  fillOpenRouterForm();
  initTabs();
  $("actionProgressCancel")?.addEventListener("click", () => cancelActionProgress());
  const date = CutDBHelpers.todayISO();
  $("logDate").value = date;
  await loadContextForDate(date);
  fillForm((await CutDB.getDay(date)) || null, date);

  $("logDate").addEventListener("change", async () => {
    const d = $("logDate").value;
    await loadContextForDate(d);
    fillForm((await CutDB.getDay(d)) || null, d);
    await refreshAll();
  });

  $("trainedSelect")?.addEventListener("change", async () => {
    syncTrainedUI();
    const d = $("logDate").value;
    const saved = await CutDB.getDay(d);
    await savePartial({ trained: $("trainedSelect").value === "train" }, "Day type saved", { quiet: true });
    renderMealCards(saved?.mealChecks || {}, saved?.swapPicks || {});
    await renderWorkoutUI(saved?.workout || null);
  });

  $("sessionSelect")?.addEventListener("change", async () => {
    const sessionId = $("sessionSelect")?.value || "";
    await renderWorkoutUI({ sessionId, exercises: [] });
    await savePartial({ trained: true, workout: readWorkoutLog() }, "Session selected", { quiet: true });
  });

  document.querySelectorAll(".section-save").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const section = btn.dataset.save;
      const labels = {
        morning: "Morning saved",
        coffee: "Coffee saved",
        meals: "Meals saved",
        workout: "Workout saved",
        wrap: "Evening wrap saved",
      };
      await savePartial(patchFromSection(section), labels[section] || "Saved");
      if (section === "morning") {
        await refreshAll();
        const measures = document.querySelector("details.measures");
        if (measures) measures.open = false;
      }
      if (section === "workout") {
        document.querySelectorAll("#workoutLog .ex-block").forEach((block) => {
          const filled = [...block.querySelectorAll(".set-w, .set-r")].some((el) =>
            String(el.value || "").trim()
          );
          markExerciseBlockDone(block, filled);
        });
      }
      if (section === "wrap") {
        const date = $("logDate").value || CutDBHelpers.todayISO();
        await renderTodayInsightCard(date);
        if ($("insightCard")) $("insightCard").hidden = !cachedPhase;
        jumpToInsight();
        void maybeRunCompletedPhaseInsights();
      }
    });
  });

  $("coffeePlus")?.addEventListener("click", async () => {
    const next = (parseNum($("coffees").value) || 0) + 1;
    setCoffeeDisplay(next);
    await savePartial({ coffees: next }, `Coffee ${next}`, { quiet: true });
  });
  $("coffeeMinus")?.addEventListener("click", async () => {
    const next = Math.max(0, (parseNum($("coffees").value) || 0) - 1);
    setCoffeeDisplay(next);
    await savePartial({ coffees: next }, `Coffee ${next}`, { quiet: true });
  });

  $("loadTodayBtn").addEventListener("click", async () => {
    const d = CutDBHelpers.todayISO();
    fillForm((await CutDB.getDay(d)) || null, d);
    await refreshAll();
  });

  $("newPhaseBtn").addEventListener("click", async () => {
    await enterCreatePhaseMode();
    $("phaseStart")?.focus();
  });
  $("phaseEndCreateBtn")?.addEventListener("click", () => {
    void openPhasesToCreate();
  });
  $("cancelPhaseBtn")?.addEventListener("click", async () => {
    phaseCreateMode = false;
    if (!selectedPhaseId) {
      const phases = await CutDB.allPhases();
      selectedPhaseId = phases.find((p) => p.active)?.id || phases[0]?.id || null;
    }
    await fillPhaseEditor();
    await renderPhaseList();
  });
  $("phaseStart").addEventListener("change", () => {
    const r = CutDBHelpers.ensureTwoWeekRange($("phaseStart").value || CutDBHelpers.todayISO());
    $("phaseStart").value = r.startDate;
    $("phaseEnd").value = r.endDate;
  });
  $("savePhaseBtn").addEventListener("click", async () => {
    const creating = phaseCreateMode || !$("editPhaseId").value;
    const name = ($("phaseName").value.trim() || "").replace(/\D+/g, "") || null;
    const r = CutDBHelpers.ensureTwoWeekRange($("phaseStart").value || CutDBHelpers.todayISO());
    const notes = $("phaseNotes").value.trim();
    const goalPct = parseNum($("phaseGoalLossPct")?.value);
    const goalLossPctPerWeek =
      goalPct != null && goalPct > 0 ? goalPct : Number(cfg().goalLossPctPerWeek) || 0.75;
    const tdRaw = Number($("phaseTrainDays")?.value);
    const trainingDaysPerWeek = Number.isFinite(tdRaw)
      ? Math.max(0, Math.min(7, Math.round(tdRaw)))
      : 4;

    if (creating) {
      let pack = null;
      try {
        pack = readPhasePackFromForm();
      } catch (err) {
        showToast(err.message);
        setPhasePackStatus(err.message);
        return;
      }
      await withActionProgress(
        pack ? "Creating phase from pack…" : "Creating phase…",
        async (report) => {
          report(20);
          let phase;
          if (pack) {
            // Form fields win over pack for goal / days / notes when the user edited them after Load.
            const formNotes = notes;
            const merged = {
              ...pack,
              goalLossPctPerWeek,
              trainingDaysPerWeek,
              notes: formNotes || pack.notes || "",
            };
            const result = await CutDB.createPhaseFromPack(merged, { startDate: r.startDate });
            phase = result.phase;
            report(75, "Pack applied…");
          } else {
            phase = await CutDB.createPhase({
              name,
              startDate: r.startDate,
              notes,
              goalLossPctPerWeek,
              trainingDaysPerWeek,
            });
            report(70);
          }
          selectedPhaseId = phase.id;
          phaseCreateMode = false;
          pendingPhasePack = null;
          if ($("phasePackText")) $("phasePackText").value = "";
          await refreshAll({ tab: "phases" });
          report(100);
        },
        {
          doneMessage: pack
            ? "Phase created — add the start photo"
            : "Phase created — add the start photo",
        }
      );
      focusPhaseStartPhoto();
      return;
    }

    const id = $("editPhaseId").value;
    const p = await CutDB.getPhase(id);
    if (!p) return;
    await withActionProgress(
      "Saving phase…",
      async (report) => {
        report(20);
        const trainDaysChanged = p.trainingDaysPerWeek !== trainingDaysPerWeek;
        // Keep auto number — do not rename from free text
        p.startDate = r.startDate;
        p.endDate = r.endDate;
        p.notes = notes;
        p.goalLossPctPerWeek = goalLossPctPerWeek;
        p.trainingDaysPerWeek = trainingDaysPerWeek;
        report(45);
        await CutDB.savePhase(p);
        // Keep diet/train labels in sync with phase number
        const diet = await CutDB.getDietForPhase(p.id);
        if (diet && diet.name !== p.name) {
          diet.name = p.name;
          await CutDB.saveDietPlan(diet);
        }
        const train = await CutDB.getTrainingForPhase(p.id);
        if (train && train.name !== p.name) {
          train.name = p.name;
          await CutDB.saveTrainingPlan(train);
        }
        if (trainDaysChanged && diet?.shoppingList) await flagShoppingRefresh(diet);
        report(65);
        for (const photo of await CutDB.photosForPhase(p.id)) {
          if (photo.date !== p.startDate) {
            photo.date = p.startDate;
            await CutDB.savePhoto(photo);
          }
        }
        report(85);
        selectedPhaseId = p.id;
        await refreshAll();
        report(100);
      },
      { doneMessage: "Phase saved" }
    );
  });
  $("deletePhaseBtn").addEventListener("click", async () => {
    const id = $("editPhaseId").value;
    if (!id || !confirm("Remove this phase and its diet + training plans?")) return;
    await withActionProgress(
      "Removing phase…",
      async (report) => {
        report(40);
        await CutDB.deletePhase(id);
        selectedPhaseId = null;
        phaseCreateMode = false;
        report(80);
        await refreshAll({ tab: "phases" });
        report(100);
      },
      { doneMessage: "Phase removed" }
    );
  });

  $("dietPhaseSelect").addEventListener("change", loadDietEditor);
  $("prepPhaseSelect")?.addEventListener("change", loadPrepPanel);
  $("phaseRefreshPackBtn")?.addEventListener("click", () => {
    void refreshCurrentPhaseFromShippedPack();
  });
  $("prepShopBtn")?.addEventListener("click", () => jumpToStep("shopping"));
  $("prepDownloadBtn")?.addEventListener("click", async () => {
    const phaseId = $("prepPhaseSelect")?.value || selectedPhaseId;
    const diet = phaseId ? await CutDB.getDietForPhase(phaseId) : null;
    if (!diet) {
      showToast("No diet on this phase");
      return;
    }
    downloadJson(`meal-prep-${CutDBHelpers.todayISO()}.json`, prepSkeletonFromDiet(diet));
  });
  $("prepFile")?.addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const phaseId = $("prepPhaseSelect")?.value || selectedPhaseId;
    if (!phaseId) return;
    try {
      const raw = JSON.parse(await f.text());
      await withActionProgress(
        "Saving recipes…",
        async (report) => {
          report(25);
          const diet = await CutDB.getDietForPhase(phaseId);
          if (!diet) throw new Error("No diet on this phase");
          patchDietRecipes(diet, extractPrepPayload(raw));
          report(70);
          await CutDB.saveDietPlan(diet);
          if (cachedDiet?.id === diet.id) cachedDiet = diet;
          await loadPrepPanel();
          report(100);
        },
        { doneMessage: "Recipes saved on this phase" }
      );
    } catch (err) {
      alert(err.message || String(err));
    }
  });
  $("shopPhaseSelect")?.addEventListener("change", loadShoppingPanel);
  $("shopRegenBtn")?.addEventListener("click", async () => {
    const phaseId = $("shopPhaseSelect")?.value;
    if (!phaseId) return;
    const diet = await CutDB.getDietForPhase(phaseId);
    if (!diet) {
      showToast("Save a diet plan first");
      return;
    }
    await generateShoppingListForDiet(diet);
    await loadShoppingPanel();
  });
  $("shopAddItemBtn")?.addEventListener("click", async () => {
    const phaseId = $("shopPhaseSelect")?.value;
    if (!phaseId) return;
    const diet = await CutDB.getDietForPhase(phaseId);
    if (!diet) {
      showToast("Save a diet plan first");
      return;
    }
    if (!diet.shoppingList) {
      diet.shoppingList = {
        weekKey: CutDBHelpers.shoppingWeekFriday(),
        generatedAt: new Date().toISOString(),
        version: SHOPPING_LIST_VERSION,
        status: "ready",
        needsRefresh: false,
        items: [],
      };
    }
    diet.shoppingList.items = diet.shoppingList.items || [];
    diet.shoppingList.items.push({
      id: CutDBHelpers.uid("shop"),
      name: "New item",
      amount: "",
      category: "Other",
      done: false,
      custom: true,
      hint: "custom",
    });
    await CutDB.saveDietPlan(diet);
    if (cachedDiet?.id === diet.id) cachedDiet.shoppingList = diet.shoppingList;
    await loadShoppingPanel();
    const inputs = $("shopList")?.querySelectorAll(".shop-item-name-input");
    const lastName = inputs?.[inputs.length - 1];
    lastName?.focus();
    lastName?.select();
  });
  $("shopUncheckBtn")?.addEventListener("click", async () => {
    const phaseId = $("shopPhaseSelect")?.value;
    if (!phaseId) return;
    const diet = await CutDB.getDietForPhase(phaseId);
    if (!diet?.shoppingList?.items?.length) return;
    await withActionProgress(
      "Resetting checks…",
      async (report) => {
        report(40);
        diet.shoppingList.items = diet.shoppingList.items.map((it) => ({ ...it, done: false }));
        await CutDB.saveDietPlan(diet);
        report(80);
        await loadShoppingPanel();
        report(100);
      },
      { doneMessage: "All unchecked" }
    );
  });
  $("rescuePhaseSelect")?.addEventListener("change", loadFoodRescuePanel);
  $("trainPhaseSelect").addEventListener("change", loadTrainEditor);
  document.querySelectorAll("#trainViewSwitch [data-train-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (cachedTrain && trainViewMode === "sessions") collectTrainFromEditor();
      trainViewMode = btn.dataset.trainView;
      applyTrainView();
    });
  });
  document.querySelectorAll("[data-diet-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (cachedDiet) collectDietFromEditor();
      document.querySelectorAll("[data-diet-view]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      dietViewMode = btn.dataset.dietView;
      renderDietTargetsAndMeals();
    });
  });
  $("swapPhaseSelect")?.addEventListener("change", loadSwapsPanel);
  $("swapAddGroupBtn")?.addEventListener("click", async () => {
    const phaseId = $("swapPhaseSelect")?.value;
    if (!phaseId) {
      showToast("Pick a phase first");
      return;
    }
    const diet = await CutDB.getDietForPhase(phaseId);
    if (!diet) {
      showToast("Save a diet plan first");
      return;
    }
    const root = $("swapList");
    const cur = root?.querySelector(".swap-cat") ? readSwapsFromRoot(root) : [...(diet.foodSwaps || [])];
    cur.push({
      id: CutDBHelpers.uid("swap"),
      label: "Swap",
      options: ["", ""],
    });
    await persistDietFoodSwaps(phaseId, cur);
    await loadSwapsPanel();
    const inputs = $("swapList")?.querySelectorAll(".swap-opt-input");
    const last = inputs?.[inputs.length - 1];
    last?.focus();
  });
  $("saveDietBtn").addEventListener("click", async () => {
    const phaseId = $("dietPhaseSelect").value;
    if (!phaseId) return;
    await withActionProgress(
      "Saving diet…",
      async (report) => {
        report(15);
        if (!cachedDiet) {
          cachedDiet = {
            id: CutDBHelpers.uid("diet"),
            phaseId,
            createdAt: new Date().toISOString(),
            foodSwaps: [],
            foodRescueChat: [],
            ...CutDBHelpers.emptyDietContent(),
          };
        }
        collectDietFromEditor();
        cachedDiet.phaseId = phaseId;
        report(40);
        await CutDB.saveDietPlan(cachedDiet);
        await flagShoppingRefresh(cachedDiet);
        report(90);
        await refreshAll();
        report(100);
      },
      { doneMessage: "Diet saved (this phone only)" }
    );
  });
  $("foodRescueAskBtn")?.addEventListener("click", () => askFoodRescue());
  $("mealRescueAskBtn")?.addEventListener("click", () => askFoodRescue({ fromSheet: true }));
  $("mealRescueCloseBtn")?.addEventListener("click", () => $("mealRescueDialog")?.close());
  $("mealRescueOpenFull")?.addEventListener("click", () => openFullRescueFromMeal());
  $("foodRescueClearBtn")?.addEventListener("click", async () => {
    const { diet } = await getRescueDietContext();
    if (!diet) return;
    if (!confirm("Clear food rescue chat for this diet?")) return;
    await withActionProgress(
      "Clearing chat…",
      async (report) => {
        report(40);
        diet.foodRescueChat = [];
        await CutDB.saveDietPlan(diet);
        if (cachedDiet?.id === diet.id) cachedDiet.foodRescueChat = [];
        renderFoodRescueChat([]);
        if ($("foodRescueStatus")) $("foodRescueStatus").textContent = "Chat cleared.";
        report(100);
      },
      { doneMessage: "Chat cleared" }
    );
  });
  $("addSessionBtn").addEventListener("click", () => {
    const phaseId = $("trainPhaseSelect").value;
    if (!cachedTrain) {
      cachedTrain = {
        id: CutDBHelpers.uid("train"),
        phaseId,
        name: $("trainName")?.value || "1",
        notes: "",
        restBetweenSetsSec: parseNum($("trainRestSets")?.value) ?? 90,
        restBetweenExercisesSec: parseNum($("trainRestEx")?.value) ?? 120,
        sessions: [],
        createdAt: new Date().toISOString(),
      };
    }
    collectTrainFromEditor();
    const n = cachedTrain.sessions.length + 1;
    const newId = CutDBHelpers.uid("session");
    cachedTrain.sessions.push({
      id: newId,
      name: n === 1 ? "Legs" : n === 2 ? "Arms" : `Session ${n}`,
      recommendedWeekday: null,
      proposedTime: "",
      exercises: [],
    });
    openTrainSessionId = newId;
    renderTrainEditor();
  });
  $("saveTrainBtn").addEventListener("click", async () => {
    const phaseId = $("trainPhaseSelect").value;
    if (!phaseId) return;
    await withActionProgress(
      "Saving training…",
      async (report) => {
        report(25);
        if (!cachedTrain) {
          cachedTrain = {
            id: CutDBHelpers.uid("train"),
            phaseId,
            createdAt: new Date().toISOString(),
            sessions: [],
          };
        }
        collectTrainFromEditor();
        cachedTrain.phaseId = phaseId;
        const phase = await CutDB.getPhase(phaseId);
        if (phase?.name) cachedTrain.name = phase.name;
        // Normalize YouTube URLs on save
        cachedTrain.sessions = (cachedTrain.sessions || []).map((s, si) => ({
          ...s,
          name: (s.name || "").trim() || `Session ${si + 1}`,
          recommendedWeekday: CutDBHelpers.clampWeekday(s.recommendedWeekday),
          proposedTime: String(s.proposedTime || "").trim(),
          exercises: (s.exercises || []).map((e) => {
            const yt =
              CutDBHelpers.normalizeYoutubeUrl?.(e.youtubeUrl) ||
              CutDBHelpers.normalizeYoutubeUrl?.(e.notes) ||
              e.youtubeUrl ||
              "";
            return {
              ...e,
              youtubeUrl: yt,
              restBetweenSetsSec: e.restBetweenSetsSec != null ? Number(e.restBetweenSetsSec) : null,
              restAfterExerciseSec: e.restAfterExerciseSec != null ? Number(e.restAfterExerciseSec) : null,
            };
          }),
        }));
        report(55);
        await CutDB.saveTrainingPlan(cachedTrain);
        report(85);
        await refreshAll();
        report(100);
      },
      { doneMessage: "Training saved (this phone only)" }
    );
  });
  $("photoInput")?.addEventListener("change", async (e) => {
    const phaseId = $("editPhaseId")?.value || selectedPhaseId;
    if (!phaseId) {
      alert("Select a phase first (More → Phases).");
      e.target.value = "";
      return;
    }
    const phase = await CutDB.getPhase(phaseId);
    if (!phase?.startDate) {
      alert("Save the phase with a start date first.");
      e.target.value = "";
      return;
    }
    const files = [...(e.target.files || [])];
    e.target.value = "";
    if (!files.length) return;
    await withActionProgress(
      files.length > 1 ? `Saving ${files.length} photos…` : "Saving photo…",
      async (report) => {
        let saved = 0;
        const failed = [];
        for (let i = 0; i < files.length; i++) {
          report(10 + Math.round((i / files.length) * 70));
          try {
            await CutDB.addPhoto(phase.startDate, files[i], { phaseId: phase.id, kind: "phase-start" });
            saved += 1;
          } catch (err) {
            failed.push(files[i].name || `photo ${i + 1}`);
          }
        }
        report(85);
        await renderPhasePhotos();
        await refreshAll();
        report(100);
        if (!saved) throw new Error(failed.length ? `Could not save: ${failed.join(", ")}` : "No photos saved");
        if (failed.length) {
          showToast(`Saved ${saved}, failed ${failed.length}`);
        }
      },
      { doneMessage: "Phase-start photo saved" }
    );
  });

  $("purgePhotosBtn")?.addEventListener("click", async () => {
    if (!confirm("Delete all photos from the tracker? This does not delete files from your iPhone Photos app.")) return;
    const r = await withActionProgress(
      "Removing photos…",
      async (report) => {
        report(30);
        const result = await CutDB.purgeAllPhotos();
        report(80);
        await refreshAll();
        report(100);
        return result;
      },
      { doneMessage: false }
    );
    showToast(`Removed ${r.removed} · freed ${formatBytes(r.freed)}`);
  });

  function readAiFormPrefs() {
    const raw = $("aiProvider")?.value || "auto";
    const provider = ["auto", "gemini", "openrouter"].includes(raw) ? raw : "auto";
    return {
      aiProvider: provider,
      geminiApiKey: ($("geminiApiKey")?.value || "").trim(),
      geminiModel: $("geminiModel")?.value || DEFAULT_GEMINI_MODEL,
      openRouterKey: ($("openRouterKey")?.value || "").trim(),
      openRouterModel: $("openRouterModel")?.value || FAST_TEXT_MODEL,
      openRouterVisionModel: $("openRouterVisionModel")?.value || "inclusionai/ling-3.0-flash-vl:free",
      autoPhaseInsight: $("autoPhaseInsight") ? $("autoPhaseInsight").checked : true,
    };
  }

  $("aiProvider")?.addEventListener("change", () => {
    syncAiProviderPanels();
  });

  $("saveOpenRouterBtn")?.addEventListener("click", () => {
    const prefs = readAiFormPrefs();
    savePrefs(prefs);
    fillAiForm();
    const n = (prefs.geminiApiKey ? 1 : 0) + (prefs.openRouterKey ? 1 : 0);
    showToast(n ? `Saved ${n} AI key${n > 1 ? "s" : ""} on device` : "AI keys cleared");
  });
  $("clearOpenRouterBtn")?.addEventListener("click", () => {
    if ($("geminiApiKey")) $("geminiApiKey").value = "";
    if ($("openRouterKey")) $("openRouterKey").value = "";
    savePrefs({ geminiApiKey: "", openRouterKey: "" });
    fillAiForm();
    showToast("AI keys cleared");
  });
  $("testOpenRouterBtn")?.addEventListener("click", async () => {
    try {
      savePrefs(readAiFormPrefs());
      const mode = aiSettings().provider;
      await withActionProgress(
        mode === "auto" ? "Racing Gemini + OpenRouter…" : `Testing ${mode}…`,
        async (report) => {
          report(25);
          const reply = await aiChat({
            system: "Reply with exactly: OK",
            user: "ping",
            temperature: 0,
          });
          report(90);
          const winner = lastAiWinner || mode;
          $("openRouterStatus").textContent = `OK via ${winner} · ${String(reply).slice(0, 60)}`;
          report(100);
        },
        { doneMessage: lastAiWinner ? `AI works (${lastAiWinner})` : "AI works" }
      );
    } catch (err) {
      $("openRouterStatus").textContent = err.message || String(err);
      alert(err.message || String(err));
    }
  });

  $("scaleReportInput")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const status = $("scaleOcrStatus");
    const setStatus = (msg) => {
      if (status) status.textContent = msg;
    };
    try {
      await withActionProgress(
        "Scanning scale report…",
        async (report) => {
          setStatus("Compressing photo…");
          report(15);
          const blob = await Promise.race([
            CutDBHelpers.compressImage(file, 900, 0.55),
            new Promise((_, rej) =>
              setTimeout(() => rej(new Error("Image compress timed out — try a JPEG screenshot")), 15000)
            ),
          ]);
          const dataUrl = await CutDBHelpers.blobToDataUrl(blob);
          setStatus(`Sending to AI (${Math.round(dataUrl.length / 1024)} KB)…`);
          report(40, "Reading scale photo…");
          const raw = await aiChatWithVisionFallback({
            system: CutDBHelpers.AI_PROMPTS.scaleOcr,
            user: "Extract ONLY measured weight and body-composition values from this scale report screenshot. Ignore goals/targets/tape. Return JSON only, digits exactly as shown.",
            imageDataUrl: dataUrl,
            temperature: 0,
            timeoutMs: 45000,
          });
          setStatus("Parsing numbers…");
          report(80);
          const parsed = extractJsonBlock(raw);
          const filled = await applyScaleOcrResult(parsed);
          if (!filled) throw new Error("No composition numbers found — try a clearer full-screen screenshot");
          setStatus(`Filled ${filled} fields from photo — review, then Save morning.`);
          report(100);
        },
        { doneMessage: "Review & save morning", minVisibleMs: 400 }
      );
    } catch (err) {
      setStatus(err.message || String(err));
      alert(err.message || String(err));
    }
  });

  $("runDailyInsightBtn")?.addEventListener("click", async () => {
    const date = $("logDate")?.value || CutDBHelpers.todayISO();
    const day = await CutDB.getDay(date);
    if (day?.dailyInsightId && !confirm("Replace this date’s insight?")) return;
    try {
      await withActionProgress(
        "Getting daily insight…",
        async (report) => {
          report(25);
          await runDailyInsightForDate(date);
          report(100);
        },
        { doneMessage: "Daily insight ready", minVisibleMs: 300 }
      );
    } catch (err) {
      showToast(err.message || String(err));
    }
  });
  $("dlDailyInsightBtn")?.addEventListener("click", async () => {
    const date = $("logDate")?.value || CutDBHelpers.todayISO();
    try {
      const payload = await buildDailyInsightPayload(date);
      downloadJson(`daily-insight-${date}.json`, payload);
      showToast("Day JSON downloaded");
    } catch (err) {
      showToast(err.message || String(err));
    }
  });
  $("importDailyInsightBtn")?.addEventListener("click", async () => {
    const date = $("logDate")?.value || CutDBHelpers.todayISO();
    const text = ($("insightPaste")?.value || "").trim();
    try {
      await withActionProgress(
        "Saving insight…",
        async (report) => {
          report(40);
          await importDailyInsightReply(date, text);
          if ($("insightPaste")) $("insightPaste").value = "";
          report(100);
        },
        { doneMessage: "Insight saved" }
      );
    } catch (err) {
      showToast(err.message || String(err));
    }
  });
  $("insightFile")?.addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if ($("insightPaste")) $("insightPaste").value = await f.text();
    $("importDailyInsightBtn")?.click();
    e.target.value = "";
  });

  $("aiAnalyzeBtn")?.addEventListener("click", async () => {
    try {
      await withActionProgress(
        "AI analyzing pack…",
        async (report) => {
          report(15);
          const pack = await CutDB.exportAiPack();
          report(30);
          const filled = await aiFillFromPrompt("analysis", pack, "Write the review now from this pack.");
          report(80);
          const clean = CutDBHelpers.sanitizeInsightContent?.(filled) || null;
          if (!clean) throw new Error("Analysis too thin or unreliable — log more days, then retry");
          const today = CutDBHelpers.todayISO();
          const phases = await CutDB.allPhases();
          const done = phases
            .filter((p) => phaseIsComplete(p, today))
            .sort((a, b) => (phaseEndISO(b) || "").localeCompare(phaseEndISO(a) || ""))[0];
          const id = await saveInsightAnalysis({
            title: clean.title || $("analysisTitle").value.trim() || "AI analysis",
            content: clean.content,
            source: "progress",
            timestamp: clean.timestamp || new Date().toISOString(),
            phaseId: done?.id || null,
          });
          if (done && !done.phaseInsightId) {
            await CutDB.savePhase({ ...done, phaseInsightId: id, phaseInsightAttemptedAt: new Date().toISOString() });
          }
          report(92);
          await renderAnalyses();
          report(100);
        },
        { doneMessage: "Analysis saved", minVisibleMs: 400 }
      );
    } catch (err) {
      alert(err.message || String(err));
    }
  });

  $("deletePhotoBtn").addEventListener("click", async () => {
    if (!activePhotoId || !confirm("Delete photo?")) return;
    await CutDB.deletePhoto(activePhotoId);
    $("photoDialog").close();
    await refreshAll();
  });

  $("exportAiBtn").addEventListener("click", async () => {
    downloadJson(`ai-pack-${CutDBHelpers.todayISO()}.json`, await CutDB.exportAiPack());
  });
  $("importAnalysisBtn").addEventListener("click", async () => {
    const text = $("analysisPaste").value.trim();
    if (!text) return;
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (_) {}
    await withActionProgress(
      "Saving analysis…",
      async (report) => {
        report(40);
        const imported = parseImportedAnalysis(text, $("analysisTitle").value.trim() || parsed?.title || "Analysis");
        const today = CutDBHelpers.todayISO();
        const phases = await CutDB.allPhases();
        const done = phases
          .filter((p) => phaseIsComplete(p, today))
          .sort((a, b) => (phaseEndISO(b) || "").localeCompare(phaseEndISO(a) || ""))[0];
        const id = await saveInsightAnalysis({
          title: $("analysisTitle").value.trim() || imported.title,
          content: imported.content,
          source: "imported",
          timestamp: imported.timestamp,
          phaseId: done?.id || null,
        });
        if (done && !done.phaseInsightId) {
          await CutDB.savePhase({ ...done, phaseInsightId: id, phaseInsightAttemptedAt: new Date().toISOString() });
        }
        $("analysisPaste").value = "";
        report(80);
        await renderAnalyses();
        report(100);
      },
      { doneMessage: "Analysis saved" }
    );
  });
  $("analysisFile").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    $("analysisPaste").value = await f.text();
    $("importAnalysisBtn").click();
    e.target.value = "";
  });
  $("exportOneAnalysisBtn").addEventListener("click", () => {
    if (activeAnalysis) downloadJson(`analysis.json`, activeAnalysis);
  });

  $("exportFullBtn").addEventListener("click", async () => {
    downloadJson(`full-backup-${CutDBHelpers.todayISO()}.json`, await CutDB.exportFull());
    savePrefs({ lastBackupAt: CutDBHelpers.todayISO() });
    lastBackupState = {
      never: false,
      last: CutDBHelpers.todayISO(),
      age: 0,
      loggedDays: lastBackupState?.loggedDays || 0,
      due: false,
      nudge: false,
    };
    renderBackupStamp(lastBackupState);
    showToast("Backup exported — monthly reminder reset");
  });
  $("importFullFile").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const merge = confirm("OK=merge, Cancel=replace all");
    try {
      await withActionProgress(
        merge ? "Merging backup…" : "Restoring backup…",
        async (report) => {
          report(25);
          await CutDB.importFull(JSON.parse(await f.text()), { merge });
          report(80);
          await refreshAll();
          report(100);
        },
        { doneMessage: merge ? "Backup merged" : "Backup restored" }
      );
    } catch (err) {
      alert(err.message || String(err));
    }
    e.target.value = "";
  });
  $("migrateBtn").addEventListener("click", async () => {
    const r = await withActionProgress(
      "Migrating…",
      async (report) => {
        report(40);
        const result = await CutDB.migrateLegacyLocalStorage();
        report(100);
        return result;
      },
      { doneMessage: false }
    );
    showToast(`Migrated ${r.migrated}`);
  });
  $("clearBtn").addEventListener("click", async () => {
    if (!confirm("Clear ALL tracker data (phases, diets, training, days, photos, insights)? This cannot be undone.")) return;
    await withActionProgress(
      "Clearing all data…",
      async (report) => {
        report(35);
        await CutDB.clearAll();
        selectedPhaseId = null;
        cachedPhase = null;
        cachedDiet = null;
        cachedTrain = null;
        report(100);
      },
      { doneMessage: "All data cleared", minVisibleMs: 450 }
    );
    location.reload();
  });

  await refreshAll({ tab: "today" });
  void (async () => {
    const applied = await maybeApplyShippedPack(cachedPhase);
    if (applied) {
      cachedPhase = await CutDB.getPhase(cachedPhase.id);
      await refreshAll({ tab: "today" });
    }
  })();
  void maybeRunCompletedPhaseInsights();
}

registerServiceWorker();
applyBrand();
initApp().catch((e) => {
  console.error(e);
  alert("Start failed: " + e.message);
});
