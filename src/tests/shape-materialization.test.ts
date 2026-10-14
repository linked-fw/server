import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const appData = { rawQuery: jest.fn() };
const run = jest.fn(async () => undefined);
const syncShape = jest.fn(() => run);
const syncShapes = jest.fn();

class AppShape {}
Object.assign(AppShape, {
  packageName: '@fixture/app',
  shape: { id: 'https://fixture.test/shape/AppShape' },
});

class FrameworkShape {}
Object.assign(FrameworkShape, {
  packageName: '@_linked/core',
  shape: { id: 'https://linked.cm/shape/core/FrameworkShape' },
});

class ShapeWithoutDeclaration {}
Object.assign(ShapeWithoutDeclaration, { packageName: '@fixture/app' });

jest.unstable_mockModule('@_linked/core', () => ({
  syncShape,
  syncShapes,
}));

jest.unstable_mockModule('@_linked/core/utils/ShapeClass', async () => {
  const actual = await jest.requireActual<
    typeof import('@_linked/core/utils/ShapeClass')
  >('@_linked/core/utils/ShapeClass');
  return {
    ...actual,
    getAllShapeClasses: () =>
      new Map([
        ['https://fixture.test/shape/AppShape', AppShape],
        ['https://linked.cm/shape/core/FrameworkShape', FrameworkShape],
        ['https://fixture.test/shape/Undeclared', ShapeWithoutDeclaration],
      ]),
  };
});

jest.unstable_mockModule('@_linked/core/utils/LinkedStorage', async () => {
  const actual = await jest.requireActual<
    typeof import('@_linked/core/utils/LinkedStorage')
  >('@_linked/core/utils/LinkedStorage');
  class TestLinkedStorage extends actual.LinkedStorage {
    static getDefaultDataset() {
      return appData as never;
    }
  }
  return { ...actual, LinkedStorage: TestLinkedStorage };
});

const { LinkedServer } = await import('../shapes/LinkedServer.js');

function makeServer(syncShapesOnBoot: boolean) {
  const server = Object.create(LinkedServer.prototype) as {
    config?: { syncShapesOnBoot?: boolean };
    materializeShapesIntoStore: () => Promise<void>;
  };
  server.config = { syncShapesOnBoot };
  return server;
}

describe('LinkedServer shape materialization boundary', () => {
  beforeEach(() => {
    run.mockClear();
    syncShape.mockClear();
    syncShapes.mockClear();
    appData.rawQuery.mockClear();
  });

  it('materializes only this process registered shapes without a dataset-wide sweep', async () => {
    await makeServer(true).materializeShapesIntoStore();

    expect(syncShape).toHaveBeenCalledTimes(1);
    expect(syncShape).toHaveBeenCalledWith(AppShape, appData);
    expect(run).toHaveBeenCalledTimes(1);
    expect(syncShapes).not.toHaveBeenCalled();
    expect(appData.rawQuery).not.toHaveBeenCalled();
  });

  it('keeps syncShapesOnBoot false as the no-materialization alias', async () => {
    await makeServer(false).materializeShapesIntoStore();

    expect(syncShape).not.toHaveBeenCalled();
    expect(syncShapes).not.toHaveBeenCalled();
  });
});
