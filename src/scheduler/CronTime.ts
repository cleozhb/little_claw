import { CronExpressionParser } from "cron-parser";

export const SCHEDULER_TIME_ZONE = "Asia/Shanghai";

const SCHEDULER_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: SCHEDULER_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export function getNextCronRun(cronExpr: string, from = new Date()): Date {
  const expr = CronExpressionParser.parse(cronExpr, {
    currentDate: from,
    tz: SCHEDULER_TIME_ZONE,
  });
  return expr.next().toDate();
}

export function cronMatchesMinute(cronExpr: string, now: Date): boolean {
  const startOfMinute = new Date(now);
  startOfMinute.setSeconds(0, 0);

  const justBefore = new Date(startOfMinute.getTime() - 1000);
  const nextDate = getNextCronRun(cronExpr, justBefore);

  return nextDate.getTime() === startOfMinute.getTime();
}

export function formatSchedulerTime(value: Date | string | number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  const parts = Object.fromEntries(
    SCHEDULER_TIME_FORMATTER.formatToParts(date).map((part) => [part.type, part.value]),
  );

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${SCHEDULER_TIME_ZONE}`;
}
