export class IceboltValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IceboltValidationError';
  }
}

export class IceboltQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IceboltQueryError';
  }
}

export class IceboltSchemaMismatchError extends Error {
  readonly expectedHash: string;
  readonly actualHash: string | null;

  constructor(expectedHash: string, actualHash: string | null) {
    super(
      actualHash === null
        ? `Database contains tables but no Icebolt metadata; refusing to migrate a foreign database (expected schema ${expectedHash}).`
        : `Database schema ${actualHash} does not match compiled schema ${expectedHash}. Apply a data migration before opening.`,
    );
    this.name = 'IceboltSchemaMismatchError';
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

/** The database was upgraded by a newer version of the app; this older copy must not touch it. */
export class IceboltSchemaTooNewError extends Error {
  readonly databaseVersion: number;
  readonly appVersion: number;

  constructor(databaseVersion: number, appVersion: number) {
    super(
      `This data was saved by a newer version of the app (schema v${databaseVersion}; this page knows v${appVersion}). Reload the page to get the latest version; nothing was changed.`,
    );
    this.name = 'IceboltSchemaTooNewError';
    this.databaseVersion = databaseVersion;
    this.appVersion = appVersion;
  }
}
