import { styleText } from 'node:util';

/**
 * Colour a log line. Built on Node's `util.styleText`, which drops the colour
 * when the stream is not a TTY or NO_COLOR / FORCE_COLOR say so — the same
 * behaviour chalk gave us, without a dependency. Several parts are joined with
 * a space, as chalk did.
 */
export function paint(
  color: 'red' | 'gray' | 'magenta' | 'yellow',
  ...text: unknown[]
): string {
  return styleText(color, text.join(' '));
}
