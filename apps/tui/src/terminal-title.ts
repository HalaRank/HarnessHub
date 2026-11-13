const frames = [..."⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"];

export function createTerminalTitle(setTitle: (title: string) => void) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let active = false;
  let disposed = false;
  let frame = 0;
  setTitle("hhu");

  const stop = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  return {
    update(running: boolean) {
      if (disposed || active === running) return;
      active = running;
      stop();
      if (!running) {
        setTitle("hhu");
        return;
      }
      frame = 0;
      const tick = () => {
        setTitle(`${frames[frame]} hhu`);
        frame = (frame + 1) % frames.length;
      };
      tick();
      timer = setInterval(tick, 100);
      timer.unref();
    },
    dispose() {
      disposed = true;
      stop();
    },
  };
}
