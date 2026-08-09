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
  What the interface shows. A build that is not a release shows its commit instead of the version, because the
  version would name a release the build is not - the whole point of the label is telling a bug reporter which
  code they are running. The comparison against the latest release still uses VERSION, which is a version.
*/
export const BUILD: string = typeof __ZAX_COMMIT__ === "string" && __ZAX_COMMIT__ !== "" ? __ZAX_COMMIT__ : version;
