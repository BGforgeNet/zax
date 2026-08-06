/**
 * The application's version, read from the workspace manifest rather than written out again here.
 *
 * It is shown in the window and compared against the latest release to decide whether an update exists, so a
 * second copy that drifted would have the application state a version it is not and report itself up to date
 * when it is not. Releasing means changing the manifest, and nothing else.
 */

import { version } from "../../../../package.json";

export const VERSION: string = version;
