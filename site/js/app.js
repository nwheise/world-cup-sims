/*
 * app.js — state, persistence, worker wiring, and event delegation.
 *
 * Data flow:
 *   tournament.json (static facts) + results.json (live scores, refreshed by
 *   the scheduled GitHub Action) -> Web Worker runs the Monte Carlo once and
 *   keeps compact per-sim records -> "analyze" requests (preferences +
 *   attended matches, both in localStorage) are fast re-aggregations, so the
 *   cheer guide updates instantly as you click.
 */

import { prepare, rankGroup } from "./sim-core.js";
import { computeScores, computeCounts, computeWeights, applyPins, pickPair,
         ratingPriors } from "./prefs.js";
import { displayName } from "./format.js";
import { renderCheer, renderMatches, renderTeams, renderSchedule, renderPath,
         renderProbs } from "./views.js";
import { scoreMatches, buildTiers, matchEvents, buildICS } from "./schedule.js";

const LS = {
  comparisons: "wc26:comparisons",
  attended: "wc26:attended",
  pinned: "wc26:pinned",
  settings: "wc26:settings",
  fanTeam: "wc26:fanteam",
};
const load = (k, fallback) => {
  try { return JSON.parse(localStorage.getItem(k)) ?? fallback; }
  catch { return fallback; }
};
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

const S = {
  tournament: null, results: null, prep: null,
  allMatches: [], ko: [], koById: new Map(), groupById: new Map(),
  koKnown: {}, playedCount: 0, ratings: {}, standings: {},
  probs: null, groupProbs: null, meta: { nSims: 0, seed: 42 },
  simStatus: { state: "running", done: 0, total: 0 },
  analysis: null,
  comparisons: load(LS.comparisons, []),
  attended: new Set(load(LS.attended, [])),
  pinned: new Set(load(LS.pinned, [])),
  settings: { ...load(LS.settings, {}), nSims: 100000 },
  fanTeam: load(LS.fanTeam, null),
  pathAnalysis: null, pathSort: "date",
  pool: [], weights: {}, counts: new Map(), currentPair: null,
  cheerSort: "date", venueFilter: "",
  matchupSel: {},                            // transient probe state (probs tab)
  teamsNotice: null,                         // transient feedback (teams tab)
  lastReqId: 0,
  lastPathReqId: 0,
};

let worker = null;
const $ = (sel) => document.querySelector(sel);
const sections = { guide: null, matches: null, teams: null, watch: null, path: null, probs: null };

// --- derived state -----------------------------------------------------------

function computeStandings() {
  const { prep } = S;
  const byPair = S.results?.group_results || {};
  const standings = {};
  "ABCDEFGHIJKL".split("").forEach((L, g) => {
    const games = [];
    const playedCount = new Map(prep.groupTeams[g].map((t) => [t, 0]));
    for (const game of prep.gamesOfGroup[g]) {
      const res = byPair[game.id];
      if (!res) continue;
      games.push({ a: game.a, b: game.b, ga: res[0], gb: res[1] });
      playedCount.set(game.a, playedCount.get(game.a) + 1);
      playedCount.set(game.b, playedCount.get(game.b) + 1);
    }
    const { order, pts, gd } = rankGroup(prep.groupTeams[g], games, prep.ratings);
    standings[L] = order.map((t) => ({
      team: prep.teams[t], played: playedCount.get(t),
      pts: pts.get(t), gd: gd.get(t),
    }));
  });
  S.standings = standings;
}

function computePrefs() {
  // Strength priors: before any picks, the default is "see the best teams".
  const scores = computeScores(S.pool, S.comparisons, ratingPriors(S.ratings));
  S.counts = computeCounts(S.pool, S.comparisons);
  // Pinned favorites are locked at 1.0 and everything unpinned is compressed
  // below them — a pin must always outrank the head-to-head ranking.
  S.weights = applyPins(computeWeights(scores), S.pinned);
  if (!S.currentPair || !S.currentPair.every((t) => S.pool.includes(t))) {
    S.currentPair = pickPair(S.pool, scores, S.counts, S.currentPair,
                             Math.random, S.comparisons);
  }
}

