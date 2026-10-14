/**
 * The no-echo secret prompt (copied from Brand OS apps/cli): the value never appears on screen, in argv or in shell history.
 *
 * A raw-mode TTY delivers a paste as ONE data chunk, often with the line break that was copied with it (system audit
 * round 2, SR2-5: "token\r" did not submit, and the Enter that followed stored a padded value, which `writeSecret`
 * refused). So the input is read character by character across chunks: the first CR or LF ends the value, wherever
 * it falls in a chunk, and anything after it is ignored. Backspace edits, Ctrl-C and Ctrl-D cancel, Ctrl-U clears,
 * other control characters (and terminal escape sequences) are dropped, never stored.
 */
export type SecretKeyOutcome =
  | { readonly kind: 'more' }
  | { readonly kind: 'submit'; readonly value: string }
  | { readonly kind: 'cancel' };

export class SecretInput {
  #value = '';
  #escape = false;
  #done = false;

  /** Feeds one chunk as the TTY delivered it; the outcome is final once it is not `more`. */
  feed(chunk: string): SecretKeyOutcome {
    if (this.#done) return { kind: 'more' };
    for (const ch of chunk) {
      if (this.#escape) {
        // An ESC sequence (arrow keys, bracketed-paste markers): skip to its final byte.
        if (/[@-~]/.test(ch) && ch !== '[' && ch !== 'O') this.#escape = false;
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        this.#done = true;
        return { kind: 'submit', value: this.#value };
      }
      if (ch === '\u0003' || ch === '\u0004') {
        this.#done = true;
        this.#value = '';
        return { kind: 'cancel' };
      }
      if (ch === '\u007f' || ch === '\b') this.#value = [...this.#value].slice(0, -1).join('');
      else if (ch === '\u0015') this.#value = '';
      else if (ch === '\u001b') this.#escape = true;
      else if (ch >= ' ') this.#value += ch;
    }
    return { kind: 'more' };
  }
}

/** The slice of `process.stdin` / `process.stdout` the prompt uses (tests pass a stand-in TTY). */
export interface SecretTty {
  readonly isTTY?: boolean;
  setRawMode(on: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  setEncoding(enc: 'utf8'): unknown;
  on(ev: 'data', fn: (chunk: string) => void): unknown;
  off(ev: 'data', fn: (chunk: string) => void): unknown;
}

export function promptSecret(
  label: string,
  stdin: SecretTty = process.stdin as unknown as SecretTty,
  write: (s: string) => void = (s) => void process.stdout.write(s),
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (stdin.isTTY !== true) return reject(new Error('a terminal is required for a no-echo prompt'));
    write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const input = new SecretInput();
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      write('\n');
    };
    const onData = (chunk: string) => {
      const r = input.feed(String(chunk));
      if (r.kind === 'more') return;
      finish();
      if (r.kind === 'submit') resolve(r.value);
      else reject(new Error('cancelled'));
    };
    stdin.on('data', onData);
  });
}
