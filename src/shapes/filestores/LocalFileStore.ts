import { relativeFileSystemUploadPath } from '@_linked/server-utils/utils/Upload';
import { publicUploadPath } from '@_linked/server-utils/utils/ServerPaths';
import {
  FileStat,
  IFileStore,
  SaveFileOptions,
  normalizeSaveFileOptions,
} from '@_linked/core/interfaces/IFileStore';
import { createHash } from 'node:crypto';
import * as fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * What `saveFile` stored, and where.
 *
 * `storedPath` is the key as it ended up in the store: it is exactly what
 * `getFile`, `fileExists`, `deleteFile` and `statFile` expect, so a caller that
 * wants to verify what it just uploaded never has to guess a name back out of a
 * URL.
 */
export interface SavedFileLocation {
  /** The key the file is stored under, relative to the store's base folder. */
  storedPath: string;
  /** The public URL, the same string `saveFile` returns. */
  publicURL: string;
}

/**
 * A file store is not a Shape.
 *
 * This class used to `extends Shape`, but used nothing from it: no `this.id`, no
 * `this.uri`, no `nodeShape`, no Shape statics, no property decorators, and no
 * caller that treated it as a Shape. The only inherited behaviour was `super({id})`
 * writing an id that nothing ever read.
 *
 * Datasets and stores stopped being Shapes deliberately (core `0e8c86e`,
 * "datasets are not shapes"), and `Shape`'s instantiation guard is currently
 * DEFERRED naming this very class as the reason. Dropping the inheritance removes
 * one of the last obstacles to re-enabling it.
 */
export class LocalFileStore implements IFileStore {
  private readonly basePath: string;

  public readonly accessURL: string;

  /**
   * `n` names the store. It was previously also accepted as `{id}` because that is
   * `Shape`'s constructor signature; both forms are still taken so existing callers
   * keep working, but neither is stored as a node id any more.
   */
  constructor(
    n: string | { id: string },
    basePath: string = relativeFileSystemUploadPath
  ) {
    this.accessURL = process.env.SITE_ROOT;
    this.basePath = basePath;
  }

  /**
   * Delete a file from the local filesystem
   * @param filePath The path to the file to delete, relative to the base upload folder
   * @returns A promise that resolves when the file is deleted
   */
  deleteFile(filePath: string): Promise<void> {
    const fileToDelete = path.join(this.basePath, filePath);

    return fs.rm(fileToDelete);
  }

  /**
   * Check if a file exists on the local filesystem
   * @param filePath The path to the file to check, relative to the base upload folder
   * @returns A promise that resolves to true if the file exists, false otherwise
   */
  fileExists(filePath: string): Promise<boolean> {
    const fileToCheck = path.join(this.basePath, filePath);

    return fs
      .access(fileToCheck)
      .then(() => true)
      .catch(() => false);
  }

  /**
   * Get a file from the local filesystem
   * @param filePath The path to the file to get, relative to the base upload folder
   * @returns A promise that resolves to the file contents as a buffer, or null if the file does not exist
   */
  getFile(filePath: string): Promise<Buffer | null> {
    const fileToGet = path.join(this.basePath, filePath);

    return fs.readFile(fileToGet).catch(() => null);
  }

  /**
   * List every file in the store, recursively.
   *
   * @param prefix Only return keys starting with this string. Matched against
   *   the returned (relative) key, so `listFiles('images/')` selects the
   *   `images` folder and `listFiles('main-')` selects by file name.
   * @returns Keys relative to the base folder, exactly as `getFile`,
   *   `fileExists`, `deleteFile` and `statFile` expect them.
   *
   * The keys are relative on purpose: every other method on this store resolves
   * its argument *against* `basePath`, so returning `data/uploads/x.txt` here
   * meant a caller who fed the result straight back into `getFile` looked for
   * `data/uploads/data/uploads/x.txt`. It also matches `S3FileStore`, which
   * strips the bucket prefix before returning.
   */
  async listFiles(prefix?: string): Promise<string[]> {
    const walk = async (relativeDir: string): Promise<string[]> => {
      const absoluteDir = path.join(this.basePath, relativeDir);

      let entries: fsSync.Dirent[];
      try {
        entries = await fs.readdir(absoluteDir, { withFileTypes: true });
      } catch (err) {
        console.warn('Error during listFiles', err);
        return [];
      }

      const nested = await Promise.all(
        entries.map((entry) => {
          // path.join('', 'x') === 'x', so the top level stays unprefixed
          const key = path.join(relativeDir, entry.name);
          // recurse into the subdirectory itself. This used to call
          // listFiles(prefix), which re-read basePath and so found the same
          // directory again -- unbounded recursion as soon as the store held
          // one folder.
          return entry.isDirectory() ? walk(key) : Promise.resolve([key]);
        })
      );

      return nested.flat();
    };

    const keys = await walk('');

    return prefix ? keys.filter((key) => key.startsWith(prefix)) : keys;
  }

