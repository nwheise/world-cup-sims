/*
 * schedule.js — the "Must-watch" tab's math, pure (no DOM, no fetches):
 * score every remaining match by how much THIS user would enjoy watching it,
 * tier the schedule into must-watch / worth-a-watch / the rest, and build an
 * iCalendar (.ics) export.
 *
 * The payoff of the "My teams" head-to-head game: a match's appeal is the
 * expected emphasized preference of the teams on the pitch — the same
 * emphasize() curve the cheer guide uses for lineup quality, so the two
 * features agree about what a "favorite" is worth:
 *   group game:  emphasize(w_a) + emphasize(w_b)            (teams known)
 *   knockout:    Σ_teams P(team appears) · emphasize(w_t)   (slot odds from
 *                the worker's appearanceProbs — no extra simulation needed)
 * Played matches are excluded; knockout matches with locked-in participants
 * score exactly like group games because their slot odds collapse to 1.
 */

import { emphasize } from "./sim-core.js";
import { displayName, slotDesc, ROUND_SHORT } from "./format.js";

/** Tier sizes: top MUST_COUNT by appeal are must-watch (plus every match
 *  featuring a pinned team), the next WORTH_COUNT are worth a watch. */
export const MUST_COUNT = 10;
export const WORTH_COUNT = 15;

/**
 * Score every not-yet-played match.
 *
 * matches: app-state descriptors ({kind:"group", a, b, ...} | {kind:"ko",
 * num, slot1, slot2, ...}); probs: the worker's serialized appearance probs
 * (probs.matches[num-73].slot1/slot2 = [[team, p], ...]) or null while the
 * simulation is still running (knockout matches are skipped until it lands);
 * weights: {team: 0..1}; results: results.json content.
 *
 * Returns [{ m, score, teams, slot1, slot2 }] where teams is the merged
 * contributor list [{team, p, w, c}] sorted by contribution c = p·emphasize(w)
 * (a team that can reach either side of a match — e.g. the final — has its
 * slot odds summed), and slot1/slot2 are the per-side [team, p] lists
 * (null for group games).
 */
export function scoreMatches(matches, probs, weights, results) {
  const out = [];
  for (const m of matches) {
    let entries, slot1 = null, slot2 = null;
    if (m.kind === "group") {
      if (results?.group_results?.[m.id]) continue; // played
      entries = [[m.a, 1], [m.b, 1]];
    } else {
      if (results?.knockout?.[m.id]?.score) continue; // played
      const pm = probs?.matches?.[m.num - 73];
      if (!pm) continue; // simulation not finished yet
      slot1 = pm.slot1;
      slot2 = pm.slot2;
      entries = [...pm.slot1, ...pm.slot2];
    }
    const byTeam = new Map();
    for (const [t, p] of entries) byTeam.set(t, (byTeam.get(t) ?? 0) + p);
    const teams = [...byTeam].map(([team, p]) => {
      const w = weights[team] ?? 0;
      return { team, p, w, c: p * emphasize(w) };
    }).sort((x, y) => y.c - x.c);
    const score = teams.reduce((s, { c }) => s + c, 0);
    out.push({ m, score, teams, slot1, slot2 });
  }
  return out;
}

/** A match's lineup is decided when both sides are known: every group game,
 *  and a knockout game once its slot odds have collapsed to single entries
 *  (real results pin the participants, so all sims agree). */
export function isDecided(s) {
  return !s.slot1 || (s.slot1.length === 1 && s.slot2.length === 1);
}

/**
 * Split scored matches into { must, worth, rest }, each sorted by kickoff
 * (it's a schedule). Only DECIDED matches (see isDecided) can tier: a
 * speculative knockout game — "you might see someone interesting" — stays in
 * rest until its lineup locks in, then competes like a group game. Must-watch
 * = every decided match featuring a pinned team (a fan never misses their own
 * team's games, whatever the math says — same philosophy as the cheer guide's
 * pinned override) PLUS the top `mustCount` decided matches by appeal among
 * everything else. Pinned matches don't consume those score slots, and pinned
 * weight = 1.0 can't distort the slot race either (every decided match with
 * a pinned team is promoted, so no slot candidate contains one): pinning only
 * ever grows the must list, never reshuffles it. Worth = the next
 * `worthCount` decided matches by appeal.
 */
export function buildTiers(scored, pinned = new Set(),
                           { mustCount = MUST_COUNT, worthCount = WORTH_COUNT } = {}) {
  const kickoff = (x, y) => x.m.kickoff.localeCompare(y.m.kickoff);
  const byScore = [...scored].sort((x, y) => (y.score - x.score) || kickoff(x, y));
  const mustIds = new Set();
  for (const s of scored) {
    if (isDecided(s) && s.teams.some(({ team }) => pinned.has(team))) {
      mustIds.add(s.m.id);
    }
  }
  const candidates = byScore.filter((s) => isDecided(s) && !mustIds.has(s.m.id));
  for (const s of candidates.slice(0, mustCount)) mustIds.add(s.m.id);
  const must = [], worth = [], rest = [];
  for (const s of byScore) {
    if (mustIds.has(s.m.id)) must.push(s);
    else if (isDecided(s) && worth.length < worthCount) worth.push(s);
    else rest.push(s);
  }
  const byDate = (a, b) => a.m.kickoff.localeCompare(b.m.kickoff);
  return { must: must.sort(byDate), worth: worth.sort(byDate), rest: rest.sort(byDate) };
}

