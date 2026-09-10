const $ = (id) => document.getElementById(id);
let selectedPhaseId = null;
let dietViewMode = "training";
let mealEditMode = "training";
let cachedPhase = null;
let cachedDiet = null;
let cachedTrain = null;
let activePhotoId = null;
let activeAnalysis = null;
let workoutState = { sessionId: "", exercises: [] };

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

async function savePartial(patch, label) {
  const date = $("logDate").value || CutDBHelpers.todayISO();
  const existing = (await CutDB.getDay(date)) || { date };
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
  if (patch.measurements) {
    merged.measurements = { ...(existing.measurements || {}), ...patch.measurements };
  }
  await CutDB.saveDay(merged);
  updateJourneyStatus(merged);
  showToast(label || "Saved");
  return merged;
}

function updateJourneyStatus(entry) {
  const e = entry || {};
  const setStatus = (key, ok) => {
    const el = document.querySelector(`[data-status-for="${key}"]`);
    if (!el) return;
    el.textContent = ok ? "Saved" : "";
    el.className = "step-status" + (ok ? " ok" : "");
  };
  const mealsDone = Object.values(e.mealChecks || {}).filter(Boolean).length;
  setStatus("morning", e.weight != null);
  setStatus("coffee", e.coffees != null);
  setStatus("meals", mealsDone > 0);
  setStatus(
    "workout",
    !!(e.workout?.exercises || []).some((x) => (x.sets || []).some((s) => s.weight != null || s.reps != null))
  );
  setStatus("wrap", e.steps != null || e.sleep != null || !!(e.notes && e.notes.length));

  const date = $("logDate")?.value || CutDBHelpers.todayISO();
  const paintNav = (photoDone) => {
    const nav = $("journeyNav");
    if (!nav) return;
    const steps = [
      { id: "morning", label: "1 Morning", done: e.weight != null },
      { id: "coffee", label: "2 Coffee", done: e.coffees != null },
      { id: "meals", label: mealsDone ? `3 Meals ${mealsDone}` : "3 Meals", done: mealsDone > 0 },
      { id: "workout", label: "4 Workout", done: !!e.workout?.sessionId, hide: !e.trained },
      { id: "wrap", label: "5 Wrap", done: e.steps != null || e.sleep != null || !!(e.notes && e.notes.length) },
      { id: "photos", label: "6 Photos", done: !!photoDone },
    ];
    nav.innerHTML = steps
      .filter((s) => !s.hide)
      .map(
        (s) =>
          `<button type="button" class="journey-chip ${s.done ? "done" : ""}" data-jump="${s.id}">${escapeHtml(
            s.label
          )}</button>`
      )
      .join("");
    nav.querySelectorAll("[data-jump]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.getElementById(`step-${btn.dataset.jump}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  };
  paintNav(false);
  CutDB.photosForDate(date).then((photos) => {
    setStatus("photos", (photos || []).length > 0);
    paintNav((photos || []).length > 0);
  });
}

function patchFromSection(section) {
  syncTrainedUI();
  if (section === "morning") {
    const measurements = readMeasurements();
    return {
      weight: parseNum($("weight").value),
      waist: measurements.waist ?? null,
      measurements,
      trained: $("trainedSelect").value === "train",
    };
  }
  if (section === "coffee") return { coffees: parseNum($("coffees").value) ?? 0 };
  if (section === "meals") {
    return {
      mealChecks: readMealChecks(),
      lunchCarb: $("lunchCarb").value,
      fatChoice: $("fatChoice").value,
      trained: $("trainedSelect").value === "train",
    };
  }
  if (section === "workout") return { trained: true, workout: readWorkoutLog() };
  if (section === "wrap") {
    return {
      steps: parseNum($("steps").value),
      sleep: parseNum($("sleep").value),
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
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
}

function showToast(msg) {
  const el = $("toast");
  if (!el) return;
  el.hidden = false;
  el.textContent = msg;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => (el.hidden = true), 2200);
}

function buildMeasureFields() {
  $("measureFields").innerHTML = CutDBHelpers.MEASURE_FIELDS.map(
    (m) =>
      `<label class="field"><span>${m.label}</span><input type="number" id="measure_${m.key}" step="0.1" placeholder="cm" /></label>`
  ).join("");
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
  const exercises = [];
  document.querySelectorAll("#workoutLog .ex-block").forEach((block) => {
    const exerciseId = block.dataset.exId;
    const name = block.dataset.exName;
    const youtubeUrl = block.dataset.yt || "";
    const restAfterExerciseSec = parseNum(block.querySelector(".ex-rest")?.value);
    const sets = [];
    block.querySelectorAll(".set-row").forEach((row) => {
      sets.push({
        weight: parseNum(row.querySelector(".set-w")?.value),
        reps: parseNum(row.querySelector(".set-r")?.value),
        restAfterSec: parseNum(row.querySelector(".set-rest")?.value),
      });
    });
    const rests = sets.map((s) => s.restAfterSec).filter((x) => x != null);
    exercises.push({
      exerciseId,
      name,
      youtubeUrl,
      sets,
      avgRestBetweenSetsSec: rests.length ? Number(mean(rests).toFixed(1)) : null,
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
    lunchCarb: $("lunchCarb").value,
    fatChoice: $("fatChoice").value,
    mealChecks: readMealChecks(),
    workout: ($("trainedSelect")?.value === "train" || $("trained")?.checked) ? readWorkoutLog() : null,
    phaseId: cachedPhase?.id || null,
    notes: $("notes").value.trim(),
    updatedAt: new Date().toISOString(),
  };
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
  const trained = !!entry?.trained;
  if ($("trainedSelect")) $("trainedSelect").value = trained ? "train" : "rest";
  if ($("trained")) $("trained").checked = trained;
  syncTrainedUI();
  $("lunchCarb").value = entry?.lunchCarb || "";
  $("fatChoice").value = entry?.fatChoice || "";
  $("notes").value = entry?.notes || "";
  renderMealCards(entry?.mealChecks || {});
  renderWorkoutUI(entry?.workout || null);
  updateJourneyStatus(entry || {});
}

function renderMealCards(saved = {}) {
  const root = $("mealCards");
  if (!cachedDiet) {
    root.innerHTML = `<p class="hint">No diet plan for this phase. Create one in the Diet tab.</p>`;
    $("mealTargets").textContent = "";
    $("mealCheckCount").textContent = "0/0";
    return;
  }
  const trained = $("trainedSelect")?.value === "train" || !!$("trained")?.checked;
  const block = trained ? cachedDiet.training : cachedDiet.rest;
  const t = block?.targets || {};
  if ($("mealPlanTitle")) $("mealPlanTitle").textContent = trained ? "Training day meals" : "Rest day meals";
  $("mealTargets").textContent = `${cachedDiet.name || "Diet"} · ${t.kcal ?? "—"} kcal · P${t.protein ?? "—"} C${t.carbs ?? "—"} F${t.fat ?? "—"}`;
  const meals = block?.meals || [];
  root.innerHTML = meals
    .map((m) => {
      const checked = !!saved[m.id];
      return `<article class="meal-card ${checked ? "done" : ""}"><label class="meal-check">
        <input type="checkbox" data-meal-id="${escapeHtml(m.id)}" ${checked ? "checked" : ""} />
        <div><strong>${escapeHtml(m.name)}</strong><em>${escapeHtml(m.when || "")}</em>
        <ul>${(m.items || []).map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul></div>
      </label></article>`;
    })
    .join("");
  const done = meals.filter((m) => saved[m.id]).length;
  $("mealCheckCount").textContent = `${done}/${meals.length}`;
  root.querySelectorAll("input").forEach((el) =>
    el.addEventListener("change", async () => {
      el.closest(".meal-card").classList.toggle("done", el.checked);
      const checks = readMealChecks();
      $("mealCheckCount").textContent = `${meals.filter((m) => checks[m.id]).length}/${meals.length}`;
      await savePartial(
        {
          mealChecks: { [el.dataset.mealId]: el.checked },
          lunchCarb: $("lunchCarb").value,
          fatChoice: $("fatChoice").value,
          trained: $("trainedSelect")?.value === "train",
        },
        el.checked ? `${el.closest(".meal-card").querySelector("strong")?.textContent || "Meal"} ✓` : "Meal unchecked"
      );
    })
  );
}

function renderWorkoutUI(savedWorkout) {
  const wrap = $("workoutLog");
  const hint = $("workoutHint");
  const select = $("sessionSelect");
  syncTrainedUI();
  if ($("trainedSelect")?.value !== "train" && !$("trained")?.checked) {
    if (hint) hint.textContent = "Set day type to Training in Morning check-in.";
    if (select) select.innerHTML = "";
    if (wrap) wrap.innerHTML = "";
    return;
  }
  if (!cachedTrain?.sessions?.length) {
    if (hint) hint.textContent = "No training plan on this phase. Add one in the Training tab.";
    if (select) select.innerHTML = "";
    if (wrap) wrap.innerHTML = "";
    return;
  }
  if (hint) hint.textContent = "Log as you lift. Use Save on each exercise or Save workout so far.";
  const sessions = cachedTrain.sessions;
  const preferred = savedWorkout?.sessionId || select.value || sessions[0].id;
  select.innerHTML = sessions
    .map((s) => `<option value="${escapeHtml(s.id)}" ${s.id === preferred ? "selected" : ""}>${escapeHtml(s.name)}</option>`)
    .join("");
  const session = sessions.find((s) => s.id === select.value) || sessions[0];
  const savedMap = {};
  (savedWorkout?.exercises || []).forEach((e) => {
    savedMap[e.exerciseId] = e;
  });

  wrap.innerHTML = (session.exercises || [])
    .map((ex) => {
      const saved = savedMap[ex.id];
      const sets =
        saved?.sets?.length > 0
          ? saved.sets
          : Array.from({ length: ex.targetSets || 3 }, () => ({ weight: null, reps: null, restAfterSec: null }));
      const yt = ex.youtubeUrl
        ? `<a href="${escapeHtml(ex.youtubeUrl)}" target="_blank" rel="noopener">YouTube form</a>`
        : "<span class='hint'>No form link</span>";
      return `<div class="ex-block" data-ex-id="${escapeHtml(ex.id)}" data-ex-name="${escapeHtml(ex.name)}" data-yt="${escapeHtml(ex.youtubeUrl || "")}">
        <div class="ex-head"><strong>${escapeHtml(ex.name)}</strong> <span class="hint">Target ${ex.targetSets || "?"}×${escapeHtml(ex.targetReps || "")}</span> ${yt}</div>
        <div class="set-table">
          <div class="set-head"><span>Set</span><span>Weight</span><span>Reps</span><span>Rest after set (s)</span></div>
          ${sets
            .map(
              (s, i) => `<div class="set-row">
              <span>${i + 1}</span>
              <input class="set-w" type="number" step="0.5" value="${s.weight ?? ""}" placeholder="kg" />
              <input class="set-r" type="number" step="1" value="${s.reps ?? ""}" placeholder="reps" />
              <input class="set-rest" type="number" step="5" value="${s.restAfterSec ?? ""}" placeholder="sec" />
            </div>`
            )
            .join("")}
        </div>
        <button type="button" class="btn tiny add-set">+ Set</button>
        <label class="field"><span>Rest before next exercise (sec)</span>
          <input class="ex-rest" type="number" step="5" value="${saved?.restAfterExerciseSec ?? ""}" placeholder="e.g. 120" />
        </label>
        <button type="button" class="btn primary save-ex">Save this exercise</button>
      </div>`;
    })
    .join("");

  wrap.querySelectorAll(".add-set").forEach((btn) => {
    btn.addEventListener("click", () => {
      const block = btn.closest(".ex-block");
      const n = block.querySelectorAll(".set-row").length + 1;
      const row = document.createElement("div");
      row.className = "set-row";
      row.innerHTML = `<span>${n}</span><input class="set-w" type="number" step="0.5" placeholder="kg" /><input class="set-r" type="number" step="1" placeholder="reps" /><input class="set-rest" type="number" step="5" placeholder="sec" />`;
      block.querySelector(".set-table").appendChild(row);
    });
  });

  wrap.querySelectorAll(".save-ex").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await savePartial({ trained: true, workout: readWorkoutLog() }, "Exercise saved");
    });
  });
}

async function loadContextForDate(date) {
  cachedPhase = await CutDB.getPhaseForDate(date);
  selectedPhaseId = cachedPhase?.id || selectedPhaseId;
  cachedDiet = cachedPhase ? await CutDB.getDietForPhase(cachedPhase.id) : null;
  cachedTrain = cachedPhase ? await CutDB.getTrainingForPhase(cachedPhase.id) : null;
  $("activePhaseLabel").textContent = cachedPhase
    ? `${cachedPhase.name} · ${formatRange(cachedPhase)}`
    : "No phase";
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
  $("avg7").textContent = formatKg(avg7);
  const wi = cachedPhase ? CutDBHelpers.getPhaseWeekInfo(cachedPhase, date) : null;
  let delta = null;
  if (wi && wi.weekNumber === 2) {
    const cur = phaseWeekAvg(data, wi.weekStart, wi.weekEnd);
    const prev = phaseWeekAvg(data, cachedPhase.startDate, CutDBHelpers.addDaysISO(cachedPhase.startDate, 6));
    if (cur.avg != null && prev.avg != null) delta = cur.avg - prev.avg;
  }
  $("weekDelta").textContent = formatDelta(delta);
  $("dayAvgHint").textContent =
    avg7 != null ? `Rolling 7-day avg: ${avg7.toFixed(2)} kg` : "Log morning weights to build averages.";
}

async function renderPhaseList() {
  const phases = await CutDB.allPhases();
  $("phaseList").innerHTML = phases
    .map((p) => {
      const sel = p.id === selectedPhaseId ? "style='outline:2px solid #0f6b5c'" : "";
      return `<li data-id="${p.id}" ${sel}>
        <div class="top"><span>${escapeHtml(p.name)}</span><span>${p.active ? "ACTIVE" : ""}</span></div>
        <div class="meta">${formatRange(p)}</div>
        <div class="row-actions"><button type="button" class="btn tiny pick" data-id="${p.id}">Edit</button>
        <button type="button" class="btn tiny make-active" data-id="${p.id}">Make active</button></div>
      </li>`;
    })
    .join("");

  $("phaseList").querySelectorAll(".pick").forEach((btn) =>
    btn.addEventListener("click", async () => {
      selectedPhaseId = btn.dataset.id;
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
      await refreshAll();
      showToast("Active phase updated");
    })
  );
}

async function fillPhaseEditor() {
  const id = selectedPhaseId || (await CutDB.getPhaseForDate($("logDate").value || CutDBHelpers.todayISO()))?.id;
  const p = id ? await CutDB.getPhase(id) : null;
  if (!p) return;
  selectedPhaseId = p.id;
  $("editPhaseId").value = p.id;
  $("phaseName").value = p.name || "";
  $("phaseStart").value = p.startDate || "";
  $("phaseEnd").value = p.endDate || "";
  $("phaseNotes").value = p.notes || "";
}

async function fillPhaseSelects() {
  const phases = await CutDB.allPhases();
  const opts = phases.map((p) => `<option value="${p.id}">${escapeHtml(p.name)} (${formatRange(p)})</option>`).join("");
  $("dietPhaseSelect").innerHTML = opts;
  $("trainPhaseSelect").innerHTML = opts;
  if (selectedPhaseId) {
    $("dietPhaseSelect").value = selectedPhaseId;
    $("trainPhaseSelect").value = selectedPhaseId;
  }
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
    $("dietName").value = "";
    $("dietNotes").value = "";
    $("dietTargets").innerHTML = `<p class="hint">No diet plan. Upload a template or click Save after filling defaults.</p>`;
    $("mealEditor").innerHTML = "";
    cachedDiet = null;
    return;
  }
  $("dietEditorWrap").style.opacity = "1";
  cachedDiet = diet;
  $("dietName").value = diet.name || "";
  $("dietNotes").value = diet.notes || "";
  renderDietTargetsAndMeals();
}

function renderDietTargetsAndMeals() {
  if (!cachedDiet) return;
  const blockKey = mealEditMode;
  // view chip uses dietViewMode for reference display; editor uses mealEditMode synced
  const mode = dietViewMode;
  mealEditMode = mode;
  const block = cachedDiet[mode];
  const t = block.targets || {};
  $("dietTargets").innerHTML = `
    <label class="field"><span>${mode} kcal</span><input id="t_kcal" type="number" value="${t.kcal ?? ""}" /></label>
    <label class="field"><span>Protein</span><input id="t_p" type="number" value="${t.protein ?? ""}" /></label>
    <label class="field"><span>Carbs</span><input id="t_c" type="number" value="${t.carbs ?? ""}" /></label>
    <label class="field"><span>Fat</span><input id="t_f" type="number" value="${t.fat ?? ""}" /></label>`;
  $("dietReference").innerHTML = (block.meals || [])
    .map(
      (m) => `<article class="ref-meal"><h3>${escapeHtml(m.name)} <small>${escapeHtml(m.when || "")}</small></h3>
      <ul>${(m.items || []).map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul></article>`
    )
    .join("");
  $("mealEditor").innerHTML = (block.meals || [])
    .map(
      (m, idx) => `<div class="editor-meal" data-idx="${idx}">
      <div class="grid-2">
        <label class="field"><span>Name</span><input data-f="name" value="${escapeHtml(m.name)}" /></label>
        <label class="field"><span>When</span><input data-f="when" value="${escapeHtml(m.when || "")}" /></label>
      </div>
      <label class="field"><span>Foods (one per line)</span><textarea data-f="items" rows="4">${escapeHtml((m.items || []).join("\n"))}</textarea></label>
      <input type="hidden" data-f="id" value="${escapeHtml(m.id)}" />
    </div>`
    )
    .join("") + `<button type="button" class="btn tiny" id="addMealBtn">+ Meal</button>`;
  $("addMealBtn")?.addEventListener("click", () => {
    cachedDiet[mode].meals.push({ id: CutDBHelpers.uid("meal"), name: "New meal", when: "", items: [] });
    renderDietTargetsAndMeals();
  });
}

function collectDietFromEditor() {
  const mode = dietViewMode;
  cachedDiet[mode].targets = {
    kcal: parseNum($("t_kcal")?.value),
    protein: parseNum($("t_p")?.value),
    carbs: parseNum($("t_c")?.value),
    fat: parseNum($("t_f")?.value),
  };
  const meals = [];
  document.querySelectorAll("#mealEditor .editor-meal").forEach((node) => {
    meals.push({
      id: node.querySelector('[data-f="id"]').value || CutDBHelpers.uid("meal"),
      name: node.querySelector('[data-f="name"]').value.trim() || "Meal",
      when: node.querySelector('[data-f="when"]').value.trim(),
      items: node
        .querySelector('[data-f="items"]')
        .value.split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    });
  });
  cachedDiet[mode].meals = meals;
  cachedDiet.name = $("dietName").value.trim() || cachedDiet.name;
  cachedDiet.notes = $("dietNotes").value.trim();
}

async function loadTrainEditor() {
  const phaseId = $("trainPhaseSelect").value || selectedPhaseId;
  if (!phaseId) return;
  selectedPhaseId = phaseId;
  let plan = await CutDB.getTrainingForPhase(phaseId);
  if (!plan) {
    $("trainName").value = "";
    $("trainNotes").value = "";
    $("trainEditor").innerHTML = `<p class="hint">No training plan. Upload a template or add sessions below then Save (creates plan).</p>`;
    cachedTrain = {
      id: CutDBHelpers.uid("train"),
      phaseId,
      name: "Training plan",
      notes: "",
      sessions: [],
      createdAt: new Date().toISOString(),
    };
    return;
  }
  cachedTrain = plan;
  $("trainName").value = plan.name || "";
  $("trainNotes").value = plan.notes || "";
  renderTrainEditor();
}

function renderTrainEditor() {
  if (!cachedTrain) return;
  $("trainEditor").innerHTML = (cachedTrain.sessions || [])
    .map(
      (s, si) => `<div class="editor-meal session-block" data-si="${si}">
      <div class="grid-2">
        <label class="field"><span>Session name</span><input data-sf="name" value="${escapeHtml(s.name)}" /></label>
        <label class="field"><span>Session id</span><input data-sf="id" value="${escapeHtml(s.id)}" /></label>
      </div>
      ${(s.exercises || [])
        .map(
          (e, ei) => `<div class="ex-edit" data-ei="${ei}">
          <div class="grid-2">
            <label class="field"><span>Exercise</span><input data-ef="name" value="${escapeHtml(e.name)}" /></label>
            <label class="field"><span>YouTube URL</span><input data-ef="youtubeUrl" value="${escapeHtml(e.youtubeUrl || "")}" /></label>
            <label class="field"><span>Target sets</span><input data-ef="targetSets" type="number" value="${e.targetSets ?? 3}" /></label>
            <label class="field"><span>Target reps</span><input data-ef="targetReps" value="${escapeHtml(e.targetReps || "")}" /></label>
          </div>
          <label class="field"><span>Notes</span><input data-ef="notes" value="${escapeHtml(e.notes || "")}" /></label>
          <input type="hidden" data-ef="id" value="${escapeHtml(e.id)}" />
          <button type="button" class="btn tiny danger rm-ex">Remove exercise</button>
        </div>`
        )
        .join("")}
      <button type="button" class="btn tiny add-ex">+ Exercise</button>
      <button type="button" class="btn tiny danger rm-session">Remove session</button>
    </div>`
    )
    .join("");

  $("trainEditor").querySelectorAll(".add-ex").forEach((btn) => {
    btn.addEventListener("click", () => {
      collectTrainFromEditor();
      const si = +btn.closest(".session-block").dataset.si;
      cachedTrain.sessions[si].exercises.push({
        id: CutDBHelpers.uid("ex"),
        name: "New exercise",
        youtubeUrl: "",
        targetSets: 3,
        targetReps: "8-10",
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
      cachedTrain.sessions.splice(si, 1);
      renderTrainEditor();
    });
  });
}

function collectTrainFromEditor() {
  if (!cachedTrain) return;
  cachedTrain.name = $("trainName").value.trim() || cachedTrain.name;
  cachedTrain.notes = $("trainNotes").value.trim();
  const sessions = [];
  document.querySelectorAll("#trainEditor .session-block").forEach((node) => {
    const exercises = [];
    node.querySelectorAll(".ex-edit").forEach((ex) => {
      exercises.push({
        id: ex.querySelector('[data-ef="id"]').value || CutDBHelpers.uid("ex"),
        name: ex.querySelector('[data-ef="name"]').value.trim() || "Exercise",
        youtubeUrl: ex.querySelector('[data-ef="youtubeUrl"]').value.trim(),
        targetSets: parseNum(ex.querySelector('[data-ef="targetSets"]').value) || 3,
        targetReps: ex.querySelector('[data-ef="targetReps"]').value.trim(),
        notes: ex.querySelector('[data-ef="notes"]').value.trim(),
      });
    });
    sessions.push({
      id: node.querySelector('[data-sf="id"]').value || CutDBHelpers.uid("session"),
      name: node.querySelector('[data-sf="name"]').value.trim() || "Session",
      exercises,
    });
  });
  cachedTrain.sessions = sessions;
}

async function renderWeek(data, date) {
  const phase = cachedPhase;
  const wi = phase ? CutDBHelpers.getPhaseWeekInfo(phase, date) : null;
  if (!phase || !wi) {
    $("weekMetrics").innerHTML = `<div class="metric"><span>Phase week</span><strong>No phase covers this date</strong></div>`;
    $("weightList").innerHTML = "";
    $("decisionHint").textContent = "Create/select a 2-week phase first.";
    $("recentList").innerHTML = "";
    return;
  }
  const week = phaseWeekAvg(data, wi.weekStart, wi.weekEnd);
  let prev = null;
  if (wi.weekNumber === 2) prev = phaseWeekAvg(data, phase.startDate, CutDBHelpers.addDaysISO(phase.startDate, 6));
  const days = sortedDates(data).filter((d) => d >= week.start && d <= week.end);
  $("weekMetrics").innerHTML = `
    <div class="metric"><span>Phase</span><strong>${escapeHtml(phase.name)}</strong></div>
    <div class="metric"><span>Phase week</span><strong>Week ${wi.weekNumber} / 2</strong></div>
    <div class="metric"><span>Dates</span><strong>${week.start} → ${week.end}</strong></div>
    <div class="metric"><span>Day in phase</span><strong>${wi.dayInPhase}/14</strong></div>
    <div class="metric"><span>Avg weight</span><strong>${formatKg(week.avg)}</strong></div>
    <div class="metric"><span>vs prior</span><strong>${formatDelta(week.avg != null && prev?.avg != null ? week.avg - prev.avg : null)}</strong></div>
    <div class="metric"><span>Lift days</span><strong>${days.filter((d) => data[d].trained).length}</strong></div>
    <div class="metric"><span>Avg coffees</span><strong>${(() => {
      const v = days.map((d) => data[d].coffees).filter((x) => typeof x === "number");
      return v.length ? mean(v).toFixed(1) : "—";
    })()}</strong></div>`;
  const weights = days
    .filter((d) => typeof data[d].weight === "number")
    .map((d) => ({ date: d, weight: data[d].weight }))
    .reverse();
  $("weightList").innerHTML = weights.length
    ? weights.map((w) => `<li><span>${w.date}</span><strong>${w.weight.toFixed(1)} kg</strong></li>`).join("")
    : "<li><span>No weights</span></li>";
  $("decisionHint").textContent =
    wi.weekNumber === 1
      ? "Phase week 1 — build average; compare in week 2."
      : "Phase week 2 — compare to week 1 before changing calories.";
  const allPhaseDays = sortedDates(data).filter((d) => d >= phase.startDate && d <= phase.endDate);
  $("recentList").innerHTML = allPhaseDays
    .reverse()
    .map((d) => {
      const e = data[d];
      const winfo = CutDBHelpers.getPhaseWeekInfo(phase, d);
      return `<li data-date="${d}"><div class="top"><span>${d}</span><span>${
        typeof e.weight === "number" ? e.weight.toFixed(1) + " kg" : "—"
      }</span></div><div class="meta">W${winfo?.weekNumber || "?"} · ${e.trained ? "Train" : "Rest"} · ☕ ${
        e.coffees ?? "—"
      }</div></li>`;
    })
    .join("");
  document.querySelectorAll("#recentList [data-date]").forEach((li) =>
    li.addEventListener("click", async () => {
      fillForm(data[li.dataset.date], li.dataset.date);
      document.querySelector('[data-tab="today"]').click();
    })
  );
}

async function renderPhotos() {
  const date = $("logDate").value;
  const dayPhotos = await CutDB.photosForDate(date);
  $("dayPhotoGrid").innerHTML = dayPhotos.length
    ? ""
    : `<p class="hint">No photos</p>`;
  for (const p of dayPhotos) {
    const url = URL.createObjectURL(p.blob);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "photo-thumb";
    btn.innerHTML = `<img src="${url}" alt="" />`;
    btn.onclick = () => {
      activePhotoId = p.id;
      $("photoDialogImg").src = url;
      $("photoDialog").showModal();
    };
    $("dayPhotoGrid").appendChild(btn);
  }
  const all = await CutDB.allPhotos();
  const root = $("allPhotos");
  if (!all.length) {
    root.innerHTML = `<p class="hint">No photos yet</p>`;
    return;
  }
  const by = {};
  all.forEach((p) => {
    (by[p.date] ||= []).push(p);
  });
  root.innerHTML = "";
  for (const d of Object.keys(by).sort().reverse()) {
    const block = document.createElement("div");
    block.className = "photo-day";
    block.innerHTML = `<h3>${d}</h3>`;
    const grid = document.createElement("div");
    grid.className = "photo-grid";
    for (const p of by[d]) {
      const url = URL.createObjectURL(p.blob);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "photo-thumb";
      btn.innerHTML = `<img src="${url}" alt="" />`;
      btn.onclick = () => {
        activePhotoId = p.id;
        $("photoDialogImg").src = url;
        $("photoDialog").showModal();
      };
      grid.appendChild(btn);
    }
    block.appendChild(grid);
    root.appendChild(block);
  }
}

async function renderAnalyses() {
  const list = await CutDB.allAnalyses();
  $("analysisList").innerHTML = list.length
    ? list
        .map(
          (a) =>
            `<li data-id="${a.id}"><div class="top"><span>${escapeHtml(a.title || "Analysis")}</span><span>${new Date(
              a.importedAt
            ).toLocaleString()}</span></div><div class="meta">${escapeHtml(a.timestamp || "")}</div></li>`
        )
        .join("")
    : "<li><div class='top'><span>None yet</span></div></li>";
  $("analysisList").querySelectorAll("[data-id]").forEach((li) =>
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
        `<circle cx="${xAt(i)}" cy="${yAt(d.value)}" r="3.2" fill="#1c1915" opacity="0.55"><title>${d.date}: ${d.value}</title></circle>`
    )
    .join("");
  const avgPath = avgLine.map((d, i) => `${i ? "L" : "M"}${xAt(i)},${yAt(d.value)}`).join(" ");
  const yTicks = [min, (min + max) / 2, max]
    .map((v) => {
      const y = yAt(v);
      return `<text x="4" y="${y + 3}" font-size="10" fill="#6b6358">${v.toFixed(1)}</text>
        <line x1="${pad.l}" y1="${y}" x2="${w - pad.r}" y2="${y}" stroke="#ddd4c4" stroke-dasharray="3 4"/>`;
    })
    .join("");
  const xLabels = [0, Math.floor((daily.length - 1) / 2), daily.length - 1]
    .filter((i, idx, arr) => arr.indexOf(i) === idx && daily[i])
    .map(
      (i) =>
        `<text x="${xAt(i)}" y="${h - 8}" font-size="10" fill="#6b6358" text-anchor="middle">${daily[i].date.slice(5)}</text>`
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
  const trainLogged = dates.filter((d) => data[d].trained).length;

  rootKpi.innerHTML = `
    <div class="chart-kpi"><span>Weigh-ins</span><strong>${weighIns.length}</strong></div>
    <div class="chart-kpi"><span>7-day avg</span><strong>${avg7 != null ? avg7.toFixed(1) + " kg" : "—"}</strong></div>
    <div class="chart-kpi"><span>~14d Δ</span><strong>${formatDelta(delta14)}</strong></div>
    <div class="chart-kpi"><span>Meal adherence</span><strong>${adherencePct != null ? adherencePct + "%" : "—"}</strong></div>
    <div class="chart-kpi"><span>Train days</span><strong>${trainLogged}</strong></div>`;
  if ($("chartsMeta")) $("chartsMeta").textContent = `${dates.length} days logged`;

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
      <text x="4" y="14" font-size="10" fill="#6b6358">100%</text>
      <text x="4" y="110" font-size="10" fill="#6b6358">0%</text>
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
  for (let i = 0; i < 42; i++) {
    const d = CutDBHelpers.addDaysISO(gridStart, i);
    const e = data[d];
    let cls = "train-cell";
    let title = d;
    if (e) {
      if (e.trained) {
        cls += " train";
        title += " · train";
      } else {
        cls += " rest";
        title += " · rest";
      }
    }
    grid += `<div class="${cls}" title="${title}">${d.slice(8)}</div>`;
  }
  $("chartTrainGrid").innerHTML = grid;

  const byLift = {};
  dates.forEach((d) => {
    const workout = data[d].workout;
    if (!workout?.exercises) return;
    workout.exercises.forEach((ex) => {
      const vol = exerciseVolume(ex);
      if (!vol) return;
      const key = (ex.name || ex.exerciseId || "Exercise").trim() || "Exercise";
      (byLift[key] ||= []).push({ date: d, value: vol });
    });
  });
  const topLifts = Object.entries(byLift)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 5);
  $("chartStrength").innerHTML = topLifts.length
    ? topLifts
        .map(
          ([name, pts]) => `<div class="lift-block"><h3>${escapeHtml(name)}</h3>
        <p class="hint">${pts.length} logged sessions · kg×reps volume</p>
        <div class="chart-wrap">${svgSingleLine(pts, { color: "#0f6b5c", height: 120 })}</div></div>`
        )
        .join("")
    : `<p class="chart-empty">Log workout sets with weight and reps.</p>`;

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
    strip.innerHTML = `<p class="chart-empty">Add progress photos on Today.</p>`;
  } else {
    strip.innerHTML = "";
    const ordered = photos
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
    for (const p of ordered) {
      const url = URL.createObjectURL(p.blob);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "photo-strip-item";
      btn.innerHTML = `<img src="${url}" alt="" /><span>${p.date}</span>`;
      btn.onclick = () => {
        activePhotoId = p.id;
        $("photoDialogImg").src = url;
        $("photoDialog").showModal();
      };
      strip.appendChild(btn);
    }
  }
}

async function refreshAll() {
  const date = $("logDate").value || CutDBHelpers.todayISO();
  await loadContextForDate(date);
  const data = await CutDB.allDays();
  await refreshHeader(data, date);
  const entry = data[date];
  renderMealCards(entry?.mealChecks || {});
  syncTrainedUI();
  renderWorkoutUI(entry?.workout || null);
  updateJourneyStatus(entry || { trained: $("trainedSelect")?.value === "train" });
  await renderPhaseList();
  await fillPhaseSelects();
  await fillPhaseEditor();
  await loadDietEditor();
  await loadTrainEditor();
  await renderWeek(data, date);
  await renderPhotos();
  await renderProgressCharts(data);
  await renderAnalyses();
  const phases = await CutDB.allPhases();
  const photos = await CutDB.allPhotos();
  $("storageStatus").textContent = `${Object.keys(data).length} days · ${phases.length} phases · ${photos.length} photos`;
}

function initTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", async () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      $(`panel-${btn.dataset.tab}`).classList.add("active");
      await refreshAll();
    });
  });
}

