/*
 * views.js — pure render functions: state in, HTML out. No fetches, no
 * worker calls; app.js owns state and event wiring (via data-* attributes
 * and event delegation).
 */

import { teamLabel, displayName, flag, kickoffParts, fmtKickoff, slotDesc,
         ROUND_SHORT, pct, esc } from "./format.js";

const bar = (p, cls = "") =>
  `<span class="bar ${cls}"><span style="width:${Math.max(0, Math.min(100, p * 100))}%"></span></span>`;

const matchChip = (m) =>
  m.kind === "group" || m.group !== undefined
    ? `<span class="chip">Group ${esc(m.group)}</span>`
    : `<span class="chip">${esc(ROUND_SHORT[m.round] || m.round)} · M${m.num ?? m.id?.slice(1)}</span>`;

// ---------------------------------------------------------------------------
// Cheer guide
// ---------------------------------------------------------------------------

export function renderCheer(S, el) {
  const haveTeams = S.comparisons.length > 0;
  const haveMatches = S.attended.size > 0;

  if (!haveTeams || !haveMatches) {
    el.innerHTML = `
      <div class="onboard">
        <h2>Get your personal cheering guide</h2>
        <ol>
          <li class="${haveMatches ? "done" : ""}">
            <strong>Pick the matches you're attending</strong> — the guide optimizes
            who you'll see in person.
            <button class="btn" data-goto="matches">My matches ${haveMatches ? "✓" : "→"}</button>
          </li>
          <li class="${haveTeams ? "done" : ""}">
            <strong>Rank the teams you want to see</strong> — quick head-to-head picks.
            <button class="btn" data-goto="teams">My teams ${haveTeams ? "✓" : "→"}</button>
          </li>
        </ol>
        <p class="muted">Then this tab tells you, for every remaining game, who to cheer
        for to maximize the chance your favorite teams end up on the pitch in front of you.</p>
      </div>`;
    return;
  }

  if (!S.analysis) {
    el.innerHTML = `<p class="muted">${simStatusLine(S)}</p>`;
    return;
  }

  const { rows, summary } = S.analysis;
  const attendedLabels = [...S.attended].map((id) => attendedShort(S, id)).join(", ");
  const spread = (() => {
    const vals = Object.values(S.weights);
    return vals.length ? Math.max(...vals) - Math.min(...vals) : 0;
  })();

  const significant = rows.filter((r) => r.significant);
  const suppressed = significant.filter((r) => r.loyalty?.suppressible);
  const main = significant.filter((r) => !r.loyalty?.suppressible);
  const negligible = rows.filter((r) => !r.significant);
  const maxImpact = main.length ? main[0].impact : 1;
  const sorted = S.cheerSort === "date"
    ? [...main].sort((a, b) => a.kickoff.localeCompare(b.kickoff))
    : main;

  const recOf = (r) => r.best === "D" ? null : (r.best === "A" ? r.a : r.b);
  const oppOf = (r) => r.best === "A" ? r.b : r.a;

  const rowHtml = (r) => {
    const rec = recOf(r);
    const upset = rec !== null &&
      (S.ratings[rec] ?? 0) < (S.ratings[oppOf(r)] ?? 0);
    const means = ["A", "D", "B"].filter((o) => r.means[o] !== undefined)
      .map((o) => {
        const lbl = o === "D" ? "draw" : displayName(o === "A" ? r.a : r.b);
        return `${esc(lbl)} ${r.means[o].toFixed(2)}`;
      }).join(" · ");
    const loy = r.loyalty && !r.loyalty.suppressible ? `
      <p class="loyalty">⚠️ Yes — this roots <strong>against ${teamLabel(r.loyalty.against)}</strong>,
      but it's their best path to your matches:
      ${pct(r.loyalty.pWin)} → ${pct(r.loyalty.pRec)} (+${Math.round(r.loyalty.swing * 100)}pp)</p>` : "";
    return `
      <article class="card cheer-card">
        <div class="cheer-head">
          ${matchChip(r)}
          <span class="matchup">${teamLabel(r.a)} <em>vs</em> ${teamLabel(r.b)}</span>
          <span class="when muted">${fmtKickoff(r.kickoff)} · ${esc(r.ground)}</span>
        </div>
        <div class="cheer-rec">
          ${rec ? `Cheer for <strong>${teamLabel(rec)}</strong>` : "Root for a <strong>draw</strong>"}
          ${upset ? '<span class="chip upset">underdog!</span>' : ""}
        </div>
        <div class="cheer-impact" title="How much this one result swings your expected lineup score">
          ${bar(r.impact / maxImpact, "impact")}<span class="muted">impact ${r.impact.toFixed(3)}</span>
        </div>
        <p class="muted small">E[lineup] by outcome: ${means}</p>
        ${loy}
      </article>`;
  };

  el.innerHTML = `
    <div class="card summary">
      <p><strong>Your matches:</strong> ${esc(attendedLabels)}</p>
      <p><strong>Top pick:</strong> ${teamLabel(summary.topTeam)} —
        <strong>${pct(summary.pTopInLineup)}</strong> chance they play in front of you.
        Expected lineup score ${summary.baselineU.toFixed(2)}.</p>
      ${spread < 0.05 ? `<p class="warn">Your preferences are nearly flat — make more
        picks in <a href="#teams">My teams</a> for a sharper guide.</p>` : ""}
      <p class="muted small">${simStatusLine(S)}</p>
    </div>
    <div class="cheer-controls">
      <h2>Games that matter most</h2>
      <span class="seg">
        <button class="btn small ${S.cheerSort !== "date" ? "active" : ""}" data-cheer-sort="impact">by impact</button>
        <button class="btn small ${S.cheerSort === "date" ? "active" : ""}" data-cheer-sort="date">by date</button>
      </span>
    </div>
    ${sorted.length ? sorted.map(rowHtml).join("") : `
      <p class="muted">No single remaining game meaningfully moves your odds —
      your favorites' path barely depends on any one result.</p>`}
    ${suppressed.length ? `
      <h2>Loyalty notes</h2>
      <p class="muted small">Pure math says root against a team you like in these —
      but the payoff is too small to be worth it. Just cheer for your team.</p>
      ${suppressed.map((r) => `
        <p class="note">• <strong>${teamLabel(r.a)} vs ${teamLabel(r.b)}</strong>
        (${fmtKickoff(r.kickoff)}): utility says root against
        ${esc(displayName(r.loyalty.against))}, but that only moves their odds
        ${pct(r.loyalty.pWin)} → ${pct(r.loyalty.pRec)}
        (+${Math.round(r.loyalty.swing * 100)}pp) — just root for
        ${esc(displayName(r.loyalty.against))}.</p>`).join("")}` : ""}
    ${negligible.length ? `
      <details class="muted">
        <summary>${negligible.length} more upcoming games are within simulation noise</summary>
        <p class="small">These don't meaningfully change who you'll see:
        ${negligible.map((r) => `${esc(displayName(r.a))}–${esc(displayName(r.b))}`).join(", ")}.</p>
      </details>` : ""}`;
}

function attendedShort(S, id) {
  const ko = S.koById.get(id);
  if (ko) return `M${ko.num} (${ko.ground.split(" (")[0]}, ${kickoffParts(ko.kickoff).dateLabel})`;
  const g = S.groupById.get(id);
  if (g) return `${displayName(g.a)}–${displayName(g.b)} (${kickoffParts(g.kickoff).dateLabel})`;
  return id;
}

function simStatusLine(S) {
  if (S.simStatus.state === "running") {
    const p = S.simStatus.total ? Math.round(100 * S.simStatus.done / S.simStatus.total) : 0;
    return `Simulating ${S.settings.nSims.toLocaleString()} tournaments… ${p}%`;
  }
  return `${S.meta.nSims.toLocaleString()} simulated tournaments · ` +
         `${S.playedCount} of 72 group games played` +
         (S.results?.fetched_at ? ` · results updated ${S.results.fetched_at.slice(0, 10)}` : "");
}

// ---------------------------------------------------------------------------
// My matches
// ---------------------------------------------------------------------------

export function renderMatches(S, el) {
  const all = S.allMatches; // precomputed, kickoff-sorted descriptors
  const venues = [...new Set(all.map((m) => m.ground))].sort();
  const filtered = S.venueFilter ? all.filter((m) => m.ground === S.venueFilter) : all;

  const groupsByDate = new Map();
  for (const m of filtered) {
    const { dateLabel } = kickoffParts(m.kickoff);
    if (!groupsByDate.has(dateLabel)) groupsByDate.set(dateLabel, []);
    groupsByDate.get(dateLabel).push(m);
  }

  const rowHtml = (m) => {
    const checked = S.attended.has(m.id) ? "checked" : "";
    const { timeLabel } = kickoffParts(m.kickoff);
    let label;
    if (m.kind === "group") {
      const res = S.results?.group_results?.[m.id];
      label = `${teamLabel(m.a)} <em>vs</em> ${teamLabel(m.b)}` +
        (res ? ` <span class="score">${res[0]}–${res[1]}</span>` : "");
    } else {
      const known = S.koKnown[m.id];
      const played = S.results?.knockout?.[m.id];
      label = known
        ? `${teamLabel(known[0])} <em>vs</em> ${teamLabel(known[1])}` +
          (played?.score ? ` <span class="score">${played.score[0]}–${played.score[1]}</span>` : "")
        : `${esc(slotDesc(m.slot1))} <em>vs</em> ${esc(slotDesc(m.slot2))}`;
    }
    return `
      <label class="match-row ${checked ? "selected" : ""}">
        <input type="checkbox" data-mid="${esc(m.id)}" ${checked}>
        <span class="time muted">${timeLabel}</span>
        ${matchChip(m)}
        <span class="label">${label}</span>
        <span class="venue muted">${esc(m.ground)}</span>
      </label>`;
  };

  el.innerHTML = `
    <div class="card">
      <p>Check every match you'll attend in person. The cheer guide maximizes the
      chance your favorite teams appear in <em>these</em> matches.</p>
      <div class="toolbar">
        <select id="venue-filter">
          <option value="">All venues</option>
          ${venues.map((v) => `<option value="${esc(v)}" ${v === S.venueFilter ? "selected" : ""}>${esc(v)}</option>`).join("")}
        </select>
        <span class="muted">${S.attended.size} selected</span>
        ${S.attended.size ? '<button class="btn small" data-clear-attended>clear all</button>' : ""}
      </div>
    </div>
    ${[...groupsByDate.entries()].map(([date, ms]) => `
      <h3 class="datehead">${esc(date)}</h3>
      ${ms.map(rowHtml).join("")}`).join("")}`;
}

// ---------------------------------------------------------------------------
// My teams (head-to-head ranking)
// ---------------------------------------------------------------------------

export function renderTeams(S, el) {
  const pair = S.currentPair;
  const poolNote = S.attended.size
    ? `Ranking the <strong>${S.pool.length}</strong> teams that can still reach your selected matches.`
    : `Ranking all <strong>${S.pool.length}</strong> teams — select your matches to narrow the pool.`;

  const ranking = S.pool
    .map((t) => ({ t, w: S.weights[t] ?? 0.5, c: S.counts.get(t) ?? 0 }))
    .sort((x, y) => y.w - x.w);

  el.innerHTML = `
    <div class="card">
      <p>Which team would you rather watch live? Click to pick — every pick sharpens
      your ranking. Stop whenever you like.</p>
      <p class="muted small">${poolNote} ${S.comparisons.length} picks so far.</p>
      ${pair ? `
        <div class="duel">
          <button class="duel-btn" data-pick="${esc(pair[0])}" data-loser="${esc(pair[1])}">
            <span class="duel-flag">${flag(pair[0])}</span>${esc(displayName(pair[0]))}
          </button>
          <span class="duel-vs">vs</span>
          <button class="duel-btn" data-pick="${esc(pair[1])}" data-loser="${esc(pair[0])}">
            <span class="duel-flag">${flag(pair[1])}</span>${esc(displayName(pair[1]))}
          </button>
        </div>` : `<p class="muted">Not enough teams to compare.</p>`}
      <div class="toolbar">
        <button class="btn small" data-skip>skip pair</button>
        <button class="btn small" data-undo ${S.comparisons.length ? "" : "disabled"}>undo last</button>
        <button class="btn small danger" data-reset-prefs ${S.comparisons.length ? "" : "disabled"}>reset all</button>
      </div>
    </div>
    <h2>Your ranking <span class="muted small">(most → least want to see)</span></h2>
    <ol class="ranking">
      ${ranking.map(({ t, w, c }) => `
        <li class="${c === 0 ? "unrated" : ""}">
          <span class="rk-team">${teamLabel(t)}</span>
          ${bar(w)}
          <span class="muted small">${w.toFixed(2)}${c < 2 ? " · few picks" : ""}</span>
        </li>`).join("")}
    </ol>`;
}

// ---------------------------------------------------------------------------
// Probabilities (preference-independent forecast)
// ---------------------------------------------------------------------------

export function renderProbs(S, el) {
  if (!S.probs) {
    el.innerHTML = `<p class="muted">${simStatusLine(S)}</p>`;
    return;
  }

  const slotList = (entries, known) => {
    if (known) return `<li class="locked">${teamLabel(known)} <strong>✓</strong></li>`;
    const top = entries.slice(0, 4);
    const rest = entries.length - top.length;
    return top.map(([t, p]) =>
      `<li>${teamLabel(t)} <span class="p">${pct(p)}</span>${bar(p)}</li>`).join("") +
      (rest > 0 ? `<li class="muted small">+ ${rest} more</li>` : "");
  };

  const koCard = (m, i) => {
    const known = S.koKnown[m.id];
    const played = S.results?.knockout?.[m.id];
    const result = played?.score
      ? `<p class="result">Final: <strong>${teamLabel(played.team1)} ${played.score[0]}–${played.score[1]} ${teamLabel(played.team2)}</strong></p>`
      : "";
    const probs = S.probs.matches[i];
    return `
      <article class="card ko-card ${S.attended.has(m.id) ? "attending" : ""}">
        <header>
          <strong>M${m.num}</strong> · ${esc(m.ground)}
          <span class="muted">${fmtKickoff(m.kickoff)}</span>
          ${S.attended.has(m.id) ? '<span class="chip attend">attending</span>' : ""}
        </header>
        ${result}
        <div class="slots">
          <div><h4>${esc(slotDesc(m.slot1))}</h4><ul>${slotList(probs.slot1, known?.[0])}</ul></div>
          <div><h4>${esc(slotDesc(m.slot2))}</h4><ul>${slotList(probs.slot2, known?.[1])}</ul></div>
        </div>
      </article>`;
  };

  // Attended matches get a pinned section up top — no scrolling to find them.
  const attendedKo = S.ko.filter((m) => S.attended.has(m.id));
  const attendedGroup = [...S.attended]
    .map((id) => S.groupById.get(id)).filter(Boolean)
    .sort((a, b) => a.kickoff.localeCompare(b.kickoff));
  const groupGameCard = (g) => {
    const res = S.results?.group_results?.[g.id];
    return `
      <article class="card ko-card attending">
        <header>
          <span class="chip">Group ${esc(g.group)}</span> ${esc(g.ground)}
          <span class="muted">${fmtKickoff(g.kickoff)}</span>
          <span class="chip attend">attending</span>
        </header>
        <p>${teamLabel(g.a)} <em class="muted">vs</em> ${teamLabel(g.b)}
          ${res ? `<span class="score">${res[0]}–${res[1]}</span>` : ""}</p>
        <p class="muted small">Group game — you already know who you'll see.</p>
      </article>`;
  };
  const yourSection = (attendedKo.length || attendedGroup.length) ? `
    <h2>⭐ Your matches</h2>
    <div class="grid">
      ${attendedGroup.map(groupGameCard).join("")}
      ${attendedKo.map((m) => koCard(m, m.num - 73)).join("")}
    </div>` : "";

  const rounds = ["Round of 32", "Round of 16", "Quarter-final", "Semi-final",
                  "Match for third place", "Final"];
  const koSections = rounds.map((round) => {
    const ms = S.ko.filter((m) => m.round === round);
    return `<h2>${esc(round)}</h2><div class="grid">${
      ms.map((m) => koCard(m, m.num - 73)).join("")}</div>`;
  }).join("");

  const groupCard = (L) => {
    const standings = S.standings[L]; // [{team, played, pts, gd}] current order
    return `
      <article class="card group-card">
        <header><strong>Group ${L}</strong></header>
        <table>
          <tr><th></th><th title="played">P</th><th title="points">Pts</th>
              <th>1st</th><th>2nd</th><th title="reach knockout">Adv</th></tr>
          ${standings.map((s) => `
            <tr>
              <td>${teamLabel(s.team)}</td>
              <td class="muted">${s.played}</td><td>${s.pts}</td>
              <td>${pct(S.groupProbs[s.team].first)}</td>
              <td>${pct(S.groupProbs[s.team].second)}</td>
              <td><strong>${pct(S.groupProbs[s.team].advance)}</strong></td>
            </tr>`).join("")}
        </table>
      </article>`;
  };

  el.innerHTML = `
    <div class="card summary">
      <p class="muted small">${simStatusLine(S)} · seed ${S.meta.seed}</p>
      <div class="toolbar">
        <label>Simulations:
          <select id="nsims">
            ${[10000, 20000, 50000].map((n) =>
              `<option value="${n}" ${n === S.settings.nSims ? "selected" : ""}>${n.toLocaleString()}</option>`).join("")}
          </select>
        </label>
      </div>
    </div>
    ${yourSection}
    <h2>Champion odds</h2>
    <div class="card">
      <ul class="champ">
        ${S.probs.champion.slice(0, 12).map(([t, p]) =>
          `<li>${teamLabel(t)} <span class="p">${pct(p)}</span>${bar(p, "champ-bar")}</li>`).join("")}
      </ul>
    </div>
    <h2>Group stage</h2>
    <div class="grid groups">${"ABCDEFGHIJKL".split("").map(groupCard).join("")}</div>
    ${koSections}`;
}
