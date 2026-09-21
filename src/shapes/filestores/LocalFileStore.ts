import { relativeFileSystemUploadPath } from '@_linked/server-utils/utils/Upload';
import { publicUploadPath } from '@_linked/server-utils/utils/ServerPaths';
import {
  FileStat,
  IFileStore,
  SaveFileOptions,
  normalizeSaveFileOptions,
} from '@_linked/core/interfaces/IFileStore';
import { Shape } from '@_linked/core/shapes/Shape';
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

export class LocalFileStore extends Shape implements IFileStore {
  private readonly basePath: string;

  public readonly accessURL: string;

  constructor(
    n: string | { id: string },
    basePath: string = relativeFileSystemUploadPath
  ) {
    if (typeof n === 'string') {
      const uri = `${process.env.DATA_ROOT}/local-filestore/${n}`;
      super({ id: uri });
    } else {
      super(n);
    }

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
   * List all files in the local filesystem, relative to the base upload folder
   * @param recursive Whether or not to search all subdirectories recursively
   * @returns A promise that resolves to a list of file paths, relative to the base upload folder
   * @todo Think about taking an options parameter instead of positional args
   * @todo Take a path parameter to list files in a subdirectory
   */
  async listFiles(prefix?: string): Promise<string[]> {
    let files = await fs.readdir(this.basePath);

    // if (recursive) {
    const allFiles = await Promise.all(
      files.map((file) => {
        const filePath = path.join(this.basePath, file);

        return fs
          .stat(filePath)
          .then((stat) => {
            if (stat.isDirectory()) {
              return this.listFiles(prefix).then((files) =>
                files.map((file) => path.join(filePath, file))
              );
            } else {
              return [filePath];
            }
          })
          .catch((err) => {
            console.warn('Error during listFiles', err);
            return [];
          });
      })
    );

    return allFiles.flat();
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
  private resolveTarget(
    filePath: string,
    mimeType: string | undefined,
    suffixDuplicates: boolean
  ): SavedFileLocation {
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

    // 6 character random string to avoid clobbering an existing file,
    // e.g. report.pdf -> report_312acb.pdf
    const randomStringSuffix = suffixDuplicates
      ? '_' + Math.random().toString(36).substring(2, 8)
      : '';

    const storedPath = withoutExt + randomStringSuffix + '.' + ext;

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
   * the name needs no sanitising, already has an extension, and
   * `preventDuplicates` is `false`. With `preventDuplicates` left unspecified
   * (this store's default, kept for upload callers) a random suffix is added,
   * and `storedPath` is the only place that name is reported.
   */
  async saveFileWithPath(
    filePath: string,
    fileContent: Buffer,
    options?: SaveFileOptions | string,
    preventDuplicates?: boolean
  ): Promise<SavedFileLocation> {
    const normalized = normalizeSaveFileOptions(options, preventDuplicates);
    // Core reports an unspecified preventDuplicates as undefined, leaving the
    // default to each store. This one has always appended a random suffix, so
    // only an explicit `false` turns that off.
    const suffixDuplicates = normalized.preventDuplicates ?? true;

    const target = this.resolveTarget(
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
