import { describe, expect, it } from '@jest/globals';
import { ssrCssInlineUrls } from '../utils/ssrCss.js';

const ROOT = '/app';

describe('ssrCssInlineUrls', () => {
  it('loads each stylesheet as ?inline', () => {
    expect(
      ssrCssInlineUrls([
        `${ROOT}/src/App.global.css`,
        `${ROOT}/src/pages/Home.module.css`,
      ]),
    ).toEqual([
      `${ROOT}/src/App.global.css?inline`,
      `${ROOT}/src/pages/Home.module.css?inline`,
    ]);
  });

  it('skips ?direct ids, which load as raw CSS and fail to parse as JS', () => {
    expect(
      ssrCssInlineUrls([`${ROOT}/src/theme.css?direct`]),
    ).toEqual([]);
  });

  it('skips its own ?inline loads and ?raw / ?url ids', () => {
    expect(
      ssrCssInlineUrls([
        `${ROOT}/src/a.css?inline`,
        `${ROOT}/src/b.css?used&inline`,
        `${ROOT}/src/c.css?raw`,
        `${ROOT}/src/d.css?url`,
      ]),
    ).toEqual([]);
  });

  it('skips files under publicDir, such as a stale production bundle', () => {
    expect(
      ssrCssInlineUrls(
        [
          `${ROOT}/public/bundles/assets/index-eb308398.css`,
          `${ROOT}/src/theme.css`,
        ],
        { publicDir: `${ROOT}/public` },
      ),
    ).toEqual([`${ROOT}/src/theme.css?inline`]);
  });

  it('does not treat a sibling directory sharing the publicDir prefix as public', () => {
    expect(
      ssrCssInlineUrls([`${ROOT}/public-styles/a.css`], {
        publicDir: `${ROOT}/public`,
      }),
    ).toEqual([`${ROOT}/public-styles/a.css?inline`]);
  });

  it('loads a file once however many ids it has, in first-seen order', () => {
    expect(
      ssrCssInlineUrls([
        `${ROOT}/src/b.css`,
        `${ROOT}/src/a.css?t=1700000000`,
        `${ROOT}/src/b.css?used`,
        `${ROOT}/src/a.css`,
        `${ROOT}/src/b.css?direct`,
      ]),
    ).toEqual([`${ROOT}/src/b.css?inline`, `${ROOT}/src/a.css?inline`]);
  });

  it('ignores modules that are not stylesheets', () => {
    expect(
      ssrCssInlineUrls([
        `${ROOT}/src/App.tsx`,
        `${ROOT}/src/Comp.vue?vue&type=style&index=0&lang.css`,
        `${ROOT}/src/styles.scss`,
      ]),
    ).toEqual([]);
  });
});
