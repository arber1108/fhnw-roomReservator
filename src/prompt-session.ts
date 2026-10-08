import { PassThrough } from "node:stream";

export type PromptResult<T> = { kind: "value"; value: T } | { kind: "back" };

type TerminalInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
  isRaw?: boolean;
  isPaused?: () => boolean;
  setRawMode?: (mode: boolean) => unknown;
};

type PromptContext = {
  input: NodeJS.ReadableStream;
  signal: AbortSignal;
  clearPromptOnDone: true;
};

class VirtualTerminalInput extends PassThrough {
  isTTY = true;
  isRaw = false;

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    return this;
  }
}

export class PromptInterruptedError extends Error {
  constructor() {
    super("Prompt interrupted");
    this.name = "PromptInterruptedError";
  }
}

/** Keeps the physical terminal in raw mode while Inquirer recreates its prompts. */
export class PromptSession {
  private readonly input = new VirtualTerminalInput();
  private readonly originalRaw: boolean;
  private readonly originalPaused: boolean;
  private active = false;
  private interrupted = false;
  private closed = false;

  constructor(private readonly source: TerminalInput = process.stdin) {
    this.originalRaw = Boolean(source.isRaw);
    this.originalPaused = source.isPaused?.() ?? false;
    if (source.isTTY && source.setRawMode) source.setRawMode(true);
    source.on("data", this.forward);
    source.resume();
  }

  private readonly forward = (chunk: Buffer | string): void => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!this.active) {
      if (bytes.includes(3)) this.interrupted = true;
      return;
    }
    this.input.write(bytes);
  };

  async prompt<T>(
    run: (context: PromptContext) => Promise<T>,
    options: { navigation?: boolean } = {}
  ): Promise<PromptResult<T>> {
    if (this.closed) throw new Error("Prompt session is closed");
    if (this.interrupted) throw new PromptInterruptedError();
    if (this.active) throw new Error("A prompt is already active");

    const controller = new AbortController();
    const handleKey = (_character: string | undefined, key: { name?: string }): void => {
      if (key.name === "escape") {
        controller.abort();
      } else if (options.navigation && key.name === "w") {
        key.name = "up";
      } else if (options.navigation && key.name === "s") {
        key.name = "down";
      }
    };

    this.input.prependListener("keypress", handleKey);
    this.active = true;
    try {
      return { kind: "value", value: await run({
        input: this.input,
        signal: controller.signal,
        clearPromptOnDone: true,
      }) };
    } catch (error) {
      if (controller.signal.aborted && error instanceof Error && error.name === "AbortPromptError") {
        return { kind: "back" };
      }
      throw error;
    } finally {
      this.active = false;
      this.input.removeListener("keypress", handleKey);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.source.removeListener("data", this.forward);
    this.input.end();
    if (this.source.isTTY && this.source.setRawMode) this.source.setRawMode(this.originalRaw);
    if (this.originalPaused || this.source.listenerCount("data") === 0) this.source.pause();
  }
}
