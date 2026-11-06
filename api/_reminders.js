// SMS reminders and housekeeping. Hobby plans have no sub-daily cron, so this runs opportunistically:
// at most once every few minutes (remgate) from admin polling and uncached public requests,
// plus the admin's manual button. Each appointment is claimed with a lock, so a reminder goes out once.
const { cmd, pipeline, hashValues } = require("./_redis");
const { K, getConfig, allAppts, byNewest } = require("./_data");
const { sendApptSms, templates } = require("./_sms");
const { mutateAppt } = require("./_appts");

const GATE_SEC = 300;
const RETENTION_MS = 180 * 24 * 3600 * 1000;
const MAX_LOGS = 400;
const MAX_NOTIFS = 200;

async function runReminders(ctx, { force = false, budgetMs = 6000 } = {}) {
  const started = Date.now();
  const [config, appts] = await Promise.all([getConfig(ctx), allAppts(ctx)]);
  const windowMs = (Number(config.siteConfig.reminderHoursBefore) || 3) * 3600 * 1000;
  const now = Date.now();
  let sent = 0;
  for (const appt of appts) {
    if (appt.status === "canceled" || appt.reminderSent || appt.noSms) continue;
    const diff = Number(appt.startsAtMs) - now;
    if (!(diff > 0 && (force || diff <= windowMs))) continue;
    if (Date.now() - started > budgetMs) break; // The next run picks up the rest.
    const claimed = await cmd("SET", K(ctx, `remlock:${appt.id}:${appt.startsAtMs}`), "1", "NX", "EX", 8 * 86400);
    if (claimed !== "OK") continue;
    // The write only lands if the row is unchanged, so a cancel or move in the meantime is respected.
    const result = await mutateAppt(ctx, appt.id, (next, prev) => {
      if (prev.status === "canceled" || prev.reminderSent || prev.startsAtMs !== appt.startsAtMs) return false;
      next.reminderSent = true;
    });
    if (!result || !result.changed) continue;
    await sendApptSms(ctx, result.appt, templates.reminder(ctx, result.appt), "reminder");
    sent++;
  }
  return { sent, appts };
}

// Once a day: drop appointments past the retention period and trim the history hashes.
async function maintenance(ctx, appts) {
  if ((await cmd("SET", K(ctx, "maint"), "1", "NX", "EX", 86400)) !== "OK") return;
  const cutoff = Date.now() - RETENTION_MS;
  const cmds = [];
  appts.filter(a => Number(a.startsAtMs) < cutoff).forEach(a => {
    cmds.push(["HDEL", K(ctx, "appts"), a.id]);
    if (a.phone) cmds.push(["SREM", K(ctx, `phoneappts:${a.phone}`), a.id]);
  });
  const [logs, notifs] = await pipeline([["HGETALL", K(ctx, "smslogs")], ["HGETALL", K(ctx, "notifs")]]);
  hashValues(logs).sort(byNewest).slice(MAX_LOGS).forEach(l => cmds.push(["HDEL", K(ctx, "smslogs"), l.id]));
  hashValues(notifs).sort(byNewest).slice(MAX_NOTIFS).forEach(n => cmds.push(["HDEL", K(ctx, "notifs"), n.id]));
  if (cmds.length) { cmds.push(["INCR", K(ctx, "ver")]); await pipeline(cmds); }
}

// gateValue is the remgate value already read by the caller, which saves a command on most requests.
// Errors are swallowed: a reminder problem must not break the page that triggered it.
async function maybeRunReminders(ctx, gateValue) {
  if (gateValue) return;
  try {
    if ((await cmd("SET", K(ctx, "remgate"), "1", "NX", "EX", GATE_SEC)) !== "OK") return;
    const { appts } = await runReminders(ctx);
    await maintenance(ctx, appts);
  } catch (_) {
    console.error("[reminders] run failed");
  }
}

module.exports = { runReminders, maybeRunReminders };
