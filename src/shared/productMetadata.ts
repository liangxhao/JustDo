import { author, productName } from '../../package.json';

const ENGLISH_PRODUCT_NAME = /^[A-Za-z]{1,64}$/;
const WINDOWS_RESERVED_FILE_NAME = /^(con|prn|aux|nul)$/i;

export const validateProductName = (value: string): string => {
  if (!ENGLISH_PRODUCT_NAME.test(value) || WINDOWS_RESERVED_FILE_NAME.test(value)) {
    throw new Error(
      'package.json productName must be a non-reserved English word containing 1-64 ASCII letters only.',
    );
  }
  return value;
};

/** User-facing brand name. Stable internal identifiers must not derive from this value. */
export const PRODUCT_NAME = validateProductName(productName);

/** Publisher attribution from package.json; separate from the product brand. */
export const AUTHOR_NAME = author.name;

/** Visible per-user application data directory, for example `%APPDATA%/<productName>`. */
export const USER_DATA_DIRECTORY_NAME = PRODUCT_NAME;

/** Visible default workspace root. Keep the existing lowercase directory convention. */
export const DEFAULT_WORKSPACE_DIRECTORY_NAME = PRODUCT_NAME.toLocaleLowerCase('en-US');
