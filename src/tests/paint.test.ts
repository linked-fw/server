import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * paint replaced chalk: it must colour a terminal, stay plain when colour is
 * off, and join several parts with a space the way chalk did.
 *
 * Run in a child Node process: `util.styleText` reads the REAL process.env,
 * and jest hands the test a sandboxed copy, so setting FORCE_COLOR here would
 * not reach it.
 */
const source = pathToFileURL(
  path.resolve(process.cwd(), 'src/utils/paint.ts')
).href;

function run(env: Record<string, string>, call: string): string {
  const { FORCE_COLOR, NO_COLOR, NODE_OPTIONS, ...rest } = process.env;
  const out = execFileSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      '--input-type=module',
      '-e',
      `import { paint } from ${JSON.stringify(source)};
       process.stdout.write(JSON.stringify(${call}));`,
    ],
    { env: { ...rest, ...env }, encoding: 'utf8' }
  );
  return JSON.parse(out);
}

describe('paint', () => {
  it('emits ANSI colour when colour is forced', () => {
    expect(run({ FORCE_COLOR: '1' }, `paint('red', 'boom')`)).toBe(
      '\u001b[31mboom\u001b[39m'
    );
    expect(run({ FORCE_COLOR: '1' }, `paint('yellow', 'warn')`)).toBe(
      '\u001b[33mwarn\u001b[39m'
    );
  });

  it('stays plain when colour is disabled or the stream is not a TTY', () => {
    expect(run({ NO_COLOR: '1' }, `paint('magenta', 'plain')`)).toBe('plain');
    // stdout is a pipe here, so with no override it must not colour either.
    expect(run({}, `paint('red', 'piped')`)).toBe('piped');
  });

  it('joins several parts with a space', () => {
    expect(
      run({ NO_COLOR: '1' }, `paint('magenta', 'Could not load package x', 'at /y')`)
    ).toBe('Could not load package x at /y');
  });
});
