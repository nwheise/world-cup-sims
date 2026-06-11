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

export const displayName = (t) => DISPLAY[t] || t;
export const flag = (t) => FLAGS[t] || "";
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

export function pct(p) {
  if (p >= 0.995) return "100%";
  if (p > 0 && p < 0.01) return "<1%";
  return `${Math.round(p * 100)}%`;
}

export const esc = (s) => String(s)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");