function nextPair(avoid) {
  const scores = computeScores(S.pool, S.comparisons, ratingPriors(S.ratings));
  S.counts = computeCounts(S.pool, S.comparisons);
  S.currentPair = pickPair(S.pool, scores, S.counts, avoid,
                           Math.random, S.comparisons);
}

// --- rendering -----------------------------------------------------------------

function renderAll() {
  renderCheer(S, sections.guide);
  renderMatches(S, sections.matches);
  renderTeams(S, sections.teams);
  renderSchedule(S, sections.watch);
  renderPath(S, sections.path);
  renderProbs(S, sections.probs);
}

function setTab(tab) {
  if (!sections[tab]) tab = "path";
  for (const [name, el] of Object.entries(sections)) {
    el.hidden = name !== tab;
    $(`nav [data-tab="${name}"]`)?.classList.toggle("active", name === tab);
  }
  if (location.hash !== `#${tab}`) history.replaceState(null, "", `#${tab}`);
}

// --- worker -----------------------------------------------------------------------

function startSimulation() {
  S.simStatus = { state: "running", done: 0, total: S.settings.nSims };
  S.probs = null;
  S.analysis = null;
  S.pathAnalysis = null;
  renderCheer(S, sections.guide);
  renderSchedule(S, sections.watch);
  renderPath(S, sections.path);
  renderProbs(S, sections.probs);
  worker.postMessage({
    type: "simulate",
    tournament: S.tournament,
    results: S.results,
    nSims: S.settings.nSims,
    seed: 42,
  });
}

let analyzeTimer = null;
function scheduleAnalyze() {
  if (analyzeTimer) clearTimeout(analyzeTimer);
  analyzeTimer = setTimeout(() => {
    // Strength priors mean weights are meaningful even with zero picks —
    // only attended matches are required.
    if (S.simStatus.state !== "done" || !S.attended.size) return;
    S.lastReqId += 1;
    worker.postMessage({
      type: "analyze",
      weights: S.weights,
      attended: [...S.attended],
      pinned: [...S.pinned],
      reqId: S.lastReqId,
    });
  }, 200);
}

let pathTimer = null;
function schedulePathAnalyze() {
  if (pathTimer) clearTimeout(pathTimer);
  pathTimer = setTimeout(() => {
    if (S.simStatus.state !== "done" || !S.fanTeam) return;
    S.lastPathReqId += 1;
    worker.postMessage({ type: "teampath", team: S.fanTeam, reqId: S.lastPathReqId });
  }, 200);
}

function onWorkerMessage(ev) {
  const msg = ev.data;
  if (msg.type === "progress") {
    S.simStatus = { state: "running", done: msg.done, total: msg.total };
    const p = msg.total ? Math.round(100 * msg.done / msg.total) : 0;
    // Update the loading placeholder's progress widget in place; the
    // .sim-progress guard means we never touch an already-rendered view.
    for (const el of [sections.guide, sections.probs, sections.path, sections.watch]) {
      const box = el.querySelector(".sim-progress");
      if (!box) continue;
      box.setAttribute("aria-valuenow", p);
      const fill = box.querySelector(".progress-fill");
      if (fill) fill.style.width = `${p}%`;
      const pctEl = box.querySelector(".sim-progress-pct");
      if (pctEl) pctEl.textContent = `${p}%`;
      const cntEl = box.querySelector(".sim-progress-count");
      if (cntEl) cntEl.textContent = msg.done.toLocaleString();
    }
  } else if (msg.type === "simulated") {
    S.simStatus = { state: "done", done: msg.meta.nSims, total: msg.meta.nSims };
    S.probs = msg.probs;
    S.groupProbs = msg.groupProbs;
    S.meta = msg.meta;
    renderAll();
    scheduleAnalyze();
    schedulePathAnalyze();
  } else if (msg.type === "analysis") {
    if (msg.reqId !== S.lastReqId) return; // stale
    S.analysis = { rows: msg.rows, summary: msg.summary };
    renderCheer(S, sections.guide);
  } else if (msg.type === "teampath") {
    if (msg.reqId !== S.lastPathReqId) return; // stale
    S.pathAnalysis = { team: msg.team, baseline: msg.baseline, rows: msg.rows };
    renderPath(S, sections.path);
  }
}

// --- events --------------------------------------------------------------------------

function setFanTeam(team) {
  S.fanTeam = team || null;
  save(LS.fanTeam, S.fanTeam);
  S.pathAnalysis = null;
  renderPath(S, sections.path);
  schedulePathAnalyze();
}

