export const BROWSER_AUTHENTICATION_CONFIG = Object.freeze({
  // Windows authentication connection executable. Leave empty to disable.
  executableName: '',
  // The full HTTPS URL must exactly match the browser's request, including the path.
  // A trailing slash alone matches only the root path (/) and has no wildcard meaning.
  localEndpoint: 'https://localhost:18080/getSpesInfo',
});
