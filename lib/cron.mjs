// Minimal 5-field cron evaluator (minute hour day-of-month month day-of-week),
// evaluated in local time like Claude Code's session crons.

const RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];
const NAMES = [
  null,
  null,
  null,
  ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
  ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
];
const MACROS = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

function value(token, field) {
  const names = NAMES[field];
  const index = names ? names.indexOf(token.toLowerCase()) : -1;
  if (index >= 0) return field === 3 ? index + 1 : index;
  if (!/^\d+$/.test(token)) throw new Error(`bad cron value: ${token}`);
  return Number(token);
}

function parseField(text, field) {
  const [min, max] = RANGES[field];
  const allowed = new Set();
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad cron step: ${part}`);
    let lo;
    let hi;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = value(a, field);
      hi = value(b, field);
    } else {
      lo = value(range, field);
      hi = stepText === undefined ? lo : max;
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron value out of range: ${part}`);
    for (let v = lo; v <= hi; v += step) allowed.add(field === 4 && v === 7 ? 0 : v);
  }
  return { allowed, any: text === "*" };
}

export function parseCron(expression) {
  const text = MACROS[expression.trim().toLowerCase()] ?? expression.trim();
  const fields = text.split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron needs 5 fields: ${expression}`);
  return fields.map(parseField);
}

// Next fire time strictly after `after` (epoch ms), or null within a year.
export function nextFire(expression, after = Date.now()) {
  let spec;
  try {
    spec = parseCron(expression);
  } catch {
    return null;
  }
  const [minute, hour, dom, month, dow] = spec;
  const date = new Date(after);
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);
  const limit = after + 366 * 24 * 60 * 60 * 1000;
  while (date.getTime() <= limit) {
    if (!month.allowed.has(date.getMonth() + 1)) {
      date.setMonth(date.getMonth() + 1, 1);
      date.setHours(0, 0, 0, 0);
      continue;
    }
    const domOk = dom.allowed.has(date.getDate());
    const dowOk = dow.allowed.has(date.getDay());
    const dayOk = dom.any || dow.any ? domOk && dowOk : domOk || dowOk;
    if (!dayOk) {
      date.setDate(date.getDate() + 1);
      date.setHours(0, 0, 0, 0);
      continue;
    }
    if (!hour.allowed.has(date.getHours())) {
      date.setHours(date.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!minute.allowed.has(date.getMinutes())) {
      date.setMinutes(date.getMinutes() + 1, 0, 0);
      continue;
    }
    return date.getTime();
  }
  return null;
}