/** Build and download a .ics calendar: a tier of the must-watch schedule
 *  ({tier: "must"|"worth"}, worth = must + worth-a-watch) or one match
 *  ({matchId}). Recomputed from current state — cheap and always fresh. */
function downloadICS({ tier, matchId }) {
  const scored = scoreMatches(S.allMatches, S.probs, S.weights, S.results);
  let list, name;
  if (matchId) {
    list = scored.filter((s) => s.m.id === matchId);
    name = `world-cup-2026-${matchId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.ics`;
  } else {
    const { must, worth } = buildTiers(scored, S.pinned);
    list = tier === "worth" ? [...must, ...worth] : must;
    list.sort((a, b) => a.m.kickoff.localeCompare(b.m.kickoff));
    name = "world-cup-2026-must-watch.ics";
  }
  if (!list.length) return;
  const ics = buildICS(matchEvents(list, S.weights, S.pinned), new Date());
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function onAttendedChanged() {
  save(LS.attended, [...S.attended]);
  S.analysis = null;
  renderAll();
  scheduleAnalyze();
}

function wireEvents() {
  document.addEventListener("click", (ev) => {
    const t = ev.target.closest("[data-tab],[data-goto],[data-pick],[data-tie],[data-skip],[data-undo],[data-reset-prefs],[data-clear-attended],[data-cheer-sort],[data-pin],[data-sel-team],[data-fan-team],[data-path-sort],[data-ics],[data-ics-tier],[data-share],[data-info],[data-info-close]");
    if (!t) return;
    if (t.dataset.tab) setTab(t.dataset.tab);
    else if (t.dataset.goto) setTab(t.dataset.goto);
    else if (t.dataset.pick) {
      S.comparisons.push([t.dataset.pick, t.dataset.loser]);
      save(LS.comparisons, S.comparisons);
      S.teamsNotice = null;
      nextPair([t.dataset.pick, t.dataset.loser]);
      computePrefs();
      renderTeams(S, sections.teams);
      renderSchedule(S, sections.watch);
      scheduleAnalyze();
    } else if (t.dataset.tie !== undefined) {
      if (!S.currentPair) return;
      S.comparisons.push([S.currentPair[0], S.currentPair[1], "="]);
      save(LS.comparisons, S.comparisons);
      S.teamsNotice = null;
      nextPair(S.currentPair);
      computePrefs();
      renderTeams(S, sections.teams);
      renderSchedule(S, sections.watch);
      scheduleAnalyze();
    } else if (t.dataset.skip !== undefined) {
      S.teamsNotice = null;
      nextPair(S.currentPair);
      renderTeams(S, sections.teams);
    } else if (t.dataset.undo !== undefined) {
      const undone = S.comparisons.pop();
      if (undone) {
        S.teamsNotice = undone[2] === "="
          ? `↩ Undid: ${displayName(undone[0])} = ${displayName(undone[1])} (equal preference)`
          : `↩ Undid: ${displayName(undone[0])} over ${displayName(undone[1])}`;
      }
      save(LS.comparisons, S.comparisons);
      computePrefs();
      renderTeams(S, sections.teams);
      renderSchedule(S, sections.watch);
      scheduleAnalyze();
    } else if (t.dataset.resetPrefs !== undefined) {
      if (!confirm("Throw away all your team picks?")) return;
      S.comparisons = [];
      save(LS.comparisons, S.comparisons);
      computePrefs();
      renderTeams(S, sections.teams);
      renderSchedule(S, sections.watch);
      S.analysis = null;
      renderCheer(S, sections.guide);
    } else if (t.dataset.clearAttended !== undefined) {
      S.attended.clear();
      onAttendedChanged();
    } else if (t.dataset.cheerSort) {
      S.cheerSort = t.dataset.cheerSort;
      renderCheer(S, sections.guide);
    } else if (t.dataset.pin) {
      if (S.pinned.has(t.dataset.pin)) S.pinned.delete(t.dataset.pin);
      else S.pinned.add(t.dataset.pin);
      save(LS.pinned, [...S.pinned]);
      computePrefs();
      renderTeams(S, sections.teams);
      renderSchedule(S, sections.watch);
      scheduleAnalyze();
    } else if (t.dataset.fanTeam !== undefined) {
      setFanTeam(t.dataset.fanTeam);
    } else if (t.dataset.pathSort) {
      S.pathSort = t.dataset.pathSort;
      renderPath(S, sections.path);
    } else if (t.dataset.icsTier) {
      downloadICS({ tier: t.dataset.icsTier });
    } else if (t.dataset.ics) {
      downloadICS({ matchId: t.dataset.ics });
    } else if (t.dataset.selTeam) {
      const { mid, slot, selTeam } = t.dataset;
      const sel = (S.matchupSel[mid] ||= {});
      sel[slot] = sel[slot] === selTeam ? undefined : selTeam;
      renderProbs(S, sections.probs);
    } else if (t.dataset.share !== undefined) {
      const data = {
        title: "World Cup 2026 — who should I cheer for?",
        url: "https://worldcupcheerguide.com/",
      };
      if (navigator.share) {
        navigator.share(data).catch(() => {});  // user cancelled — fine
      } else {
        navigator.clipboard?.writeText(data.url).then(() => {
          const icon = t.innerHTML;
          t.innerHTML = "✓ copied";
          setTimeout(() => { t.innerHTML = icon; }, 1500);
        });
      }
    } else if (t.dataset.info !== undefined) {
      $("#info-dialog")?.showModal();
    } else if (t.dataset.infoClose !== undefined) {
      $("#info-dialog")?.close();
    }
  });

  // Click on the dimmed backdrop closes the overlay (the dialog element
  // itself is only the click target when the click lands outside its box).
  $("#info-dialog")?.addEventListener("click", (ev) => {
    if (ev.target === ev.currentTarget) ev.currentTarget.close();
  });

  document.addEventListener("change", (ev) => {
    const t = ev.target;
    if (t.dataset?.mid) {
      if (t.checked) S.attended.add(t.dataset.mid);
      else S.attended.delete(t.dataset.mid);
      onAttendedChanged();
    } else if (t.id === "fan-team") {
      setFanTeam(t.value);
    } else if (t.id === "venue-filter") {
      S.venueFilter = t.value;
      renderMatches(S, sections.matches);
    }
  });

  window.addEventListener("hashchange", () => setTab(location.hash.slice(1)));
}

// --- boot ------------------------------------------------------------------------------

async function boot() {
  for (const name of Object.keys(sections)) sections[name] = $(`#tab-${name}`);
  wireEvents();

  // no-cache = always revalidate (cheap 304s via ETag) — the data must track
  // the 2-hourly results refresh, not the CDN's 10-minute cache window.
  const [tournament, results] = await Promise.all([
    fetch("data/tournament.json", { cache: "no-cache" }).then((r) => r.json()),
    fetch("data/results.json", { cache: "no-cache" })
      .then((r) => r.json())
      .catch(() => ({ group_results: {}, knockout: {} })),
  ]);
  S.tournament = tournament;
  S.results = results;
  S.ratings = tournament.ratings;
  // The ranking pool is always all 48 teams — preferences feed every tab
  // (must-watch, cheer guide), not just attended matches.
  S.pool = Object.keys(S.ratings).sort();
  S.prep = prepare(tournament);
  S.playedCount = Object.keys(results.group_results || {}).length;

  const groupMatches = tournament.group_games.map((g) => ({ kind: "group", ...g }));
  S.ko = tournament.knockout.map((m) => ({ kind: "ko", ...m }));
  S.allMatches = [...groupMatches, ...S.ko]
    .sort((a, b) => a.kickoff.localeCompare(b.kickoff));
  S.groupById = new Map(groupMatches.map((m) => [m.id, m]));
  S.koById = new Map(S.ko.map((m) => [m.id, m]));
  for (const [id, entry] of Object.entries(results.knockout || {})) {
    if (entry.team1 && entry.team2) S.koKnown[id] = [entry.team1, entry.team2];
  }

  computeStandings();
  computePrefs();
  renderAll();
  setTab(location.hash.slice(1) || "path");

  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.onmessage = onWorkerMessage;
  startSimulation();
}

boot().catch((err) => {
  document.body.insertAdjacentHTML("beforeend",
    `<p class="error">Failed to load: ${err?.message || err}</p>`);
  throw err;
});