  /**
   * Work out the key a save will use, and the URL that key is served under.
   *
   * This used to be `getUploadTarget` from `@_linked/server-utils`, which could
   * not be used here for two reasons:
   *
   * - it lowercases the name. That is HTTP-upload hygiene (browsers hand over
   *   whatever the user's filesystem had, and `getUploadTarget` is still the
   *   right place for it — `uploadSingleFileFromFormData` calls it before it
   *   ever reaches a store), but it corrupts a key a program chose on purpose,
   *   such as a Vite content hash: `main-hwqwrAvA.css`.
   * - it always resolves against `relativeFileSystemUploadPath`, ignoring this
   *   store's `basePath`, so a store with a custom base folder wrote where it
   *   could not read back.
   *
   * Characters that are not safe in a file name are still replaced, exactly as
   * `getUploadTarget` does it — only the case is left alone.
   */
  private async resolveTarget(
    filePath: string,
    mimeType: string | undefined,
    suffixDuplicates: boolean
  ): Promise<SavedFileLocation> {
    // alphanumerics, dot, underscore, dash and the path separator survive; a
    // run of anything else becomes one dash. Case is deliberately preserved.
    //
    // The dash has to be in that set. Without it a run of dashes collapsed to
    // one, so a Vite base64 content hash that happens to start with a dash —
    // `shapeCodeGenerator--2JmNvrO.js` — came back as
    // `shapeCodeGenerator-2JmNvrO.js`, a different key from the one the caller
    // asked for and from the one baked into the bundle.
    let sanitisedName = filePath.replace(/[^A-Za-z0-9\._\/-]+/g, '-');

    if (sanitisedName.indexOf('.') === -1) {
      //auto add an extension if none is present, based on the mimetype
      if (!mimeType) {
        throw new Error(
          'This file does not have an extension and no mimetype was provided'
        );
      }
      sanitisedName = sanitisedName + '.' + mimeType.split('/')[1];
    }

    const ext = sanitisedName.split('.').pop();
    const withoutExt = sanitisedName.substring(
      0,
      sanitisedName.length - (ext.length + 1)
    );

    // A 6 character random string avoids clobbering an existing file,
    // e.g. report.pdf -> report_312acb.pdf.
    //
    // It is only applied when the name is actually taken. This used to be
    // unconditional, which did prevent duplicates but also meant a caller never
    // got back the key it asked for: a content-hashed bundle handed over as
    // `main-hwqwrAvA.css` landed as `main-hwqwrAvA_x9k2ml.css`, so the name
    // baked into the HTML no longer resolved. Checking first keeps the
    // never-clobber guarantee -- a taken name still gets a suffix, and the
    // suffixed name is itself re-checked -- while leaving free names alone.
    // `S3FileStore` has always worked this way, so the two implementations of
    // IFileStore now read the flag the same.
    let storedPath = withoutExt + '.' + ext;

    if (suffixDuplicates) {
      // 36^6 is ~2 billion, so a second collision is already vanishingly
      // unlikely; the cap turns a pathological case into a clear error rather
      // than a spin.
      const maxAttempts = 10;
      let attempt = 0;

      while (await this.fileExists(storedPath)) {
        if (attempt++ >= maxAttempts) {
          throw new Error(
            `Could not find a free name for '${filePath}' after ${maxAttempts} attempts`
          );
        }

        storedPath =
          withoutExt + '_' + Math.random().toString(36).substring(2, 8) + '.' + ext;
      }
    }

    return {
      storedPath,
      publicURL: this.accessURL + publicUploadPath + '/' + storedPath,
    };
  }

