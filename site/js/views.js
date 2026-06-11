/*
 * views.js — pure render functions: state in, HTML out. No fetches, no
 * worker calls; app.js owns state and event wiring (via data-* attributes
 * and event delegation).
 */

import { teamLabel, displayName, flag, kickoffParts, fmtKickoff, fmtTimestamp,
         slotDesc, ROUND_SHORT, pct, esc } from "./format.js";

const bar = (p, cls = "") =>
  `<span class="bar ${cls}"><span style="width:${Math.max(0, Math.min(100, p * 100))}%"></span></span>`;

/**
 * "How this result moves your teams" — per liked team, P(they end up in your
 * attended lineup) under each outcome of this game. Rendered only when at
 * least one liked team's odds actually move (>1pp spread), so the guide can
 * show that recommendations weigh EVERY team you like, not just the two
 * playing.
 */
function pLineupTable(r) {
  const teams = Object.entries(r.pLineup || {})
    .filter(([, p]) => {
      const vals = Object.values(p);
      return vals.length >= 2 && Math.max(...vals) - Math.min(...vals) > 0.01;
    });
  if (!teams.length) return "";
  const os = ["A", "D", "B"].filter((o) => r.means[o] !== undefined);
  const head = os.map((o) =>
    `<th class="${o === r.best ? "rec" : ""}">${o === "D" ? "draw" : esc(displayName(o === "A" ? r.a : r.b)) + " wins"}</th>`).join("");
  const rows = teams.map(([t, p]) => `
    <tr><td>${teamLabel(t)}</td>${os.map((o) =>
      `<td class="${o === r.best ? "rec" : ""}">${pct(p[o] ?? 0)}</td>`).join("")}</tr>`).join("");
  return `
    <details class="lineup-detail">
      <summary class="muted small">How this result moves your teams</summary>
      <table class="lineup-table">
        <tr><th>P(in your matches)</th>${head}</tr>
        ${rows}
      </table>
    </details>`;
}

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
    let loy = "";
    if (r.loyalty && !r.loyalty.suppressible) {
      const L = r.loyalty;
      // Spell out what each percentage is and which outcome it belongs to —
      // a bare "8% → 23%" reads as a trend, not two conditional probabilities.
      loy = L.kind === "other" ? `
      <p class="loyalty">⚠️ Yes — this roots <strong>against ${teamLabel(L.against)}</strong>,
      but it boosts <strong>${teamLabel(L.beneficiary)}</strong>: the chance you see
      ${esc(displayName(L.beneficiary))} live at one of your matches is
      <strong>${pct(L.benRec)}</strong> with this result, vs ${pct(L.benWin)} if
      ${esc(displayName(L.against))} won instead (+${Math.round(L.benSwing * 100)}pp).</p>` : `
      <p class="loyalty">⚠️ Yes — this roots <strong>against ${teamLabel(L.against)}</strong>,
      but losing is their best path to your matches (3rd place gets routed there):
      the chance you see ${esc(displayName(L.against))} live is
      <strong>${pct(L.pRec)}</strong> with this result, vs only ${pct(L.pWin)} if they
      won (+${Math.round(L.swing * 100)}pp).</p>`;
    }
    const lineupTable = pLineupTable(r);
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
        <div class="cheer-impact" title="How much this one result swings your expected lineup quality">
          ${bar(r.impact / maxImpact, "impact")}<span class="muted">impact ${r.impact.toFixed(3)}</span>
        </div>
        <p class="muted small">Lineup quality by outcome: ${means}</p>
        ${loy}
        ${lineupTable}
      </article>`;
  };

  el.innerHTML = `
    <div class="card summary">
      <p><strong>Your matches:</strong> ${esc(attendedLabels)}</p>
      <p><strong>Your top picks</strong> — chance each plays in front of you:</p>
      <ul class="top-picks">
        ${(summary.topTeams || []).map(({ team, p }) => `
          <li>${teamLabel(team)} <strong>${pct(p)}</strong>${bar(p)}</li>`).join("")}
      </ul>
      <p class="muted small">Recommendations below maximize your expected
      <strong>lineup quality</strong>: how much you'll like the teams you end up
      watching live, favorites counting extra (0 = none of your teams show up;
      1.0 ≈ one absolute favorite on the pitch).</p>
      ${spread < 0.05 ? `<p class="warn">Your preferences are nearly flat — make more
        picks in <a href="#teams">My teams</a> for a sharper guide.</p>` : ""}
      <p class="muted small">${simStatusLine(S)}</p>
    </div>
    <div class="cheer-controls">
      <h2>Who to cheer for, game by game</h2>
      <span class="seg">
        <button class="btn small ${S.cheerSort === "date" ? "active" : ""}" data-cheer-sort="date">by date</button>
        <button class="btn small ${S.cheerSort !== "date" ? "active" : ""}" data-cheer-sort="impact">by impact</button>
      </span>
    </div>
    ${sorted.length ? sorted.map(rowHtml).join("") : `
      <p class="muted">No single remaining game meaningfully moves your odds —
      your favorites' path barely depends on any one result.</p>`}
    ${suppressed.length ? `
      <h2>Loyalty notes</h2>
      <p class="muted small">Pure math says root against a team you like in these —
      but it doesn't meaningfully improve the odds for any team you like.
      Just cheer for your team.</p>
      ${suppressed.map((r) => {
        const L = r.loyalty;
        const vs = L.swing >= 0
          ? `only nudges their chance of appearing at your matches from ${pct(L.pWin)} (if they win) to ${pct(L.pRec)}`
          : `would actually drop their chance of appearing at your matches from ${pct(L.pWin)} (if they win) to ${pct(L.pRec)}`;
        return `
        <p class="note">• <strong>${teamLabel(r.a)} vs ${teamLabel(r.b)}</strong>
        (${fmtKickoff(r.kickoff)}): raw lineup math leans against
        ${esc(displayName(L.against))}, but that ${vs}, and no other team you
        like meaningfully gains — just root for ${esc(displayName(L.against))}.</p>`;
      }).join("")}` : ""}
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
  return `${S.meta.nSims.toLocaleString()} simulated tournaments` +
         (S.results?.fetched_at ? ` · results updated ${fmtTimestamp(S.results.fetched_at)}` : "");
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
    .map((t) => ({ t, w: S.weights[t] ?? 0.5, c: S.counts.get(t) ?? 0,
                   pinned: S.pinned.has(t) }))
    .sort((x, y) => (y.pinned - x.pinned) || (y.w - x.w));

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
    <p class="muted small">Tap the star to pin a team as an absolute favorite
    (★ = pinned: locked at 1.00, and always ranked above every unpinned team —
    the rest top out at 0.85).</p>
    <ol class="ranking">
      ${ranking.map(({ t, w, c, pinned }) => `
        <li class="${c === 0 && !pinned ? "unrated" : ""} ${pinned ? "pinned" : ""}">
          <button class="pin ${pinned ? "on" : ""}" data-pin="${esc(t)}"
            title="${pinned ? "Unpin" : "Pin as absolute favorite (weight 1.00)"}">${pinned ? "★" : "☆"}</button>
          <span class="rk-team">${teamLabel(t)}</span>
          ${bar(w)}
          <span class="muted small">${w.toFixed(2)}${pinned ? " · pinned" : c < 2 ? " · few picks" : ""}</span>
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

  const slotList = (entries, known, mid, slot, selected) => {
    if (known) return `<li class="locked">${teamLabel(known)} <strong>✓</strong></li>`;
    const expanded = S.expandedSlots.has(`${mid}:${slot}`);
    const top = expanded ? entries : entries.slice(0, 4);
    const rest = entries.length - top.length;
    return top.map(([t, p]) =>
      `<li class="selectable ${t === selected ? "sel" : ""}" data-sel-team="${esc(t)}"
           data-mid="${esc(mid)}" data-slot="${slot}" title="Click to ask: how likely is this exact matchup?">
        <span class="dot" aria-hidden="true"></span><span>${teamLabel(t)}</span>
        <span class="p">${pct(p)}</span>${bar(p)}</li>`).join("") +
      (rest > 0 ? `<li class="muted small more" data-expand-slot data-mid="${esc(mid)}" data-slot="${slot}">+ ${rest} more…</li>` : "");
  };

  const koCard = (m, i) => {
    const known = S.koKnown[m.id];
    const played = S.results?.knockout?.[m.id];
    const result = played?.score
      ? `<p class="result">Final: <strong>${teamLabel(played.team1)} ${played.score[0]}–${played.score[1]} ${teamLabel(played.team2)}</strong></p>`
      : "";
    const probs = S.probs.matches[i];
    const locked = known?.[0] && known?.[1];
    // Top matchups (joint odds) — skip once the real pairing is locked in.
    const matchups = !locked && probs.matchups?.length > 1 ? `
      <div class="matchups">
        <h4>Most likely matchups</h4>
        <ul>${probs.matchups.slice(0, 3).map(([t1, t2, p]) =>
          `<li><span>${teamLabel(t1)}</span><em>vs</em><span>${teamLabel(t2)}</span><span class="p">${pct(p)}</span></li>`).join("")}
        </ul>
      </div>` : "";
    // "What about X vs Y?" — a locked side counts as selected automatically.
    const sel = S.matchupSel[m.id] || {};
    const selA = known?.[0] ?? sel[1], selB = known?.[1] ?? sel[2];
    let selLine = "";
    if (!locked && (selA || selB)) {
      if (selA && selB) {
        const hit = probs.matchups.find(([t1, t2]) => t1 === selA && t2 === selB);
        const p = hit ? hit[2] : 0;
        selLine = `<p class="sel-line">P(<strong>${teamLabel(selA)}</strong> vs
          <strong>${teamLabel(selB)}</strong>) = <strong>${p > 0 ? pct(p)
            : `never in ${S.meta.nSims.toLocaleString()} sims`}</strong></p>`;
      } else {
        selLine = `<p class="sel-line muted small">Pick a team on the other side to
          see that exact matchup's odds.</p>`;
      }
    }
    return `
      <article class="card ko-card ${S.attended.has(m.id) ? "attending" : ""}">
        <header>
          <strong>M${m.num}</strong> · ${esc(m.ground)}
          <span class="muted">${fmtKickoff(m.kickoff)}</span>
          ${S.attended.has(m.id) ? '<span class="chip attend">attending</span>' : ""}
        </header>
        ${result}
        <div class="slots">
          <div><h4>${esc(slotDesc(m.slot1))}</h4><ul>${slotList(probs.slot1, known?.[0], m.id, 1, sel[1])}</ul></div>
          <div><h4>${esc(slotDesc(m.slot2))}</h4><ul>${slotList(probs.slot2, known?.[1], m.id, 2, sel[2])}</ul></div>
        </div>
        ${selLine}
        ${matchups}
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
      <p class="muted small">💡 In any match card below, tap one team on each side
      (the ◌ dots) to see the odds of that exact matchup.</p>
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