/** 1-based "your #N" rank per team: pinned favorites first, then by weight —
 *  the same order the My-teams ranking list displays. */
export function rankMap(weights, pinned = new Set()) {
  const order = Object.keys(weights).sort((a, b) =>
    ((pinned.has(b) ? 1 : 0) - (pinned.has(a) ? 1 : 0)) || (weights[b] - weights[a]));
  return new Map(order.map((t, i) => [t, i + 1]));
}

// ---------------------------------------------------------------------------
// iCalendar export (RFC 5545)
// ---------------------------------------------------------------------------

/** Broadcast windows, generous on purpose: knockout games can run to
 *  extra time and penalties. */
export const DURATION_MIN = { group: 120, ko: 165 };

const SITE = "https://worldcupcheerguide.com/";

/** ISO datetime (any offset) -> ICS UTC stamp "20260611T190000Z". */
export function icsStamp(d) {
  return new Date(d).toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
}

/** RFC 5545 TEXT escaping: backslash, semicolon, comma, newline. */
export function icsEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;")
    .replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

const utf8len = (s) => new TextEncoder().encode(s).length;

/** Fold a content line at 75 octets (continuations start with a space),
 *  splitting on code points so multi-byte chars/flags never get cut. */
export function icsFold(line) {
  if (utf8len(line) <= 75) return line;
  const parts = [];
  let cur = "";
  for (const ch of line) {
    if (utf8len(cur + ch) > 75) { parts.push(cur); cur = " "; }
    cur += ch;
  }
  parts.push(cur);
  return parts.join("\r\n");
}

const uidSlug = (id) => String(id).toLowerCase().replace(/[^a-z0-9]+/g, "-");

/**
 * Scored matches -> calendar event descriptors. Summaries name the teams when
 * they're known (group games, locked knockout pairings) and the bracket slots
 * otherwise; descriptions say WHY the match made the user's list ("Argentina
 * — your #1, 64% to be here").
 */
export function matchEvents(list, weights = {}, pinned = new Set()) {
  const ranks = rankMap(weights, pinned);
  return list.map((s) => {
    const m = s.m;
    const why = s.teams
      .filter(({ p, c }) => p >= 0.05 && c >= 0.02)
      .slice(0, 3)
      .map(({ team, p }) => `${displayName(team)} (your #${ranks.get(team) ?? "?"}${
        p >= 0.995 ? "" : `, ${Math.round(p * 100)}% to be here`})`)
      .join(", ");
    let summary, desc;
    if (m.kind === "group") {
      summary = `⚽ ${displayName(m.a)} vs ${displayName(m.b)} — World Cup Group ${m.group}`;
      desc = `World Cup 2026 group stage.`;
    } else {
      const locked = s.slot1.length === 1 && s.slot2.length === 1;
      const round = ROUND_SHORT[m.round] || m.round;
      summary = locked
        ? `⚽ ${displayName(s.slot1[0][0])} vs ${displayName(s.slot2[0][0])} — World Cup ${round}`
        : `⚽ World Cup ${round}: ${slotDesc(m.slot1)} vs ${slotDesc(m.slot2)}`;
      desc = `World Cup 2026 ${m.round} (match ${m.num}).`;
      if (!locked) {
        const likely = (sl) => displayName(sl[0][0]);
        desc += ` Most likely: ${likely(s.slot1)} vs ${likely(s.slot2)}.`;
      }
    }
    if (why) desc += ` On your must-watch list because of ${why}.`;
    desc += ` Live odds: ${SITE}`;
    return {
      id: m.id,
      start: m.kickoff,
      durationMin: m.kind === "group" ? DURATION_MIN.group : DURATION_MIN.ko,
      summary, location: m.ground, description: desc,
    };
  });
}

/**
 * Build a complete VCALENDAR from event descriptors ({id, start (ISO with
 * offset), durationMin, summary, location, description}). `now` is injected
 * (DTSTAMP) so output is deterministic under test.
 */
export function buildICS(events, now) {
  const stamp = icsStamp(now);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//worldcupcheerguide.com//Must-watch schedule//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:World Cup 2026 — my must-watch matches",
  ];
  for (const ev of events) {
    const start = new Date(ev.start);
    const end = new Date(start.getTime() + ev.durationMin * 60000);
    lines.push(
      "BEGIN:VEVENT",
      `UID:wc26-${uidSlug(ev.id)}@worldcupcheerguide.com`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsStamp(start)}`,
      `DTEND:${icsStamp(end)}`,
      `SUMMARY:${icsEscape(ev.summary)}`,
      `LOCATION:${icsEscape(ev.location)}`,
      `DESCRIPTION:${icsEscape(ev.description)}`,
      `URL:${SITE}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(icsFold).join("\r\n") + "\r\n";
}
