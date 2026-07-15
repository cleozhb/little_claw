import { expect, test } from "bun:test";
import { systemAppClock } from "../../src/utils/AppClock.ts";

test("formats dates and times in Asia/Shanghai", () => {
  const instant = new Date("2026-07-10T16:30:00.000Z");
  expect(systemAppClock.formatDate(instant)).toBe("2026-07-11");
  expect(systemAppClock.formatTime(instant)).toBe("00:30");
});
