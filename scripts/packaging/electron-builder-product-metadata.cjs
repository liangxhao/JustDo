'use strict';

function resolveBuilderProductMetadata(productName) {
  if (
    typeof productName !== 'string' ||
    !/^[A-Za-z]{1,64}$/.test(productName) ||
    /^(con|prn|aux|nul)$/i.test(productName)
  ) {
    throw new Error(
      'package.json productName must be a non-reserved English word containing 1-64 ASCII letters only.',
    );
  }

  return {
    productName,
    appId: `com.${productName.toLocaleLowerCase('en-US')}.app`,
  };
}

module.exports = { resolveBuilderProductMetadata };
