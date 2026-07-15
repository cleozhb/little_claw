export const APP_TIME_ZONE = "Asia/Shanghai";

export interface AppClock {
  now(): Date;
  formatDate(date: Date): string;
  formatTime(date: Date): string;
}

const DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: APP_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: APP_TIME_ZONE,
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
});

export const systemAppClock: AppClock = {
  now: () => new Date(),
  formatDate: (date) => {
    const parts = DATE_FORMATTER.formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    return `${year}-${month}-${day}`;
  },
  formatTime: (date) => TIME_FORMATTER.format(date),
};