  /**
   * Save a file to the local filesystem
   * @param filePath The path to save the file to, relative to the base folder
   * @param fileContent The contents of the file as a buffer
   * @param options Save options, or a string read as the old positional mimeType.
   *   A local file has no headers to attach, so only `mimeType` (used to add a
   *   missing extension) and `preventDuplicates` mean anything here;
   *   `cacheControl` and `metadata` are accepted and ignored.
   * @param preventDuplicates Only honoured when `options` is a string
   * @returns A promise that resolves to the public URL of the file. Use
   *   {@link saveFileWithPath} when you also need the key it was stored under.
   */
  async saveFile(
    filePath: string,
    fileContent: Buffer,
    options?: SaveFileOptions | string,
    preventDuplicates?: boolean
  ): Promise<string> {
    const { publicURL } = await this.saveFileWithPath(
      filePath,
      fileContent,
      options,
      preventDuplicates
    );

    return publicURL;
  }

  /**
   * Save a file and report both the key it was stored under and its URL.
   *
   * `saveFile` can only return one string, and `IFileStore` says that string is
   * a URL — but a caller that wants to verify what it just wrote needs the
   * *key*, which is what `statFile`, `getFile`, `fileExists` and `deleteFile`
   * take. That is what `storedPath` is: hand it straight back to any of them.
   *
   * The key equals the `filePath` given verbatim — case included — as long as
   * the name needs no sanitising and already has an extension. With
   * `preventDuplicates` left unspecified (this store's default, kept for upload
   * callers) that still holds for a name nothing else occupies; only a name
   * already taken gains a random suffix, and `storedPath` is the only place
   * that name is reported.
   */
  async saveFileWithPath(
    filePath: string,
    fileContent: Buffer,
    options?: SaveFileOptions | string,
    preventDuplicates?: boolean
  ): Promise<SavedFileLocation> {
    const normalized = normalizeSaveFileOptions(options, preventDuplicates);
    // Core reports an unspecified preventDuplicates as undefined, leaving the
    // default to each store. This one protects an existing file, so only an
    // explicit `false` allows an overwrite.
    const suffixDuplicates = normalized.preventDuplicates ?? true;

    const target = await this.resolveTarget(
      filePath,
      normalized.mimeType,
      suffixDuplicates
    );

    // resolved against basePath, exactly like every read method does, so what
    // is written here can be read back by the same key
    const targetFilePath = path.join(this.basePath, target.storedPath);

    //make sure the target folder exists
    if (!fsSync.existsSync(path.dirname(targetFilePath))) {
      fsSync.mkdirSync(path.dirname(targetFilePath), { recursive: true });
    }
    await fs.writeFile(targetFilePath, fileContent);

    return target;
  }

  /**
   * Read back the metadata of a stored file, for verify-after-upload.
   *
   * The path is resolved exactly like saveFile/getFile/fileExists/deleteFile
   * do, against this store's base folder, so the `storedPath` that
   * saveFileWithPath reports can be handed straight back here.
   *
   * The sha256 is computed on demand from the bytes: statFile is only called
   * during publish verification, not on every upload.
   *
   * @param filePath The path to the file, relative to the base upload folder
   * @returns The size and sha256 of the file, or null if it does not exist
   */
  async statFile(filePath: string): Promise<FileStat | null> {
    const fileToStat = path.join(this.basePath, filePath);

    let stat: fsSync.Stats;
    try {
      stat = await fs.stat(fileToStat);
    } catch (err) {
      return null;
    }
    if (!stat.isFile()) {
      return null;
    }

    const contents = await fs.readFile(fileToStat);
    const sha256 = createHash('sha256').update(contents).digest('hex');

    return { size: stat.size, sha256 };
  }
}
