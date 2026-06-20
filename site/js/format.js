/*
 * format.js — display helpers: pretty team names (the simulator uses ASCII
 * names internally), emoji flags, kickoff formatting in VENUE-local time, and
 * human descriptions of knockout slot codes.
 */

const DISPLAY = {
  "Turkiye": "Türkiye",
  "Cote d'Ivoire": "Côte d'Ivoire",
  "Curacao": "Curaçao",
};

const FLAGS = {
  "Mexico": "🇲🇽", "South Africa": "🇿🇦", "South Korea": "🇰🇷", "Czechia": "🇨🇿",
  "Canada": "🇨🇦", "Bosnia-Herzegovina": "🇧🇦", "Qatar": "🇶🇦", "Switzerland": "🇨🇭",
  "Brazil": "🇧🇷", "Morocco": "🇲🇦", "Haiti": "🇭🇹", "Scotland": "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
  "USA": "🇺🇸", "Paraguay": "🇵🇾", "Australia": "🇦🇺", "Turkiye": "🇹🇷",
  "Germany": "🇩🇪", "Curacao": "🇨🇼", "Cote d'Ivoire": "🇨🇮", "Ecuador": "🇪🇨",
  "Netherlands": "🇳🇱", "Japan": "🇯🇵", "Sweden": "🇸🇪", "Tunisia": "🇹🇳",
  "Belgium": "🇧🇪", "Egypt": "🇪🇬", "Iran": "🇮🇷", "New Zealand": "🇳🇿",
  "Spain": "🇪🇸", "Cabo Verde": "🇨🇻", "Saudi Arabia": "🇸🇦", "Uruguay": "🇺🇾",
  "France": "🇫🇷", "Senegal": "🇸🇳", "Iraq": "🇮🇶", "Norway": "🇳🇴",
  "Argentina": "🇦🇷", "Algeria": "🇩🇿", "Austria": "🇦🇹", "Jordan": "🇯🇴",
  "Portugal": "🇵🇹", "DR Congo": "🇨🇩", "Uzbekistan": "🇺🇿", "Colombia": "🇨🇴",
  "England": "🏴󠁧󠁢󠁥󠁮󠁧󠁿", "Croatia": "🇭🇷", "Ghana": "🇬🇭", "Panama": "🇵🇦",
};

// One representative team color each, deliberately mid-dark and a touch muted so
// the white percentages on the W/D/L bar stay legible (very light flag colors
// like yellow/orange/sky are darkened here). The flags still do the anchoring.
const COLORS = {
  "Mexico": "#157f3c", "South Africa": "#0a7d5a", "South Korea": "#c0392b", "Czechia": "#11457e",
  "Canada": "#c83a34", "Bosnia-Herzegovina": "#2f5fa8", "Qatar": "#7a213f", "Switzerland": "#cf2e2e",
  "Brazil": "#169148", "Morocco": "#166b3a", "Haiti": "#1b4f9c", "Scotland": "#1f4f8f",
  "USA": "#2a4a9c", "Paraguay": "#c0392b", "Australia": "#0a7d4f", "Turkiye": "#d12e2e",
  "Germany": "#2f2f35", "Curacao": "#1f5fa0", "Cote d'Ivoire": "#c15f15", "Ecuador": "#1f3f8f",
  "Netherlands": "#c15f15", "Japan": "#b01a3a", "Sweden": "#1f6fb2", "Tunisia": "#c0392b",
  "Belgium": "#a8202c", "Egypt": "#b01a2a", "Iran": "#1f7a3d", "New Zealand": "#303034",
  "Spain": "#b81d2a", "Cabo Verde": "#1f4f9c", "Saudi Arabia": "#166b3a", "Uruguay": "#2477b0",
  "France": "#28408c", "Senegal": "#157f3c", "Iraq": "#1f7a3d", "Norway": "#b01a2a",
  "Argentina": "#3a82b8", "Algeria": "#166b3a", "Austria": "#c0392b", "Jordan": "#7a213f",
  "Portugal": "#7a1f2e", "DR Congo": "#2a6fb0", "Uzbekistan": "#1f8a4d", "Colombia": "#a8791a",
  "England": "#c0392b", "Croatia": "#b8323e", "Ghana": "#1f7a3d", "Panama": "#1f3f8f",
};

export const displayName = (t) => DISPLAY[t] || t;
export const flag = (t) => FLAGS[t] || "";
export const teamColor = (t) => COLORS[t] || "#3b4a6b";
export const teamLabel = (t) => `${flag(t)} ${displayName(t)}`.trim();

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "2026-07-01T13:00:00-07:00" -> { dateKey, dateLabel, timeLabel } in VENUE time. */
export function kickoffParts(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return { dateKey: iso, dateLabel: iso, timeLabel: "" };
  const [, y, mo, d, hh, mm] = m;
  const wd = DAYS[new Date(Date.UTC(+y, +mo - 1, +d)).getUTCDay()];
  const h = +hh;
  const timeLabel = `${((h + 11) % 12) + 1}:${mm} ${h < 12 ? "AM" : "PM"}`;
  return {
    dateKey: `${y}-${mo}-${d}`,
    dateLabel: `${wd}, ${MONTHS[+mo - 1]} ${+d}`,
    timeLabel,
  };
}

export const fmtKickoff = (iso) => {
  const { dateLabel, timeLabel } = kickoffParts(iso);
  return `${dateLabel} · ${timeLabel}`;
};

/** Knockout slot code -> human description. */
export function slotDesc(code) {
  let m;
  if ((m = /^1([A-L])$/.exec(code))) return `Group ${m[1]} winner`;
  if ((m = /^2([A-L])$/.exec(code))) return `Group ${m[1]} runner-up`;
  if ((m = /^W(\d+)$/.exec(code))) return `Winner of M${m[1]}`;
  if ((m = /^L(\d+)$/.exec(code))) return `Loser of M${m[1]}`;
  if (code.startsWith("3")) return `3rd place (${code.slice(1)})`;
  return code;
}

export const ROUND_SHORT = {
  "Round of 32": "R32", "Round of 16": "R16", "Quarter-final": "QF",
  "Semi-final": "SF", "Match for third place": "3rd place", "Final": "Final",
};

/** UTC ISO timestamp -> "Jun 11 at 4:04 PM" in the VIEWER's local timezone. */
export function fmtTimestamp(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${date} at ${time}`;
}

export function pct(p) {
  if (p >= 0.995) return "100%";
  if (p > 0 && p < 0.01) return "<1%";
  return `${Math.round(p * 100)}%`;
}

export const esc = (s) => String(s)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");
