export function buildSdkPackage(options: {
  source: string;
  destination: string;
  licenseFile?: string;
}): Promise<string>;
