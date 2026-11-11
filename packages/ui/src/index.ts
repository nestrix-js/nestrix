/** Directory that holds the dashboard files (this module lives in it). */
export const dashboardDirectory: URL = new URL("./", import.meta.url);

/** The generated list of dashboard files: paths, sizes and content hashes. */
export const manifestUrl: URL = new URL("./manifest.json", import.meta.url);
