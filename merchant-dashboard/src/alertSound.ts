/**
 * The new-order alarm.
 *
 * A shopkeeper is not staring at a laptop — they are serving someone at the
 * counter. A silent badge is not an alert. This makes a sound, and keeps making
 * it until a human acknowledges the order.
 *
 * Synthesised with the Web Audio API rather than shipping an .mp3: no asset to
 * load (so it cannot fail to arrive on a slow connection), no CORS or caching
 * questions, and it works with the dashboard served from anywhere.
 */

/** Two-tone chime, repeated. Deliberately not a pleasant background noise. */
const BEEP_PATTERN = [
  { frequency: 880, startAt: 0, duration: 0.18 },
  { frequency: 1180, startAt: 0.22, duration: 0.3 },
];

/** Gap between repeats while an order is still unacknowledged. */
const REPEAT_MS = 3_000;

export class AlertSound {
  private context: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Browsers block audio until the user has interacted with the page, so the
   * AudioContext starts suspended and must be resumed from a real gesture.
   *
   * The merchant's sign-in click is that gesture — `prime()` is called there.
   * Without this the very first new-order alarm of a session would be silently
   * swallowed by the autoplay policy: no error, no sound, and a missed order.
   */
  async prime(): Promise<void> {
    if (!this.context) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return; // No Web Audio: the banner and tab title still alert.
      this.context = new Ctor();
    }
    if (this.context.state === "suspended") {
      await this.context.resume().catch(() => {
        // Not yet allowed. The next gesture will prime it.
      });
    }
  }

  /** True once the browser will actually let us make a sound. */
  get isReady(): boolean {
    return this.context?.state === "running";
  }

  private playOnce() {
    const ctx = this.context;
    if (!ctx || ctx.state !== "running") return;

    for (const note of BEEP_PATTERN) {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();

      oscillator.frequency.value = note.frequency;
      oscillator.type = "sine";

      // Ramp the volume rather than switching it: an instant start/stop on a
      // sine wave produces an audible click.
      const start = ctx.currentTime + note.startAt;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.25, start + 0.02);
      gain.gain.linearRampToValueAtTime(0, start + note.duration);

      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(start);
      oscillator.stop(start + note.duration + 0.05);
    }
  }

  /** Sounds now, then keeps sounding until stop() is called. */
  start() {
    if (this.timer) return; // Already going — do not stack alarms.
    void this.prime().then(() => this.playOnce());
    this.timer = setInterval(() => this.playOnce(), REPEAT_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get isSounding(): boolean {
    return this.timer !== null;
  }
}

/** One alarm for the whole app — two would beat against each other. */
export const alertSound = new AlertSound();
