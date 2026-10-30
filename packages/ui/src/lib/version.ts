/**
 * The application's version, read from the workspace manifest rather than written out again here.
 *
 * It is compared against the latest release to decide whether an update exists, so a second copy that drifted
 * would have the application report itself up to date when it is not. Releasing means changing the manifest,
 * and nothing else. What the interface displays is BUILD below, which is not always this.
 */

import { version } from "../../../../package.json";

export const VERSION: string = version;

/** Set by the build: the commit a non-release build came from, or "" for one built from a release tag. */
declare const __ZAX_COMMIT__: string;

/*
  What the interface shows. A build that is not a release carries the commit as a pre-release suffix -
  `0.8.0-c295f20` - so the label still says which release it is working towards and still sorts against the
  others, while naming the code a bug reporter is actually running. It is a display string: the comparison
  against the latest release uses VERSION, and a suffixed one would read as older than the release it precedes.
*/
export const BUILD: string =
  typeof __ZAX_COMMIT__ === "string" && __ZAX_COMMIT__ !== "" ? `${version}-${__ZAX_COMMIT__}` : version;
