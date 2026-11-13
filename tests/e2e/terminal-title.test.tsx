import { afterEach, expect, jest, test } from "bun:test";
import { createTerminalTitle } from "../../apps/tui/src/terminal-title";

afterEach(() => jest.useRealTimers());

test("terminal title is hhu when idle and animates only while active", () => {
  jest.useFakeTimers();
  const titles: string[] = [];
  const title = createTerminalTitle((value) => titles.push(value));
  expect(titles).toEqual(["hhu"]);
  title.update(false);
  expect(titles).toHaveLength(1);
  title.update(true);
  expect(titles.at(-1)).toBe("⠋ hhu");
  jest.advanceTimersByTime(100);
  expect(titles.at(-1)).toBe("⠙ hhu");
  title.update(true);
  jest.advanceTimersByTime(100);
  expect(titles.at(-1)).toBe("⠹ hhu");
  jest.advanceTimersByTime(800);
  expect(titles.at(-1)).toBe("⠋ hhu");
  title.update(false);
  expect(titles.at(-1)).toBe("hhu");
  const count = titles.length;
  jest.advanceTimersByTime(1000);
  expect(titles).toHaveLength(count);
  title.dispose();
});

test("terminal title restarts cleanly and disposal stops all further writes", () => {
  jest.useFakeTimers();
  const titles: string[] = [];
  const title = createTerminalTitle((value) => titles.push(value));
  title.update(true);
  jest.advanceTimersByTime(200);
  title.update(false);
  title.update(true);
  expect(titles.at(-1)).toBe("⠋ hhu");
  title.dispose();
  const count = titles.length;
  jest.advanceTimersByTime(2000);
  title.update(false);
  title.update(true);
  title.dispose();
  expect(titles).toHaveLength(count);
});