async function init() {
  buildMeasureFields();
  initTabs();
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
    await savePartial({ trained: $("trainedSelect").value === "train" }, "Day type saved");
    renderMealCards(saved?.mealChecks || {});
    renderWorkoutUI(saved?.workout || null);
  });

  $("sessionSelect")?.addEventListener("change", async () => {
    renderWorkoutUI(null);
    await savePartial({ trained: true, workout: readWorkoutLog() }, "Session selected");
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
      }
    });
  });

  $("coffeePlus")?.addEventListener("click", async () => {
    const next = (parseNum($("coffees").value) || 0) + 1;
    setCoffeeDisplay(next);
    await savePartial({ coffees: next }, `Coffee ${next}`);
  });
  $("coffeeMinus")?.addEventListener("click", async () => {
    const next = Math.max(0, (parseNum($("coffees").value) || 0) - 1);
    setCoffeeDisplay(next);
    await savePartial({ coffees: next }, `Coffee ${next}`);
  });

  ["lunchCarb", "fatChoice"].forEach((id) => {
    $(id)?.addEventListener("change", async () => {
      await savePartial(
        {
          lunchCarb: $("lunchCarb").value,
          fatChoice: $("fatChoice").value,
          mealChecks: readMealChecks(),
        },
        id === "lunchCarb" ? "Lunch carb saved" : "Fat choice saved"
      );
    });
  });

  $("loadTodayBtn").addEventListener("click", async () => {
    const d = CutDBHelpers.todayISO();
    fillForm((await CutDB.getDay(d)) || null, d);
    await refreshAll();
  });

  $("exportDayTplBtn")?.addEventListener("click", async () => {
    const date = $("logDate").value || CutDBHelpers.todayISO();
    const entry = await CutDB.getDay(date);
    const tpl = entry
      ? CutDB.exportDayTemplate(entry)
      : CutDB.exportBlankDayTemplate(date);
    downloadJson(`day-template-${date}.json`, tpl);
  });
  $("importDayTpl")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const date = $("logDate").value || CutDBHelpers.todayISO();
      const payload = JSON.parse(await file.text());
      const saved = await CutDB.importDayTemplate(payload, date);
      $("logDate").value = saved.date;
      await loadContextForDate(saved.date);
      fillForm(saved, saved.date);
      await refreshAll();
      showToast("Day template imported");
    } catch (err) {
      alert(err.message || String(err));
    }
    e.target.value = "";
  });

  $("newPhaseBtn").addEventListener("click", async () => {
    const name = prompt("Phase name?", `Phase ${new Date().toLocaleDateString()}`);
    if (name == null) return;
    const phase = await CutDB.createPhase({ name: name.trim() || undefined });
    selectedPhaseId = phase.id;
    await refreshAll();
    showToast("Phase created (2 weeks)");
  });
  $("phaseStart").addEventListener("change", () => {
    const r = CutDBHelpers.ensureTwoWeekRange($("phaseStart").value || CutDBHelpers.todayISO());
    $("phaseStart").value = r.startDate;
    $("phaseEnd").value = r.endDate;
  });
  $("savePhaseBtn").addEventListener("click", async () => {
    const id = $("editPhaseId").value;
    const p = await CutDB.getPhase(id);
    if (!p) return;
    const r = CutDBHelpers.ensureTwoWeekRange($("phaseStart").value || CutDBHelpers.todayISO());
    p.name = $("phaseName").value.trim() || p.name;
    p.startDate = r.startDate;
    p.endDate = r.endDate;
    p.notes = $("phaseNotes").value.trim();
    await CutDB.savePhase(p);
    selectedPhaseId = p.id;
    await refreshAll();
    showToast("Phase saved");
  });
  $("deletePhaseBtn").addEventListener("click", async () => {
    const id = $("editPhaseId").value;
    if (!id || !confirm("Remove this phase and its diet + training plans?")) return;
    await CutDB.deletePhase(id);
    selectedPhaseId = null;
    await refreshAll();
    showToast("Phase removed");
  });

  $("dietPhaseSelect").addEventListener("change", loadDietEditor);
  $("trainPhaseSelect").addEventListener("change", loadTrainEditor);
  document.querySelectorAll("[data-diet-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (cachedDiet) collectDietFromEditor();
      document.querySelectorAll("[data-diet-view]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      dietViewMode = btn.dataset.dietView;
      renderDietTargetsAndMeals();
    });
  });
  $("saveDietBtn").addEventListener("click", async () => {
    const phaseId = $("dietPhaseSelect").value;
    if (!phaseId) return;
    if (!cachedDiet) {
      cachedDiet = {
        id: CutDBHelpers.uid("diet"),
        phaseId,
        createdAt: new Date().toISOString(),
        ...CutDBHelpers.defaultDietContent(),
      };
    }
    collectDietFromEditor();
    cachedDiet.phaseId = phaseId;
    await CutDB.saveDietPlan(cachedDiet);
    await refreshAll();
    showToast("Diet plan saved");
  });
  $("deleteDietBtn").addEventListener("click", async () => {
    const phaseId = $("dietPhaseSelect").value;
    if (!phaseId || !confirm("Remove diet plan from this phase?")) return;
    await CutDB.deleteDietForPhase(phaseId);
    cachedDiet = null;
    await refreshAll();
    showToast("Diet removed");
  });
  $("exportDietTplBtn").addEventListener("click", async () => {
    const phaseId = $("dietPhaseSelect").value;
    const diet = await CutDB.getDietForPhase(phaseId);
    const tpl = diet
      ? {
          type: "cut-tracker-diet-template",
          version: 3,
          name: diet.name,
          notes: diet.notes,
          training: diet.training,
          rest: diet.rest,
        }
      : CutDB.exportBlankDietTemplate();
    downloadJson(`diet-template-${CutDBHelpers.todayISO()}.json`, tpl);
  });
  $("importDietTpl").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const phaseId = $("dietPhaseSelect").value;
      await CutDB.importDietTemplate(JSON.parse(await file.text()), phaseId);
      await refreshAll();
      showToast("Diet template imported");
    } catch (err) {
      alert(err.message);
    }
    e.target.value = "";
  });

  $("addSessionBtn").addEventListener("click", () => {
    if (!cachedTrain) {
      cachedTrain = {
        id: CutDBHelpers.uid("train"),
        phaseId: $("trainPhaseSelect").value,
        name: "Training plan",
        notes: "",
        sessions: [],
        createdAt: new Date().toISOString(),
      };
    }
    collectTrainFromEditor();
    cachedTrain.sessions.push({
      id: CutDBHelpers.uid("session"),
      name: `Day ${(cachedTrain.sessions.length + 1).toString()}`,
      exercises: [],
    });
    renderTrainEditor();
  });
  $("saveTrainBtn").addEventListener("click", async () => {
    const phaseId = $("trainPhaseSelect").value;
    if (!phaseId) return;
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
    await CutDB.saveTrainingPlan(cachedTrain);
    await refreshAll();
    showToast("Training plan saved");
  });
  $("deleteTrainBtn").addEventListener("click", async () => {
    const phaseId = $("trainPhaseSelect").value;
    if (!phaseId || !confirm("Remove training plan from this phase?")) return;
    await CutDB.deleteTrainingForPhase(phaseId);
    cachedTrain = null;
    await refreshAll();
    showToast("Training plan removed");
  });
  $("exportTrainTplBtn").addEventListener("click", async () => {
    const plan = await CutDB.getTrainingForPhase($("trainPhaseSelect").value);
    const tpl = plan
      ? { type: "cut-tracker-training-template", version: 1, name: plan.name, notes: plan.notes, sessions: plan.sessions }
      : CutDB.exportBlankTrainingTemplate();
    downloadJson(`training-template-${CutDBHelpers.todayISO()}.json`, tpl);
  });
  $("importTrainTpl").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await CutDB.importTrainingTemplate(JSON.parse(await file.text()), $("trainPhaseSelect").value);
      await refreshAll();
      showToast("Training template imported");
    } catch (err) {
      alert(err.message);
    }
    e.target.value = "";
  });

  $("photoInput").addEventListener("change", async (e) => {
    const date = $("logDate").value || CutDBHelpers.todayISO();
    const existing = (await CutDB.getDay(date)) || { date };
    await CutDB.saveDay({
      ...existing,
      date,
      phaseId: cachedPhase?.id || existing.phaseId || null,
      updatedAt: new Date().toISOString(),
    });
    for (const f of e.target.files) await CutDB.addPhoto(date, f);
    e.target.value = "";
    await refreshAll();
    showToast("Photo saved");
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
    await CutDB.saveAnalysis({
      id: CutDBHelpers.uid("analysis"),
      type: "cut-tracker-analysis",
      title: $("analysisTitle").value.trim() || parsed?.title || "Analysis",
      timestamp: parsed?.timestamp || new Date().toISOString(),
      importedAt: new Date().toISOString(),
      content: parsed?.content || text,
      source: "ai",
    });
    $("analysisPaste").value = "";
    await renderAnalyses();
    showToast("Analysis saved");
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
  });
  $("importFullFile").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const merge = confirm("OK=merge, Cancel=replace all");
    await CutDB.importFull(JSON.parse(await f.text()), { merge });
    await refreshAll();
    e.target.value = "";
  });
  $("migrateBtn").addEventListener("click", async () => {
    const r = await CutDB.migrateLegacyLocalStorage();
    showToast(`Migrated ${r.migrated}`);
  });
  $("clearBtn").addEventListener("click", async () => {
    if (!confirm("Clear ALL data?")) return;
    await CutDB.clearAll();
    await refreshAll();
  });

  await refreshAll();
}

init().catch((e) => {
  console.error(e);
  alert("Start failed: " + e.message);
});
